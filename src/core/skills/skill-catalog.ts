/**
 * Skill catalog for ProjectMind.
 * Evidence-derived per-skill definitions shared with the CLI and the generator.
 */

export interface SkillEvidence {
  id: string;
  description: string;
  files: string[];
  importance: number;
  whyItHelps: string;
  suggestedCommands: string[];
}

export interface SkillGap {
  skill: string;
  label: string;
  description: string;
  whyItHelps: string;
  currentLevel: number;
  targetLevel: number;
  gap: number;
  priority: 'critical' | 'high' | 'medium' | 'low';
  learningResources: string[];
  estimatedHours: number;
  relatedFiles: string[];
  suggestedCommands: string[];
}

export interface ProficiencyEvidence {
  sessionCount: number;
  touchedPaths: string[];
  /** Serialized session decisions (JSON) — keyword evidence for skill use. */
  decisionsText: string;
  /** Agent fingerprint asyncPreference: -1 = unmeasured, 0..1 otherwise. */
  asyncPreference: number;
}

export interface SkillDefinition {
  id: string;
  label: string;
  description: string;
  /** Roadmap requirement: plain-language explanation of what this skill helps with. */
  whyItHelps: string;
  /** Target proficiency (0-1) — also the "gap target". */
  importance: number;
  /** Path-signal regexes matched against repo files / touched files. */
  indicators: RegExp[];
  resources: string[];
  /** CLI commands that exercise this skill in this project. */
  suggestedCommands: string[];
}

export const SKILL_CATALOG: SkillDefinition[] = [
  {
    id: 'typescript',
    label: 'TypeScript',
    description: 'TypeScript type system and advanced types',
    whyItHelps:
      'Nearly every file here is TypeScript — precise types keep the public API surface and tool contracts honest.',
    importance: 0.9,
    indicators: [/\.tsx?$/i],
    resources: ['TypeScript Handbook', 'Effective TypeScript', 'Type Challenges'],
    suggestedCommands: ['pm scale'],
  },
  {
    id: 'async-patterns',
    label: 'Async patterns',
    description: 'Async/await, promises, error handling',
    whyItHelps:
      'Long-running scans, LLM calls and DB access dominate the hot paths; unhandled rejections here crash whole sessions.',
    importance: 0.85,
    indicators: [/retry\.ts$/i, /await/i],
    resources: ['Async/Await Best Practices', 'Error Handling in Node.js'],
    suggestedCommands: ['pm doctor scan-health'],
  },
  {
    id: 'dependency-injection',
    label: 'Dependency injection',
    description: 'DI patterns, service locators, factories',
    whyItHelps:
      'The CLI/MCP services layer is built on constructor injection — following it keeps tools testable and interchangeable.',
    importance: 0.7,
    indicators: [/(^|\/)services?(\.ts|\/)/i, /container/i],
    resources: ['DI in TypeScript', 'InversifyJS', 'TSyringe'],
    suggestedCommands: ['pm scale'],
  },
  {
    id: 'architectural-contracts',
    label: 'Architecture contracts',
    description: 'Layer boundaries, forbidden imports, contracts',
    whyItHelps:
      'Layered modules (auth, storage, core, cli) rely on contract files to catch boundary violations at analyze time.',
    importance: 0.8,
    indicators: [/contracts?\//i, /(^|\/)layers?\.ts$/i],
    resources: ['Architecture Decision Records', 'Clean Architecture'],
    suggestedCommands: ['pm layers', 'pm check'],
  },
  {
    id: 'coherence-checking',
    label: 'Coherence checking',
    description: 'Fast/deep coherence analysis, contract engine',
    whyItHelps:
      'coherence gates are the project quality gate — fast-tier verdicts drive every edit workflow.',
    importance: 0.75,
    indicators: [/(^|\/)coherence(\/|\.ts$)/i],
    resources: ['Code Quality Metrics', 'Static Analysis Tools'],
    suggestedCommands: ['pm check'],
  },
  {
    id: 'debt-detection',
    label: 'Debt detection',
    description: 'Redundancy, pattern drift, architectural drift detection',
    whyItHelps:
      'Debt reports decide release gates (high severity = blocker); accurate detection keeps the Genome score honest.',
    importance: 0.7,
    indicators: [/(^|\/)debt(\/|\.ts$|-prioritize\.ts$)/i, /dedup/i],
    resources: ['Technical Debt Management', 'Code Quality Gates'],
    suggestedCommands: ['pm debt', 'pm debt-prioritize', 'pm genome'],
  },
  {
    id: 'embedding-generation',
    label: 'Embeddings',
    description: 'Code embeddings, semantic similarity, vector search',
    whyItHelps:
      'Semantic memory search and similar-file suggestions depend on the embedding provider pipeline.',
    importance: 0.65,
    indicators: [/embedding/i],
    resources: ['Vector Embeddings', 'Sentence Transformers', 'FAISS'],
    suggestedCommands: ['pm embed'],
  },
  {
    id: 'ast-parsing',
    label: 'AST parsing',
    description: 'TypeScript AST parsing, tree-sitter multi-language parsing, symbol extraction',
    whyItHelps:
      'taint, structural-search and multi-language analysis all parse code — bugs here silently drop findings.',
    importance: 0.7,
    indicators: [/(^|\/)parser\//i, /structural-search/i, /tree-sitter/i],
    resources: ['TypeScript Compiler API', 'Babel Plugin Handbook'],
    suggestedCommands: ['pm taint', 'pm structural-search'],
  },
  {
    id: 'knowledge-graph',
    label: 'Knowledge graph',
    description: 'File indexing, import resolution, graph queries',
    whyItHelps:
      'impact, circular-deps and coherence queries all read the graph — keeping import resolution accurate prevents false negatives.',
    importance: 0.75,
    indicators: [/(^|\/)(kg|graph)(\/|\.ts$)/i, /imports/i],
    resources: ['Graph Databases', 'Neo4j', 'Property Graphs'],
    suggestedCommands: ['pm graph', 'pm impact', 'pm resolve'],
  },
  {
    id: 'sqlite-persistence',
    label: 'SQLite persistence',
    description: 'SQLite schema, migrations, prepared statements',
    whyItHelps:
      'Schema migrations are the riskiest change class in this project; SQLite ALTER rules differ sharply from other engines.',
    importance: 0.6,
    indicators: [/(^|\/)(storage|database)(\/|\.ts$)/i, /schema\.ts$/i, /migrations\.ts$/i],
    resources: ['SQLite Internals', 'Better-SQLite3', 'Knex.js'],
    suggestedCommands: ['pm scan'],
  },
  {
    id: 'mcp-protocol',
    label: 'MCP protocol',
    description: 'Model Context Protocol server/tools',
    whyItHelps:
      'Every tool and resource ships over MCP — envelope validation and transport quirks (headers, sessions) surface here.',
    importance: 0.6,
    indicators: [/(^|\/)mcp(\/|\.ts$|-server\.ts$)/i, /mcp-server/i],
    resources: ['MCP Specification', 'MCP SDK Examples'],
    suggestedCommands: ['pm mcp'],
  },
  {
    id: 'llm-integration',
    label: 'LLM integration',
    description: 'LLM providers, prompts, deep analysis',
    whyItHelps:
      'deep coherence, team-memory conflict resolution and docgen call providers — prompt regressions change results silently.',
    importance: 0.65,
    indicators: [/(^|\/)llm(\/|\.ts$)/i, /providers?(\/|\.ts$)/i, /(^|\/)deep\.ts$/i],
    resources: ['Prompt Engineering', 'LangChain', 'Function Calling'],
    suggestedCommands: ['pm docgen'],
  },
  {
    id: 'cli-design',
    label: 'CLI design',
    description: 'Commander.js patterns, async handlers, output formatting',
    whyItHelps:
      'Every feature is exposed as a commander command — consistent handlers and output keep pm usable in CI.',
    importance: 0.7,
    indicators: [/(^|\/)cli\//i, /commander/i],
    resources: ['Commander.js Docs', 'CLI Best Practices'],
    suggestedCommands: ['pm --help'],
  },
  {
    id: 'testing-patterns',
    label: 'Testing patterns',
    description: 'Vitest, mocking, integration tests',
    whyItHelps:
      'The repo gates on vitest totals — new evidence paths (OAuth, skills) need unit tests before merging.',
    importance: 0.6,
    indicators: [/(^|\/)(tests?|__tests__)\//i, /\.(test|spec)\.tsx?$/i],
    resources: ['Vitest Guide', 'Testing Library', 'Mutation Testing'],
    suggestedCommands: ['pm testgen'],
  },
  {
    id: 'security-auditing',
    label: 'Security auditing',
    description: 'Secret detection, crypto analysis, OWASP checks',
    whyItHelps:
      'Secrets and taint flows are audited by dedicated tools; token handling (HTTP/OAuth) is a real attack surface here.',
    importance: 0.7,
    indicators: [/(^|\/)(audit|secrets-life)\.ts$/i, /taint/i, /auth/i],
    resources: ['OWASP Top 10', 'Secret Detection', 'SAST Tools'],
    suggestedCommands: ['pm audit', 'pm secrets-life', 'pm taint'],
  },
  {
    id: 'license-compliance',
    label: 'License compliance',
    description: 'SPDX, license scanning, policy enforcement',
    whyItHelps:
      'Dependency licensing is machine-checked before releases — the SBOM path is the compliance source of truth.',
    importance: 0.5,
    indicators: [/(^|\/)(license|sbom|deps-fresh)\.ts$/i],
    resources: ['SPDX Specification', 'License Compliance Automation'],
    suggestedCommands: ['pm sbom', 'pm deps-fresh'],
  },
  {
    id: 'architecture-analysis',
    label: 'Architecture analysis',
    description: 'Coupling, cohesion, layer boundaries, impact analysis',
    whyItHelps:
      'Coupling and impact signals drive refactor ROI — accurate analysis prevents risky edits to shared files.',
    importance: 0.7,
    indicators: [/(^|\/)(coupling|impact|layers)\.ts$/i, /refactor-roi/i],
    resources: ['Coupling Metrics', 'Structure101', 'ArchUnit'],
    suggestedCommands: ['pm coupling', 'pm impact', 'pm refactor-roi'],
  },
  {
    id: 'agent-session-management',
    label: 'Agent session management',
    description: 'Session tracking, memory, context sharing',
    whyItHelps:
      'Cross-session memory and 3-way team-memory merges are the project identity — session hygiene keeps them sound.',
    importance: 0.6,
    indicators: [/(^|\/)(session|agent|memory)(\/|\.ts$)/i],
    resources: ['Agent Memory Patterns', 'Context Engineering'],
    suggestedCommands: ['pm agent status'],
  },
  {
    id: 'pattern-extraction',
    label: 'Pattern extraction',
    description: 'Code pattern mining, redundancy detection',
    whyItHelps:
      'Dedup and pattern-drift analyses mine repeated structures — extraction quality bounds redundancy results.',
    importance: 0.65,
    indicators: [/(^|\/)patterns?(\/|-extractor\.ts$)/i],
    resources: ['Code Clone Detection', 'Mining Software Repositories'],
    suggestedCommands: ['pm dedup'],
  },
  {
    id: 'refactoring-automation',
    label: 'Refactoring automation',
    description: 'AST transforms, safe code modifications',
    whyItHelps:
      'Structural rewrites touch many files at once; automated transforms must stay lossless.',
    importance: 0.6,
    indicators: [/(^|\/)(refactor|organize-imports)/i],
    resources: ['Codemods', 'jscodeshift', 'AST Transforms'],
    suggestedCommands: ['pm refactor-roi'],
  },
  {
    id: 'documentation-generation',
    label: 'Documentation generation',
    description: 'API docs, README, ADRs from code',
    whyItHelps:
      'ADRs and docs keep architecture decisions retrievable by future agents — generation keeps them current.',
    importance: 0.5,
    indicators: [/(^|\/)(docgen|adr|onboard)\.ts$/i],
    resources: ['JSDoc', 'TypeDoc', 'API Documentation'],
    suggestedCommands: ['pm docgen', 'pm adr'],
  },
];
