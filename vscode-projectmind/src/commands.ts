import * as vscode from 'vscode';
import { MCPClient } from './mcpClient';
import { StatusBarManager } from './statusBar';

/**
 * Register all VS Code commands for ProjectMind.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  mcpClient: MCPClient,
  statusBar: StatusBarManager
): void {
  // Scan Project
  context.subscriptions.push(
    vscode.commands.registerCommand('projectmind.scanProject', async () => {
      statusBar.showProgress('Scanning project...');
      try {
        const result = await mcpClient.callTool('scan_project', {
          root: vscode.workspace.rootPath,
        });
        const report = JSON.parse(result.content[0]?.text || '{}');
        statusBar.updateMetrics(report.totalFiles || 0, report.agentCoverage || 0, report.avgCognitiveLoad || 0);
        vscode.window.showInformationMessage(`ProjectMind: Scanned ${report.totalFiles || 0} files`);
      } catch (e) {
        statusBar.showError('Scan failed');
        vscode.window.showErrorMessage(`ProjectMind scan failed: ${e}`);
      }
    })
  );

  // Scan File
  context.subscriptions.push(
    vscode.commands.registerCommand('projectmind.scanFile', async (filePath?: string) => {
      const path = filePath || vscode.window.activeTextEditor?.document.uri.fsPath;
      if (!path) {
        vscode.window.showWarningMessage('No file to scan');
        return;
      }
      statusBar.showProgress('Scanning file...');
      try {
        const result = await mcpClient.callTool('get_context', { filePath: path });
        vscode.window.showInformationMessage('ProjectMind: File scanned');
      } catch (e) {
        statusBar.showError('File scan failed');
      }
    })
  );

  // Show Report — renders LIVE data (was a static 'Loading...' placeholder)
  context.subscriptions.push(
    vscode.commands.registerCommand('projectmind.showReport', async () => {
      const panel = vscode.window.createWebviewPanel(
        'projectmindReport',
        'ProjectMind Report',
        vscode.ViewColumn.One,
        { enableScripts: false }
      );
      panel.webview.html = `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:20px">
        <h2>ProjectMind Report</h2><p>Fetching…</p></body></html>`;
      try {
        const [scaleRes, debtRes] = await Promise.all([
          mcpClient.callTool('scale_report', {}),
          mcpClient.callTool('debt_report', {}).catch(() => null),
        ]);
        const scale = JSON.parse(scaleRes.content[0]?.text || '{}');
        const debt = debtRes ? JSON.parse(debtRes.content[0]?.text || '{}') : {};
        const fin = (v: unknown): number =>
          typeof v === 'number' && Number.isFinite(v) ? v : 0;
        const hotspots = (scale.topHotspots ?? []).slice(0, 10) as Array<{ path?: string; cognitiveLoad?: number; agentTouched?: boolean }>;
        panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
          body{font-family:-apple-system,'Segoe UI',sans-serif;padding:24px;color:var(--vscode-foreground)}
          .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:16px 0}
          .card{background:var(--vscode-input-background);border-radius:8px;padding:14px}
          .k{font-size:11px;text-transform:uppercase;opacity:.65}
          .v{font-size:22px;font-weight:600;margin-top:4px}
          li{margin:4px 0} code{color:var(--vscode-textPreformat-foreground)}
        </style></head><body>
          <h2>🧠 ProjectMind Report</h2>
          <div class="grid">
            <div class="card"><div class="k">Total Files</div><div class="v">${fin(scale.totalFiles)}</div></div>
            <div class="card"><div class="k">Agent Coverage</div><div class="v">${(fin(scale.agentCoverage)*100).toFixed(1)}%</div></div>
            <div class="card"><div class="k">Avg Cognitive Load</div><div class="v">${fin(scale.avgCognitiveLoad).toFixed(3)}</div></div>
            <div class="card"><div class="k">Genome Score</div><div class="v">${(fin(debt.coherenceGenomeScore)*100).toFixed(1)}%</div></div>
            <div class="card"><div class="k">Debt Items</div><div class="v">${fin(debt.totalItems)}<small> (H:${fin(debt.bySeverity?.high)} M:${fin(debt.bySeverity?.medium)} L:${fin(debt.bySeverity?.low)})</small></div></div>
          </div>
          <h3>Top Hotspots</h3>
          ${hotspots.length ? `<ul>${hotspots.map((h) => `<li><code>${String(h.path ?? '').replace(/</g, '&lt;')}</code> — load ${fin(h.cognitiveLoad).toFixed(3)}${h.agentTouched ? ' · agent-touched' : ''}</li>`).join('')}</ul>`
            : '<p>No hotspots yet — run <b>Scan Project</b> first.</p>'}
        </body></html>`;
      } catch (e) {
        panel.webview.html = `<html><body style="padding:24px;font-family:sans-serif">
          <h3>Report failed</h3><p>${String(e instanceof Error ? e.message : e).replace(/</g, '&lt;')}</p>
          <p>Make sure the CLI is installed and run <b>Scan Project</b>.</p></body></html>`;
      }
    })
  );

  // Check Coherence
  context.subscriptions.push(
    vscode.commands.registerCommand('projectmind.checkCoherence', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
      }
      const code = editor.document.getText();
      const filePath = editor.document.uri.fsPath;
      try {
        const result = await mcpClient.callTool('check_coherence', { code, filePath });
        const report = JSON.parse(result.content[0]?.text || '{}');
        vscode.window.showInformationMessage(`Coherence: ${report.verdict} (confidence: ${report.confidence})`);
      } catch (e) {
        vscode.window.showErrorMessage(`Coherence check failed: ${e}`);
      }
    })
  );

  // Find Similar
  context.subscriptions.push(
    vscode.commands.registerCommand('projectmind.findSimilar', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const filePath = editor.document.uri.fsPath;
      try {
        // The server exposes embedding-based similarity via get_context's
        // includeSimilar flag ('find_similar' is not a registered tool).
        const result = await mcpClient.callTool('get_context', {
          filePath,
          includeImports: false,
          includeDependents: false,
          includeSimilar: true,
          limit: 5,
        });
        const report = JSON.parse(result.content[0]?.text || '{}');
        const similar: Array<{ path?: string; cognitiveLoad?: number }> = report.similarFiles ?? [];
        if (similar.length === 0) {
          vscode.window.showInformationMessage('ProjectMind: No similar files found. Run a scan first.');
        } else {
          const preview = similar.slice(0, 3).map((f) => f.path).join(', ');
          vscode.window.showInformationMessage(
            `ProjectMind: ${similar.length} similar file(s) — ${preview}${similar.length > 3 ? '…' : ''}`
          );
        }
      } catch (e) {
        vscode.window.showErrorMessage(`Find similar failed: ${e}`);
      }
    })
  );

  // Show Impact
  context.subscriptions.push(
    vscode.commands.registerCommand('projectmind.showImpact', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const filePath = editor.document.uri.fsPath;
      try {
        const result = await mcpClient.callTool('analyze_impact', { filePath });
        const report = JSON.parse(result.content[0]?.text || '{}');
        vscode.window.showInformationMessage(`Impact: ${report.affectedFiles || 0} files affected`);
      } catch (e) {
        vscode.window.showErrorMessage(`Impact analysis failed: ${e}`);
      }
    })
  );
}
