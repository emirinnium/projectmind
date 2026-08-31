import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { renderModuleSvg, renderModulePng, encodePng } from '../../src/cli/commands/graph-render.js';
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
describe('renderModuleSvg', () => {
    it('produces a well-formed svg with the module title', () => {
        const svg = renderModuleSvg(makeReport());
        expect(svg).toContain('<svg');
        expect(svg.trimEnd()).toMatch(/<\/svg>$/);
        expect(svg).toContain('ProjectMind - Module Diagram');
        expect(svg).toContain('src/a.ts');
    });
    it('escapes XML entities in module and file labels', () => {
        const report = makeReport();
        report.modules[0].name = 'a<b&c"d';
        const svg = renderModuleSvg(report);
        expect(svg).not.toContain('<b&');
        expect(svg).toContain('a&lt;b&amp;c&quot;d');
    });
});
describe('encodePng', () => {
    it('emits a valid PNG signature, IHDR dims and inflatable IDAT', () => {
        const width = 64;
        const height = 48;
        const rgba = new Uint8Array(width * height * 4);
        // Draw a few random-ish pixels so deflate has real data.
        for (let i = 0; i < rgba.length; i += 4) {
            rgba[i] = (i * 7) % 256;
            rgba[i + 1] = (i * 13) % 256;
            rgba[i + 2] = (i * 29) % 256;
            rgba[i + 3] = 255;
        }
        const png = encodePng(width, height, rgba);
        expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        expect(png.toString('ascii', 12, 16)).toBe('IHDR');
        expect(png.readUInt32BE(16)).toBe(width);
        expect(png.readUInt32BE(20)).toBe(height);
        const idatStart = png.indexOf('IDAT', 12);
        expect(idatStart).toBeGreaterThan(0);
        const idatLen = png.readUInt32BE(idatStart - 4);
        const raw = inflateSync(png.subarray(idatStart + 4, idatStart + 4 + idatLen));
        expect(raw.length).toBe((width * 3 + 1) * height);
        // IEND type string sits after IDAT data + IDAT CRC(4) + IEND length(4).
        expect(png.toString('ascii', idatStart + 4 + idatLen + 8, idatStart + 4 + idatLen + 12)).toBe('IEND');
    });
});
describe('renderModulePng', () => {
    it('renders a deterministic, decodable PNG bar chart', () => {
        const report = makeReport();
        const pngA = renderModulePng(report, 320);
        const pngB = renderModulePng(report, 320);
        expect([...pngA.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const w = pngA.readUInt32BE(16);
        const h = pngA.readUInt32BE(20);
        expect(w).toBe(320);
        expect(h).toBeGreaterThan(10);
        const idatStart = pngA.indexOf('IDAT', 12);
        const idatLen = pngA.readUInt32BE(idatStart - 4);
        const raw = inflateSync(pngA.subarray(idatStart + 4, idatStart + 4 + idatLen));
        expect(raw.length).toBe((w * 3 + 1) * h);
        expect(pngA.equals(pngB)).toBe(true);
    });
    it('handles an empty module list without throwing', () => {
        const report = makeReport();
        report.modules = [];
        const png = renderModulePng(report, 200);
        expect(png.toString('ascii', 1, 3)).toBe('PN');
    });
});
//# sourceMappingURL=graph-render.test.js.map