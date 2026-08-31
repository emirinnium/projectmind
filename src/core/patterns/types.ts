/**
 * Cross-Project Pattern Learning Types (F4 / F34)
 * Abstract template representation for learned patterns.
 *
 * F34 abstraction-level mapping (documented, stable):
 * The legacy enum stored/used by older code was 'concrete' | 'template' |
 * 'abstract'. It maps onto the spec enum so existing rows stay meaningful:
 *   'concrete'  -> 'idiomatic'
 *   'template'  -> 'design'
 *   'abstract'  -> 'architectural'
 * Legacy values remain ACCEPTED ON WRITE as deprecated aliases via
 * normalizeAbstractionLevel() (see cross-project.ts).
 */

/** Spec abstraction levels (F34). */
export type AbstractionLevel = 'architectural' | 'design' | 'idiomatic';

/** @deprecated legacy levels — accepted on write, mapped to spec levels. */
export type LegacyAbstractionLevel = 'concrete' | 'template' | 'abstract';

/** Anything accepted as an abstraction level input. */
export type AbstractionLevelInput = AbstractionLevel | LegacyAbstractionLevel;

/** F34: how a pattern performed across projects. */
export interface PatternSuccessMetrics {
  usedInProjects: number;
  testCoverage: number;
  bugRate: number;
}

export interface PatternVariant {
  id: string;
  projectId: string | null;
  codeHash: string;
  embedding: number[] | null;
  confidence: number;
  firstSeen: string;
  lastSeen: string;
  usageCount: number;
  /** F34: concrete implementation details of this variant. */
  language: string;
  filePath: string;
  signature: string;
}

export interface AbstractTemplate {
  interfaceName: string;
  methodSignatures: string[];
  parameters: string[];
  returnType: string;
}

export interface LearnedPattern {
  id: string;
  /** F34 spec field — stable pattern identity (same value as id). */
  patternId: string;
  name: string;
  category: string;
  description: string;
  codeHash: string;
  confidence: number;
  firstSeen: string;
  lastSeen: string;
  usageCount: number;
  embedding: number[] | null;
  projectId: string | null; // origin project (nullable for cross-project)
  /** F34 spec field — origin project id as a string ('' when unknown). */
  originProject: string;
  abstractionLevel: AbstractionLevel;
  /** Abstract template: interface + method signature */
  abstractTemplate: AbstractTemplate;
  variants: PatternVariant[];
  /** F34 spec field — same collection as variants. */
  implementationVariants: PatternVariant[];
  /** F34 spec field — defaults populated on construction. */
  successMetrics: PatternSuccessMetrics;
}

/** A LearnedPattern returned by similarity search with match details (F37). */
export interface PatternMatch extends LearnedPattern {
  /** Cosine similarity that produced this match (never hardcoded). */
  similarity: number;
  /** True when matched via the 16-dim hash fallback embedding. */
  lowConfidence: boolean;
}

export interface PatternGraph {
  nodes: LearnedPattern[];
  edges: { from: string; to: string; similarity: number }[];
  originProjectId: string | null;
}
