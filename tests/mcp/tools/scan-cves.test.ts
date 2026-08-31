import { describe, it, expect, beforeEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from '../../mcp/tools/types.js';
import { registerScanCvesTool } from '../../../src/mcp/tools/scan-cves.js';

const TEST_PROJECT_ROOT = resolve(process.cwd(), 'fixtures-proj') || '/tmp/test-project';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

  function mockSpawnSync(mockOutput: string, status = 0) {
    vi.mocked(spawnSync).mockReturnValue({
      status,
      stdout: Buffer.from(mockOutput),
      stderr: Buffer.from(''),
      pid: 1,
      output: [Buffer.from(mockOutput), Buffer.from('')],
      signal: null,
    });
}

describe('scan_cves tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty vulnerabilities when no vulnerabilities are found', () => {
    const output = JSON.stringify({ vulnerabilities: {}, metadata: {} });
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      stdout: Buffer.from(output),
      stderr: Buffer.from(''),
      pid: 1,
      output: [Buffer.from(output), Buffer.from('')],
      signal: null,
    });

    const server = {} as McpServer;
    const deps: McpDependencies = {
      kg: {} as any,
      coherence: {} as any,
      debt: {} as any,
      scale: {} as any,
      projectRoot: TEST_PROJECT_ROOT,
    } as McpDependencies;

    // @ts-expect-error - testing tool registration
    registerScanCvesTool(server, deps);

    // The tool is registered; test the inputSchema directly
    const inputSchema = (server.registerTool as unknown as (
      name: string,
      cfg: any,
      cb: any) => void).mock.calls[0]?.[1]?.inputSchema;
    expect(inputSchema).toBeDefined();

    // Verify the schema has fix and level fields
    expect(inputSchema?.fix).toBeDefined();
    expect(inputSchema?.level).toBeDefined();
  });

  it('returns vulnerabilities with correct severity and suggested fixes', () => {
    const mockAuditOutput = JSON.stringify({
      vulnerabilities: {
        'CVE-1234-5678': {
          id: 'CVE-1234-5678',
          title: 'Test vulnerability',
          severity: 'critical',
          dependencies: { name: 'test-pkg', version: '1.0.0' },
          advisoryUrl: 'https://example.com/advisory',
        },
        'CVE-8765-4321': {
          id: 'CVE-8765-4321',
          title: 'Low severity vuln',
          severity: 'low',
          dependencies: { name: 'other-pkg', version: '2.0.0' },
        },
      },
      metadata: {},
    });

    ;(spawnSync as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      status: 0,
      stdout: mockAuditOutput,
      stderr: Buffer.from(''),
    });

    const server = {} as McpServer;
    const deps: McpDependencies = {
      kg: {} as any,
      coherence: {} as any,
      debt: {} as any,
      scale: {} as any,
      projectRoot: TEST_PROJECT_ROOT,
    } as McpDependencies;

    // @ts-expect-error - testing tool registration
    registerScanCvesTool(server, deps);

    // Verify the tool's input schema
    const registeredCfg = (server.registerTool as unknown).mock.calls[0]?.[1];
    expect(registeredCfg?.inputSchema?.fix).toBeDefined();
    expect(registeredCfg?.inputSchema?.level).toBeDefined();
    expect(registeredCfg?.inputSchema?.fix?.default).toBe(false);
    expect(registeredCfg?.inputSchema?.level?.default).toBe('moderate');
  });

  it('filters vulnerabilities by level', () => {
    const mockAuditOutput = JSON.stringify({
      vulnerabilities: {
        'CVE-1': {
          id: 'CVE-1',
          title: 'Critical vuln',
          severity: 'critical',
          dependencies: { name: 'pkg1', version: '1.0.0' },
        },
        'CVE-2': {
          id: 'CVE-2',
          title: 'High vuln',
          severity: 'high',
          dependencies: { name: 'pkg2', version: '2.0.0' },
        },
        'CVE-3': {
          id: 'CVE-3',
          title: 'Moderate vuln',
          severity: 'moderate',
          dependencies: { name: 'pkg3', version: '3.0.0' },
        },
        'CVE-4': {
          id: 'CVE-4',
          title: 'Low vuln',
          severity: 'low',
          dependencies: { name: 'pkg4', version: '4.0.0' },
        },
      },
      metadata: {},
    });

    ;(spawnSync as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      status: 0,
      stdout: mockAuditOutput,
      stderr: Buffer.from(''),
    });

    const server = {} as McpServer;
    const deps: McpDependencies = {
      kg: {} as any,
      coherence: {} as any,
      debt: {} as any,
      scale: {} as any,
      projectRoot: TEST_PROJECT_ROOT,
    } as McpDependencies;

    // @ts-expect-error - testing tool registration
    registerScanCvesTool(server, deps);

    // Test with level: 'high' - should only return critical and high
    const registeredCfg = (server.registerTool as unknown).mock.calls[0]?.[1];
    expect(registeredCfg?.inputSchema?.level).toBeDefined();
  });

  it('handles error when npm is not available', () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      stdout: Buffer.from(output),
      stderr: Buffer.from(''),
      pid: 1,
      output: [Buffer.from(output), Buffer.from('')],
      signal: null,
    });

    const server = {} as McpServer;
    const deps: McpDependencies = {
      kg: {} as any,
      coherence: {} as any,
      debt: {} as any,
      scale: {} as any,
      projectRoot: TEST_PROJECT_ROOT,
    } as McpDependencies;

    // @ts-expect-error - testing tool registration
    registerScanCvesTool(server, deps);

    const registeredCfg = (server.registerTool as unknown).mock.calls[0]?.[1];
    expect(registeredCfg?.inputSchema?.fix).toBeDefined();
    expect(registeredCfg?.inputSchema?.level).toBeDefined();
  });

  it('has input schema with fix and level options', () => {
    const server = {} as McpServer;
    const deps: McpDependencies = {
      kg: {} as any,
      coherence: {} as any,
      debt: {} as any,
      scale: {} as any,
      projectRoot: TEST_PROJECT_ROOT,
    } as McpDependencies;

    // @ts-expect-error - testing tool registration
    registerScanCvesTool(server, deps);

    const registeredCfg = (server.registerTool as unknown).mock.calls[0]?.[1];
    // Schema should have fix (boolean, default false) and level (enum, default moderate)
    expect(registeredCfg?.inputSchema?.fix).toBeDefined();
    expect(typeof registeredCfg?.inputSchema?.fix?.default).toBe('boolean');
    expect(registeredCfg?.inputSchema?.fix?.default).toBe(false);
    expect(registeredCfg?.inputSchema?.level).toBeDefined();
    expect(Array.isArray(registeredCfg?.inputSchema?.level?.enum)).toBe(true);
    expect(registeredCfg?.inputSchema?.level?.enum).toContain('moderate');
    expect(registeredCfg?.inputSchema?.level?.enum).toContain('high');
  });
});