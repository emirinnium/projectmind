import * as vscode from 'vscode';
import { MCPClient } from './mcpClient';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function listPage(title: string, summary: string[], bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 16px; color: var(--vscode-foreground); }
    h2 { margin-top: 0; }
    .summary { opacity: 0.85; font-size: 12px; margin-bottom: 10px; }
    ul.list { padding-left: 18px; }
    li { margin-bottom: 8px; }
    code { color: var(--vscode-textPreformat-foreground); }
  </style>
</head>
<body>
  <h2>${escapeHtml(title)}</h2>
  ${summary.map((s) => `<div class="summary">${escapeHtml(s)}</div>`).join('')}
  ${bodyHtml}
</body>
</html>`;
}

/**
 * Manages the ProjectMind sidebar panel.
 */
export class SidebarPanel {
  public static currentPanel: SidebarPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private mcpClient: MCPClient;

  public static createOrShow(mcpClient: MCPClient): SidebarPanel {
    const column = vscode.ViewColumn.One;
    if (SidebarPanel.currentPanel) {
      SidebarPanel.currentPanel.panel.reveal(column);
    } else {
      const panel = vscode.window.createWebviewPanel(
        'projectmindSidebar',
        'ProjectMind',
        column,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );
      SidebarPanel.currentPanel = new SidebarPanel(panel, mcpClient);
    }
    return SidebarPanel.currentPanel;
  }

  private constructor(panel: vscode.WebviewPanel, mcpClient: MCPClient) {
    this.panel = panel;
    this.mcpClient = mcpClient;
    this.update();
    this.wireMessages();
    this.panel.onDidDispose(() => this.dispose());
  }

  /**
   * Wire webview button messages to real actions. Without this listener the
   * sidebar buttons post into the void.
   */
  private wireMessages(): void {
    this.panel.webview.onDidReceiveMessage(async (msg: { command: string }) => {
      try {
        if (msg.command === 'scan') {
          await vscode.commands.executeCommand('projectmind.scanProject');
          await this.update();
        } else if (msg.command === 'debt') {
          await this.renderList('debt_report', {}, 'Cognitive Debt');
        } else if (msg.command === 'hotspots') {
          await this.renderHotspots();
        }
      } catch (e) {
        vscode.window.showErrorMessage(`ProjectMind: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, undefined, []);
  }

  /** Render a simple list view from a tool that returns {items:[{description,severity,filePath}]} or {topHotspots}. */
  private async renderList(toolName: 'debt_report', args: Record<string, unknown>, title: string): Promise<void> {
    const result = await this.mcpClient.callTool(toolName, args);
    const report = JSON.parse(result.content[0]?.text || '{}') as {
      totalItems?: number;
      bySeverity?: Record<string, number>;
      items?: Array<{ description?: string; type?: string; severity?: string; filePath?: string | null }>;
    };
    const rows = (report.items ?? []).slice(0, 15).map((it) =>
      `<li><b>[${(it.severity ?? '?').toUpperCase()}]</b> ${escapeHtml(it.type ?? '')}: ${escapeHtml(it.description ?? '')}<br/><small>${escapeHtml(it.filePath || 'project-wide')}</small></li>`
    ).join('');
    this.panel.webview.html = listPage(title, [
      `Total items: ${report.totalItems ?? 0}`,
      `High: ${report.bySeverity?.high ?? 0} · Medium: ${report.bySeverity?.medium ?? 0} · Low: ${report.bySeverity?.low ?? 0}`,
    ], `<ul class="list">${rows}</ul>`);
  }

  /** Hotspots = files with highest cognitive load from scale report modules. */
  private async renderHotspots(): Promise<void> {
    const result = await this.mcpClient.callTool('scale_report', {});
    const report = JSON.parse(result.content[0]?.text || '{}') as {
      topHotspots?: Array<{ path?: string; relativePath?: string; cognitiveLoad?: number; agentTouched?: boolean }>;
      avgCognitiveLoad?: number;
    };
    const spots = (report.topHotspots ?? []).slice(0, 10);
    const rows = spots.map((h) =>
      `<li><code>${escapeHtml(h.relativePath || h.path || '')}</code> — load ${(h.cognitiveLoad ?? 0).toFixed(3)}${h.agentTouched ? ' · agent-touched' : ''}</li>`
    ).join('');
    this.panel.webview.html = listPage('Top Hotspots', [
      `Avg cognitive load: ${(report.avgCognitiveLoad ?? 0).toFixed(3)}`,
    ], `<ul class="list">${rows}</ul>`);
  }

  /**
   * Refresh the sidebar content.
   */
  async update(): Promise<void> {
    this.panel.webview.html = await this.getHtml();
  }

  /**
   * Get the HTML content for the sidebar.
   */
  private async getHtml(): Promise<string> {
    let metrics = { files: 0, coverage: 0, load: 0 };
    try {
      const result = await this.mcpClient.callTool('scale_report', { root: '.' });
      const report = JSON.parse(result.content[0]?.text || '{}');
      metrics = {
        files: report.totalFiles || 0,
        coverage: report.agentCoverage || 0,
        load: report.avgCognitiveLoad || 0,
      };
    } catch {
      // Use default metrics
    }

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 16px; color: var(--vscode-foreground); }
    .metric { margin: 12px 0; padding: 12px; background: var(--vscode-input-background); border-radius: 6px; }
    .metric-label { font-size: 11px; text-transform: uppercase; opacity: 0.7; }
    .metric-value { font-size: 20px; font-weight: 600; margin-top: 4px; }
    .actions { margin-top: 20px; }
    button { width: 100%; padding: 8px; margin: 4px 0; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <h2>🧠 ProjectMind</h2>
  <div class="metric">
    <div class="metric-label">Total Files</div>
    <div class="metric-value">${metrics.files}</div>
  </div>
  <div class="metric">
    <div class="metric-label">Agent Coverage</div>
    <div class="metric-value">${(metrics.coverage * 100).toFixed(1)}%</div>
  </div>
  <div class="metric">
    <div class="metric-label">Avg Cognitive Load</div>
    <div class="metric-value">${metrics.load.toFixed(3)}</div>
  </div>
  <div class="actions">
    <button onclick="scanProject()">Scan Project</button>
    <button onclick="showDebt()">View Debt</button>
    <button onclick="showHotspots()">View Hotspots</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    function scanProject() { vscode.postMessage({ command: 'scan' }); }
    function showDebt() { vscode.postMessage({ command: 'debt' }); }
    function showHotspots() { vscode.postMessage({ command: 'hotspots' }); }
  </script>
</body>
</html>`;
  }

  /**
   * Dispose of the panel.
   */
  dispose(): void {
    SidebarPanel.currentPanel = undefined;
    this.panel.dispose();
  }
}
