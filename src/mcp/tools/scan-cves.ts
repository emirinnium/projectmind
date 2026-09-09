import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { confineToProject } from './_shared.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
// npm is exposed as a .cmd shim on Windows; child_process.execFile does not
// resolve that shim when shell execution is disabled.
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';

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
  message?: string;
}

/**
 * npm sometimes writes warnings before/after its JSON payload (notably when
 * the audit registry is unavailable), and its rejected child-process error
 * may expose that payload on stderr instead of stdout on Windows. Extract the
 * JSON object before parsing so the MCP contract remains stable in both cases.
 */
function parseAuditJson(raw: string): NpmAuditOutput | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as NpmAuditOutput;
  } catch {
    return null;
  }
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
  warning?: string;
  rawOutput?: string;
  fixPreview?: { success: boolean; output?: unknown; rawOutput?: string; error?: string };
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
        fix: z
          .boolean()
          .default(false)
          .describe('If true, run `npm audit fix --dry-run` to preview fixes (read-only).'),
        level: z
          .enum(['info', 'low', 'moderate', 'high', 'critical'])
          .default('moderate')
          .describe('Minimum severity level to report'),
      },
    },
    async (args) => {
      try {
        const projectRoot = confineToProject(deps.projectRoot, deps.projectRoot);

        // Run `npm audit --json` confined to the project root
        let auditOutput: string;
        try {
          const result = await execFileAsync(NPM_COMMAND, ['audit', '--json'], {
            cwd: projectRoot,
            env: { ...process.env, PATH: process.env.PATH },
            // npm is a .cmd shim on Windows. The arguments are fixed literals,
            // so shell resolution is safe here and avoids spawn ENOENT/EINVAL.
            shell: process.platform === 'win32',
            timeout: 120_000,
            maxBuffer: 10 * 1024 * 1024,
          });
          auditOutput = result.stdout;
        } catch (error) {
          // npm audit returns non-zero when vulnerabilities are found; its
          // structured report may be exposed on stdout or stderr depending on
          // npm/platform and registry failure mode.
          const auditError = error as { stdout?: string; stderr?: string };
          auditOutput = [auditError.stdout, auditError.stderr].filter(Boolean).join('\n');
        }

        const parsed = parseAuditJson(auditOutput);
        if (!parsed) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: false,
                    error:
                      'Failed to parse npm audit output. Is this a Node.js project with package-lock.json/yarn.lock?',
                    rawOutput: auditOutput.substring(0, 500),
                  } satisfies ScanCvesResponse,
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // A registry outage is returned by npm as a valid JSON error object.
        // Keep the MCP call successful with an explicit warning and an empty
        // result instead of misreporting it as a malformed project/lockfile.
        if (!parsed.vulnerabilities && parsed.message) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    vulnerabilities: [],
                    summary: {
                      total: 0,
                      bySeverity: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
                    },
                    warning: `npm audit was unavailable: ${parsed.message}`,
                    rawOutput: auditOutput.substring(0, 500),
                  } satisfies ScanCvesResponse,
                  null,
                  2,
                ),
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
            // npm returns either a boolean or an object describing a forced
            // install. Both values mean a remediation path exists.
            fixAvailable = Boolean(v.fixAvailable);
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

        // Optional dry-run preview is deliberately separate from the audit
        // result. It never writes package.json/package-lock.json.
        let fixPreview: ScanCvesResponse['fixPreview'];
        if (args.fix) {
          let previewOutput = '';
          try {
            const preview = await execFileAsync(
              NPM_COMMAND,
              ['audit', 'fix', '--dry-run', '--json'],
              {
                cwd: projectRoot,
                env: { ...process.env, PATH: process.env.PATH },
                shell: process.platform === 'win32',
                timeout: 120_000,
                maxBuffer: 10 * 1024 * 1024,
              },
            );
            previewOutput = preview.stdout;
          } catch (error) {
            const previewError = error as { stdout?: string; stderr?: string };
            previewOutput = previewError.stdout ?? '';
            if (!previewOutput) {
              fixPreview = {
                success: false,
                error:
                  previewError.stderr || (error instanceof Error ? error.message : String(error)),
              };
            }
          }
          if (!fixPreview) {
            const parsedPreview = parseAuditJson(previewOutput);
            if (parsedPreview) {
              fixPreview = { success: true, output: parsedPreview };
            } else {
              fixPreview = {
                success: false,
                rawOutput: previewOutput.substring(0, 5000),
                error: 'Could not parse npm audit fix preview output.',
              };
            }
          }
        }

        // Filter by level if specified
        const levelOrder: Record<string, number> = {
          info: 0,
          low: 1,
          moderate: 2,
          high: 3,
          critical: 4,
        };
        const minLevel = levelOrder[args.level];
        const filteredVulns = vulnerabilities.filter((v) => levelOrder[v.severity] >= minLevel);

        // Compute summary
        const bySeverity: Record<string, number> = {
          info: 0,
          low: 0,
          moderate: 0,
          high: 0,
          critical: 0,
        };
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
          ...(fixPreview ? { fixPreview } : {}),
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
    },
  );
}
