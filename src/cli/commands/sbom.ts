import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type SbomPackage,
  generateSpdx,
  generateCycloneDx,
  validateSbom,
  generateUuid,
  signWithCosign,
} from './sbom-engine.js';

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
    .action(
      asyncHandler(
        async (opts: {
          format: string;
          output: string;
          includeDev: string;
          includePeer: string;
          includeOptional: string;
          projectName: string;
          projectVersion: string;
          namespace: string;
          sign: boolean;
          validate: boolean;
        }) => {
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
                process.exitCode = 1;
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
            const namespace =
              opts.namespace ||
              `https://github.com/emirinnium/${projectName}/sbom/${projectVersion}`;

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
                content = generateSpdx(
                  projectName,
                  projectVersion,
                  namespace,
                  packages,
                  opts.format === 'spdx-tag',
                );
                break;
              case 'cyclonedx':
                content = generateCycloneDx(projectName, projectVersion, namespace, packages);
                break;
              case 'json':
                content = JSON.stringify(
                  {
                    sbom: {
                      specVersion: '1.5',
                      serialNumber: `urn:uuid:${generateUuid()}`,
                      name: projectName,
                      version: projectVersion,
                      metadata: { timestamp: new Date().toISOString() },
                      packages,
                    },
                  },
                  null,
                  2,
                );
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

            output.success(
              `SBOM generated: ${packages.length} packages in ${opts.format.toUpperCase()} format`,
            );
          });
        },
      ),
    );

  return sbomCmd;
}
