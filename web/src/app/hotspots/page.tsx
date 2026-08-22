import { getReportData } from '@/lib/data';

export const dynamic = 'force-dynamic';

export default async function HotspotsPage() {
  const data = await getReportData();

  const hotspots = data.topHotspots;

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-gray-900">Code Hotspots</h1>
      <p className="text-gray-500">Modules with highest cognitive load — priority targets for refactoring</p>

      {hotspots.length > 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <ul className="space-y-3">
            {hotspots.map((hotspot, index) => (
              <li
                key={index}
                className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-red-100 text-xs font-bold text-red-700">
                    {index + 1}
                  </span>
                  <span className="text-sm text-gray-700 truncate max-w-sm font-mono">
                    {hotspot.path}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900">
                    {hotspot.cognitiveLoad.toFixed(3)}
                  </span>
                  {hotspot.agentTouched ? (
                    <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">
                      Touched
                    </span>
                  ) : (
                    <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded">
                      New
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <p className="text-gray-500">No hotspots detected. Run a scan first.</p>
        </div>
      )}
    </div>
  );
}
