import { Command } from 'commander';
import { withServices, asyncHandler, output } from '../utils/shared.js';

export function createHealthCommand(): Command {
  return new Command('health')
    .description('Check ProjectMind system health')
    .option('-j, --json', 'Output as JSON')
    .action(asyncHandler(async (opts: { json?: boolean }) => {
      await withServices(['scale', 'debt', 'coherence'], async (_ctx, services) => {
        const scaleReport = services.scale.getScaleReport();
        const debtReport = services.debt.getReport();
        const genome = services.debt.computeGenome();
        const scanProfile = services.scale.getLastScanProfile();

        const health = {
          status: 'healthy' as 'healthy' | 'degraded' | 'unhealthy',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
          checks: {
            database: 'ok',
            knowledgeGraph: 'ok',
            coherenceEngine: services.coherence.hasLLMProvider() ? 'ok (with LLM)' : 'ok (fast-tier only)',
            importResolution: genome.breakdown.importResolutionRate > 0.5 ? 'ok' : 'warning',
            agentCoverage: scaleReport.agentCoverage > 0 ? 'ok' : 'warning',
            cognitiveLoad: scaleReport.avgCognitiveLoad < 0.5 ? 'ok' : 'warning',
            debt: debtReport.bySeverity.high === 0 ? 'ok' : 'critical',
            genomeScore: genome.coherenceScore > 0.7 ? 'ok' : 'warning',
          },
          metrics: {
            totalFiles: scaleReport.totalFiles,
            genomeScore: Math.round(genome.coherenceScore * 10000) / 100,
            importResolutionRate: Math.round(genome.breakdown.importResolutionRate * 10000) / 100,
            agentCoverage: Math.round(scaleReport.agentCoverage * 10000) / 100,
            avgCognitiveLoad: Math.round(scaleReport.avgCognitiveLoad * 1000) / 1000,
            highDebtItems: debtReport.bySeverity.high,
            mediumDebtItems: debtReport.bySeverity.medium,
            lowDebtItems: debtReport.bySeverity.low,
            patternCount: genome.breakdown.patternCount,
            highConfidencePatterns: genome.breakdown.highConfidencePatterns,
            agentSessions: genome.breakdown.agentSessions,
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
            const icon = result.startsWith('ok') ? '✓' : result === 'warning' ? '⚠' : '✗';
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
}