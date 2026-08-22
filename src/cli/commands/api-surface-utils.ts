import { logger } from '@/cli/utils/shared.js';

export interface ExportedSymbol {
  name: string;
  type: 'function' | 'class' | 'interface' | 'type' | 'const' | 'enum';
  filePath: string;
  relativePath: string;
  signature?: string;
  isDefault?: boolean;
  isAsync?: boolean;
  params?: string;
  returnType?: string;
  extends?: string;
  implements?: string[];
  deprecated?: boolean;
  since?: string;
}

export interface ApiDiff {
  added: ExportedSymbol[];
  removed: ExportedSymbol[];
  changed: { old: ExportedSymbol; new: ExportedSymbol; changes: string[] }[];
  breaking: ExportedSymbol[];
}

export async function extractApiSurface(files: any[], _projectRoot: string): Promise<ExportedSymbol[]> {
  const { readFileSync } = await import('node:fs');
  const symbols: ExportedSymbol[] = [];
  
  for (const file of files) {
    try {
      const content = readFileSync(file.path, 'utf-8');
      const extracted = extractExportsFromFile(content, file.path, file.relativePath);
      symbols.push(...extracted);
    } catch (_e) {
      logger.warn(`Skipping unreadable file in API surface scan: ${file.path}`);
    }
  }
  
  return symbols;
}

export function extractExportsFromFile(content: string, filePath: string, relativePath: string): ExportedSymbol[] {
  const symbols: ExportedSymbol[] = [];
  
  // Functions
  const funcRegex = /(?:^\s*\/\*\*[\s\S]*?\*\/\s*)?export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*([^{]+))?/gm;
  let match;
  while ((match = funcRegex.exec(content)) !== null) {
    const doc = match[0].includes('/**') ? extractDocstring(match[0]) : undefined;
    const deprecated = doc?.includes('@deprecated') || false;
    const since = extractSince(doc);
    symbols.push({
      name: match[1],
      type: 'function',
      filePath,
      relativePath,
      signature: `${match[1]}(${match[2] || ''})${match[3] ? `: ${match[3].trim()}` : ''}`,
      isAsync: match[0].includes('async'),
      params: match[2],
      returnType: match[3]?.trim(),
      deprecated,
      since,
    });
  }
  
  // Classes
  const classRegex = /(?:^\s*\/\*\*[\s\S]*?\*\/\s*)?export\s+(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?/gm;
  while ((match = classRegex.exec(content)) !== null) {
    const doc = match[0].includes('/**') ? extractDocstring(match[0]) : undefined;
    const deprecated = doc?.includes('@deprecated') || false;
    const since = extractSince(doc);
    symbols.push({
      name: match[1],
      type: 'class',
      filePath,
      relativePath,
      signature: `class ${match[1]}${match[2] ? ` extends ${match[2]}` : ''}${match[3] ? ` implements ${match[3].trim()}` : ''}`,
      extends: match[2],
      implements: match[3] ? match[3].split(',').map(s => s.trim()) : [],
      deprecated,
      since,
    });
  }
  
  // Interfaces
  const interfaceRegex = /(?:^\s*\/\*\*[\s\S]*?\*\/\s*)?export\s+interface\s+(\w+)(?:\s+extends\s+([^{]+))?/gm;
  while ((match = interfaceRegex.exec(content)) !== null) {
    const doc = match[0].includes('/**') ? extractDocstring(match[0]) : undefined;
    const deprecated = doc?.includes('@deprecated') || false;
    const since = extractSince(doc);
    symbols.push({
      name: match[1],
      type: 'interface',
      filePath,
      relativePath,
      signature: `interface ${match[1]}${match[2] ? ` extends ${match[2].trim()}` : ''}`,
      extends: match[2],
      deprecated,
      since,
    });
  }
  
  // Type aliases
  const typeRegex = /export\s+type\s+(\w+)\s*=/gm;
  while ((match = typeRegex.exec(content)) !== null) {
    symbols.push({
      name: match[1],
      type: 'type',
      filePath,
      relativePath,
    });
  }
  
  // Const exports (including arrow functions)
  const constRegex = /export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::\s*([^=]+))?\s*=>/gm;
  while ((match = constRegex.exec(content)) !== null) {
    symbols.push({
      name: match[1],
      type: 'const',
      filePath,
      relativePath,
      signature: `const ${match[1]} = (${match[2] || ''})${match[3] ? `: ${match[3].trim()}` : ''} =>`,
      isAsync: match[0].includes('async'),
      params: match[2],
      returnType: match[3]?.trim(),
    });
  }
  
  // Enums
  const enumRegex = /export\s+enum\s+(\w+)/gm;
  while ((match = enumRegex.exec(content)) !== null) {
    symbols.push({
      name: match[1],
      type: 'enum',
      filePath,
      relativePath,
    });
  }
  
  return symbols;
}

export function extractDocstring(text: string): string {
  const match = text.match(/\/\*\*([\s\S]*?)\*\//);
  return match ? match[1].trim() : '';
}

export function extractSince(doc?: string): string | undefined {
  if (!doc) return undefined;
  const match = doc.match(/@since\s+(\S+)/);
  return match ? match[1] : undefined;
}

export async function getApiAtRef(_ref: string, _projectRoot: string): Promise<ExportedSymbol[]> {
  // Try to use git show to get files at ref
  // For now, return empty array (would need git integration)
  // This is a placeholder for git integration
  return [];
}

export function computeDiff(base: ExportedSymbol[], current: ExportedSymbol[]): ApiDiff {
  const baseMap = new Map(base.map(s => [`${s.type}:${s.name}`, s]));
  const currentMap = new Map(current.map(s => [`${s.type}:${s.name}`, s]));
  
  const added: ExportedSymbol[] = [];
  const removed: ExportedSymbol[] = [];
  const changed: ApiDiff['changed'] = [];
  const breaking: ExportedSymbol[] = [];
  
  // Find added and changed
  for (const [key, currentSym] of currentMap) {
    const baseSym = baseMap.get(key);
    if (!baseSym) {
      added.push(currentSym);
    } else {
      const changes = compareSymbols(baseSym, currentSym);
      if (changes.length > 0) {
        changed.push({ old: baseSym, new: currentSym, changes });
        if (isBreakingChange(changes)) {
          breaking.push(currentSym);
        }
      }
    }
  }
  
  // Find removed
  for (const [key, baseSym] of baseMap) {
    if (!currentMap.has(key)) {
      removed.push(baseSym);
      breaking.push(baseSym); // Removals are breaking
    }
  }
  
  return { added, removed, changed, breaking };
}

export function compareSymbols(old: ExportedSymbol, _newSym: ExportedSymbol): string[] {
  const changes: string[] = [];
  
  if (old.type !== _newSym.type) changes.push(`type: ${old.type} → ${_newSym.type}`);
  if (old.signature !== _newSym.signature) changes.push(`signature changed`);
  if (old.isAsync !== _newSym.isAsync) changes.push(`async: ${old.isAsync} → ${_newSym.isAsync}`);
  if (old.params !== _newSym.params) changes.push(`parameters changed`);
  if (old.returnType !== _newSym.returnType) changes.push(`return type: ${old.returnType} → ${_newSym.returnType}`);
  if (old.extends !== _newSym.extends) changes.push(`extends: ${old.extends} → ${_newSym.extends}`);
  if (JSON.stringify(old.implements) !== JSON.stringify(_newSym.implements)) changes.push(`implements changed`);
  if (old.deprecated !== _newSym.deprecated) changes.push(`deprecated: ${old.deprecated} → ${_newSym.deprecated}`);
  
  return changes;
}

export function isBreakingChange(changes: string[]): boolean {
  // Removals, signature changes, type changes, removing async, changing return types
  return changes.some(c => 
    c.includes('type:') || 
    c.includes('signature changed') || 
    c.includes('parameters changed') ||
    c.includes('return type') ||
    c.includes('deprecated: false → true')
  );
}

export function getBreakingReason(_sym: ExportedSymbol): string {
  // Would need to track what changed
  return 'Signature or type changed (check diff)';
}

export function generateMarkdownReport(current: ExportedSymbol[], diff: ApiDiff | null, hasBase: boolean): string {
  const lines = [
    '# API Surface Report',
    '',
    `Generated: ${new Date().toISOString().split('T')[0]}`,
    `Total Exports: ${current.length}`,
    '',
    '## Current API Surface',
    '',
  ];
  
  const byType = current.reduce((acc, sym) => {
    if (!acc[sym.type]) acc[sym.type] = [];
    acc[sym.type].push(sym);
    return acc;
  }, {} as Record<string, ExportedSymbol[]>);
  
  for (const [type, symbols] of Object.entries(byType)) {
    lines.push(`### ${type.charAt(0).toUpperCase() + type.slice(1)}s (${symbols.length})`, '');
    for (const sym of symbols) {
      const dep = sym.deprecated ? ' ⚠️ **DEPRECATED**' : '';
      const def = sym.isDefault ? ' *(default)*' : '';
      const sig = sym.signature ? `\`${sym.signature}\`` : '';
      lines.push(`- **${sym.name}**${def}${dep} ${sig}`);
      lines.push(`  - File: \`${sym.relativePath}\``);
      if (sym.deprecated) lines.push(`  - ⚠️ **DEPRECATED**`);
      if (sym.since) lines.push(`  - Since: ${sym.since}`);
      lines.push('');
    }
  }
  
  if (diff && hasBase) {
    lines.push('## API Diff', '');
    
    if (diff.added.length > 0) {
      lines.push(`### Added (${diff.added.length})`, '');
      for (const sym of diff.added) {
        lines.push(`- **+ ${sym.name}** (\`${sym.relativePath}\`)`);
      }
      lines.push('');
    }
    
    if (diff.removed.length > 0) {
      lines.push(`### Removed (${diff.removed.length})`, '');
      for (const sym of diff.removed) {
        lines.push(`- **- ${sym.name}** (\`${sym.relativePath}\`) 💥 BREAKING`);
      }
      lines.push('');
    }
    
    if (diff.changed.length > 0) {
      lines.push(`### Changed (${diff.changed.length})`, '');
      for (const { old, changes } of diff.changed) {
        lines.push(`- **~ ${old.name}** (\`${old.relativePath}\`): ${changes.join(', ')}`);
      }
      lines.push('');
    }
    
    if (diff.breaking.length > 0) {
      lines.push(`### ⚠️ Breaking Changes (${diff.breaking.length})`, '');
      for (const sym of diff.breaking) {
        lines.push(`- **! ${sym.name}** (\`${sym.relativePath}\`)`);
      }
      lines.push('');
    }
  }
  
  return lines.join('\n');
}
