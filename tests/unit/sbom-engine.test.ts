import { describe, expect, it } from 'vitest';
import {
  generateCycloneDx,
  generateSpdx,
  validateSbom,
  type SbomPackage,
} from '../../src/cli/commands/sbom-engine.js';
import { currentModuleDir, resolvePackageVersion } from '../../src/utils/version.js';

const packageVersion = resolvePackageVersion(currentModuleDir(import.meta.url));
const packages: SbomPackage[] = [
  {
    name: 'example-dependency',
    version: '1.2.3',
    license: 'MIT',
  },
];

describe('SBOM engine', () => {
  it('generates a valid SPDX tag-value document with the package version', () => {
    const content = generateSpdx('demo-project', '2.4.0', 'https://example.test/sbom', packages);

    expect(content).toContain(`Creator: Tool: ProjectMind-${packageVersion}`);
    expect(content).toContain('PackageVersion: 2.4.0');
    expect(validateSbom(content, 'spdx-tag')).toEqual({ valid: true, errors: [] });
  });

  it('generates a valid CycloneDX document with escaped package metadata', () => {
    const content = generateCycloneDx('demo-project', '2.4.0', packages);

    expect(content).toContain(`<version>${packageVersion}</version>`);
    expect(content).toContain('<name>example-dependency</name>');
    expect(validateSbom(content, 'cyclonedx')).toEqual({ valid: true, errors: [] });
  });

  it('reports structural errors instead of accepting malformed SBOM content', () => {
    const result = validateSbom('SPDXVersion: SPDX-2.3\nDataLicense: NOASSERTION', 'spdx');

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing document SPDXID: SPDXRef-DOCUMENT');
  });
});
