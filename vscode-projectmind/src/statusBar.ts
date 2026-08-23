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
   * Update the status bar with scan results. Values are sanitized so a
   * malformed upstream payload can never render 'NaN'.
   */
  updateMetrics(files: number, coverage: number, load: number): void {
    const safe = (v: unknown, fallback = 0): number => {
      const n = typeof v === 'string' ? Number(v) : v;
      return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
    };
    const safeFiles = Math.max(0, Math.round(safe(files)));
    const coveragePct = safe(coverage) * 100;
    const safeLoad = safe(load);
    this.statusBarItem.text = `$(brain) PM ${safeFiles} | ${coveragePct.toFixed(1)}% | load: ${safeLoad.toFixed(2)}`;
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
