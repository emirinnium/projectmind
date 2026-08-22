// VS Code Webview Components
// These components are rendered inside the VS Code webview panel

export interface MetricCardProps {
  label: string;
  value: string | number;
  icon?: string;
}

export function MetricCard({ label, value, icon }: MetricCardProps): string {
  return `
    <div class="metric-card">
      ${icon ? `<span class="metric-icon">${icon}</span>` : ''}
      <div class="metric-content">
        <div class="metric-label">${label}</div>
        <div class="metric-value">${value}</div>
      </div>
    </div>
  `;
}

export interface DebtItemProps {
  severity: 'high' | 'medium' | 'low';
  type: string;
  description: string;
  filePath?: string;
}

export function DebtItem({ severity, type, description, filePath }: DebtItemProps): string {
  const colors = {
    high: '#ef4444',
    medium: '#f59e0b',
    low: '#10b981',
  };

  return `
    <div class="debt-item" style="border-left: 3px solid ${colors[severity]}">
      <div class="debt-header">
        <span class="debt-severity">${severity.toUpperCase()}</span>
        <span class="debt-type">${type}</span>
      </div>
      <div class="debt-description">${description}</div>
      ${filePath ? `<div class="debt-file">${filePath}</div>` : ''}
    </div>
  `;
}

export interface HotspotItemProps {
  path: string;
  cognitiveLoad: number;
  rank: number;
}

export function HotspotItem({ path, cognitiveLoad, rank }: HotspotItemProps): string {
  return `
    <div class="hotspot-item">
      <span class="hotspot-rank">${rank}</span>
      <span class="hotspot-path">${path}</span>
      <span class="hotspot-load">${cognitiveLoad.toFixed(3)}</span>
    </div>
  `;
}

export const webviewStyles = `
  .metric-card {
    display: flex;
    align-items: center;
    padding: 12px;
    background: var(--vscode-input-background);
    border-radius: 6px;
    margin: 8px 0;
  }
  .metric-icon {
    font-size: 24px;
    margin-right: 12px;
  }
  .metric-label {
    font-size: 11px;
    text-transform: uppercase;
    opacity: 0.7;
  }
  .metric-value {
    font-size: 20px;
    font-weight: 600;
  }
  .debt-item {
    padding: 12px;
    margin: 8px 0;
    background: var(--vscode-input-background);
    border-radius: 6px;
  }
  .debt-header {
    display: flex;
    gap: 8px;
    margin-bottom: 4px;
  }
  .debt-severity {
    font-weight: 600;
    font-size: 11px;
  }
  .debt-type {
    opacity: 0.7;
  }
  .hotspot-item {
    display: flex;
    align-items: center;
    padding: 8px 12px;
    background: var(--vscode-input-background);
    border-radius: 4px;
    margin: 4px 0;
  }
  .hotspot-rank {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-radius: 50%;
    font-size: 12px;
    font-weight: 600;
    margin-right: 12px;
  }
  .hotspot-path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hotspot-load {
    font-weight: 600;
    margin-left: 12px;
  }
`;
