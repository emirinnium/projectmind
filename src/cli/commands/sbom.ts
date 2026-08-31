import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

interface SbomPackage {
  name: string;
  version: string;
  license?: string;
  licenseId?: string;
  licenseName?: string;
  copyrightText?: string;
  downloadLocation?: string;
  supplier?: string;
  description?: string;
  homepage?: string;
  packageUrl?: string;
  verified?: boolean;
  dependencies?: string[];
}

export function createSbomCommand(): Command {
  const sbomCmd = new Command('sbom')
    .description('Generate Software Bill of Materials (SPDX/CycloneDX)')
    .option('--format <fmt>', 'Output format: spdx|cyclonedx|json|spdx-tag', 'spdx')
    .option('-o, --output <file>', 'Output file path')
    .option('--include-dev', 'Include devDependencies', 'true')
    .option('--include-peer', 'Include peerDependencies', 'true')
    .option('--include-optional', 'Include optionalDependencies', 'true')
    .option('--project-name <name>', 'Project name for SBOM')
    .option('--project-version <ver>', 'Project version')
    .option('--namespace <uri>', 'Document namespace URI')
    .option('--sign', 'Sign SBOM (requires cosign)')
    .option('--validate', 'Validate existing SBOM file')
    .action(asyncHandler(async (opts: { format: string; output: string; includeDev: string; includePeer: string; includeOptional: string; projectName: string; projectVersion: string; namespace: string; sign: boolean; validate: boolean }) => {
      await withService(['scale'], async (_ctx, services) => {
        services.scale!;
        const { loadConfig } = await import('../../utils/config.js');
        const config = loadConfig();
        
        output.section('SBOM Generator');
        
        if (opts.validate) {
          if (!opts.output || !existsSync(opts.output)) {
            output.error('Specify SBOM file to validate with -o');
            return;
          }
          const content = readFileSync(opts.output, 'utf-8');
          const result = validateSbom(content, opts.format);
          if (result.valid) {
            output.success('SBOM is valid');
          } else {
            output.error(`SBOM validation failed: ${result.errors.join(', ')}`);
            process.exit(1);
          }
          return;
        }
        
        const pkgPath = join(config.projectRoot, 'package.json');
        if (!existsSync(pkgPath)) {
          output.warn('No package.json found');
          return;
        }
        
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        const projectName = opts.projectName || pkg.name || 'projectmind';
        const projectVersion = opts.projectVersion || pkg.version || '0.0.0';
        const namespace = opts.namespace || `https://github.com/emirinnium/${projectName}/sbom/${projectVersion}`;
        
        const deps = {
          ...(opts.includeDev === 'true' ? pkg.devDependencies : {}),
          ...(opts.includePeer === 'true' ? pkg.peerDependencies : {}),
          ...(opts.includeOptional === 'true' ? pkg.optionalDependencies : {}),
          ...pkg.dependencies,
        };
        
        const packages: SbomPackage[] = Object.entries(deps).map(([name, version]) => ({
          name,
          version: (version as string).replace(/^[\^~]/, ''),
          license: pkg.license,
          downloadLocation: `https://www.npmjs.com/package/${name}`,
        }));
        
        output.section(`SBOM Generation: ${projectName}@${projectVersion}`);
        output.kv('Format', opts.format.toUpperCase());
        output.kv('Packages', packages.length);
        output.kv('Namespace', namespace);
        
        let content = '';
        
        switch (opts.format) {
          case 'spdx':
          case 'spdx-tag':
            content = generateSpdx(projectName, projectVersion, namespace, packages, opts.format === 'spdx-tag');
            break;
          case 'cyclonedx':
            content = generateCycloneDx(projectName, projectVersion, namespace, packages);
            break;
          case 'json':
            content = JSON.stringify({ 
              sbom: { 
                specVersion: '1.5',
                serialNumber: `urn:uuid:${generateUuid()}`,
                name: projectName,
                version: projectVersion,
                metadata: { timestamp: new Date().toISOString() },
                packages 
              } 
            }, null, 2);
            break;
        }
        
        if (opts.output) {
          writeFileSync(opts.output, content);
          output.success(`SBOM written to ${opts.output}`);
        } else {
          output.info(content);
        }
        
        if (opts.sign) {
          if (!opts.output) {
            output.warn('Signing requires --output <file> (cosign signs a file on disk)');
          } else {
            signWithCosign(opts.output);
          }
        }
        
        output.success(`SBOM generated: ${packages.length} packages in ${opts.format.toUpperCase()} format`);
      });
    }));
  
  return sbomCmd;
}

function generateSpdx(projectName: string, projectVersion: string, namespace: string, packages: SbomPackage[], tagValue: boolean): string {
  const lines = [
    'SPDXVersion: SPDX-2.3',
    'DataLicense: CC0-1.0',
    `SPDXID: SPDXRef-DOCUMENT`,
    `DocumentName: ${projectName}`,
    `DocumentNamespace: ${namespace}`,
    'Creator: Tool: ProjectMind-1.0.0',
    `Created: ${new Date().toISOString()}`,
    '',
    '## Package Information',
    `PackageName: ${projectName}`,
    `SPDXID: SPDXRef-Package`,
    `PackageDownloadLocation: NOASSERTION`,
    `FilesAnalyzed: false`,
    `PackageLicenseConcluded: NOASSERTION`,
    `PackageLicenseDeclared: NOASSERTION`,
    `PackageCopyrightText: NOASSERTION`,
    '',
  ];
  
  for (const pkg of packages) {
    lines.push('', '## Dependency Package');
    lines.push(`PackageName: ${pkg.name}`);
    lines.push(`SPDXID: SPDXRef-Package-${pkg.name.replace(/[^a-zA-Z0-9]/g, '-')}`);
    lines.push(`PackageVersion: ${pkg.version}`);
    lines.push(`PackageLicenseConcluded: ${pkg.license || 'NOASSERTION'}`);
    lines.push(`PackageLicenseDeclared: ${pkg.license || 'NOASSERTION'}`);
    lines.push(`PackageDownloadLocation: ${pkg.downloadLocation || 'NOASSERTION'}`);
    lines.push(`PackageCopyrightText: NOASSERTION`);
  }
  
  if (tagValue) {
    return lines.join('\n');
  }
  return lines.join('\n');
}

function generateCycloneDx(projectName: string, projectVersion: string, namespace: string, packages: SbomPackage[]): string {
  const packagesXml = packages.map(pkg => `
    <component type="library">
      <name>${escapeXml(pkg.name)}</name>
      <version>${escapeXml(pkg.version)}</version>
      <purl>pkg:npm/${escapeXml(pkg.name)}@${escapeXml(pkg.version)}</purl>
    </component>`).join('\n');
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<bom xmlns="http://cyclonedx.org/schema/bom/1.5" version="1" serialNumber="urn:uuid:${generateUuid()}">
  <metadata>
    <timestamp>${new Date().toISOString()}</timestamp>
    <tools>
      <tool>
        <name>ProjectMind</name>
        <version>1.0.0</version>
      </tool>
    </tools>
    <component type="application">
      <name>${escapeXml(projectName)}</name>
      <version>${escapeXml(projectVersion)}</version>
    </component>
  </metadata>
  <components>
${packagesXml}
  </components>
</bom>`;
}

function validateSbom(content: string, format: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  try {
    if (format === 'spdx' || format === 'spdx-tag') {
      // SPDX 2.x tag-value structural checks.
      const tags = new Map<string, string[]>();
      for (const line of content.split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx <= 0 || line.startsWith('#')) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (!key) continue;
        (tags.get(key) ?? tags.set(key, []).get(key)!).push(value);
      }
      const first = (k: string): string | undefined => tags.get(k)?.[0];

      const version = first('SPDXVersion');
      if (!version) errors.push('Missing SPDXVersion');
      else if (!/^SPDX-2\.[0-3]$/.test(version)) errors.push(`Unsupported SPDXVersion "${version}" (expected SPDX-2.2/2.3)`);

      if (first('DataLicense') !== 'CC0-1.0') errors.push('Missing/invalid DataLicense (must be CC0-1.0)');
      if (first('SPDXID') !== 'SPDXRef-DOCUMENT') errors.push('Missing document SPDXID: SPDXRef-DOCUMENT');

      if (!first('DocumentName')) errors.push('Missing DocumentName');
      const ns = first('DocumentNamespace');
      if (!ns) errors.push('Missing DocumentNamespace');
      else if (!/^https?:\/\//.test(ns)) errors.push('DocumentNamespace must be an absolute URI');

      if (!(tags.get('Creator')?.length)) errors.push('Missing Creator');
      const created = first('Created');
      if (!created) errors.push('Missing Created');
      else if (Number.isNaN(Date.parse(created))) errors.push('Created is not a valid ISO timestamp');

      if (!(tags.get('PackageName')?.length)) errors.push('No PackageName entries found');
    } else if (format === 'cyclonedx') {
      // CycloneDX XML structural checks.
      if (!/<\?xml\s+version=/.test(content)) errors.push('Missing XML declaration');
      const bomMatch = content.match(/<bom\b[^>]*>/);
      if (!bomMatch) {
        errors.push('Missing <bom> root element');
      } else {
        const bomTag = bomMatch[0];
        if (!bomTag.includes('xmlns="http://cyclonedx.org/schema/bom/')) errors.push('Missing CycloneDX namespace');
        if (!/serialNumber="urn:uuid:[0-9a-fA-F-]{36}"/.test(bomTag)) errors.push('Missing/invalid serialNumber (urn:uuid:...)');
        if (!/version="\d+"/.test(bomTag)) errors.push('Missing bom version attribute');
      }
      if (!content.includes('<metadata>')) errors.push('Missing metadata section');
      if (!content.includes('<timestamp>')) errors.push('Missing metadata timestamp');
      if (!content.includes('<components>')) errors.push('Missing components section');

      // Every component must declare name and version.
      for (const comp of content.matchAll(/<component\b[^>]*>([\s\S]*?)<\/component>/g)) {
        const body = comp[1];
        if (!/<name>[\s\S]+?<\/name>/.test(body)) errors.push('component without <name>');
        if (!/<version>[\s\S]+?<\/version>/.test(body)) errors.push('component without <version>');
      }
    } else if (format === 'json') {
      interface SbomJson { bomFormat?: string; specVersion?: string; version?: number; components?: Array<Record<string, string | number>>; sbom?: { specVersion?: string; serialNumber?: string; packages?: Array<{ name?: string; version?: string }> } }
      const parsed = JSON.parse(content) as SbomJson;

      if (parsed.bomFormat === 'CycloneDX') {
        // Accept standard CycloneDX JSON as well as our own shape.
        if (typeof parsed.specVersion !== 'string') errors.push('Missing specVersion');
        if (typeof parsed.version !== 'number') errors.push('Missing numeric version');
        if (!Array.isArray(parsed.components)) errors.push('Missing components array');
      } else {
        const sbom = parsed.sbom as
          | { specVersion?: string; serialNumber?: string; packages?: Array<{ name?: string; version?: string }> }
          | undefined;
        if (!sbom) {
          errors.push('Missing sbom root');
        } else {
          if (!sbom.specVersion) errors.push('Missing sbom.specVersion');
          if (!sbom.serialNumber || !/^urn:uuid:[0-9a-fA-F-]{36}$/.test(sbom.serialNumber)) {
            errors.push('Missing/invalid sbom.serialNumber (urn:uuid:...)');
          }
          if (!Array.isArray(sbom.packages)) {
            errors.push('Missing sbom.packages array');
          } else {
            sbom.packages.forEach((p, i) => {
              if (!p?.name) errors.push(`packages[${i}] without name`);
              if (!p?.version) errors.push(`packages[${i}] without version`);
            });
          }
        }
      }
    }
  } catch (e) {
    errors.push(`Parse error: ${e}`);
  }

  return { valid: errors.length === 0, errors };
}

/** RFC4122-compliant v4 UUID via node:crypto. */
function generateUuid(): string {
  return randomUUID();
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
/**
 * Sign an SBOM file with cosign when the binary is available.
 * Uses keyless OIDC flow unless COSIGN_KEY is set in the environment.
 */
function signWithCosign(filePath: string): void {
  // SECURITY: execFileSync with an argument array and NO shell. filePath comes
  // from the CLI --output option and COSIGN_KEY from the environment; with
  // shell:true either could inject shell commands (self-injection class).
  // With shell:false they are discrete argv entries never parsed by a shell.
  try {
    execFileSync('cosign', ['version'], { encoding: 'utf-8' });
  } catch {
    output.warn('cosign CLI not found on PATH — signing skipped.');
    output.info('Install sigstore/cosign or run manually:');
    output.kv('  cosign sign-blob', `--key=<key> --output-signature=${filePath}.sig ${filePath}`);
    return;
  }

  const args = ['sign-blob', '--output-signature', `${filePath}.sig`, '--yes'];
  if (process.env.COSIGN_KEY) {
    args.push('--key', process.env.COSIGN_KEY);
  }
  args.push(filePath);
  try {
    execFileSync('cosign', args, { encoding: 'utf-8' });
    output.success(`SBOM signed: ${filePath}.sig`);
  } catch (err) {
    const e = err as { status?: number | null; stderr?: string | Buffer };
    const stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf-8') ?? '');
    output.warn(`cosign failed (exit ${e.status ?? 'unknown'}): ${stderr.slice(0, 200)}`);
  }
}
