#!/usr/bin/env node
import { Command } from 'commander';
import { createInitCommand } from './cli/commands/init.js';
import { createScanCommand } from './cli/commands/scan.js';
import { createCheckCommand } from './cli/commands/check.js';
import { createReportCommand } from './cli/commands/report.js';
import { createContextCommand } from './cli/commands/context.js';
import { createSessionCommands } from './cli/commands/session.js';
import { createMemoryCommand } from './cli/commands/memory.js';
import { createScaleCommand } from './cli/commands/scale.js';
import { createDebtCommand } from './cli/commands/debt.js';
import { createGenomeCommand } from './cli/commands/genome.js';
import { createResolveCommand } from './cli/commands/resolve.js';
import { createMcpCommand } from './cli/commands/mcp.js';
import { createHealthCommand } from './cli/commands/health.js';
import { createDebugCommand } from './cli/commands/debug.js';
import { createDoctorCommand } from './cli/commands/doctor.js';
import { createAgentCommand } from './cli/commands/agent.js';

const program = new Command();

program
  .name('projectmind')
  .description('Living Codebase Intelligence Layer for AI Agents')
  .version('1.0.0');

program.addCommand(createInitCommand());
program.addCommand(createScanCommand());
program.addCommand(createCheckCommand());
program.addCommand(createReportCommand());
program.addCommand(createContextCommand());
program.addCommand(createSessionCommands());
program.addCommand(createMemoryCommand());
program.addCommand(createScaleCommand());
program.addCommand(createDebtCommand());
program.addCommand(createGenomeCommand());
program.addCommand(createResolveCommand());
program.addCommand(createMcpCommand());
program.addCommand(createHealthCommand());
program.addCommand(createDebugCommand());
program.addCommand(createDoctorCommand());
program.addCommand(createAgentCommand());

// Ensure process exits after command completes
program.exitOverride();

try {
  program.parse();
} catch (err: unknown) {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: string }).code;
    if (code !== 'commander.help' && code !== 'commander.version') {
      console.error(err);
      process.exit(1);
    }
  } else {
    console.error(err);
    process.exit(1);
  }
}