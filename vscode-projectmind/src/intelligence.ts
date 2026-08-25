import * as vscode from 'vscode';
import { MCPClient } from './mcpClient';

/**
 * ProjectMind intelligence surface for the editor:
 *  - CodeLens: file-level stats (dependents / cognitive load / similar files)
 *    plus a one-click "Show Impact" lens backed by analyze_impact.
 *  - Hover: the same context rendered on demand over any line.
 *
 * Data comes from the real MCP server (get_context / analyze_impact) and is
 * cached per file for 60s so typing stays smooth.
 */

interface FileContextSummary {
  dependents: number;
  similar: number;
  cognitiveLoad: number;
  agentTouched: boolean;
  cycles: number;
}

const CACHE_TTL_MS = 60_000;

export class ProjectMindIntelligence implements vscode.CodeLensProvider, vscode.HoverProvider {
  private cache = new Map<string, { at: number; data: FileContextSummary | null }>();

  constructor(private readonly client: MCPClient) {}

  private invalidate(): void {
    const now = Date.now();
    for (const [k, v] of this.cache) {
      if (now - v.at > CACHE_TTL_MS) this.cache.delete(k);
    }
  }

  private async summarize(uri: vscode.Uri): Promise<FileContextSummary | null> {
    this.invalidate();
    const key = uri.fsPath;
    const hit = this.cache.get(key);
    if (hit) return hit.data;

    let data: FileContextSummary | null = null;
    try {
      const result = await this.client.callTool('get_context', {
        filePath: uri.fsPath,
        includeImports: false,
        includeDependents: true,
        includeSimilar: true,
        limit: 5,
      });
      const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
      if (text) {
        const payload = JSON.parse(text) as {
          dependents?: unknown[];
          similarFiles?: unknown[];
          file?: { cognitiveLoad?: number; agentTouched?: boolean };
          circularDependencies?: string[][];
        };
        data = {
          dependents: Array.isArray(payload.dependents) ? payload.dependents.length : 0,
          similar: Array.isArray(payload.similarFiles) ? payload.similarFiles.length : 0,
          cognitiveLoad: payload.file?.cognitiveLoad ?? 0,
          agentTouched: !!payload.file?.agentTouched,
          cycles: Array.isArray(payload.circularDependencies)
            ? payload.circularDependencies.filter((c) => c.includes(uri.fsPath.replace(/\\/g, '/'))).length
            : 0,
        };
      }
    } catch {
      data = null; // server not ready / file unscanned — lenses simply hide
    }

    this.cache.set(key, { at: Date.now(), data });
    return data;
  }

  // ---- CodeLensProvider ----

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!/^\.(ts|tsx|js|jsx|mjs|cjs)$/.test(document.fileName.split('.').pop() ?? '')) return [];
    const summary = await this.summarize(document.uri);
    if (!summary) return [];

    const top = new vscode.Range(0, 0, 0, 0);
    const lenses: vscode.CodeLens[] = [
      new vscode.CodeLens(top, {
        title: `🧠 PM · ${summary.dependents} dependents · load ${summary.cognitiveLoad.toFixed(2)}${summary.agentTouched ? ' · ✍️ agent-touched' : ''}`,
        command: 'projectmind.showImpact',
        arguments: [document.uri],
      }),
    ];
    if (summary.cycles > 0) {
      lenses.push(new vscode.CodeLens(top, { title: `⚠️ ${summary.cycles} cycle(s) involve this file`, command: 'projectmind.showImpact', arguments: [document.uri] }));
    }
    lenses.push(
      new vscode.CodeLens(
        new vscode.Range(new vscode.Position(0, 1), new vscode.Position(0, 1)),
        { title: 'Show Impact', command: 'projectmind.showImpact', arguments: [document.uri] }
      )
    );
    return lenses;
  }

  // ---- HoverProvider ----

  async provideHover(document: vscode.TextDocument): Promise<vscode.Hover | undefined> {
    const summary = await this.summarize(document.uri);
    if (!summary) return undefined;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(
      [
        `**🧠 ProjectMind**`,
        ``,
        `- Dependents: **${summary.dependents}**`,
        `- Similar files: **${summary.similar}**`,
        `- Cognitive load: **${summary.cognitiveLoad.toFixed(3)}**`,
        summary.agentTouched ? '- ✍️ Recently touched by an agent' : '',
        summary.cycles > 0 ? `- ⚠️ Part of ${summary.cycles} dependency cycle(s)` : '',
      ].filter(Boolean).join('\n')
    );
    md.isTrusted = true;
    return new vscode.Hover(md);
  }

  dispose(): void {
    this.cache.clear();
  }
}

/** Registers the providers + the showImpact command. Returns disposables. */
export function registerIntelligence(context: vscode.ExtensionContext, client: MCPClient): vscode.Disposable {
  const intelligence = new ProjectMindIntelligence(client);

  const showImpact = vscode.commands.registerCommand('projectmind.showImpact', async (uri: vscode.Uri) => {
    try {
      const result = await client.callTool('analyze_impact', { filePath: uri.fsPath, changeType: 'modify', tests: true });
      const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '{}';
      const payload = JSON.parse(text) as {
        riskLevel?: string;
        impactedTestCount?: number;
        summary?: { directDependents?: number };
      };
      const choice = await vscode.window.showInformationMessage(
        `🧠 Impact: ${payload.riskLevel?.toUpperCase() ?? '?'} · ${payload.summary?.directDependents ?? 0} direct dependents · ${payload.impactedTestCount ?? 0} impacted test file(s)`,
        'Show Full Report'
      );
      if (choice === 'Show Full Report') {
        const doc = await vscode.workspace.openTextDocument({ content: text, language: 'json' });
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    } catch (e) {
      vscode.window.showErrorMessage(`ProjectMind impact analysis failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  const codeLens = vscode.languages.registerCodeLensProvider(
    [{ language: 'typescript' }, { language: 'javascript' }, { language: 'typescriptreact' }, { language: 'javascriptreact' }],
    intelligence
  );
  const hover = vscode.languages.registerHoverProvider(
    [{ language: 'typescript' }, { language: 'javascript' }, { language: 'typescriptreact' }, { language: 'javascriptreact' }],
    intelligence
  );

  context.subscriptions.push(showImpact, codeLens, hover, intelligence);
  return intelligence;
}
