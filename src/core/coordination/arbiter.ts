import type { KnowledgeGraph } from '../../storage/knowledge-graph.js';
import type { FileLock } from '../../storage/kg/helpers/locks.js';
import { predictMergeRisk, type ConflictRisk, type MergeContentChange } from './risk.js';

const MAX_AGENTS = 32;
const MAX_FILES_PER_AGENT = 100;

export interface ArbiterAgentPlan {
  agentName: string;
  files: string[];
  priority?: number;
  contentChanges?: MergeContentChange[];
}

export interface ArbitrateAgentsInput {
  agents: ArbiterAgentPlan[];
}

export interface ArbiterPairRisk {
  leftAgent: string;
  rightAgent: string;
  level: ConflictRisk['level'];
  score: number;
  sharedFiles: string[];
  locksBetween: Array<{
    filePath: string;
    holder: string;
    plannedAgent: string;
    expiresAt: string;
  }>;
  leftToRight: ConflictRisk;
  rightToLeft: ConflictRisk;
  reasons: string[];
}

export interface ArbiterDependencyEdge {
  before: string;
  after: string;
  sourceFiles: string[];
  targetFiles: string[];
  reason: string;
}

export interface ArbiterAgentRisk {
  agentName: string;
  level: ConflictRisk['level'];
  score: number;
  pairCount: number;
  lockConflicts: Array<{
    filePath: string;
    heldBy: string;
    expiresAt: string;
    reason: string | null;
  }>;
  reasons: string[];
}

export interface ArbiterShardSuggestion {
  agentName: string;
  isolatedFiles: string[];
  coordinationFiles: string[];
  suggestedAction: string;
}

export interface ArbiterConflictGroup {
  groupId: string;
  agents: string[];
  files: string[];
  risk: 'medium' | 'high';
}

export interface ArbitrateAgentsReport {
  version: 'projectmind-arbiter-v1';
  agents: string[];
  pairRisks: ArbiterPairRisk[];
  agentRisks: ArbiterAgentRisk[];
  dependencyEdges: ArbiterDependencyEdge[];
  recommendedRebaseOrder: string[];
  rebaseOrderReason: string;
  cycleBreaks: string[][];
  conflictGroups: ArbiterConflictGroup[];
  shardSuggestions: ArbiterShardSuggestion[];
  activeLocks: number;
  unplannedLocks: Array<{
    filePath: string;
    heldBy: string;
    expiresAt: string;
  }>;
  limitations: string[];
}

function normalizePath(filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function levelRank(level: ConflictRisk['level']): number {
  return level === 'high' ? 2 : level === 'medium' ? 1 : 0;
}

function higherLevel(
  left: ConflictRisk['level'],
  right: ConflictRisk['level'],
): ConflictRisk['level'] {
  return levelRank(left) >= levelRank(right) ? left : right;
}

function mergeReasons(left: string[], right: string[]): string[] {
  return sortedUnique([...left, ...right]);
}

function validatePlans(input: ArbitrateAgentsInput): ArbiterAgentPlan[] {
  if (!Array.isArray(input.agents) || input.agents.length < 2 || input.agents.length > MAX_AGENTS) {
    throw new Error(`agents must contain between 2 and ${MAX_AGENTS} plans.`);
  }
  const names = new Set<string>();
  return input.agents.map((plan) => {
    if (!plan || typeof plan !== 'object' || typeof plan.agentName !== 'string') {
      throw new Error('Every agent plan must provide a string agentName.');
    }
    const agentName = plan.agentName.trim();
    if (!agentName || agentName.length > 200) {
      throw new Error('Every agentName must be a non-empty string of at most 200 characters.');
    }
    if (names.has(agentName)) throw new Error(`Duplicate agentName: ${agentName}`);
    names.add(agentName);
    if (
      !Array.isArray(plan.files) ||
      plan.files.length < 1 ||
      plan.files.length > MAX_FILES_PER_AGENT
    ) {
      throw new Error(`${agentName} must contain between 1 and ${MAX_FILES_PER_AGENT} files.`);
    }
    if (plan.files.some((file) => typeof file !== 'string')) {
      throw new Error(`${agentName} files must contain only strings.`);
    }
    const files = sortedUnique(plan.files.map(normalizePath));
    if (files.length === 0) throw new Error(`${agentName} must contain at least one file.`);
    return {
      agentName,
      files,
      priority: Number.isFinite(plan.priority) ? Math.trunc(plan.priority ?? 0) : 0,
      contentChanges: plan.contentChanges,
    };
  });
}

function buildDependencyEdges(
  kg: KnowledgeGraph,
  plans: ArbiterAgentPlan[],
): { edges: ArbiterDependencyEdge[]; unresolved: string[] } {
  const edges = new Map<string, ArbiterDependencyEdge>();
  const unresolved = new Set<string>();
  const traversal = kg.getGraphTraversal(false);

  for (let leftIndex = 0; leftIndex < plans.length; leftIndex++) {
    const left = plans[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < plans.length; rightIndex++) {
      const right = plans[rightIndex]!;
      const rightFiles = new Set(right.files);
      const leftFiles = new Set(left.files);
      const directions = [
        {
          source: left,
          targets: right,
          targetSet: rightFiles,
          before: right.agentName,
          after: left.agentName,
        },
        {
          source: right,
          targets: left,
          targetSet: leftFiles,
          before: left.agentName,
          after: right.agentName,
        },
      ];

      for (const direction of directions) {
        const sourceFiles = new Set<string>();
        const targetFiles = new Set<string>();
        for (const sourceFile of direction.source.files) {
          const info = kg.getFileByPath(sourceFile);
          if (!info) {
            unresolved.add(sourceFile);
            continue;
          }
          const imported = traversal.bfs(info.id, 1, true).visited;
          for (const target of imported) {
            const targetPath = normalizePath(target.relativePath || target.path);
            if (targetPath === sourceFile || !direction.targetSet.has(targetPath)) continue;
            sourceFiles.add(sourceFile);
            targetFiles.add(targetPath);
          }
        }
        if (sourceFiles.size === 0) continue;
        const key = `${direction.before}\0${direction.after}`;
        const existing = edges.get(key);
        if (existing) {
          existing.sourceFiles = sortedUnique([...existing.sourceFiles, ...sourceFiles]);
          existing.targetFiles = sortedUnique([...existing.targetFiles, ...targetFiles]);
        } else {
          edges.set(key, {
            before: direction.before,
            after: direction.after,
            sourceFiles: sortedUnique(sourceFiles),
            targetFiles: sortedUnique(targetFiles),
            reason: `${direction.after} imports files planned by ${direction.before}; rebase ${direction.after} after ${direction.before}.`,
          });
        }
      }
    }
  }
  return {
    edges: [...edges.values()].sort(
      (left, right) =>
        left.before.localeCompare(right.before) || left.after.localeCompare(right.after),
    ),
    unresolved: [...unresolved].sort(),
  };
}

function addLockEvidence(
  pairRisks: ArbiterPairRisk[],
  plans: ArbiterAgentPlan[],
  locks: FileLock[],
): void {
  const planByAgent = new Map(plans.map((plan) => [plan.agentName, plan]));
  for (const pair of pairRisks) {
    const left = planByAgent.get(pair.leftAgent)!;
    const right = planByAgent.get(pair.rightAgent)!;
    for (const lock of locks) {
      const lockPath = normalizePath(lock.filePath);
      const leftTarget = left.files.includes(lockPath);
      const rightTarget = right.files.includes(lockPath);
      if (leftTarget && lock.agentName === pair.rightAgent) {
        pair.locksBetween.push({
          filePath: lockPath,
          holder: pair.rightAgent,
          plannedAgent: pair.leftAgent,
          expiresAt: lock.expiresAt,
        });
      }
      if (rightTarget && lock.agentName === pair.leftAgent) {
        pair.locksBetween.push({
          filePath: lockPath,
          holder: pair.leftAgent,
          plannedAgent: pair.rightAgent,
          expiresAt: lock.expiresAt,
        });
      }
    }
    pair.locksBetween.sort((leftLock, rightLock) =>
      leftLock.filePath.localeCompare(rightLock.filePath),
    );
    if (pair.locksBetween.length > 0) {
      pair.level = 'high';
      pair.score += pair.locksBetween.length * 4;
      pair.reasons = mergeReasons(
        pair.reasons,
        pair.locksBetween.map(
          (lock) =>
            `Advisory lock collision: ${lock.filePath} is held by ${lock.holder} while ${lock.plannedAgent} plans to edit it.`,
        ),
      );
    }
  }
}

function buildRebaseOrder(
  plans: ArbiterAgentPlan[],
  edges: ArbiterDependencyEdge[],
): { order: string[]; cycleBreaks: string[][] } {
  const names = plans.map((plan) => plan.agentName);
  const priorities = new Map(plans.map((plan) => [plan.agentName, plan.priority ?? 0]));
  const outgoing = new Map(names.map((name) => [name, new Set<string>()]));
  const indegree = new Map(names.map((name) => [name, 0]));
  for (const edge of edges) {
    const targets = outgoing.get(edge.before);
    if (!targets || targets.has(edge.after)) continue;
    targets.add(edge.after);
    indegree.set(edge.after, (indegree.get(edge.after) ?? 0) + 1);
  }

  const remaining = new Set(names);
  const order: string[] = [];
  const cycleBreaks: string[][] = [];
  while (remaining.size > 0) {
    let ready = [...remaining].filter((name) => (indegree.get(name) ?? 0) === 0);
    if (ready.length === 0) {
      const cycle = [...remaining].sort();
      cycleBreaks.push(cycle);
      ready = [cycle[0]!];
    }
    ready.sort(
      (left, right) =>
        (priorities.get(right) ?? 0) - (priorities.get(left) ?? 0) || left.localeCompare(right),
    );
    const next = ready[0]!;
    remaining.delete(next);
    order.push(next);
    for (const target of outgoing.get(next) ?? []) {
      indegree.set(target, Math.max(0, (indegree.get(target) ?? 0) - 1));
    }
  }
  return { order, cycleBreaks };
}

function buildConflictGroups(
  plans: ArbiterAgentPlan[],
  pairRisks: ArbiterPairRisk[],
  dependencyEdges: ArbiterDependencyEdge[],
): ArbiterConflictGroup[] {
  const parent = new Map(plans.map((plan) => [plan.agentName, plan.agentName]));
  const find = (name: string): string => {
    const current = parent.get(name);
    if (!current || current === name) return name;
    const root = find(current);
    parent.set(name, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  for (const pair of pairRisks) {
    if (pair.level !== 'low' || pair.sharedFiles.length > 0) union(pair.leftAgent, pair.rightAgent);
  }
  for (const edge of dependencyEdges) union(edge.before, edge.after);

  const grouped = new Map<
    string,
    { agents: Set<string>; files: Set<string>; risk: 'medium' | 'high' }
  >();
  for (const plan of plans) {
    const root = find(plan.agentName);
    const group = grouped.get(root) ?? {
      agents: new Set(),
      files: new Set(),
      risk: 'medium' as const,
    };
    group.agents.add(plan.agentName);
    if (group.agents.size > 1) group.files = new Set([...group.files, ...plan.files]);
    grouped.set(root, group);
  }
  for (const pair of pairRisks) {
    if (pair.level === 'low' && pair.sharedFiles.length === 0) continue;
    const group = grouped.get(find(pair.leftAgent));
    if (!group) continue;
    group.risk = group.risk === 'high' || pair.level === 'high' ? 'high' : 'medium';
    for (const file of pair.sharedFiles) group.files.add(file);
  }
  return [...grouped.entries()]
    .filter(([, group]) => group.agents.size > 1)
    .map(([root, group]) => ({
      groupId: `group-${root}`,
      agents: [...group.agents].sort(),
      files: [...group.files].sort(),
      risk: group.risk,
    }))
    .sort((left, right) => left.groupId.localeCompare(right.groupId));
}

export function arbitrateAgents(
  kg: KnowledgeGraph,
  input: ArbitrateAgentsInput,
): ArbitrateAgentsReport {
  const plans = validatePlans(input).sort((left, right) =>
    left.agentName.localeCompare(right.agentName),
  );
  const pairRisks: ArbiterPairRisk[] = [];
  for (let left = 0; left < plans.length; left++) {
    for (let right = left + 1; right < plans.length; right++) {
      const leftPlan = plans[left]!;
      const rightPlan = plans[right]!;
      const risk = riskForPairWithGraph(kg, leftPlan, rightPlan);
      pairRisks.push(risk);
    }
  }
  const locks = kg.getActiveLocks();
  addLockEvidence(pairRisks, plans, locks);
  const dependency = buildDependencyEdges(kg, plans);
  const rebase = buildRebaseOrder(plans, dependency.edges);
  const planPaths = new Set(plans.flatMap((plan) => plan.files));
  const plannedAgents = new Set(plans.map((plan) => plan.agentName));
  const unplannedLocks = locks
    .filter(
      (lock) => !plannedAgents.has(lock.agentName) && planPaths.has(normalizePath(lock.filePath)),
    )
    .map((lock) => ({
      filePath: normalizePath(lock.filePath),
      heldBy: lock.agentName,
      expiresAt: lock.expiresAt,
    }))
    .sort(
      (left, right) =>
        left.filePath.localeCompare(right.filePath) || left.heldBy.localeCompare(right.heldBy),
    );

  const agentRisks = plans.map((plan) => {
    const related = pairRisks.filter(
      (pair) => pair.leftAgent === plan.agentName || pair.rightAgent === plan.agentName,
    );
    const lockConflicts = locks
      .filter(
        (lock) =>
          lock.agentName !== plan.agentName && plan.files.includes(normalizePath(lock.filePath)),
      )
      .map((lock) => ({
        filePath: normalizePath(lock.filePath),
        heldBy: lock.agentName,
        expiresAt: lock.expiresAt,
        reason: lock.reason,
      }))
      .sort(
        (left, right) =>
          left.filePath.localeCompare(right.filePath) || left.heldBy.localeCompare(right.heldBy),
      );
    const pairLevel = related.reduce<ConflictRisk['level']>(
      (level, pair) => higherLevel(level, pair.level),
      'low',
    );
    const score = Math.max(0, ...related.map((pair) => pair.score)) + lockConflicts.length * 4;
    const level = lockConflicts.length > 0 ? 'high' : pairLevel;
    return {
      agentName: plan.agentName,
      level,
      score,
      pairCount: related.length,
      lockConflicts,
      reasons: mergeReasons(
        // Every pair in `related` already contains this agent. Keep the full
        // pair evidence: substring matching agent names (for example `agent`
        // and `agent-a`) can otherwise attribute one direction incorrectly.
        related.flatMap((pair) => pair.reasons),
        lockConflicts.map(
          (lock) =>
            `Cannot safely start: ${lock.filePath} is held by ${lock.heldBy} until ${lock.expiresAt}.`,
        ),
      ),
    } satisfies ArbiterAgentRisk;
  });

  const sharedFiles = new Set(pairRisks.flatMap((pair) => pair.sharedFiles));
  const dependencyFiles = new Map<string, Set<string>>();
  for (const edge of dependency.edges) {
    for (const agent of [edge.before, edge.after]) {
      const files = dependencyFiles.get(agent) ?? new Set<string>();
      edge.sourceFiles.forEach((file) => files.add(file));
      edge.targetFiles.forEach((file) => files.add(file));
      dependencyFiles.set(agent, files);
    }
  }
  const shardSuggestions = plans.map((plan) => {
    const coordination = new Set<string>(sharedFiles);
    for (const lock of locks) {
      if (lock.agentName !== plan.agentName && plan.files.includes(normalizePath(lock.filePath))) {
        coordination.add(normalizePath(lock.filePath));
      }
    }
    for (const file of dependencyFiles.get(plan.agentName) ?? []) coordination.add(file);
    const isolatedFiles = plan.files.filter((file) => !coordination.has(file));
    const coordinationFiles = plan.files.filter((file) => coordination.has(file));
    return {
      agentName: plan.agentName,
      isolatedFiles,
      coordinationFiles,
      suggestedAction:
        coordinationFiles.length === 0
          ? 'Work independently on the isolated shard; no cross-agent coordination signal was found.'
          : isolatedFiles.length > 0
            ? `Start with isolatedFiles, then coordinate ${coordinationFiles.length} shared/dependent file(s) in the recommended rebase order.`
            : 'Keep this plan coordinated with the other agents; no isolated shard was found.',
    } satisfies ArbiterShardSuggestion;
  });

  const limitations = [
    'Arbitration is advisory: it does not prevent filesystem or git writes.',
    'Dependency direction uses indexed one-hop static imports; unresolved, dynamic, generated, and runtime edges are not inferred.',
    'Merge content evidence is bounded line-range analysis; it is not an AST merge or a semantic conflict proof.',
    'Rebase order is deterministic for the indexed graph; cycleBreaks identify where human ordering is still required.',
  ];
  if (dependency.unresolved.length > 0) {
    limitations.push(
      `Unindexed source files were omitted from dependency direction: ${dependency.unresolved.join(', ')}.`,
    );
  }
  if (unplannedLocks.length > 0) {
    limitations.push(
      'Some planned files are locked by agents not present in this arbitration request; coordinate with those holders before editing.',
    );
  }

  return {
    version: 'projectmind-arbiter-v1',
    agents: plans.map((plan) => plan.agentName),
    pairRisks,
    agentRisks,
    dependencyEdges: dependency.edges,
    recommendedRebaseOrder: rebase.order,
    rebaseOrderReason:
      dependency.edges.length > 0
        ? 'Dependencies are ordered first; equal-priority independent agents are ordered deterministically by priority then name.'
        : 'No indexed cross-agent dependency was found; order is deterministic by priority then name.',
    cycleBreaks: rebase.cycleBreaks,
    conflictGroups: buildConflictGroups(plans, pairRisks, dependency.edges),
    shardSuggestions,
    activeLocks: locks.length,
    unplannedLocks,
    limitations,
  };
}

function riskForPairWithGraph(
  kg: KnowledgeGraph,
  left: ArbiterAgentPlan,
  right: ArbiterAgentPlan,
): ArbiterPairRisk {
  const leftToRight = predictMergeRisk(kg, {
    myFiles: left.files,
    otherHeldFiles: right.files,
    myContentChanges: left.contentChanges,
    otherContentChanges: right.contentChanges,
  });
  const rightToLeft = predictMergeRisk(kg, {
    myFiles: right.files,
    otherHeldFiles: left.files,
    myContentChanges: right.contentChanges,
    otherContentChanges: left.contentChanges,
  });
  return {
    leftAgent: left.agentName,
    rightAgent: right.agentName,
    level: higherLevel(leftToRight.level, rightToLeft.level),
    score: Math.max(leftToRight.score, rightToLeft.score),
    sharedFiles: sortedUnique(left.files.filter((file) => right.files.includes(file))),
    locksBetween: [],
    leftToRight,
    rightToLeft,
    reasons: mergeReasons(
      leftToRight.reasons.map((reason) => `${left.agentName} → ${right.agentName}: ${reason}`),
      rightToLeft.reasons.map((reason) => `${right.agentName} → ${left.agentName}: ${reason}`),
    ),
  };
}
