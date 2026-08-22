import * as vscode from 'vscode';

/**
 * Manages the VS Code status bar items for ProjectMind.
 */
export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.text = "$(brain) ProjectMind";
    this.statusBarItem.tooltip = "ProjectMind: Click for report";
    this.statusBarItem.command = "projectmind.showReport";
    this.statusBarItem.show();
    context.subscriptions.push(this.statusBarItem);
  }

  /**
   * Update the status bar with scan results.
   */
  updateMetrics(files: number, coverage: number, load: number): void {
    const coveragePercent = (coverage * 100).toFixed(1);
    this.statusBarItem.text = `$(brain) ${files} files | ${coveragePercent}% | load: ${load.toFixed(2)}`;
  }

  /**
   * Show a progress indicator during scanning.
   */
  showProgress(message: string): void {
    this.statusBarItem.text = `$(sync~spin) ProjectMind: ${message}`;
  }

  /**
   * Show an error in the status bar.
   */
  showError(message: string): void {
    this.statusBarItem.text = `$(error) ProjectMind: ${message}`;
  }

  /**
   * Dispose of the status bar item.
   */
  dispose(): void {
    this.statusBarItem.dispose();
  }
}
