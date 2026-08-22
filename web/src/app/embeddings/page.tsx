import { getReportData } from '@/lib/data';

export const dynamic = 'force-dynamic';

export default async function EmbeddingsPage() {
  const data = await getReportData();

  const modules = Object.entries(data.languages)
    .map(([name, info]) => ({ name, files: info.files, complexity: info.bytes / 1000 }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 12);

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-gray-900">Code Embeddings</h1>
      <p className="text-gray-500">Module similarity clusters based on file structure and complexity</p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {modules.length > 0 ? (
          modules.map((mod) => (
            <div key={mod.name} className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-mono font-medium text-gray-900 truncate max-w-[150px]">
                  {mod.name}
                </span>
                <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded">
                  {mod.files} files
                </span>
              </div>
              <div className="mt-3">
                <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                  <span>Complexity</span>
                  <span>{mod.complexity.toFixed(1)}</span>
                </div>
                <div className="h-2 w-full rounded-full bg-gray-100">
                  <div
                    className="h-2 rounded-full bg-purple-500"
                    style={{ width: `${Math.min(100, mod.complexity)}%` }}
                  />
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="col-span-full rounded-xl border border-gray-200 bg-white p-6">
            <p className="text-gray-500">No embedding data available. Run a scan first.</p>
          </div>
        )}
      </div>
    </div>
  );
}
