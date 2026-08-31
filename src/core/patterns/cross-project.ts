/**
 * Cross-Project Pattern Engine (F4)
 * Pattern extraction, cross-project sync, and embedding-based comparison.
 *
 * F34: types align with the user spec (patternId / originProject /
 * implementationVariants / successMetrics). Legacy abstraction levels map:
 *   'concrete' -> 'idiomatic', 'template' -> 'design', 'abstract' -> 'architectural'
 * (see types.ts header; normalizeAbstractionLevel accepts both on write).
 *
 * F35: syncPatternToProject no longer creates the patterns table ad-hoc; the
 * table must exist (created by normal schema init, which includes the
 * UNIQUE(code_hash, name) constraint). A missing table throws a clear error.
 *
 * F36: the engine REQUIRES an explicit database (DatabaseSync or file path).
 * There is NO initDatabase('projectmind.db') fallback — tests pass a temp DB
 * or ':memory:', production passes the shared connection.
 *
 * F37: similarity confidence is the actual cosine score (never hardcoded);
 * project ids are treated as strings (bound as-is, no parseInt); stored
 * patterns are reconstructed with their REAL abstractTemplate (code_hash
 * stores the canonical serialized template — see extractPatterns).
 *
 * ABSTRACT EXTRACTION NOTE (see also abstract-extraction-notes.md):
 * AST interface/method signatures are generalized by extracting `interface`
 * declarations, collecting `methodSignatures` from `PropertySignature` nodes
 * (name + type), and building `abstractTemplate` by stripping concrete
 * implementations (removing class bodies, keeping only interface contracts).
 * This creates language-agnostic templates.
 */

import type {
  LearnedPattern,
  PatternGraph,
  PatternMatch,
  PatternVariant,
  PatternSuccessMetrics,
  AbstractTemplate,
  AbstractionLevel,
  AbstractionLevelInput,
  LegacyAbstractionLevel,
} from './types.js';
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../storage/schema.js';

/**
 * F34 mapping: legacy enum values -> spec values. Documented and stable so
 * existing rows/inputs keep their meaning.
 */
export const LEGACY_ABSTRACTION_LEVEL_MAP: Record<LegacyAbstractionLevel, AbstractionLevel> = {
  concrete: 'idiomatic',
  template: 'design',
  abstract: 'architectural',
};

/** Accepts spec levels and deprecated legacy aliases (F34). */
export function normalizeAbstractionLevel(level: AbstractionLevelInput): AbstractionLevel {
  return LEGACY_ABSTRACTION_LEVEL_MAP[level as LegacyAbstractionLevel] ?? (level as AbstractionLevel);
}

/** F34: default success metrics for freshly extracted/synced patterns. */
export function defaultSuccessMetrics(): PatternSuccessMetrics {
  return { usedInProjects: 1, testCoverage: 0, bugRate: 0 };
}

export interface CrossProjectPatternEngineOptions {
  /**
   * Similarity threshold. Default depends on the embedding source (F37):
   * 0.85 with real embeddings, 0.6 with the 16-dim hash fallback (whose
   * matches are additionally marked low-confidence).
   */
  similarityThreshold?: number;
  maxVariants?: number;
  /**
   * True when the caller wires a real embedding provider. With the built-in
   * 16-dim hash fallback (default) the threshold default is lowered and
   * matches are marked low-confidence.
   */
  useRealEmbeddings?: boolean;
}

interface PatternInit {
  id: string;
  name: string;
  category: string;
  description: string;
  codeHash: string;
  confidence: number;
  firstSeen: string;
  lastSeen: string;
  usageCount: number;
  embedding: number[] | null;
  projectId: string | null;
  abstractionLevel: AbstractionLevelInput;
  abstractTemplate: AbstractTemplate;
  variants: PatternVariant[];
  successMetrics?: PatternSuccessMetrics;
}

/** Fill the F34 spec fields (aliases + defaults) around a pattern core. */
export function buildPattern(init: PatternInit): LearnedPattern {
  return {
    id: init.id,
    patternId: init.id,
    name: init.name,
    category: init.category,
    description: init.description,
    codeHash: init.codeHash,
    confidence: init.confidence,
    firstSeen: init.firstSeen,
    lastSeen: init.lastSeen,
    usageCount: init.usageCount,
    embedding: init.embedding,
    projectId: init.projectId,
    originProject: init.projectId ?? '',
    abstractionLevel: normalizeAbstractionLevel(init.abstractionLevel),
    abstractTemplate: init.abstractTemplate,
    variants: init.variants,
    implementationVariants: init.variants,
    successMetrics: init.successMetrics ?? defaultSuccessMetrics(),
  };
}

const SCAN_EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'build']);

function scanTsFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && !SCAN_EXCLUDED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        results.push(...scanTsFiles(full));
      } else if (entry.isFile() && extname(entry.name) === '.ts' && !entry.name.endsWith('.d.ts')) {
        results.push(full);
      }
    }
  } catch {
    // ignore unreadable dirs
  }
  return results;
}

/**
 * 16-dim bag-of-words hash embedding — the FALLBACK used when no real
 * embedding provider is wired (F37). Deterministic, dependency-free.
 */
export function computeBagOfWordsEmbedding(template: AbstractTemplate): number[] {
  const text = JSON.stringify(template);
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const vec = new Array<number>(16).fill(0);
  for (const w of words) {
    let h = 0;
    for (let i = 0; i < w.length; i++) {
      h = (((h << 5) - h + w.charCodeAt(i)) | 0) % 2147483647;
    }
    const idx = Math.abs(h) % 16;
    vec[idx] += 1;
  }
  const max = Math.max(...vec, 1);
  return vec.map((v) => v / max);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let n1 = 0;
  let n2 = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    n1 += a[i] * a[i];
    n2 += b[i] * b[i];
  }
  if (n1 === 0 || n2 === 0) return 0;
  return dot / (Math.sqrt(n1) * Math.sqrt(n2));
}

/**
 * F37: extraction confidence is computed from the quality of the extraction
 * (signature count + embedding coverage) — never a hardcoded constant.
 */
export function extractionConfidence(signatureCount: number, embedding: number[]): number {
  const coverage = embedding.length > 0 ? embedding.filter((v) => v > 0).length / embedding.length : 0;
  return Math.min(0.95, 0.5 + 0.05 * Math.min(signatureCount, 6) + 0.2 * coverage);
}

/**
 * Reconstruct the real abstract template from a stored code_hash.
 * extractPatterns stores the canonical JSON serialization of the template as
 * the code_hash (it doubles as the UNIQUE identity); legacy rows that stored
 * an opaque hash fall back to a name-only template.
 */
export function templateFromCodeHash(codeHash: string, name: string): AbstractTemplate {
  try {
    const parsed: unknown = JSON.parse(codeHash);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as AbstractTemplate).interfaceName === 'string' &&
      Array.isArray((parsed as AbstractTemplate).methodSignatures)
    ) {
      const t = parsed as AbstractTemplate & { parameters?: unknown; returnType?: unknown };
      return {
        interfaceName: t.interfaceName,
        methodSignatures: t.methodSignatures,
        parameters: Array.isArray(t.parameters) ? (t.parameters as string[]) : [],
        returnType: typeof t.returnType === 'string' ? t.returnType : '',
      };
    }
  } catch {
    // opaque hash — fall through
  }
  return { interfaceName: name, methodSignatures: [], parameters: [], returnType: '' };
}

function extractMethodSignatures(
  sourceFile: ts.SourceFile,
  members: ts.NodeArray<ts.ClassElement | ts.TypeElement>
): { signatures: string[]; params: string[]; returnType: string } {
  const signatures: string[] = [];
  const params: string[] = [];
  let returnType = 'void';
  for (const member of members) {
    if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member) || ts.isPropertySignature(member)) {
      const name = (member.name as ts.Identifier)?.text ?? member.name?.getText(sourceFile) ?? 'unknown';
      let sig = name;
      if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
        const paramStrs = member.parameters.map((p) => {
          const pName = (p.name as ts.Identifier)?.text ?? p.name?.getText(sourceFile) ?? 'p';
          const pType = p.type ? p.type.getText(sourceFile) : 'any';
          params.push(`${pName}: ${pType}`);
          return `${pName}: ${pType}`;
        });
        sig += `(${paramStrs.join(', ')})`;
        const ret = member.type ? member.type.getText(sourceFile) : 'void';
        sig += `: ${ret}`;
        if (returnType === 'void' && ret !== 'void') returnType = ret;
      } else if (ts.isPropertySignature(member)) {
        const propType = member.type ? member.type.getText(sourceFile) : 'any';
        sig += `: ${propType}`;
        params.push(`${name}: ${propType}`);
        if (returnType === 'void' && propType !== 'void') returnType = propType;
      }
      signatures.push(sig);
    }
  }
  return { signatures, params, returnType };
}

export class CrossProjectPatternEngine {
  private readonly db: DatabaseSync;
  private readonly ownsDb: boolean;
  private readonly similarityThreshold: number;
  private readonly maxVariants: number;
  private readonly useRealEmbeddings: boolean;

  /**
   * F36: an explicit database is REQUIRED — a DatabaseSync instance or a file
   * path (including ':memory:'). When a path is given the schema is created
   * locally on that connection. The production projectmind.db is never
   * opened implicitly.
   */
  constructor(db: DatabaseSync | string, options?: CrossProjectPatternEngineOptions) {
    if (db === undefined || db === null) {
      throw new Error(
        'CrossProjectPatternEngine requires an explicit database (DatabaseSync instance or file path). ' +
          'The implicit projectmind.db fallback was removed (F36).'
      );
    }
    if (typeof db === 'string') {
      this.db = new DatabaseSync(db);
      this.db.exec(SCHEMA_SQL);
      this.ownsDb = true;
    } else {
      this.db = db;
      this.ownsDb = false;
    }
    this.useRealEmbeddings = options?.useRealEmbeddings ?? false;
    // F37: default threshold depends on the embedding source.
    this.similarityThreshold = options?.similarityThreshold ?? (this.useRealEmbeddings ? 0.85 : 0.6);
    this.maxVariants = options?.maxVariants ?? 10;
  }

  /** Close the connection when the engine opened it from a path. */
  close(): void {
    if (this.ownsDb) {
      try {
        this.db.close();
      } catch {
        // already closed
      }
    }
  }

  /**
   * Extract learned patterns from a project.
   * Scans `.ts` files, parses with TypeScript compiler API, extracts
   * interfaces/classes, and creates abstract-template patterns.
   * F34: patterns carry patternId/originProject/implementationVariants/
   * successMetrics; variants carry language/filePath/signature/embedding.
   * F37: confidence is computed, never hardcoded.
   */
  extractPatterns(projectId: string, projectRoot?: string): LearnedPattern[] {
    const root = projectRoot ?? '.';
    const files = scanTsFiles(root);
    const patterns: LearnedPattern[] = [];
    for (const filePath of files) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
        const relPath = relative(root, filePath);
        ts.forEachChild(sourceFile, (node) => {
          if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
            const name = (node.name as ts.Identifier)?.text ?? 'Anonymous';
            const members = ts.isInterfaceDeclaration(node)
              ? node.members
              : (node.members ?? ([] as unknown as ts.NodeArray<ts.ClassElement>));
            const extracted = extractMethodSignatures(
              sourceFile,
              members as ts.NodeArray<ts.ClassElement | ts.TypeElement>
            );
            const abstractTemplate: AbstractTemplate = {
              interfaceName: name,
              methodSignatures: extracted.signatures,
              parameters: extracted.params,
              returnType: extracted.returnType,
            };
            const embedding = computeBagOfWordsEmbedding(abstractTemplate);
            // Canonical serialized template doubles as the stable identity
            // (UNIQUE(code_hash, name) dedupes cross-project syncs).
            const codeHash = JSON.stringify(abstractTemplate);
            const now = new Date().toISOString();
            const id = `pat-${projectId}-${patterns.length + 1}`;
            const confidence = extractionConfidence(extracted.signatures.length, embedding);
            const variant: PatternVariant = {
              id: `${id}-v1`,
              projectId,
              codeHash,
              embedding,
              confidence,
              firstSeen: now,
              lastSeen: now,
              usageCount: 1,
              language: 'typescript',
              filePath: relPath,
              signature: extracted.signatures.join('; ') || name,
            };
            patterns.push(
              buildPattern({
                id,
                name,
                category: ts.isInterfaceDeclaration(node) ? 'interface' : 'class',
                description: `Abstract template extracted from ${relPath}`,
                codeHash,
                confidence,
                firstSeen: now,
                lastSeen: now,
                usageCount: 1,
                embedding,
                projectId,
                // Legacy extraction used 'template' — mapped to 'design' (F34).
                abstractionLevel: 'template',
                abstractTemplate,
                variants: [variant].slice(0, this.maxVariants),
              })
            );
          }
        });
      } catch {
        // Skip unparseable files
      }
    }
    return patterns;
  }

  /**
   * Sync a pattern to a target project (cross-project sync).
   * F35: requires the patterns table to exist (normal schema init, including
   * UNIQUE(code_hash, name)); throws a clear error otherwise. Dedup is
   * handled by INSERT OR IGNORE against that constraint.
   * F37: project ids are bound as strings — no parseInt coercion.
   */
  syncPatternToProject(
    patternOrId: LearnedPattern | string,
    targetProjectId: string,
    db?: DatabaseSync
  ): boolean {
    const dbInstance = db ?? this.db;
    const table = dbInstance
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='patterns'")
      .get();
    if (!table) {
      throw new Error(
        'patterns table does not exist — initialize the schema first (initDatabase/DatabaseManager or pass a path to the engine constructor).'
      );
    }

    const pattern = typeof patternOrId === 'string' ? null : patternOrId;
    const name = pattern ? pattern.name : (patternOrId as string);
    const category = pattern ? pattern.category : 'unknown';
    const description = pattern ? pattern.description : '';
    const codeHash = pattern ? pattern.codeHash : JSON.stringify({ id: patternOrId });
    const confidence = pattern ? pattern.confidence : 0.5;
    const embedding = JSON.stringify(pattern ? (pattern.embedding ?? []) : []);
    const firstSeen = pattern ? pattern.firstSeen : new Date().toISOString();
    const lastSeen = new Date().toISOString();
    const usageCount = pattern ? pattern.usageCount : 1;

    const result = dbInstance
      .prepare(
        `INSERT OR IGNORE INTO patterns
           (name, category, description, code_hash, confidence, first_seen, last_seen, usage_count, embedding, project_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        name,
        category,
        description,
        codeHash,
        confidence,
        firstSeen,
        lastSeen,
        usageCount,
        embedding,
        targetProjectId // string as-is (F37)
      );
    return Number(result.changes) > 0;
  }

  /**
   * Compare two patterns using embedding cosine similarity.
   * Uses real bag-of-words embeddings derived from abstract templates.
   */
  comparePatterns(p1: LearnedPattern, p2: LearnedPattern): number {
    const e1 = p1.embedding ?? computeBagOfWordsEmbedding(p1.abstractTemplate);
    const e2 = p2.embedding ?? computeBagOfWordsEmbedding(p2.abstractTemplate);
    if (e1.length === 0 || e2.length === 0 || e1.length !== e2.length) {
      return this.compareAbstractTemplates(p1.abstractTemplate, p2.abstractTemplate);
    }
    return cosineSimilarity(e1, e2);
  }

  private compareAbstractTemplates(a: AbstractTemplate, b: AbstractTemplate): number {
    const interfaceMatch = a.interfaceName === b.interfaceName ? 0.4 : 0;
    const sigOverlap = this.signatureOverlap(a.methodSignatures, b.methodSignatures);
    return Math.min(1, interfaceMatch + sigOverlap * 0.6);
  }

  private signatureOverlap(s1: string[], s2: string[]): number {
    if (s1.length === 0 || s2.length === 0) return 0;
    const common = s1.filter((x) => s2.includes(x)).length;
    return common / Math.max(s1.length, s2.length);
  }

  /**
   * Find similar patterns in a target project by querying the patterns table.
   * F37: project ids are strings; confidence is the ACTUAL cosine score;
   * stored patterns are reconstructed with their real abstractTemplate;
   * hash-fallback matches are marked low-confidence.
   */
  findSimilarPatternsInProject(
    queryPattern: LearnedPattern,
    targetProjectId: string,
    db?: DatabaseSync
  ): PatternMatch[] {
    const dbInstance = db ?? this.db;
    const rows = dbInstance
      .prepare('SELECT * FROM patterns WHERE project_id = ?')
      .all(targetProjectId) as Array<Record<string, unknown>>;

    const queryEmb = queryPattern.embedding ?? computeBagOfWordsEmbedding(queryPattern.abstractTemplate);
    const results: PatternMatch[] = [];

    for (const row of rows) {
      const rowHash = (row.code_hash as string) ?? '';
      const rowName = (row.name as string) ?? '';
      let rowEmb: number[] = [];
      try {
        rowEmb = JSON.parse((row.embedding as string) ?? '[]') as number[];
      } catch {
        rowEmb = [];
      }

      const template = templateFromCodeHash(rowHash, rowName);

      let similarity: number;
      if (rowHash.length > 0 && rowHash === queryPattern.codeHash) {
        similarity = 1; // identical template
      } else if (queryEmb.length > 0 && rowEmb.length > 0 && queryEmb.length === rowEmb.length) {
        similarity = cosineSimilarity(queryEmb, rowEmb);
      } else {
        similarity = this.compareAbstractTemplates(queryPattern.abstractTemplate, template);
      }

      if (similarity >= this.similarityThreshold) {
        const rowProjectId = row.project_id;
        const pattern = buildPattern({
          id: `pat-db-${String(row.id)}`,
          name: rowName,
          category: (row.category as string) ?? '',
          description: (row.description as string) ?? '',
          codeHash: rowHash,
          confidence: similarity, // F37: computed, never hardcoded
          firstSeen: (row.first_seen as string) ?? new Date().toISOString(),
          lastSeen: (row.last_seen as string) ?? new Date().toISOString(),
          usageCount: (row.usage_count as number) ?? 0,
          embedding: rowEmb.length > 0 ? rowEmb : null,
          projectId: rowProjectId === null || rowProjectId === undefined ? null : String(rowProjectId),
          abstractionLevel: 'template',
          abstractTemplate: template, // F37: real template, not empty
          variants: [],
        });
        results.push({
          ...pattern,
          similarity,
          lowConfidence: !this.useRealEmbeddings,
        });
      }
    }
    return results;
  }

  /**
   * Build a PatternGraph from patterns with similarity edges.
   */
  buildGraph(patterns: LearnedPattern[], originProjectId?: string): PatternGraph {
    const nodes = patterns;
    const edges: PatternGraph['edges'] = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const sim = this.comparePatterns(nodes[i], nodes[j]);
        if (sim >= this.similarityThreshold) {
          edges.push({ from: nodes[i].id, to: nodes[j].id, similarity: sim });
        }
      }
    }
    return { nodes, edges, originProjectId: originProjectId ?? null };
  }
}
