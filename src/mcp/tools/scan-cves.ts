import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { confineToProject } from './_shared.js';
import { registerCheckCoherenceTool } from './coherence.js';
import { spawnSync } from 'child_process';

/** npm audit --json output structure */
interface NpmAuditVulnerability {
  id?: string;
  title?: string;
  severity?: string;
  advisoryUrl?: string;
  url?: string;
  fixAvailable?: boolean;
  resolutions?: unknown;
  name?: string;
  version?: string;
  dependencies?: {
    name?: string;
    version?: string;
  };
}

interface NpmAuditOutput {
  vulnerabilities?: Record<string, NpmAuditVulnerability>;
  metadata?: unknown;
}

export interface ScanVulnResult {
  name: string;
  severity: string;
  version: string;
  fixAvailable: boolean;
  suggestedFix: string;
  details: string;
}

export interface ScanCvesResponse {
  success: boolean;
  vulnerabilities?: ScanVulnResult[];
  summary?: {
    total: number;
    bySeverity: Record<string, number>;
  };
  error?: string;
  rawOutput?: string;
}

export function registerScanCvesTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'scan_cves',
    {
      title: 'Scan CVEs',
      description:
        'Scan project dependencies for known vulnerabilities using `npm audit --json`.\n' +
        'Returns structured vulnerability details, severity levels, and suggested fixes.\n' +
        'Input schema accepts `fix` (run `npm audit fix` preview) and `level` (minimum severity to report).',
      inputSchema: {
        fix: z.boolean().default(false).describe('If true, run `npm audit fix --dry-run` to preview fixes (read-only).'),
        level: z
          .enum(['info', 'low', 'moderate', 'high', 'critical'])
          .default('moderate')
          .describe('Minimum severity level to report'),
      },
    },
    async (args, { _meta }) => {
      try {
        const projectRoot = confineToProject(deps.projectRoot, deps.projectRoot);

        // Run `npm audit --json` confined to the project root
        const npmAudit = spawnSync('npm', ['audit', '--json'], {
          cwd: projectRoot,
          env: { ...process.env, PATH: process.env.PATH },
          timeout: 120_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let auditOutput: string;
        if (npmAudit.status === 0) {
          auditOutput = npmAudit.stdout.toString('utf8');
        } else {
          // npm audit may return non-zero when vulnerabilities are found;
          // still try to parse partial output
          auditOutput = npmAudit.stdout.toString('utf8');
        }

        let parsed: NpmAuditOutput;
        try {
          parsed = JSON.parse(auditOutput) as NpmAuditOutput;
        } catch {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: 'Failed to parse npm audit output. Is this a Node.js project with package-lock.json/yarn.lock?',
                  rawOutput: auditOutput.substring(0, 500),
                } satisfies ScanCvesResponse, null, 2),
              },
            ],
          };
        }

        const vulnObj = parsed.vulnerabilities ?? {};
        const vulnEntries = Object.values(vulnObj);

        // Map npm audit output to structured format
        const vulnerabilities: ScanVulnResult[] = vulnEntries.map((v) => {
          const severity = v.severity || 'low';
          const pkg = v.dependencies ?? v;
          const name = pkg.name || 'unknown';
          const version = pkg.version || 'unknown';

          // Determine if a fix is available and get suggested fix
          let fixAvailable = false;
          let suggestedFix = '';

          // Check for fix info in the advisory
          if (v.advisoryUrl) {
            suggestedFix = `Update ${name} to a version that fixes this vulnerability. See ${v.advisoryUrl}`;
          } else if (v.url) {
            suggestedFix = `Update ${name} to a version that fixes this vulnerability. See ${v.url}`;
          } else {
            suggestedFix = `Update ${name} to remove this vulnerability`;
          }

          // Check if a fix is available based on npm audit output
          if (v.fixAvailable !== undefined) {
            fixAvailable = v.fixAvailable;
          } else if (v.resolutions) {
            fixAvailable = true;
            suggestedFix = `Run 'npm audit fix' to apply automatic fixes`;
          }

          return {
            name,
            severity,
            version,
            fixAvailable,
            suggestedFix,
            details: v.title || v.id || 'No advisory title available',
          };
        });

        // Filter by level if specified
        const levelOrder: Record<string, number> = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
        const minLevel = levelOrder[args.level];
        const filteredVulns = vulnerabilities.filter((v) => levelOrder[v.severity] >= minLevel);

        // Compute summary
        const bySeverity: Record<string, number> = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
        filteredVulns.forEach((v) => {
          bySeverity[v.severity] = (bySeverity[v.severity] || 0) + 1;
        });

        const response: ScanCvesResponse = {
          success: true,
          vulnerabilities: filteredVulns,
          summary: {
            total: filteredVulns.length,
            bySeverity,
          },
        };
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorResponse: ScanCvesResponse = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(errorResponse, null, 2),
            },
          ],
        };
      }
    }
  );
}