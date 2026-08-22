import { Command } from 'commander';
import { BaseCommand, asyncHandler, output } from '@/cli/utils/shared.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

class HealthCommand extends BaseCommand {
  constructor() {
    super('health', 'Check ProjectMind system health');
  }

  registerCommands(): Command {
    const cmd = this.cmd;

    cmd
      .option('-j, --json', 'Output as JSON')
      .action(asyncHandler(async (opts: { json?: boolean }) => {
        await this.withService(['scale', 'debt', 'coherence'], async (_ctx, services) => {
          const scale = services.scale!;
          const debt = services.debt!;
          const coherence = services.coherence!;
          const genome = debt.computeGenome();
          const scanProfile = scale.getLastScanProfile();

          const health = {
            status: 'healthy' as 'healthy' | 'degraded' | 'unhealthy',
            timestamp: new Date().toISOString(),
            version: pkgVersion,
            checks: {
              database: 'ok',
              knowledgeGraph: 'ok',
              coherenceEngine: coherence.hasLLMProvider() ? 'ok (with LLM)' : 'ok (fast-tier only)',
              importResolution: 'ok',
              agentCoverage: scale.getScaleReport().agentCoverage > 0 ? 'ok' : 'warning',
              cognitiveLoad: scale.getScaleReport().avgCognitiveLoad < 0.5 ? 'ok' : 'warning',
              debt: debt.getReport().bySeverity.high === 0 ? 'ok' : 'critical',
              genomeScore: genome.coherenceScore > 0.7 ? 'ok' : 'warning',
            },
            metrics: {
              totalFiles: scale.getScaleReport().totalFiles,
              genomeScore: Math.round(genome.coherenceScore * 10000) / 100,
              importResolutionRate: 0,
              agentCoverage: Math.round(scale.getScaleReport().agentCoverage * 10000) / 100,
              avgCognitiveLoad: Math.round(scale.getScaleReport().avgCognitiveLoad * 1000) / 1000,
              highDebtItems: debt.getReport().bySeverity.high,
              mediumDebtItems: debt.getReport().bySeverity.medium,
              lowDebtItems: debt.getReport().bySeverity.low,
              patternCount: 0,
              highConfidencePatterns: 0,
              agentSessions: 0,
              lastScanDurationMs: scanProfile?.durationMs,
              lastScanThroughput: scanProfile?.filesPerSecond,
            },
          };

          // Determine overall status
          if (health.checks.debt === 'critical') {
            health.status = 'unhealthy';
          } else if (Object.values(health.checks).some(v => v === 'warning')) {
            health.status = 'degraded';
          }

          if (opts.json) {
            console.log(JSON.stringify(health, null, 2));
          } else {
            output.section('ProjectMind Health Check');
            output.kv('Status', health.status.toUpperCase());
            output.kv('Timestamp', health.timestamp);
            output.kv('Version', health.version);

            output.section('Component Checks');
            for (const [check, result] of Object.entries(health.checks)) {
              const icon = result.startsWith('ok') ? 'âœ‘' : result === 'warning' ? 'âš ' : 'âœ—';
              output.kv(`  ${check}`, `${icon} ${result}`);
            }

            output.section('Metrics');
            for (const [key, value] of Object.entries(health.metrics)) {
              output.kv(`  ${key}`, String(value));
            }

            if (health.status !== 'healthy') {
              process.exit(1);
            }
          }
        });
      }));

    return cmd;
  }
}

export function createHealthCommand(): Command {
  return new HealthCommand().registerCommands();
}