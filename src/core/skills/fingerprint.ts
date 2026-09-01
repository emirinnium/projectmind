/**
 * F3 — Agent Coding Personality & Skill Persistence (Fingerprint-Based Adaptive Skill Profile).
 *
 * AST-based fingerprint extraction using TypeScript compiler API (not regex).
 * Produces a 6-field AgentFingerprint used by the skill engine and profile storage.
 */

import ts from 'typescript';
import type {
  AgentFingerprint,
  FingerprintMeasured,
  ErrorHandlingStyle,
  NamingConvention,
  TestPattern,
} from '../../storage/kg/types.js';

/**
 * Extract the name identifier string from a variable, function, or class declaration.
 * Returns undefined if the declaration has no name (e.g., anonymous function exports).
 */
function getDeclarationName(
  node: ts.VariableDeclaration | ts.FunctionDeclaration | ts.ClassDeclaration,
): string | undefined {
  const name = (node as ts.VariableDeclaration | ts.FunctionDeclaration | ts.ClassDeclaration).name;
  return name && ts.isIdentifier(name) ? name.text : undefined;
}

export interface FileEdit {
  filePath: string;
  oldContent?: string;
  newContent?: string;
  diff?: string;
}

export class AgentFingerprintExtractor {
  /**
   * Extract full fingerprint from source file content via AST traversal.
   */
  extractFromAST(fileContent: string): AgentFingerprint {
    const sourceFile = ts.createSourceFile(
      'fingerprint.ts',
      fileContent,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    let awaitHits = 0;
    let thenHits = 0;
    let assertionCount = 0;
    let totalLines = fileContent.split('\n').length;
    let tryBlocks = 0;
    let dotCatch = 0;
    let throws = 0;
    let resultObjects = 0;
    let camel = 0;
    let snake = 0;
    let pascal = 0;
    let screamingSnake = 0;

    let describeHits = 0;
    let itHits = 0;
    let testHits = 0;

    let interfaceCount = 0;
    let typeAliasCount = 0;
    let genericCount = 0;
    let classCount = 0;

    const visit = (node: ts.Node) => {
      // Async / await
      if (ts.isAwaitExpression(node)) awaitHits++;
      if (ts.isFunctionDeclaration(node) && node.modifiers) {
        for (const mod of node.modifiers) {
          if (mod.kind === ts.SyntaxKind.AsyncKeyword) {
            // async function counted implicitly via await/then ratio
          }
        }
      }
      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'then') {
          thenHits++;
        }
        if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'catch') {
          dotCatch++;
        }
      }

      // Type assertions (as expressions)
      if (ts.isAsExpression(node)) assertionCount++;

      // Try / catch / throw
      if (ts.isTryStatement(node)) tryBlocks++;
      if (ts.isThrowStatement(node)) throws++;

      // Result-object patterns (e.g., { ok, err }) — approximate via object literal with ok/err keys
      if (ts.isObjectLiteralExpression(node)) {
        for (const prop of node.properties) {
          if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
            const name = prop.name.text;
            if (name === 'ok' || name === 'err' || name === 'error') {
              resultObjects++;
            }
          }
        }
      }

      // Naming conventions from declarations
      if (
        ts.isVariableDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)
      ) {
        const name = getDeclarationName(node);
        if (name) {
          if (/^[A-Z]+(?:_[A-Z0-9]+)+$/.test(name)) screamingSnake++;
          else if (/^[a-z]+(?:_[a-z0-9]+)+$/.test(name)) snake++;
          else if (/^[a-z][a-zA-Z0-9]*$/.test(name)) camel++;
          else if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) pascal++;
        }
      }

      // Test patterns
      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        if (ts.isIdentifier(expr)) {
          const text = expr.text;
          if (text === 'describe') describeHits++;
          if (text === 'it') itHits++;
          if (text === 'test') testHits++;
        }
      }

      // Abstractions
      if (ts.isInterfaceDeclaration(node)) interfaceCount++;
      if (ts.isTypeAliasDeclaration(node)) typeAliasCount++;
      if (ts.isClassDeclaration(node)) classCount++;
      if (ts.isTypeParameterDeclaration(node)) genericCount++;

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    // Async preference: await vs then-chain
    const styleDenominator = awaitHits + thenHits;
    const asyncPreference =
      styleDenominator > 0 ? Math.round((awaitHits / styleDenominator) * 100) / 100 : 0.5;

    // Type strictness: assertions per 10 lines, capped at 1.0, plus interface/type density
    const assertionRate = assertionCount / (totalLines / 10 || 1);
    const abstractionDensity = Math.min(1, (interfaceCount + typeAliasCount + genericCount) / 10);
    const typeStrictness = Math.min(
      1,
      Math.round(Math.min(1, assertionRate) * 100) / 100 + abstractionDensity * 0.3,
    );

    // Error handling style
    const errorHandlingStyle = this.classifyErrorHandling(
      tryBlocks,
      dotCatch,
      throws,
      resultObjects,
    );

    // Naming convention
    const namingConvention = this.dominantNaming(camel, snake, pascal, screamingSnake);

    // Test pattern
    const testPattern = this.classifyTestPattern(describeHits, itHits, testHits);

    // Favorite abstractions
    const favoriteAbstractions = this.extractFavoriteAbstractions(
      interfaceCount,
      typeAliasCount,
      genericCount,
      classCount,
    );

    // Measured metadata: track which dimensions were actually measured
    const measured: FingerprintMeasured = {
      asyncPreference: styleDenominator > 0,
      namingConvention: camel + snake + pascal + screamingSnake > 0,
      errorHandlingStyle: tryBlocks + dotCatch + throws + resultObjects > 0,
    };

    return {
      asyncPreference,
      typeStrictness: Math.round(typeStrictness * 100) / 100,
      errorHandlingStyle,
      namingConvention,
      testPattern,
      favoriteAbstractions,
      measured,
    };
  }

  /**
   * Extract partial fingerprint from an edit (new content only, or diff).
   */
  extractFromEdit(edit: FileEdit): Partial<AgentFingerprint> {
    const content = edit.newContent ?? edit.oldContent ?? '';
    if (!content) return {};
    const full = this.extractFromAST(content);
    // For edits, return only fields that changed significantly vs baseline (simplified: return full)
    return full;
  }

  private classifyErrorHandling(
    tryBlocks: number,
    dotCatch: number,
    throws: number,
    resultObjects: number,
  ): ErrorHandlingStyle {
    const styles: Array<[ErrorHandlingStyle, number]> = [
      ['try-catch', tryBlocks],
      ['result-type', dotCatch],
      ['throw', throws],
      ['result-type', resultObjects],
    ];
    const active = styles.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    if (active.length === 0) return 'try-catch';
    if (active.length === 1) return active[0][0];
    return active[0][1] >= active[1][1] * 2 ? active[0][0] : 'mixed';
  }
  private dominantNaming(
    camel: number,
    snake: number,
    pascal: number,
    screamingSnake: number,
  ): NamingConvention {
    const total = camel + snake + pascal + screamingSnake;
    if (total === 0) return 'unknown';
    const entries: Array<[NamingConvention, number]> = [
      ['camelCase', camel],
      ['snake_case', snake],
      ['PascalCase', pascal],
      ['SCREAMING_SNAKE', screamingSnake],
    ];
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][1] >= total * 0.6 ? entries[0][0] : 'mixed';
  }

  private classifyTestPattern(describeHits: number, itHits: number, testHits: number): TestPattern {
    const total = describeHits + itHits + testHits;
    if (total === 0) return 'none';
    if (describeHits > 0 && itHits > 0) return 'bdd';
    if (testHits > 0 && describeHits === 0) return 'unit';
    if (itHits > 0 && describeHits === 0) return 'unit';
    return 'mixed';
  }

  private extractFavoriteAbstractions(
    interfaceCount: number,
    typeAliasCount: number,
    genericCount: number,
    classCount: number,
  ): string[] {
    const abstractions: string[] = [];
    if (interfaceCount > 0) abstractions.push('interface');
    if (typeAliasCount > 0) abstractions.push('type-alias');
    if (genericCount > 0) abstractions.push('generic');
    if (classCount > 0) abstractions.push('class');
    if (abstractions.length === 0) abstractions.push('none');
    return abstractions;
  }
  private hashToken(token: string): number {
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }
}

/** Singleton extractor for reuse across engine and storage layers. */
export const fingerprintExtractor = new AgentFingerprintExtractor();
