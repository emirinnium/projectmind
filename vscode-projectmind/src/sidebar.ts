import * as vscode from 'vscode';
import { MCPClient } from './mcpClient';

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
    this.panel.onDidDispose(() => this.dispose());
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
