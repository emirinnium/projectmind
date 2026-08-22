'use client';

import { useState } from 'react';
import { runScan } from '@/lib/data';

export default function ScanButton() {
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<{ scanned: number; errors: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleScan = async () => {
    setScanning(true);
    setError(null);
    setResult(null);
    try {
      const data = await runScan();
      setResult({ scanned: data.scanned, errors: data.errors });
      // Refresh the page after scan to show updated data
      setTimeout(() => window.location.reload(), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={handleScan}
        disabled={scanning}
        className="rounded-lg bg-primary-600 px-4 py-2 text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {scanning ? 'Scanning...' : 'Run Scan'}
      </button>
      {result && (
        <span className="text-sm text-green-600">
          ✓ Scanned {result.scanned} files ({result.errors} errors)
        </span>
      )}
      {error && (
        <span className="text-sm text-red-600">✗ {error}</span>
      )}
    </div>
  );
}
