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

  // Show Report
  context.subscriptions.push(
    vscode.commands.registerCommand('projectmind.showReport', async () => {
      const panel = vscode.window.createWebviewPanel(
        'projectmindReport',
        'ProjectMind Report',
        vscode.ViewColumn.One,
        {}
      );
      panel.webview.html = getReportHtml();
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
      const code = editor.document.getText();
      try {
        const result = await mcpClient.callTool('find_similar', { code });
        vscode.window.showInformationMessage('ProjectMind: Similar code search complete');
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

/**
 * Generate HTML for the report webview.
 */
function getReportHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>ProjectMind Report</title>
  <style>
    body { font-family: sans-serif; padding: 20px; }
    .metric { margin: 10px 0; padding: 10px; background: #f0f0f0; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>ProjectMind Report</h1>
  <div class="metric">Loading...</div>
</body>
</html>`;
}
