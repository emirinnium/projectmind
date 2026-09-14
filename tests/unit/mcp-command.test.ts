import { describe, expect, it } from 'vitest';
import { createMcpCommand } from '@/cli/commands/mcp.js';

describe('mcp CLI command', () => {
  it('accepts singular schema as an alias for the finite schema export command', () => {
    const command = createMcpCommand();
    const schemas = command.commands.find((child) => child.name() === 'schemas');

    expect(schemas).toBeDefined();
    expect(schemas?.aliases()).toContain('schema');
  });
});
