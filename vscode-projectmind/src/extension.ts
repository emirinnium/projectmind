import * as vscode from 'vscode';
import { MCPClient } from './mcpClient';
import { StatusBarManager } from './statusBar';
import { registerCommands } from './commands';

let mcpClient: MCPClient | null = null;
let statusBar: StatusBarManager | null = null;

export async function activate(context: vscode.ExtensionContext) {
  console.log('ProjectMind extension activated');

  // Initialize MCP client
  mcpClient = new MCPClient();
  
  // Initialize status bar
  statusBar = new StatusBarManager(context);

  // Register commands
  registerCommands(context, mcpClient, statusBar);

  // Auto-scan on startup if enabled
  const config = vscode.workspace.getConfiguration('projectmind');
  if (config.get('autoScan', true)) {
    vscode.commands.executeCommand('projectmind.scanProject');
  }

  // Watch for file saves if enabled
  if (config.get('scanOnSave', true)) {
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme === 'file') {
        vscode.commands.executeCommand('projectmind.scanFile', doc.uri.fsPath);
      }
    });
  }
}

export function deactivate() {
  mcpClient?.dispose();
  statusBar?.dispose();
}
