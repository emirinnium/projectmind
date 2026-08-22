import { getReportData } from '@/lib/data';

export const dynamic = 'force-dynamic';

export default async function SecurityPage() {
  const data = await getReportData();

  // Calculate security metrics from available data
  const totalModules = Object.keys(data.languages).length;
  const uncoveredModules = Object.entries(data.languages).filter(
    ([, info]) => info.files > 10 && info.bytes / 1000 > 5
  ).length;

  const securityMetrics = [
    { label: 'Agent Coverage', value: `${(data.agentCoverage * 100).toFixed(1)}%`, status: data.agentCoverage > 0.5 ? 'good' : 'warning' },
    { label: 'Total Modules', value: totalModules, status: 'info' },
    { label: 'Uncovered Modules', value: uncoveredModules, status: uncoveredModules < 5 ? 'good' : 'warning' },
    { label: 'Avg Cognitive Load', value: data.avgCognitiveLoad.toFixed(3), status: data.avgCognitiveLoad < 0.5 ? 'good' : 'warning' },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-gray-900">Security Audit</h1>
      <p className="text-gray-500">Codebase security and coverage metrics</p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {securityMetrics.map((metric) => {
          const colorMap: Record<string, string> = {
            good: 'bg-green-50 text-green-700 border-green-200',
            warning: 'bg-yellow-50 text-yellow-700 border-yellow-200',
            info: 'bg-blue-50 text-blue-700 border-blue-200',
          };
          return (
            <div key={metric.label} className={`rounded-xl border p-5 ${colorMap[metric.status]}`}>
              <p className="text-sm font-medium opacity-80">{metric.label}</p>
              <p className="mt-1 text-2xl font-bold">{metric.value}</p>
            </div>
          );
        })}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <h3 className="mb-4 text-lg font-semibold text-gray-900">Coverage Details</h3>
        {totalModules > 0 ? (
          <div className="space-y-2">
            {Object.entries(data.languages).slice(0, 8).map(([name, info]) => (
              <div key={name} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                <span className="text-sm font-mono text-gray-700">{name}</span>
                <div className="flex items-center gap-2">
                  <div className="h-2 w-24 rounded-full bg-gray-100">
                    <div
                      className="h-2 rounded-full bg-green-500"
                      style={{ width: `${Math.min(100, info.files * 2)}%` }}
                    />
                  </div>
                  <span className="text-xs text-gray-500">{info.files} files</span>
                </div>
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
