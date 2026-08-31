import { Command } from 'commander';
import { BaseCommand, asyncHandler, output } from '@/cli/utils/shared.js';
import { resolvePackageVersion, currentModuleDir } from '@/cli/utils/version.js';

const pkgVersion = resolvePackageVersion(currentModuleDir(import.meta.url));

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

          // Real signals from the knowledge graph (replaces hardcoded zeros).
          const { getStatement, getDatabase } = await import('../../storage/database.js');
          const q = <T>(sql: string): T => getStatement(sql).get() as T;
          const imp = q<{ total: number; resolved: number }>(
            "SELECT COUNT(*) AS total, SUM(CASE WHEN resolved = 1 THEN 1 ELSE 0 END) AS resolved FROM imports"
          ) ?? { total: 0, resolved: 0 };
          const importResolutionRate = imp.total > 0 ? imp.resolved / imp.total : 0;
          const patternStats = q<{ n: number; hi: number }>(
            'SELECT COUNT(*) AS n, SUM(CASE WHEN confidence >= 0.8 THEN 1 ELSE 0 END) AS hi FROM patterns'
          ) ?? { n: 0, hi: 0 };
          const sessionCount = (getDatabase().prepare('SELECT COUNT(*) AS n FROM agent_sessions').get() as { n: number }).n;

          const health = {
            status: 'healthy' as 'healthy' | 'degraded' | 'unhealthy',
            timestamp: new Date().toISOString(),
            version: pkgVersion,
            checks: {
              database: 'ok',
              knowledgeGraph: 'ok',
              coherenceEngine: coherence.hasLLMProvider() ? 'ok (with LLM)' : 'ok (fast-tier only)',
              importResolution: importResolutionRate >= 0.8 ? 'ok' : `warning (${Math.round(importResolutionRate*100)}% resolved)`,
              agentCoverage: scale.getScaleReport().agentCoverage > 0 ? 'ok' : 'warning',
              cognitiveLoad: scale.getScaleReport().avgCognitiveLoad < 0.5 ? 'ok' : 'warning',
              debt: debt.getReport().bySeverity.high === 0 ? 'ok' : 'critical',
              genomeScore: genome.coherenceScore > 0.7 ? 'ok' : 'warning',
            },
            metrics: {
              totalFiles: scale.getScaleReport().totalFiles,
              genomeScore: Math.round(genome.coherenceScore * 10000) / 100,
              importResolutionRate: Math.round(importResolutionRate * 10000) / 100,
              agentCoverage: Math.round(scale.getScaleReport().agentCoverage * 10000) / 100,
              avgCognitiveLoad: Math.round(scale.getScaleReport().avgCognitiveLoad * 1000) / 1000,
              highDebtItems: debt.getReport().bySeverity.high,
              mediumDebtItems: debt.getReport().bySeverity.medium,
              lowDebtItems: debt.getReport().bySeverity.low,
              patternCount: patternStats.n,
              highConfidencePatterns: patternStats.hi,
              agentSessions: sessionCount,
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
            // Output icons as escaped unicode to survive any source-file
            // encoding round-trip (previously stored as broken UTF-8).
            const icon = result.startsWith('ok') ? '\u2713' : result === 'warning' ? '\u26A0' : '\u2717';
            output.kv(`  ${check}`, `${icon} ${result}`);
            }

            output.section('Metrics');
            for (const [key, value] of Object.entries(health.metrics)) {
              output.kv(`  ${key}`, String(value));
            }

            if (health.status !== 'healthy') {
              throw new Error("Health check failed");
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