import * as vscode from 'vscode';
import { MCPClient } from './mcpClient';

/**
 * Manages inline diagnostics for ProjectMind coherence issues.
 */
export class DiagnosticManager {
  private diagnosticCollection: vscode.DiagnosticCollection;
  private mcpClient: MCPClient;

  constructor(mcpClient: MCPClient) {
    this.mcpClient = mcpClient;
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection('projectmind');
  }

  /**
   * Run coherence check on a file and display diagnostics.
   */
  async checkFile(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== 'file') {
      return;
    }

    const config = vscode.workspace.getConfiguration('projectmind');
    if (!config.get('showInlineHints', true)) {
      return;
    }

    const code = document.getText();
    const filePath = document.uri.fsPath;

    try {
      const result = await this.mcpClient.callTool('check_coherence', {
        code,
        filePath,
        fastOnly: true,
      });
      const report = JSON.parse(result.content[0]?.text || '{}');

      const diagnostics: vscode.Diagnostic[] = [];

      if (report.verdict === 'fail' || report.verdict === 'warn') {
        const severity = report.verdict === 'fail'
          ? vscode.DiagnosticSeverity.Error
          : vscode.DiagnosticSeverity.Warning;

        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 0),
          `ProjectMind: ${report.reasoningTrace?.[0] || 'Coherence issue detected'}`,
          severity
        );
        diagnostic.source = 'ProjectMind';
        diagnostic.code = 'coherence';
        diagnostics.push(diagnostic);
      }

      this.diagnosticCollection.set(document.uri, diagnostics);
    } catch {
      // Silently ignore errors to avoid disrupting the editor
    }
  }

  /**
   * Clear diagnostics for a file.
   */
  clearFile(uri: vscode.Uri): void {
    this.diagnosticCollection.delete(uri);
  }

  /**
   * Clear all diagnostics.
   */
  clearAll(): void {
    this.diagnosticCollection.clear();
  }

  /**
   * Dispose of the diagnostic collection.
   */
  dispose(): void {
    this.diagnosticCollection.dispose();
  }
}
