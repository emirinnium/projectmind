import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import { getDatabase } from '../../storage/database.js';
import { SCHEMA_SQL } from '../../storage/schema.js';
import { FileStructure } from '../ast-parser.js';
import { codeToEmbedding, cosineSimilarity } from '../legacy-embeddings.js';

export interface Pattern {
  id: number;
  name: string;
  category: string;
  description: string;
  codeHash: string;
  confidence: number;
  usageCount: number;
  firstSeen: string;
  lastSeen: string;
  embedding: number[] | null;
}

export interface PatternViolation {
  id: number;
  patternId: number;
  filePath: string;
  lineNumber: number;
  severity: 'high' | 'medium' | 'low';
  detectedAt: string;
  resolved: boolean;
}

export class PatternLibrary {
  private db: DatabaseSync;
  private patternCache: Pattern[] | null = null;
  private cacheExpiry = 0;
  private readonly CACHE_TTL_MS = 30_000;

  constructor(db?: DatabaseSync) {
    this.db = db ?? getDatabase();
    this.db.exec(SCHEMA_SQL);
  }

  extractPatterns(fileStruct: FileStructure): Pattern[] {
    const patterns: Pattern[] = [];
    const hash = fileStruct.hash;

    const namingPatterns = this.extractNamingPatterns(fileStruct);
    patterns.push(...namingPatterns);

    const importPatterns = this.extractImportPatterns(fileStruct);
    patterns.push(...importPatterns);

    const structurePatterns = this.extractStructurePatterns(fileStruct);
    patterns.push(...structurePatterns);

    // Invalidate cache after writing new patterns
    this.patternCache = null;

    for (const p of patterns) {
      this.storePattern(p, hash);
    }

    return patterns;
  }

  private extractNamingPatterns(file: FileStructure): Pattern[] {
    const patterns: Pattern[] = [];

    for (const fn of file.functions) {
      if (fn.name === 'anonymous') continue;
      const convention = this.detectNamingConvention(fn.name);
      // Higher confidence for standard conventions
      const confidence =
        convention === 'unknown'
          ? 0.5
          : convention.includes('camel') || convention.includes('Pascal')
            ? 0.9
            : 0.85;
      patterns.push({
        id: 0,
        name: fn.name,
        category: 'naming',
        description: `Function naming: ${convention}`,
        codeHash: file.hash,
        confidence,
        usageCount: 1,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        embedding: codeToEmbedding(fn.signature),
      });
    }

    return patterns;
  }

  private extractImportPatterns(file: FileStructure): Pattern[] {
    const patterns: Pattern[] = [];
    const importSources = file.imports.map((i) => i.source);

    // Higher confidence for consistent import style
    const hasRelative = importSources.some((s) => s.startsWith('.'));
    const hasAbsolute = importSources.some((s) => s.startsWith('@/') || s.startsWith('#'));
    const hasNodeBuiltin = importSources.some((s) => s.startsWith('node:'));
    const hasExternal = importSources.some(
      (s) =>
        !s.startsWith('.') && !s.startsWith('@/') && !s.startsWith('#') && !s.startsWith('node:'),
    );

    let confidence = 0.7;
    if (hasRelative && !hasAbsolute && !hasExternal) confidence = 0.9; // Pure relative
    if (hasAbsolute && !hasRelative) confidence = 0.95; // Pure path aliases
    if (hasNodeBuiltin) confidence = Math.max(confidence, 0.9); // Node builtins are good

    patterns.push({
      id: 0,
      name: 'import_style',
      category: 'imports',
      description: `Import sources: ${importSources.join(', ')}`,
      codeHash: file.hash,
      confidence,
      usageCount: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      embedding: codeToEmbedding(importSources.join('\n')),
    });

    return patterns;
  }

  private extractStructurePatterns(file: FileStructure): Pattern[] {
    const patterns: Pattern[] = [];

    const hasClasses = file.classes.length > 0;
    const hasFunctions = file.functions.length > 0;
    const functionDensity = file.functions.length / Math.max(file.lines, 1);

    // Higher confidence for well-structured files
    let confidence = 0.6;
    if (file.lines > 50 && file.lines < 300) confidence = 0.8; // Good file size
    if (hasClasses && hasFunctions) confidence = Math.max(confidence, 0.85); // Mixed structure
    if (functionDensity > 0.05 && functionDensity < 0.3) confidence = Math.max(confidence, 0.8); // Reasonable density
    if (file.imports.length > 0 && file.imports.length < 20)
      confidence = Math.max(confidence, 0.85); // Reasonable imports

    patterns.push({
      id: 0,
      name: 'structure_profile',
      category: 'structure',
      description: `Classes: ${hasClasses ? 'yes' : 'no'}, Functions: ${hasFunctions ? 'yes' : 'no'}, Density: ${functionDensity.toFixed(4)}`,
      codeHash: file.hash,
      confidence,
      usageCount: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      embedding: codeToEmbedding(file.functions.map((f) => f.signature).join('\n')),
    });

    // Add complexity pattern
    const complexity = file.functions.length + file.classes.length * 2;
    patterns.push({
      id: 0,
      name: 'complexity',
      category: 'structure',
      description: `Complexity score: ${complexity}`,
      codeHash: file.hash,
      confidence: complexity < 20 ? 0.9 : complexity < 50 ? 0.7 : 0.5,
      usageCount: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      embedding: codeToEmbedding(String(complexity)),
    });

    return patterns;
  }

  private detectNamingConvention(name: string): string {
    if (name.match(/^[a-z][a-zA-Z0-9]*$/)) return 'camelCase';
    if (name.match(/^[A-Z][a-zA-Z0-9]*$/)) return 'PascalCase';
    if (name.match(/^[a-z][a-z0-9_]*$/)) return 'snake_case';
    if (name.match(/^[A-Z][A-Z0-9_]*$/)) return 'SCREAMING_SNAKE_CASE';
    return 'unknown';
  }

  private storePattern(pattern: Omit<Pattern, 'id'> & { id: number }, codeHash: string): void {
    const existing = this.db
      .prepare('SELECT id, usage_count, last_seen FROM patterns WHERE code_hash = ? AND name = ?')
      .get(codeHash, pattern.name) as
      { id: number; usage_count: number; last_seen: string } | undefined;

    if (existing) {
      this.db
        .prepare(
          'UPDATE patterns SET usage_count = usage_count + 1, last_seen = ?, confidence = MIN(?, 1.0) WHERE id = ?',
        )
        .run(new Date().toISOString(), pattern.confidence, existing.id);
    } else {
      const embedding = pattern.embedding ? JSON.stringify(pattern.embedding) : null;
      this.db
        .prepare(
          `INSERT INTO patterns (name, category, description, code_hash, confidence, first_seen, last_seen, usage_count, embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          pattern.name,
          pattern.category,
          pattern.description,
          pattern.codeHash,
          pattern.confidence,
          new Date().toISOString(),
          new Date().toISOString(),
          1,
          embedding,
        );
    }
  }

  /**
   * Cached version of getPatterns(). Results are cached for CACHE_TTL_MS
   * to avoid repeated full-table SELECTs in hot paths (genome scoring,
   * debt detection). Cache auto-invalidates after extractPatterns().
   */
  getPatterns(): Pattern[] {
    if (this.patternCache && Date.now() < this.cacheExpiry) {
      return this.patternCache;
    }

    const rows = this.db
      .prepare('SELECT * FROM patterns ORDER BY usage_count DESC, last_seen DESC')
      .all() as Record<string, SQLOutputValue>[];
    this.patternCache = rows.map((r) => ({
      id: r.id as number,
      name: r.name as string,
      category: r.category as string,
      description: r.description as string,
      codeHash: r.code_hash as string,
      confidence: r.confidence as number,
      usageCount: r.usage_count as number,
      firstSeen: r.first_seen as string,
      lastSeen: r.last_seen as string,
      embedding: r.embedding ? (JSON.parse(r.embedding as string) as number[]) : null,
    }));
    this.cacheExpiry = Date.now() + this.CACHE_TTL_MS;
    return this.patternCache;
  }

  findViolations(fileStruct: FileStructure): PatternViolation[] {
    const violations: PatternViolation[] = [];
    const patterns = this.getPatterns();

    for (const fn of fileStruct.functions) {
      if (fn.name === 'anonymous') continue;
      const patternEmbedding = codeToEmbedding(fn.signature);

      for (const pattern of patterns) {
        if (!pattern.embedding) continue;
        const sim = cosineSimilarity(patternEmbedding, pattern.embedding);
        if (sim < 0.3 && pattern.category === 'naming') {
          violations.push({
            id: 0,
            patternId: pattern.id,
            filePath: fileStruct.filePath,
            lineNumber: fn.startLine,
            severity: sim < 0.15 ? 'high' : 'medium',
            detectedAt: new Date().toISOString(),
            resolved: false,
          });
        }
      }
    }

    return violations;
  }

  getCoherenceScore(): number {
    const result = this.db
      .prepare('SELECT AVG(confidence) as avg_conf, COUNT(*) as cnt FROM patterns')
      .get() as { avg_conf: number | null; cnt: number };

    if (!result.cnt) return 1.0;
    return result.avg_conf ?? 1.0;
  }
}
