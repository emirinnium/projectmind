// Data fetching utilities for ProjectMind Web UI

export interface ReportData {
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

// Base URL for API calls - use absolute URL for server components
const API_BASE = process.env.PROJECTMIND_API_BASE || 'http://localhost:3000';

export async function getReportData(): Promise<ReportData> {
  try {
    // Use absolute URL for server-side fetching, relative for client-side
    const url = typeof window === 'undefined' ? `${API_BASE}/api/report` : '/api/report';
    const res = await fetch(url, { 
      cache: 'no-store',
      next: { revalidate: 0 },
    });
    if (res.ok) {
      const data = await res.json();
      return {
        totalFiles: data.totalFiles || 0,
        totalLines: data.totalLines || 0,
        totalBytes: data.totalBytes || 0,
        languages: data.languages || {},
        agentCoverage: data.agentCoverage || 0,
        avgCognitiveLoad: data.avgCognitiveLoad || 0,
        debtItems: data.debtItems || [],
        topHotspots: data.topHotspots || [],
        debtTotal: data.debtTotal || 0,
        genomeScore: data.genomeScore || 0,
      };
    }
  } catch (e) {
    console.error('Failed to fetch report data:', e);
  }

  return {
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
  };
}

export async function runScan(): Promise<{ scanned: number; errors: number; totalFiles: number; agentCoverage: number; avgCognitiveLoad: number }> {
  const url = typeof window === 'undefined' ? `${API_BASE}/api/scan` : '/api/scan';
  const res = await fetch(url, {
    method: 'POST',
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error('Scan failed');
  }
  return res.json();
}
