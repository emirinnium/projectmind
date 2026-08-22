import { getReportData } from '@/lib/data';

export const dynamic = 'force-dynamic';

export default async function DebtPage() {
  const data = await getReportData();

  const debtByLanguage = Object.entries(data.languages)
    .map(([name, info]) => ({
      name,
      files: info.files,
      load: info.bytes / 1000,
    }))
    .sort((a, b) => b.load - a.load)
    .slice(0, 10);

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-gray-900">Cognitive Debt</h1>
      <p className="text-gray-500">Modules ranked by cognitive load (higher = more complex)</p>

      {debtByLanguage.length > 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="pb-3 text-sm font-semibold text-gray-600">Module</th>
                <th className="pb-3 text-sm font-semibold text-gray-600">Files</th>
                <th className="pb-3 text-sm font-semibold text-gray-600">Cognitive Load</th>
              </tr>
            </thead>
            <tbody>
              {debtByLanguage.map((mod) => (
                <tr key={mod.name} className="border-b border-gray-100 last:border-0">
                  <td className="py-3 text-sm font-medium text-gray-900">{mod.name}</td>
                  <td className="py-3 text-sm text-gray-600">{mod.files}</td>
                  <td className="py-3">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-32 rounded-full bg-gray-100">
                        <div
                          className="h-2 rounded-full bg-orange-500"
                          style={{ width: `${Math.min(100, (mod.load / 100) * 100)}%` }}
                        />
                      </div>
                      <span className="text-sm text-gray-600">{mod.load.toFixed(2)}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <p className="text-gray-500">No debt data available. Run a scan first.</p>
        </div>
      )}
    </div>
  );
}
