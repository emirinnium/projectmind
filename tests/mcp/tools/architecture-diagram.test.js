import { describe, it, expect } from 'vitest';
import { exportArchitectureDiagramForTool } from '../../../src/mcp/tools/architecture-diagram.js';
/**
 * Minimal FileInfo stub — only the fields the renderers read are populated
 * (mirrors tests/unit/graph-render.test.ts).
 */
function makeFile(path, relativePath) {
    return {
        id: 1,
        path,
        relativePath,
        language: 'typescript',
        sizeBytes: 100,
        hash: 'abc',
        agentTouched: false,
        agentTouchedBy: null,
        agentTouchedAt: null,
        cognitiveLoad: 0.1,
        lastScanned: '2026-01-01T00:00:00.000Z',
        lastSynced: '2026-01-01T00:00:00.000Z',
        patterns: [],
    };
}
/** Deterministic two-module scale report (mirrors tests/unit/graph-render.test.ts). */
function makeReport() {
    return {
        totalFiles: 3,
        totalBytes: 300,
        totalLines: 30,
        languages: { typescript: { files: 2, bytes: 200 }, javascript: { files: 1, bytes: 100 } },
        modules: [
            {
                path: 'src',
                name: 'src',
                fileCount: 2,
                totalBytes: 200,
                cognitiveLoad: 0.5,
                agentCoverage: 0.5,
                files: [makeFile('C:/p/src/a.ts', 'src/a.ts'), makeFile('C:/p/src/b.ts', 'src/b.ts')],
            },
            {
                path: 'tests',
                name: 'tests',
                fileCount: 1,
                totalBytes: 100,
                cognitiveLoad: 0.2,
                agentCoverage: 0,
                files: [makeFile('C:/p/tests/x.test.ts', 'tests/x.test.ts')],
            },
        ],
        agentCoverage: 0.33,
        avgCognitiveLoad: 0.35,
        topHotspots: [],
        uncoveredFiles: [],
    };
}
/**
 * Minimal McpDependencies stub — exportArchitectureDiagramForTool only reads
 * `deps.scale.getScaleReport()`, so the rest of the surface is a partial cast
 * (mirrors the contracts.test.ts deps-stub pattern).
 */
function makeDeps(report) {
    return {
        scale: { getScaleReport: () => report },
    };
}
describe('export_architecture_diagram (exportArchitectureDiagramForTool)', () => {
    it('renders SVG content starting with <svg by default', () => {
        const result = exportArchitectureDiagramForTool(makeDeps(makeReport()), {});
        expect(result.format).toBe('svg');
        expect(result.content.startsWith('<svg')).toBe(true);
        expect(result.content).toContain('ProjectMind - Module Diagram');
    });
    it('renders PNG as a base64 data URL', () => {
        const result = exportArchitectureDiagramForTool(makeDeps(makeReport()), { format: 'png' });
        expect(result.format).toBe('png');
        expect(result.content.startsWith('data:image/png;base64,')).toBe(true);
        const b64 = result.content.slice('data:image/png;base64,'.length);
        const buf = Buffer.from(b64, 'base64');
        expect([...buf.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    });
    it('renders a valid Mermaid graph block with node ids', () => {
        const result = exportArchitectureDiagramForTool(makeDeps(makeReport()), { format: 'mermaid' });
        expect(result.format).toBe('mermaid');
        expect(result.content).toMatch(/^graph TD/);
        expect(result.content).toContain('m_src');
        expect(result.content).toContain('m_tests');
        expect(result.content).toContain('-->');
    });
    it('narrows the diagram to a single module via the module filter', () => {
        const result = exportArchitectureDiagramForTool(makeDeps(makeReport()), {
            format: 'mermaid',
            module: 'tests',
        });
        expect(result.content).toContain('m_tests');
        expect(result.content).not.toContain('m_src');
    });
    it('caps the number of modules via depth (top N by file count)', () => {
        const result = exportArchitectureDiagramForTool(makeDeps(makeReport()), {
            format: 'mermaid',
            depth: 1,
        });
        expect(result.content).toContain('m_src');
        expect(result.content).not.toContain('m_tests');
    });
    it('throws a helpful error for an unknown module', () => {
        expect(() => exportArchitectureDiagramForTool(makeDeps(makeReport()), { module: 'nope' })).toThrow(/No module matches "nope"/);
    });
    it('throws a helpful error when the report has no modules', () => {
        const report = makeReport();
        report.modules = [];
        expect(() => exportArchitectureDiagramForTool(makeDeps(report), {})).toThrow(/run scan_project first/);
    });
});
//# sourceMappingURL=architecture-diagram.test.js.map