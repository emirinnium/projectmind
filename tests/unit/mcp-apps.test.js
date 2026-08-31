import { describe, it, expect } from 'vitest';
import { buildModuleSizeChart, buildLanguageChart, buildDebtChart, buildScanForm, buildGenomeSummary } from '../../src/mcp/apps/builders.js';
import { attachApps, buildAppsPayload } from '../../src/mcp/apps/content.js';
function makeScaleReport() {
    return {
        totalFiles: 3,
        totalBytes: 300,
        totalLines: 30,
        languages: { typescript: { files: 2, bytes: 200 } },
        modules: [
            {
                path: 'src',
                name: 'src',
                fileCount: 2,
                totalBytes: 200,
                cognitiveLoad: 0.5,
                agentCoverage: 0.5,
                files: [],
            },
            {
                path: 'tests',
                name: 'tests',
                fileCount: 1,
                totalBytes: 100,
                cognitiveLoad: 0.2,
                agentCoverage: 0,
                files: [],
            },
        ],
        agentCoverage: 0.33,
        avgCognitiveLoad: 0.35,
        topHotspots: [],
        uncoveredFiles: [],
    };
}
function makeDebtReport() {
    return {
        totalItems: 10,
        bySeverity: { high: 1, medium: 3, low: 6 },
        byType: { pattern_drift: 2, architectural_drift: 3, redundancy: 4, agent_conflict: 0, complexity: 1, code_age: 0, cognitive_load: 0, change_frequency: 0 },
        coherenceGenomeScore: 0.8,
        items: [],
        hasMore: false,
    };
}
describe('apps builders', () => {
    it('buildModuleSizeChart sorts modules by file count and caps at 10', () => {
        const report = makeScaleReport();
        const chart = buildModuleSizeChart(report);
        expect(chart.kind).toBe('chart');
        if (chart.kind !== 'chart')
            return;
        expect(chart.chartType).toBe('bar');
        if (chart.chartType !== 'bar')
            return;
        const barOptions = chart.options;
        expect(barOptions.labels).toEqual(['src', 'tests']);
        expect(barOptions.series[0].data).toEqual([2, 1]);
    });
    it('buildLanguageChart flattens the language record into pie data', () => {
        const chart = buildLanguageChart(makeScaleReport());
        expect(chart.kind).toBe('chart');
        if (chart.kind !== 'chart')
            return;
        expect(chart.chartType).toBe('pie');
        if (chart.chartType !== 'pie')
            return;
        const pieOptions = chart.options;
        expect(pieOptions.data).toEqual([{ name: 'typescript', value: 2 }]);
    });
    it('buildDebtChart reflects the severity breakdown', () => {
        const chart = buildDebtChart(makeDebtReport());
        expect(chart.kind).toBe('chart');
        if (chart.kind !== 'chart')
            return;
        expect(chart.chartType).toBe('bar');
        if (chart.chartType !== 'bar')
            return;
        const barOptions = chart.options;
        expect(barOptions.labels).toEqual(['high', 'medium', 'low']);
        expect(barOptions.series[0].data).toEqual([1, 3, 6]);
    });
    it('buildScanForm exposes root and full fields', () => {
        const form = buildScanForm({ root: '/tmp/p' });
        expect(form.kind).toBe('form');
        if (form.kind !== 'form')
            return;
        expect(form.fields.map((f) => f.name)).toEqual(['root', 'full']);
        expect(form.fields[0].placeholder).toBe('/tmp/p');
    });
    it('buildGenomeSummary renders a markdown summary', () => {
        const md = buildGenomeSummary(0.956, 4);
        expect(md.kind).toBe('markdown');
        if (md.kind !== 'markdown')
            return;
        expect(md.content).toContain('95.6%');
        expect(md.content).toContain('4 records');
    });
});
describe('apps content envelope', () => {
    it('buildAppsPayload wraps components in the mcp-apps v1 envelope', () => {
        const payload = buildAppsPayload([buildScanForm()]);
        const parsed = JSON.parse(payload);
        expect(parsed['mcp-apps']).toBe('v1');
        expect(parsed.components).toHaveLength(1);
    });
    it('attachApps appends a text block and keeps the original content', () => {
        const result = attachApps({ content: [{ type: 'text', text: 'hi' }] }, [buildModuleSizeChart(makeScaleReport())]);
        expect(result.content).toHaveLength(2);
        expect(result.content[0].text).toBe('hi');
        const parsed = JSON.parse(result.content[1].text);
        expect(parsed.components).toHaveLength(1);
    });
    it('attachApps is a no-op for an empty component list', () => {
        const result = attachApps({ content: [{ type: 'text', text: 'hi' }] }, []);
        expect(result.content).toHaveLength(1);
    });
});
//# sourceMappingURL=mcp-apps.test.js.map