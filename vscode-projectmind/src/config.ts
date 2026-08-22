import * as vscode from 'vscode';

/**
 * Configuration keys for ProjectMind extension.
 */
export interface ProjectMindConfig {
  autoScan: boolean;
  scanOnSave: boolean;
  showInlineHints: boolean;
  mcpServerPath: string;
  embeddingsProvider: string;
  offline: boolean;
}

/**
 * Get the current ProjectMind configuration from VS Code settings.
 */
export function getConfig(): ProjectMindConfig {
  const config = vscode.workspace.getConfiguration('projectmind');
  return {
    autoScan: config.get('autoScan', true),
    scanOnSave: config.get('scanOnSave', true),
    showInlineHints: config.get('showInlineHints', true),
    mcpServerPath: config.get('mcpServerPath', 'projectmind'),
    embeddingsProvider: config.get('embeddingsProvider', 'transformers'),
    offline: config.get('offline', false),
  };
}

/**
 * Update a ProjectMind configuration value.
 */
export async function setConfig<K extends keyof ProjectMindConfig>(
  key: K,
  value: ProjectMindConfig[K]
): Promise<void> {
  const config = vscode.workspace.getConfiguration('projectmind');
  await config.update(key, value, vscode.ConfigurationTarget.Workspace);
}

/**
 * Check if the ProjectMind MCP server is available.
 */
export async function isServerAvailable(serverPath: string): Promise<boolean> {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    await execAsync(`${serverPath} --version`);
    return true;
  } catch {
    return false;
  }
}
