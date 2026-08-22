'use client';

import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  Legend,
} from 'recharts';

interface DebtChartProps {
  data: Array<{ severity: string; count: number }>;
}

const COLORS: Record<string, string> = {
  high: '#ef4444',
  medium: '#f59e0b',
  low: '#10b981',
};

export default function DebtChart({ data }: DebtChartProps) {
  // Filter out items with 0 count to avoid label overlapping
  const chartData = data
    .filter((item) => item.count > 0)
    .map((item) => ({
      name: item.severity.charAt(0).toUpperCase() + item.severity.slice(1),
      value: item.count,
      color: COLORS[item.severity] || '#6b7280',
    }));

  // Calculate total for percentage display
  const total = chartData.reduce((sum, item) => sum + item.value, 0);

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6">
      <h3 className="mb-4 text-lg font-semibold text-gray-900">Debt by Severity</h3>
      {chartData.length > 0 ? (
        <ResponsiveContainer width="100%" height={250}>
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={90}
              dataKey="value"
              label={({ name, value }) => {
                const pct = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                return `${name}: ${value} (${pct}%)`;
              }}
            >
              {chartData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip formatter={(value: number) => [`${value} items`, 'Count']} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      ) : (
        <div className="flex h-64 items-center justify-center text-gray-400">
          No debt items found
        </div>
      )}
    </div>
  );
}
