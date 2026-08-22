import { EventEmitter } from 'events';

interface MCPToolResult {
  content: Array<{ type: string; text: string }>;
}

/**
 * Client for communicating with ProjectMind MCP server.
 * Spawns the MCP server as a child process and communicates via stdio.
 */
export class MCPClient extends EventEmitter {
  private process: import('child_process').ChildProcess | null = null;
  private serverPath: string;
  private requestId = 0;

  constructor(serverPath: string = 'projectmind') {
    super();
    this.serverPath = serverPath;
  }

  /**
   * Start the MCP server process.
   */
  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    const { spawn } = await import('child_process');
    this.process = spawn(this.serverPath, ['mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (data) => {
      this.emit('data', data.toString());
    });

    this.process.stderr?.on('data', (data) => {
      console.error('MCP Server Error:', data.toString());
    });

    this.process.on('close', (code) => {
      console.log(`MCP Server exited with code ${code}`);
      this.process = null;
    });
  }

  /**
   * Call an MCP tool and return the result.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    await this.start();

    const id = ++this.requestId;
    const request = {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    };

    return new Promise((resolve, reject) => {
      const handler = (data: string) => {
        try {
          const lines = data.split('\n');
          for (const line of lines) {
            if (!line.startsWith('{')) continue;
            const parsed = JSON.parse(line);
            if (parsed.id === id) {
              this.off('data', handler);
              if (parsed.error) {
                reject(new Error(parsed.error.message));
              } else {
                resolve(parsed.result as MCPToolResult);
              }
              return;
            }
          }
        } catch {
          // Ignore parse errors
        }
      };

      this.on('data', handler);
      this.process?.stdin?.write(JSON.stringify(request) + '\n');

      // Timeout after 30 seconds
      setTimeout(() => {
        this.off('data', handler);
        reject(new Error('Tool call timeout'));
      }, 30000);
    });
  }

  /**
   * Dispose of the client and stop the server.
   */
  dispose(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}
