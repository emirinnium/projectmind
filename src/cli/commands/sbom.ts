import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

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
          console.log(content);
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

function generateSpdx(projectName: string, projectVersion: string, namespace: string, packages: any[], tagValue: boolean): string {
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

function generateCycloneDx(projectName: string, projectVersion: string, namespace: string, packages: any[]): string {
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
      if (!content.includes('SPDXVersion:')) errors.push('Missing SPDXVersion');
      if (!content.includes('SPDXID: SPDXRef-DOCUMENT')) errors.push('Missing SPDXID');
      if (!content.includes('DocumentName:')) errors.push('Missing DocumentName');
    } else if (format === 'cyclonedx') {
      if (!content.includes('<bom')) errors.push('Missing BOM root element');
      if (!content.includes('xmlns="http://cyclonedx.org/schema')) errors.push('Missing CycloneDX namespace');
    } else if (format === 'json') {
      const parsed = JSON.parse(content);
      if (!parsed.sbom) errors.push('Missing sbom root');
    }
  } catch (e) {
    errors.push(`Parse error: ${e}`);
  }
  
  return { valid: errors.length === 0, errors };
}

function generateUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&apos;');
}
/**
 * Sign an SBOM file with cosign when the binary is available.
 * Uses keyless OIDC flow unless COSIGN_KEY is set in the environment.
 */
function signWithCosign(filePath: string): void {
  const probe = spawnSync('cosign', ['version'], { encoding: 'utf-8', shell: true });
  if (probe.status !== 0) {
    output.warn('cosign CLI not found on PATH — signing skipped.');
    output.info('Install sigstore/cosign or run manually:');
    output.kv('  cosign sign-blob', `--key=<key> --output-signature=${filePath}.sig ${filePath}`);
    return;
  }

  const args = ['sign-blob', '--output-signature', `${filePath}.sig`, '--yes'];
  if (process.env.COSIGN_KEY) {
    args.push('--key', process.env.COSIGN_KEY);
  }
  const result = spawnSync('cosign', [...args, filePath], { encoding: 'utf-8', shell: true });
  if (result.status === 0) {
    output.success(`SBOM signed: ${filePath}.sig`);
  } else {
    output.warn(`cosign failed (exit ${result.status}): ${(result.stderr || '').slice(0, 200)}`);
  }
}
