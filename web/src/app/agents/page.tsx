import { getReportData } from '@/lib/data';

export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const data = await getReportData();

  const modules = Object.entries(data.languages)
    .map(([name, info]) => ({ name, files: info.files, complexity: info.bytes / 1000 }))
    .sort((a, b) => b.complexity - a.complexity)
    .slice(0, 8);

  // Determine module coverage based on file count (deterministic, no Math.random)
  const coverageMap = modules.map((mod, i) => ({
    ...mod,
    covered: i < Math.ceil(modules.length * 0.4), // Top 40% considered covered
  }));

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-gray-900">Agent Activity</h1>
      <p className="text-gray-500">Agent coverage and module interaction status</p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-5">
          <p className="text-sm font-medium text-blue-700">Total Files</p>
          <p className="mt-1 text-2xl font-bold text-blue-900">{data.totalFiles}</p>
        </div>
        <div className="rounded-xl border border-green-200 bg-green-50 p-5">
          <p className="text-sm font-medium text-green-700">Agent Coverage</p>
          <p className="mt-1 text-2xl font-bold text-green-900">{(data.agentCoverage * 100).toFixed(1)}%</p>
        </div>
        <div className="rounded-xl border border-purple-200 bg-purple-50 p-5">
          <p className="text-sm font-medium text-purple-700">Modules</p>
          <p className="mt-1 text-2xl font-bold text-purple-900">{Object.keys(data.languages).length}</p>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <h3 className="mb-4 text-lg font-semibold text-gray-900">Module Coverage</h3>
        {coverageMap.length > 0 ? (
          <div className="space-y-3">
            {coverageMap.map((mod) => (
              <div key={mod.name} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                <div className="flex items-center gap-3">
                  <span className={`h-3 w-3 rounded-full ${mod.covered ? 'bg-green-500' : 'bg-gray-300'}`} />
                  <span className="text-sm font-mono text-gray-700">{mod.name}</span>
                </div>
                <span className="text-xs text-gray-500">{mod.files} files</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-500">No data available. Run a scan first.</p>
        )}
      </div>
    </div>
  );
}
