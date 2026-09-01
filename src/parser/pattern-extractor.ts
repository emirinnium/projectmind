import { parseFile, detectLanguage, type FileStructure } from './ast-parser.js';
import { PatternLibrary, type PatternViolation } from './patterns/library.js';
import type { Language } from './types.js';

// Re-export for backwards compatibility
export { PatternLibrary } from './patterns/library.js';
export type { Pattern, PatternViolation } from './patterns/library.js';

/**
 * Extended pattern categories beyond what PatternLibrary provides.
 * PatternLibrary handles naming, imports, structure — we add architectural
 * patterns, design patterns, and code smell detection.
 */
export type ExtendedPatternCategory =
  | 'naming'
  | 'imports'
  | 'structure'
  | 'architectural'
  | 'design-pattern'
  | 'code-smell'
  | 'error-handling'
  | 'concurrency'
  | 'type-safety';

export interface ExtendedPattern {
  id: string;
  name: string;
  category: ExtendedPatternCategory;
  description: string;
  filePath: string;
  lineNumber: number;
  confidence: number;
  severity?: 'info' | 'warning' | 'critical';
  suggestion?: string;
}

export interface ExtractionResult {
  filePath: string;
  language: Language;
  patterns: ExtendedPattern[];
  violations: PatternViolation[];
  stats: {
    totalPatterns: number;
    byCategory: Record<string, number>;
    avgConfidence: number;
  };
}

/**
 * Real pattern extractor — parses source files and extracts architectural,
 * design, and structural patterns beyond simple naming/import conventions.
 */
export class PatternExtractor {
  private library: PatternLibrary;

  constructor() {
    this.library = new PatternLibrary();
  }

  /**
   * Extract all patterns from a single file.
   */
  async extractFromFile(filePath: string, content?: string): Promise<ExtractionResult> {
    let fileStruct: FileStructure | null = null;

    if (content) {
      const lang = detectLanguage(filePath);
      fileStruct = await this.parseFromContent(filePath, content, lang);
    } else {
      fileStruct = parseFile(filePath);
    }

    if (!fileStruct) {
      return {
        filePath,
        language: detectLanguage(filePath),
        patterns: [],
        violations: [],
        stats: { totalPatterns: 0, byCategory: {}, avgConfidence: 0 },
      };
    }

    return this.extractFromStructure(fileStruct);
  }

  /**
   * Extract patterns from multiple files (batch mode).
   */
  async extractFromFiles(filePaths: string[]): Promise<ExtractionResult[]> {
    return Promise.all(filePaths.map((fp) => this.extractFromFile(fp)));
  }

  /**
   * Extract patterns from already-parsed FileStructure.
   */
  extractFromStructure(file: FileStructure): ExtractionResult {
    const patterns: ExtendedPattern[] = [];

    // 1. Get base patterns from PatternLibrary
    const basePatterns = this.library.extractPatterns(file);
    const violations = this.library.findViolations(file);

    // Convert base patterns to extended format
    for (const bp of basePatterns) {
      patterns.push({
        id: `base-${bp.id}`,
        name: bp.name,
        category: bp.category as ExtendedPatternCategory,
        description: bp.description,
        filePath: file.filePath,
        lineNumber: 0,
        confidence: bp.confidence,
        severity: 'info',
      });
    }

    // 2. Architectural patterns
    patterns.push(...this.detectArchitecturalPatterns(file));

    // 3. Design patterns
    patterns.push(...this.detectDesignPatterns(file));

    // 4. Code smells
    patterns.push(...this.detectCodeSmells(file));

    // 5. Error handling patterns
    patterns.push(...this.detectErrorHandlingPatterns(file));

    // 6. Concurrency patterns
    patterns.push(...this.detectConcurrencyPatterns(file));

    // 7. Type safety patterns
    patterns.push(...this.detectTypeSafetyPatterns(file));

    // Calculate stats
    const byCategory: Record<string, number> = {};
    let totalConfidence = 0;
    for (const p of patterns) {
      byCategory[p.category] = (byCategory[p.category] || 0) + 1;
      totalConfidence += p.confidence;
    }

    return {
      filePath: file.filePath,
      language: file.language,
      patterns,
      violations,
      stats: {
        totalPatterns: patterns.length,
        byCategory,
        avgConfidence: patterns.length > 0 ? totalConfidence / patterns.length : 0,
      },
    };
  }

  private async parseFromContent(
    filePath: string,
    content: string,
    lang: Language,
  ): Promise<FileStructure | null> {
    try {
      if (lang === 'typescript' || lang === 'javascript') {
        const { parseTypeScriptFile } = await import('./ast/parser.js');
        return parseTypeScriptFile(filePath, content, lang);
      }
      const { parseFileMultilang } = await import('./multilang-parser.js');
      return parseFileMultilang(filePath, content);
    } catch {
      return null;
    }
  }

  /**
   * Detect architectural patterns: MVC, Repository, Service Layer, etc.
   */
  private detectArchitecturalPatterns(file: FileStructure): ExtendedPattern[] {
    const patterns: ExtendedPattern[] = [];
    const path = file.filePath.toLowerCase();

    // Repository pattern (AST-based detection)
    const hasRepositoryInterface = file.classes.some((cls) => {
      return (
        cls.implements.some((impl) => impl.includes('Repository')) ||
        cls.methods.some(
          (method) => method.name === 'find' || method.name === 'save' || method.name === 'delete',
        )
      );
    });

    if (hasRepositoryInterface || path.includes('repository') || path.includes('repo')) {
      patterns.push({
        id: 'arch-repository',
        name: 'Repository Pattern',
        category: 'architectural',
        description: 'Data access abstraction — decouples business logic from persistence',
        filePath: file.filePath,
        lineNumber: hasRepositoryInterface
          ? file.classes.find((cls) => cls.implements.some((impl) => impl.includes('Repository')))
              ?.startLine || 0
          : 0,
        confidence: hasRepositoryInterface ? 0.95 : 0.85,
        severity: 'info',
      });
    }

    // Service Layer
    if (path.includes('service') || path.includes('manager')) {
      patterns.push({
        id: 'arch-service',
        name: 'Service Layer',
        category: 'architectural',
        description: 'Business logic encapsulation in service classes',
        filePath: file.filePath,
        lineNumber: 0,
        confidence: 0.8,
        severity: 'info',
      });
    }

    // Controller
    if (path.includes('controller') || path.includes('handler') || path.includes('route')) {
      patterns.push({
        id: 'arch-controller',
        name: 'Controller/Handler',
        category: 'architectural',
        description: 'Request handling and routing layer',
        filePath: file.filePath,
        lineNumber: 0,
        confidence: 0.8,
        severity: 'info',
      });
    }

    // Adapter/Facade
    if (path.includes('adapter') || path.includes('facade') || path.includes('wrapper')) {
      patterns.push({
        id: 'arch-adapter',
        name: 'Adapter/Facade Pattern',
        category: 'architectural',
        description: 'Interface translation between incompatible systems',
        filePath: file.filePath,
        lineNumber: 0,
        confidence: 0.75,
        severity: 'info',
      });
    }

    // Factory pattern in file structure
    const hasFactory = file.functions.some(
      (f) => f.name.toLowerCase().includes('factory') || f.name.toLowerCase().includes('create'),
    );
    if (hasFactory) {
      patterns.push({
        id: 'arch-factory',
        name: 'Factory Pattern',
        category: 'architectural',
        description: 'Object creation delegation',
        filePath: file.filePath,
        lineNumber: 0,
        confidence: 0.7,
        severity: 'info',
      });
    }

    return patterns;
  }

  /**
   * Detect design patterns: Singleton, Observer, Strategy, etc.
   */
  private detectDesignPatterns(file: FileStructure): ExtendedPattern[] {
    const patterns: ExtendedPattern[] = [];

    // Singleton detection (AST-based)
    for (const cls of file.classes) {
      const hasPrivateConstructor = cls.methods.some(
        (method) => method.name === 'constructor' && method.accessModifier === 'private',
      );
      const hasStaticInstance = cls.properties.some(
        (prop) => prop.name === 'instance' && prop.isStatic,
      );
      const hasGetInstanceMethod = cls.methods.some(
        (method) => method.name === 'getInstance' && method.isStatic,
      );

      if (
        (hasPrivateConstructor && hasStaticInstance && hasGetInstanceMethod) ||
        cls.name.toLowerCase().includes('singleton')
      ) {
        patterns.push({
          id: 'design-singleton',
          name: 'Singleton Pattern',
          category: 'design-pattern',
          description: `Class "${cls.name}" implements singleton via private constructor/static instance`,
          filePath: file.filePath,
          lineNumber: cls.startLine,
          confidence:
            hasPrivateConstructor && hasStaticInstance && hasGetInstanceMethod ? 0.98 : 0.9,
          severity: 'info',
          suggestion: 'Consider dependency injection instead for testability',
        });
      }
    }

    // Observer pattern
    const hasObserver = file.functions.some(
      (f) =>
        f.name.includes('subscribe') ||
        f.name.includes('on') ||
        f.name.includes('emit') ||
        f.name.includes('listen'),
    );
    if (hasObserver) {
      patterns.push({
        id: 'design-observer',
        name: 'Observer Pattern',
        category: 'design-pattern',
        description: 'Event-driven communication via subscription/notification',
        filePath: file.filePath,
        lineNumber: 0,
        confidence: 0.65,
        severity: 'info',
      });
    }

    // Strategy pattern
    const hasStrategy =
      file.classes.length > 1 &&
      file.classes.some((c) => c.implements.length > 0) &&
      file.functions.some((f) => f.name.includes('execute') || f.name.includes('strategy'));
    if (hasStrategy) {
      patterns.push({
        id: 'design-strategy',
        name: 'Strategy Pattern',
        category: 'design-pattern',
        description: 'Behavioral pattern — interchangeable algorithms via common interface',
        filePath: file.filePath,
        lineNumber: 0,
        confidence: 0.6,
        severity: 'info',
      });
    }

    // Decorator detection (TypeScript)
    const hasDecorator = file.imports.some(
      (i) => i.source.includes('reflect-metadata') || i.source.includes('decorator'),
    );
    if (hasDecorator) {
      patterns.push({
        id: 'design-decorator',
        name: 'Decorator Pattern',
        category: 'design-pattern',
        description: 'Metadata-driven behavior extension via decorators',
        filePath: file.filePath,
        lineNumber: 0,
        confidence: 0.7,
        severity: 'info',
      });
    }

    return patterns;
  }

  /**
   * Detect code smells: long methods, god classes, feature envy, etc.
   */
  private detectCodeSmells(file: FileStructure): ExtendedPattern[] {
    const patterns: ExtendedPattern[] = [];

    // Long methods (>30 lines)
    for (const fn of file.functions) {
      const methodLength = fn.endLine - fn.startLine;
      if (methodLength > 50) {
        patterns.push({
          id: `smell-long-method-${fn.name}`,
          name: 'Long Method',
          category: 'code-smell',
          description: `Function "${fn.name}" is ${methodLength} lines — consider extracting into smaller functions`,
          filePath: file.filePath,
          lineNumber: fn.startLine,
          confidence: 0.85,
          severity: 'warning',
          suggestion: 'Extract logical blocks into well-named helper functions',
        });
      }
    }

    // God class (>500 lines, >10 methods, or high cognitive load)
    for (const cls of file.classes) {
      const classLength = cls.endLine - cls.startLine;
      const isGodClass = classLength > 500 || cls.methodsCount > 15 || cls.cognitiveLoad > 50;

      if (isGodClass) {
        patterns.push({
          id: `smell-god-class-${cls.name}`,
          name: 'God Class',
          category: 'code-smell',
          description: `Class "${cls.name}" has ${cls.methodsCount} methods, ${classLength} lines, and cognitive load ${cls.cognitiveLoad} — violates Single Responsibility Principle`,
          filePath: file.filePath,
          lineNumber: cls.startLine,
          confidence: cls.cognitiveLoad > 50 ? 0.95 : 0.8,
          severity: cls.cognitiveLoad > 50 ? 'critical' : 'warning',
          suggestion:
            'Extract cohesive groups of methods/properties into separate classes based on responsibility domains',
        });
      }
    }

    // High cyclomatic complexity
    for (const fn of file.functions) {
      if (fn.cyclomaticComplexity > 10) {
        patterns.push({
          id: `smell-complexity-${fn.name}`,
          name: 'High Cyclomatic Complexity',
          category: 'code-smell',
          description: `Function "${fn.name}" has complexity ${fn.cyclomaticComplexity} (threshold: 10)`,
          filePath: file.filePath,
          lineNumber: fn.startLine,
          confidence: 0.9,
          severity: 'warning',
          suggestion:
            'Simplify conditional logic — use early returns, strategy pattern, or extract conditions',
        });
      }
    }

    // Too many parameters
    for (const fn of file.functions) {
      if (fn.parameters.length > 5) {
        patterns.push({
          id: `smell-many-params-${fn.name}`,
          name: 'Long Parameter List',
          category: 'code-smell',
          description: `Function "${fn.name}" has ${fn.parameters.length} parameters — consider an options object`,
          filePath: file.filePath,
          lineNumber: fn.startLine,
          confidence: 0.75,
          severity: 'warning',
          suggestion: 'Introduce parameter object or use builder pattern',
        });
      }
    }

    // Primitive obsession
    const primitiveParams = file.functions.filter(
      (f) =>
        f.parameters.length >= 3 &&
        f.parameters.every((p) => ['string', 'number', 'boolean'].includes(p.type)),
    );
    if (primitiveParams.length > 2) {
      patterns.push({
        id: 'smell-primitive-obsession',
        name: 'Primitive Obsession',
        category: 'code-smell',
        description: 'Multiple functions with 3+ primitive parameters — consider value objects',
        filePath: file.filePath,
        lineNumber: 0,
        confidence: 0.6,
        severity: 'info',
      });
    }

    return patterns;
  }

  /**
   * Detect error handling patterns: try/catch, Result types, etc.
   */
  private detectErrorHandlingPatterns(file: FileStructure): ExtendedPattern[] {
    const patterns: ExtendedPattern[] = [];

    // Check for consistent error handling style
    const hasTryCatch = file.functions.some(
      (f) => f.name.includes('try') || f.name.includes('catch') || f.name.includes('handle'),
    );
    const hasAsyncResult = file.functions.some((f) => f.isAsync && f.name.includes('Result'));
    const hasEither = file.imports.some(
      (i) =>
        i.source.includes('either') || i.source.includes('result') || i.source.includes('fp-ts'),
    );

    if (hasTryCatch && !hasEither) {
      patterns.push({
        id: 'error-try-catch',
        name: 'Exception-Based Error Handling',
        category: 'error-handling',
        description: 'Uses try/catch for error propagation',
        filePath: file.filePath,
        lineNumber: 0,
        confidence: 0.8,
        severity: 'info',
        suggestion:
          'Consider Result/Either types for expected errors, exceptions only for exceptional cases',
      });
    }

    if (hasEither || hasAsyncResult) {
      patterns.push({
        id: 'error-result-type',
        name: 'Result Type Error Handling',
        category: 'error-handling',
        description: 'Uses monadic error handling (Result/Either) — explicit error paths',
        filePath: file.filePath,
        lineNumber: 0,
        confidence: 0.85,
        severity: 'info',
      });
    }

    return patterns;
  }

  /**
   * Detect concurrency patterns: async/await, worker threads, etc.
   */
  private detectConcurrencyPatterns(file: FileStructure): ExtendedPattern[] {
    const patterns: ExtendedPattern[] = [];

    const asyncCount = file.functions.filter((f) => f.isAsync).length;
    const totalFns = file.functions.length;

    if (totalFns > 0 && asyncCount / totalFns > 0.5) {
      patterns.push({
        id: 'conc-heavy-async',
        name: 'Heavy Async Usage',
        category: 'concurrency',
        description: `${Math.round((asyncCount / totalFns) * 100)}% of functions are async — potential for parallel optimization`,
        filePath: file.filePath,
        lineNumber: 0,
        confidence: 0.7,
        severity: 'info',
        suggestion: 'Consider Promise.all() for independent async operations',
      });
    }

    const hasWorkerThreads = file.imports.some((i) => i.source === 'node:worker_threads');
    if (hasWorkerThreads) {
      patterns.push({
        id: 'conc-worker-threads',
        name: 'Worker Threads',
        category: 'concurrency',
        description: 'Uses Node.js worker threads for CPU-intensive tasks',
        filePath: file.filePath,
        lineNumber: 0,
        confidence: 0.9,
        severity: 'info',
      });
    }

    return patterns;
  }

  /**
   * Detect type safety patterns: strict typing, type guards, etc.
   */
  private detectTypeSafetyPatterns(file: FileStructure): ExtendedPattern[] {
    const patterns: ExtendedPattern[] = [];

    if (file.language !== 'typescript') return patterns;

    // Check for 'any' usage (heuristic based on function signatures)
    const anyUsage = file.functions.filter(
      (f) =>
        f.signature.includes(': any') || f.signature.includes('<any>') || f.returnType === 'any',
    );

    if (anyUsage.length > 0) {
      patterns.push({
        id: 'type-any-usage',
        name: 'Any Type Usage',
        category: 'type-safety',
        description: `${anyUsage.length} function(s) use 'any' type — reduces type safety`,
        filePath: file.filePath,
        lineNumber: 0,
        confidence: 0.9,
        severity: 'warning',
        suggestion: 'Replace with specific types, unknown, or generic constraints',
      });
    }

    // Check for type guards / discriminated unions
    const hasTypeGuards = file.functions.some(
      (f) =>
        (f.name.startsWith('is') && f.returnType.includes('=>')) || f.returnType.includes('is '),
    );
    if (hasTypeGuards) {
      patterns.push({
        id: 'type-guards',
        name: 'Type Guards',
        category: 'type-safety',
        description: 'Uses type narrowing functions for safer type operations',
        filePath: file.filePath,
        lineNumber: 0,
        confidence: 0.75,
        severity: 'info',
      });
    }

    return patterns;
  }
}

// Convenience function for direct usage
export async function extractPatterns(filePath: string): Promise<ExtractionResult> {
  const extractor = new PatternExtractor();
  return extractor.extractFromFile(filePath);
}

export async function extractPatternsFromFiles(filePaths: string[]): Promise<ExtractionResult[]> {
  const extractor = new PatternExtractor();
  return extractor.extractFromFiles(filePaths);
}
