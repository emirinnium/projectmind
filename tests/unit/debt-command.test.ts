import { describe, expect, it } from 'vitest';
import { createDebtCommand } from '@/cli/commands/debt.js';

describe('debt CLI command', () => {
  it('exposes a machine-readable report option on the parent command', () => {
    const command = createDebtCommand();
    const jsonOption = command.options.find((option) => option.long === '--json');

    expect(jsonOption).toBeDefined();
    expect(command.commands.map((child) => child.name())).toEqual([
      'clear',
      'detect',
      'clear-patterns',
    ]);
  });
});
