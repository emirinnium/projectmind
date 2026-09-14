import { describe, expect, it } from 'vitest';
import {
  buildMcpHandshakeInvocation,
  consumeMcpJsonLines,
} from '../../src/cli/commands/init-mcp.js';

describe('MCP handshake JSON-line framing', () => {
  it('passes package CLI options through npx with an explicit separator', () => {
    expect(buildMcpHandshakeInvocation(undefined, '@emirhanturker/projectmind@1.0.4')).toEqual({
      executable: 'npx',
      args: ['--yes', '@emirhanturker/projectmind@1.0.4', '--', 'mcp', '--profile', 'core'],
    });
    expect(
      buildMcpHandshakeInvocation('C:/node/npx-cli.js', '@emirhanturker/projectmind@latest'),
    ).toEqual({
      executable: process.execPath,
      args: [
        'C:/node/npx-cli.js',
        '--yes',
        '@emirhanturker/projectmind@latest',
        '--',
        'mcp',
        '--profile',
        'core',
      ],
    });
  });

  it('preserves a large response split across stdout chunks', () => {
    const response = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: { tools: Array.from({ length: 1_000 }, (_, index) => ({ name: `tool_${index}` })) },
    });
    expect(response.length).toBeGreaterThan(16_000);

    const split = Math.floor(response.length / 2);
    const first = consumeMcpJsonLines('', response.slice(0, split));
    expect(first.messages).toHaveLength(0);
    expect(first.buffer).toBe(response.slice(0, split));
    expect(first.oversized).toBe(false);

    const second = consumeMcpJsonLines(first.buffer, `${response.slice(split)}\n`);
    expect(second.buffer).toBe('');
    expect(second.oversized).toBe(false);
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]?.id).toBe(2);
    expect(second.messages[0]?.result?.tools).toHaveLength(1_000);
  });

  it('ignores non-JSON log lines without losing the next response', () => {
    const result = consumeMcpJsonLines(
      '',
      `not-json\n${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`,
    );

    expect(result.buffer).toBe('');
    expect(result.messages).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
  });
});
