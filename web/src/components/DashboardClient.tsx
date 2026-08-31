'use client';

import { useState, useEffect, useCallback } from 'react';
import MetricCard from '@/components/MetricCard';
import DebtChart from '@/components/DebtChart';
import HotspotList from '@/components/HotspotList';

interface ReportData {
  totalFiles: number;
  totalLines: number;
  totalBytes: number;
  languages: Record<string, { files: number; bytes: number }>;
  agentCoverage: number;
  avgCognitiveLoad: number;
  debtItems: Array<{ severity: string; count: number }>;
  topHotspots: Array<{ path: string; cognitiveLoad: number; agentTouched: boolean }>;
  debtTotal: number;
  genomeScore: number;
}

const emptyData: ReportData = {
  totalFiles: 0,
  totalLines: 0,
  totalBytes: 0,
  languages: {},
  agentCoverage: 0,
  avgCognitiveLoad: 0,
  debtItems: [],
  topHotspots: [],
  debtTotal: 0,
  genomeScore: 0,
}

/** Pure component that renders the dashboard UI given report data */
function DashboardReport({ data, scanning, scanProgress, error, lastScanTime }: {
  data: ReportData;
  scanning: boolean;
  scanProgress: string | null;
  error: string | null;
  lastScanTime: Date | null;
}):
  JSX.Element {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">Codebase intelligence overview</p>
        </div>
        <div className="flex items-center gap-3">
          {lastScanTime && (
            <span className="text-xs text-gray-400">
              Last scan: {lastScanTime.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={/* onScan will be provided by parent */}
            disabled={scanning}
            className="rounded-lg bg-primary-600 px-4 py-2 text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {scanning ? 'Scanning...' : 'Run Scan'}
          </button>
        </div>
      </div>

      {/* Scan Progress / Error */}
      {scanProgress && (
        <div className="rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-700">
          <span className="animate-pulse">⟳</span> {scanProgress}
        </div>
      )}
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          ✗ {error}
        </div>
      )}

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Total Files"
          value={data.totalFiles}
          icon="📁"
          color="blue"
        />
        <MetricCard
          title="Languages"
          value={Object.keys(data.languages).length}
          icon="🌐"
          color="green"
        />
        <MetricCard
          title="Agent Coverage"
          value={`${(data.agentCoverage * 100).toFixed(1)}%`}
          icon="🤖"
          color="purple"
        />
        <MetricCard
          title="Avg Cognitive Load"
          value={data.avgCognitiveLoad.toFixed(3)}
          icon="🧠"
          color="orange"
        />
      </div>

      {/* Genome Score & Debt Total */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <MetricCard
          title="Genome Score"
          value={`${(data.genomeScore * 100).toFixed(1)}%`}
          icon="🧬"
          color="teal"
        />
        <MetricCard
          title="Total Debt Items"
          value={data.debtTotal}
          icon="⚠️"
          color="red"
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <DebtChart data={data.debtItems} />
        <HotspotList hotspots={data.topHotspots} />
      </div>
    </div>
  );
}

export default function DashboardClient() {
  const [data, setData] = useState<ReportData>(emptyData);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastScanTime, setLastScanTime] = useState<Date | null>(null);

  // Fetch report data from API
  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/report', { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        setData({
          totalFiles: json.totalFiles || 0,
          totalLines: json.totalLines || 0,
          totalBytes: json.totalBytes || 0,
          languages: json.languages || {},
          agentCoverage: json.agentCoverage || 0,
          avgCognitiveLoad: json.avgCognitiveLoad || 0,
          debtItems: json.debtItems || [],
          topHotspots: json.topHotspots || [],
          debtTotal: json.debtTotal || 0,
          genomeScore: json.genomeScore || 0,
        });
      }
    } catch (e) {
      console.error('Failed to fetch report data:', e);
    }
  }, []);

  // Initial data fetch
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // SSE events source for live dashboard updates
  useEffect(() => {
    const eventsSource = new EventSource('/api/events');
    eventsSource.addEventListener('report', (ev) => {
      try { setData(JSON.parse((ev as MessageEvent).data)); setError(null); } catch {}
    });
    eventsSource.onerror = () => eventsSource.close();
    return () => eventsSource.close();
  }, []);

  // Run scan
  const handleScan = async () => {
    setScanning(true);
    setError(null);
    setScanProgress('Starting scan...');

    try {
      // Start the scan
      const res = await fetch('/api/scan', {
        method: 'POST',
        cache: 'no-store',
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Scan failed');
      }

      const scanResult = await res.json();
      setScanProgress(`Scanned ${scanResult.scanned} files (${scanResult.errors} errors)`);

      // Fetch updated data after scan completes
      await fetchData();
      setLastScanTime(new Date());
      setScanProgress(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scan failed');
      setScanProgress(null);
    } finally {
      setScanning(false);
    }
  };

  return <DashboardReport
    data={data}
    scanning={scanning}
    scanProgress={scanProgress}
    error={error}
    lastScanTime={lastScanTime} />;
}
