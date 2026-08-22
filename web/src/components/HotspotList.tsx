interface HotspotListProps {
  hotspots: Array<{ path: string; cognitiveLoad: number; agentTouched: boolean }>;
}

export default function HotspotList({ hotspots }: HotspotListProps) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6">
      <h3 className="mb-4 text-lg font-semibold text-gray-900">Top Hotspots</h3>
      {hotspots.length > 0 ? (
        <ul className="space-y-3">
          {hotspots.slice(0, 5).map((hotspot, index) => (
            <li
              key={index}
              className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-red-100 text-xs font-bold text-red-700">
                  {index + 1}
                </span>
                <span className="text-sm text-gray-700 truncate max-w-xs">
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
      ) : (
        <div className="flex h-64 items-center justify-center text-gray-400">
          No hotspots detected
        </div>
      )}
    </div>
  );
}
