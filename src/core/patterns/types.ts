/**
 * Cross-Project Pattern Learning Types (F4)
 * Abstract template representation for learned patterns.
 */

export type AbstractionLevel = 'concrete' | 'template' | 'abstract';

export interface PatternVariant {
  id: string;
  projectId: string | null;
  codeHash: string;
  embedding: number[] | null;
  confidence: number;
  firstSeen: string;
  lastSeen: string;
  usageCount: number;
}

export interface LearnedPattern {
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
  projectId: string | null; // origin project (nullable for cross-project)
  abstractionLevel: AbstractionLevel;
  /** Abstract template: interface + method signature */
  abstractTemplate: {
    interfaceName: string;
    methodSignatures: string[];
    parameters: string[];
    returnType: string;
  };
  variants: PatternVariant[];
}

export interface PatternGraph {
  nodes: LearnedPattern[];
  edges: { from: string; to: string; similarity: number }[];
  originProjectId: string | null;
}
