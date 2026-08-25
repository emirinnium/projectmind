import * as vscode from 'vscode';
import { MCPClient } from './mcpClient';
import { StatusBarManager } from './statusBar';
import { registerCommands } from './commands';
import { DiagnosticManager } from './diagnostics';
import { registerIntelligence } from './intelligence';
import { SidebarPanel } from './sidebar';

let mcpClient: MCPClient | null = null;
let statusBar: StatusBarManager | null = null;
let diagnostics: DiagnosticManager | null = null;

export async function activate(context: vscode.ExtensionContext) {
  console.log('ProjectMind extension activated');

  // Initialize MCP client — pin it to the first workspace folder so the
  // server scans the user's project, not the VS Code installation dir.
  mcpClient = new MCPClient();
  mcpClient.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Initialize status bar
  statusBar = new StatusBarManager(context);

  // Inline coherence diagnostics (previously dead code — now wired)
  diagnostics = new DiagnosticManager(mcpClient);
  context.subscriptions.push({ dispose: () => diagnostics?.dispose() });

  // CodeLens ("N dependents · load X" + Show Impact) and hover intelligence.
  registerIntelligence(context, mcpClient);

  // Register commands
  registerCommands(context, mcpClient, statusBar);

  // Open the ProjectMind sidebar panel
  context.subscriptions.push(
    vscode.commands.registerCommand('projectmind.openSidebar', () => {
      SidebarPanel.createOrShow(mcpClient!);
    })
  );

  const config = vscode.workspace.getConfiguration('projectmind');

  // Inline hints: check the active/saved document through the real MCP server
  if (config.get('showInlineHints', true)) {
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.uri.scheme === 'file') {
          void diagnostics?.checkFile(editor.document);
        }
      })
    );
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        void diagnostics?.checkFile(doc);
      })
    );
  }

  // Auto-scan on startup if enabled
  if (config.get('autoScan', true)) {
    vscode.commands.executeCommand('projectmind.scanProject');
  }

  // Watch for file saves if enabled (subscription is now tracked for disposal)
  if (config.get('scanOnSave', true)) {
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.scheme === 'file') {
          vscode.commands.executeCommand('projectmind.scanFile', doc.uri.fsPath);
        }
      })
    );
  }
}

export function deactivate() {
  mcpClient?.dispose();
  statusBar?.dispose();
  diagnostics?.dispose();
}
