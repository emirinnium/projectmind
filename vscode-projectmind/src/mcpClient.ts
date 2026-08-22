import { EventEmitter } from 'events';

interface MCPToolResult {
  content: Array<{ type: string; text: string }>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const PROTOCOL_VERSION = '2024-11-05';

/**
 * Client for communicating with the ProjectMind MCP server.
 * Spawns the server as a child process and speaks JSON-RPC over stdio,
 * including the MANDATORY initialize handshake required by the MCP spec.
 */
export class MCPClient extends EventEmitter {
  private process: import('child_process').ChildProcess | null = null;
  private serverPath: string;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private stdoutBuffer = '';
  private bootPromise: Promise<void> | null = null;

  constructor(serverPath: string = 'projectmind') {
    super();
    this.serverPath = serverPath;
  }

  /**
   * Start the server and complete the MCP initialize handshake exactly once.
   */
  async start(): Promise<void> {
    if (!this.bootPromise) {
      this.bootPromise = this.boot().catch((e) => {
        this.bootPromise = null;
        throw e;
      });
    }
    return this.bootPromise;
  }

  private async boot(): Promise<void> {
    const { spawn } = await import('child_process');
    this.process = spawn(this.serverPath, ['mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.on('error', (err) => {
      this.failAllPending(new Error(`MCP server failed to start: ${err.message}`));
      this.process = null;
      this.bootPromise = null;
      this.emit('error', err);
    });

    this.process.stdout?.on('data', (data) => this.handleStdout(data.toString()));

    this.process.stderr?.on('data', (data) => {
      console.error('[projectmind-mcp]', data.toString());
    });

    this.process.on('close', (code) => {
      console.log(`MCP server exited with code ${code}`);
      this.failAllPending(new Error(`MCP server exited unexpectedly (code ${code})`));
      this.process = null;
      this.bootPromise = null;
    });

    // MCP requires: initialize request -> result -> initialized notification.
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'projectmind-vscode', version: '1.0.0' },
    }, 15_000);
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  /** Newline-delimited JSON-RPC framing with request-id routing. */
  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      if (!line.startsWith('{')) continue;
      try {
        const msg = JSON.parse(line) as {
          id?: number; error?: { message?: string }; result?: unknown;
        };
        if (typeof msg.id === 'number') {
          const pending = this.pending.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error.message || 'MCP request failed'));
            } else {
              pending.resolve(msg.result);
            }
          }
        }
        // Notifications (no id) are intentionally ignored.
      } catch {
        // Ignore malformed lines.
      }
    }
  }

  private send(message: unknown): void {
    this.process?.stdin?.write(JSON.stringify(message) + '\n');
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin?.writable) {
        reject(new Error('MCP server is not running'));
        return;
      }
      const id = ++this.requestId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /**
   * Call an MCP tool. Ensures the initialize handshake has completed first.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    await this.start();
    const result = await this.request(
      'tools/call',
      { name: toolName, arguments: args },
      60_000
    );
    return result as MCPToolResult;
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /**
   * Stop the server and reject anything still in flight.
   */
  dispose(): void {
    this.failAllPending(new Error('MCP client disposed'));
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.bootPromise = null;
  }
}
