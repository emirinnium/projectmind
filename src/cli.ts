#!/usr/bin/env node
import { Command } from 'commander';
import { logger } from './utils/logger.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json - search up from current directory
function getVersion(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    try {
      const pkgPath = join(dir, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.name === '@emirhanturker/projectmind') {
        return pkg.version;
      }
    } catch {
      // Continue searching upward
    }
    dir = dirname(dir);
  }
  return '0.0.0';
}

const pkgVersion = getVersion();

// Display ASCII banner on startup
try {
  const logoPath = join(__dirname, '..', 'assets', 'cli-logo.txt');
  const logo = readFileSync(logoPath, 'utf-8');
  console.log(logo);
  console.log('');
} catch {
  // Logo file not found, skip banner
}

const commandFactories: Array<{ createCommand: () => Command }> = [];

async function loadCommands(): Promise<void> {
  const modules: Array<{ path: string; name: string }> = [
    { path: './cli/commands/init.js', name: 'createInitCommand' },
    { path: './cli/commands/scan.js', name: 'createScanCommand' },
    { path: './cli/commands/check.js', name: 'createCheckCommand' },
    { path: './cli/commands/report.js', name: 'createReportCommand' },
    { path: './cli/commands/context.js', name: 'createContextCommand' },
    { path: './cli/commands/session.js', name: 'createSessionCommands' },
    { path: './cli/commands/memory.js', name: 'createMemoryCommand' },
    { path: './cli/commands/scale.js', name: 'createScaleCommand' },
    { path: './cli/commands/debt.js', name: 'createDebtCommand' },
    { path: './cli/commands/genome.js', name: 'createGenomeCommand' },
    { path: './cli/commands/resolve.js', name: 'createResolveCommand' },
    { path: './cli/commands/mcp.js', name: 'createMcpCommand' },
    { path: './cli/commands/health.js', name: 'createHealthCommand' },
    { path: './cli/commands/debug.js', name: 'createDebugCommand' },
    { path: './cli/commands/doctor.js', name: 'createDoctorCommand' },
    { path: './cli/commands/agent.js', name: 'createAgentCommand' },
    { path: './cli/commands/search.js', name: 'createSearchCommand' },
    { path: './cli/commands/impact.js', name: 'createImpactCommand' },
    { path: './cli/commands/debt-prioritize.js', name: 'createDebtPrioritizeCommand' },
    { path: './cli/commands/audit.js', name: 'createAuditCommand' },
    { path: './cli/commands/license.js', name: 'createLicenseCommand' },
    { path: './cli/commands/graph.js', name: 'createGraphCommand' },
    { path: './cli/commands/heatmap.js', name: 'createHeatmapCommand' },
    { path: './cli/commands/ownership.js', name: 'createOwnershipCommand' },
    { path: './cli/commands/adr.js', name: 'createAdrCommand' },
    { path: './cli/commands/dedup.js', name: 'createDedupCommand' },
    { path: './cli/commands/churn.js', name: 'createChurnCommand' },
    { path: './cli/commands/api-surface.js', name: 'createApiSurfaceCommand' },
    { path: './cli/commands/layers.js', name: 'createLayersCommand' },
    { path: './cli/commands/coupling.js', name: 'createCouplingCommand' },
    { path: './cli/commands/pr-preview.js', name: 'createPrPreviewCommand' },
    { path: './cli/commands/onboard.js', name: 'createOnboardCommand' },
    { path: './cli/commands/test-quality.js', name: 'createTestQualityCommand' },
    { path: './cli/commands/deps-fresh.js', name: 'createDepsFreshCommand' },
    { path: './cli/commands/refactor-roi.js', name: 'createRefactorRoiCommand' },
    { path: './cli/commands/flags.js', name: 'createFlagsCommand' },
    { path: './cli/commands/secrets-life.js', name: 'createSecretsLifeCommand' },
    { path: './cli/commands/sbom.js', name: 'createSbomCommand' },
    { path: './cli/commands/refactor.js', name: 'createRefactorCommand' },
    { path: './cli/commands/testgen.js', name: 'createTestgenCommand' },
    { path: './cli/commands/docgen.js', name: 'createDocgenCommand' },
    { path: './cli/commands/migrate.js', name: 'createMigrateCommand' },
    { path: './cli/commands/skill-recommend.js', name: 'createSkillRecommendCommand' },
    { path: './cli/commands/context-budget.js', name: 'createContextBudgetCommand' },
    { path: './cli/commands/contract-test.js', name: 'createContractTestCommand' },
    { path: './cli/commands/trace.js', name: 'createTraceCommand' },
    { path: './cli/commands/project.js', name: 'createProjectCommand' },
    { path: './cli/commands/data-flow.js', name: 'createDataFlowCommand' },
    { path: './cli/commands/structural-search.js', name: 'createStructuralSearchCommand' },
    { path: './cli/commands/embed.js', name: 'createEmbedCommand' },
    { path: './cli/commands/taint.js', name: 'createTaintCommand' },
  ];

  for (const { path, name } of modules) {
    const mod = await import(path) as Record<string, () => Command>;
    const factory = mod[name];
    if (typeof factory !== 'function') {
      throw new Error(`Module ${path} does not export ${name}`);
    }
    commandFactories.push({ createCommand: factory });
  }
}

function registerCommands(program: Command): void {
  for (const { createCommand } of commandFactories) {
    program.addCommand(createCommand());
  }
}

const program = new Command();

program
  .name('projectmind')
  .description('Living Codebase Intelligence Layer for AI Agents')
  .version(pkgVersion);

loadCommands()
  .then(() => {
    registerCommands(program);
    program.exitOverride();

    try {
      program.parse();
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err) {
        const code = (err as { code: string }).code;
        if (code !== 'commander.help' && code !== 'commander.version') {
          logger.error(`CLI error: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      } else {
        logger.error(`CLI error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }
  })
  .catch((err: unknown) => {
    logger.error(`Failed to initialize CLI: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
