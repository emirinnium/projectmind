import { Command } from 'commander';
import { BaseCommand, asyncHandler, output } from '@/cli/utils/shared.js';
import { resolvePackageVersion, currentModuleDir } from '@/cli/utils/version.js';
import { getDefaultAliasResolver } from '@/parser/alias-resolver.js';

const pkgVersion = resolvePackageVersion(currentModuleDir(import.meta.url));

class HealthCommand extends BaseCommand {
  constructor() {
    super('health', 'Check ProjectMind system health');
  }

  registerCommands(): Command {
    const cmd = this.cmd;

    cmd.option('-j, --json', 'Output as JSON').action(
      asyncHandler(async (opts: { json?: boolean }) => {
        await this.withService(['scale', 'debt', 'coherence'], async (ctx, services) => {
          const scale = services.scale!;
          const debt = services.debt!;
          const coherence = services.coherence!;
          const genome = debt.computeGenome();
          const scanProfile = scale.getLastScanProfile();
          const scaleReport = scale.getScaleReport();
          const debtReport = debt.getReport();

          // Count only project-local edges for resolution health. External
          // packages are expected to remain outside the local knowledge graph.
          const { getDatabase } = await import('../../storage/database.js');
          const database = getDatabase();
          const projectId = ctx.kg.getCurrentProjectId();
          const importRows = database
            .prepare(
              'SELECT i.source, i.resolved FROM imports i JOIN files f ON f.id = i.file_id WHERE f.project_id = ?',
            )
            .all(ctx.kg.getCurrentProjectId()) as Array<{ source: string; resolved: number }>;
          const aliasResolver = getDefaultAliasResolver();
          const localImports = importRows.filter((row) =>
            aliasResolver.isProjectLocalSource(row.source),
          );
          const resolvedLocalImports = localImports.filter((row) => row.resolved === 1).length;
          const importResolutionRate =
            localImports.length > 0 ? resolvedLocalImports / localImports.length : 1;
          const externalImportCount = importRows.length - localImports.length;
          const patternStats = (database
            .prepare(
              'SELECT COUNT(*) AS n, SUM(CASE WHEN confidence >= 0.8 THEN 1 ELSE 0 END) AS hi FROM patterns WHERE project_id = ?',
            )
            .get(projectId) as { n: number; hi: number } | undefined) ?? { n: 0, hi: 0 };
          const sessionCount = (
            database
              .prepare('SELECT COUNT(*) AS n FROM agent_sessions WHERE project_id = ?')
              .get(projectId) as { n: number }
          ).n;

          const health = {
            status: 'healthy' as 'healthy' | 'degraded' | 'unhealthy',
            timestamp: new Date().toISOString(),
            version: pkgVersion,
            checks: {
              database: 'ok',
              knowledgeGraph: 'ok',
              coherenceEngine: coherence.hasLLMProvider() ? 'ok (with LLM)' : 'ok (fast-tier only)',
              importResolution:
                importResolutionRate >= 0.8
                  ? 'ok'
                  : `warning (${Math.round(importResolutionRate * 100)}% resolved)`,
              agentCoverage: scaleReport.agentCoverage > 0 ? 'ok' : 'warning',
              cognitiveLoad: scaleReport.avgCognitiveLoad < 0.5 ? 'ok' : 'warning',
              debt: debtReport.bySeverity.high === 0 ? 'ok' : 'critical',
              genomeScore: genome.coherenceScore > 0.7 ? 'ok' : 'warning',
            },
            metrics: {
              totalFiles: scaleReport.totalFiles,
              genomeScore: Math.round(genome.coherenceScore * 10000) / 100,
              importResolutionRate: Math.round(importResolutionRate * 10000) / 100,
              localImportCount: localImports.length,
              externalImportCount,
              agentCoverage: Math.round(scaleReport.agentCoverage * 10000) / 100,
              avgCognitiveLoad: Math.round(scaleReport.avgCognitiveLoad * 1000) / 1000,
              highDebtItems: debtReport.bySeverity.high,
              mediumDebtItems: debtReport.bySeverity.medium,
              lowDebtItems: debtReport.bySeverity.low,
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
          } else if (Object.values(health.checks).some((v) => v === 'warning')) {
            health.status = 'degraded';
          }

          if (opts.json) {
            output.json(health);
          } else {
            output.section('ProjectMind Health Check');
            output.kv('Status', health.status.toUpperCase());
            output.kv('Timestamp', health.timestamp);
            output.kv('Version', health.version);

            output.section('Component Checks');
            for (const [check, result] of Object.entries(health.checks)) {
              // Output icons as escaped unicode to survive any source-file
              // encoding round-trip (previously stored as broken UTF-8).
              const icon = result.startsWith('ok')
                ? '\u2713'
                : result === 'warning'
                  ? '\u26A0'
                  : '\u2717';
              output.kv(`  ${check}`, `${icon} ${result}`);
            }

            output.section('Metrics');
            for (const [key, value] of Object.entries(health.metrics)) {
              output.kv(`  ${key}`, String(value));
            }

            if (health.status !== 'healthy') {
              throw new Error('Health check failed');
            }
          }
        });
      }),
    );

    return cmd;
  }
}

export function createHealthCommand(): Command {
  return new HealthCommand().registerCommands();
}
