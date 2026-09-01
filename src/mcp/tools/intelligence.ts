import { z } from 'zod';
import { basename, dirname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import {
  IntentEngine,
  classifyTask,
  createKgGraphAdapter,
} from '../../core/search/intent-engine.js';
import { ImpactPredictor } from '../../core/predictive/impact-predictor.js';
import type { CodeChange, PredictorConfig } from '../../core/predictive/types.js';
import { ContextBudgetOptimizer } from '../../core/context/budget-optimizer.js';
import type { ContextItem, ContextTaskType } from '../../core/context/types.js';
import { IntegrityGuard } from '../../core/kg/integrity-guard.js';
import { IntentBroadcastService } from '../../core/collaboration/broadcast.js';
import type { ExpectedChanges } from '../../core/collaboration/types.js';
import {
  CrossProjectPatternEngine,
  buildPattern,
  computeBagOfWordsEmbedding,
} from '../../core/patterns/cross-project.js';
import type { AbstractTemplate } from '../../core/patterns/types.js';
import { confineToProject } from './_shared.js';

/**
 * WP8 capability tools (F38): intent search, predictive impact, context
 * budget planning, KG integrity, live intent broadcast + conflict checks,
 * and cross-project pattern lookup.
 */

/** Default predictor tuning — mirrors the `doctor scan-health` config. */
const DEFAULT_PREDICTOR_CONFIG: PredictorConfig = {
  bayesianPrior: 0.5,
  crossModuleWeight: 0.8,
  confidenceThreshold: 0.7,
  modelUpdateRate: 0.1,
};

/** Fallback agent identity when the caller does not supply one. */
function agentIdentity(deps: McpDependencies, supplied?: string): string {
  return supplied ?? deps.agentName ?? 'mcp-client';
}

// Shared IntentBroadcastService per server process: broadcast_intent,
// check_intent_conflicts and get_context's conflictWarnings (F38b) must all
// observe the same in-memory + DB state. The cache is keyed by the db
// reference: if the server is re-wired to a different database instance the
// service is rebuilt so it never reads/writes a stale DB handle.
let _sharedBroadcastCache: {
  db: DatabaseSync | undefined;
  service: IntentBroadcastService;
} | null = null;

/** Process-wide broadcast service bound to the server DB (F38/F38b). */
export function getSharedBroadcastService(db?: DatabaseSync): IntentBroadcastService {
  if (_sharedBroadcastCache && _sharedBroadcastCache.db === db) {
    return _sharedBroadcastCache.service;
  }
  const service = new IntentBroadcastService(db);
  _sharedBroadcastCache = { db, service };
  return service;
}

function json(result: object): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function noDb(tool: string): { content: Array<{ type: 'text'; text: string }> } {
  return json({
    success: false,
    error: `${tool} requires the project database, which is not initialized.`,
  });
}

/** search_intent — hybrid intent-driven semantic navigation (IntentEngine). */
function registerSearchIntentTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'search_intent',
    {
      title: 'Intent-Driven Search',
      description:
        'Search the codebase with a natural-language task query (hybrid semantic + structural + intent scoring).\n' +
        'WHEN to call: when you need files relevant to a TASK ("where do I add rate limiting?") rather than a literal string.\n' +
        'For literal text matching use projectmind_run_cli with pm search instead (run_cli on clients without the projectmind_ prefix).',
      inputSchema: {
        query: z
          .string()
          .describe('Natural-language task query (e.g. "fix the login timeout bug")'),
        structuralHints: z
          .array(z.string())
          .optional()
          .describe('Optional structural hints (e.g. ["class", "middleware"])'),
        expectedOutputs: z
          .array(z.string())
          .optional()
          .describe('Optional expected outputs/artifacts (e.g. ["http response"])'),
        filePath: z
          .string()
          .optional()
          .describe('Optional seed file path to expand structural neighbors from'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum results'),
      },
    },
    async (args) => {
      try {
        if (!deps.db) return noDb('search_intent');
        const engine = new IntentEngine({ db: deps.db, projectRoot: deps.projectRoot });
        const adapter = createKgGraphAdapter(deps.kg);
        const results = await engine.search(
          {
            naturalLanguage: args.query,
            structuralHints: args.structuralHints,
            expectedOutputs: args.expectedOutputs,
            filePath: args.filePath,
          },
          adapter,
          args.limit,
        );
        return json({
          success: true,
          taskType: classifyTask(args.query),
          intent: engine.classifyIntent({ naturalLanguage: args.query }),
          count: results.length,
          results,
        });
      } catch (error) {
        return json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

/** predict_impact — predicted test breakage for a (planned) change. */
function registerPredictImpactTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'predict_impact',
    {
      title: 'Predict Test Breakage',
      description:
        'Predict which tests/callers break when a file changes (signature diff + KG call-site analysis + historical failure correlation).\n' +
        'WHEN to call: BEFORE committing a change, or to evaluate a planned edit. Compares the working tree against HEAD; pass previousContent to simulate a not-yet-written change.\n' +
        'Returns predicted failures with confidence, reasons and suggested fixes.',
      inputSchema: {
        filePath: z.string().describe('File being changed'),
        changeType: z
          .enum(['add', 'modify', 'delete'])
          .default('modify')
          .describe('Kind of change'),
        affectedFunctions: z
          .array(z.string())
          .optional()
          .describe('Function names known/suspected to change'),
        previousContent: z
          .string()
          .optional()
          .describe('Pre-change file content (defaults to git HEAD version)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe('Maximum predicted failures to return'),
      },
    },
    async (args) => {
      try {
        const predictor = new ImpactPredictor(DEFAULT_PREDICTOR_CONFIG, deps.db);
        const change: CodeChange = {
          filePath: args.filePath,
          moduleName: basename(dirname(args.filePath)) || args.filePath,
          changeType: args.changeType,
          crossModule: false,
          affectedFunctions: args.affectedFunctions,
          previousContent: args.previousContent,
        };
        const predictions = predictor.predictTestBreaks(change).slice(0, args.limit);
        const historical = predictor.correlateHistoricalFailures(args.filePath);
        const report = predictor.predictImpact(change);
        return json({
          success: true,
          filePath: args.filePath,
          predictedImpact: report.predictedImpact,
          totalConfidence: report.totalConfidence,
          affectedModules: report.affectedModules,
          historical,
          predictedFailures: predictions,
        });
      } catch (error) {
        return json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

/** plan_context_budget — token-budgeted context plan (ContextBudgetOptimizer). */
function registerPlanContextBudgetTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'plan_context_budget',
    {
      title: 'Context Budget Planner',
      description:
        'Plan which files to load into a limited context/token budget (value-based DP knapsack with greedy fallback and task-type boosts).\n' +
        'WHEN to call: before reading many files for a task — get a ranked, budget-respecting file list with inclusion reasons and compression hints.\n' +
        'Omit per-file tokens to auto-estimate from file size; omit relevanceScore to default to 0.5.',
      inputSchema: {
        files: z
          .array(
            z.object({
              path: z.string().describe('File path (project-relative or absolute)'),
              tokens: z
                .number()
                .int()
                .positive()
                .optional()
                .describe('Token cost (auto-estimated when omitted)'),
              relevanceScore: z
                .number()
                .min(0)
                .max(1)
                .optional()
                .describe('0..1 relevance (default 0.5)'),
              recentlyChanged: z.boolean().optional(),
              importedByQueryFiles: z.boolean().optional(),
              semanticMatch: z.boolean().optional(),
              errorHandling: z.boolean().optional(),
              apiSurface: z.boolean().optional(),
              couplingScore: z.number().min(0).max(1).optional(),
              isTestFile: z.boolean().optional(),
            }),
          )
          .min(1)
          .describe('Candidate files'),
        budget: z.number().int().positive().describe('Token budget to respect'),
        taskType: z
          .enum(['bug fix', 'feature', 'refactor', 'test'])
          .optional()
          .describe('Task type for relevance boosts'),
        strategy: z
          .enum(['greedy', 'dp', 'adaptive'])
          .optional()
          .describe('Selection strategy (default dp with greedy fallback)'),
      },
    },
    async (args) => {
      try {
        for (const f of args.files) {
          confineToProject(f.path, deps.projectRoot);
        }
        const optimizer = new ContextBudgetOptimizer({
          strategy: args.strategy,
          taskType: args.taskType,
        });
        const items: ContextItem[] = args.files.map((f) => ({
          path: f.path,
          tokens:
            f.tokens ?? ContextBudgetOptimizer.tokenEstimator(resolve(deps.projectRoot, f.path)),
          relevanceScore: f.relevanceScore ?? 0.5,
          recentlyChanged: f.recentlyChanged,
          importedByQueryFiles: f.importedByQueryFiles,
          semanticMatch: f.semanticMatch,
          errorHandling: f.errorHandling,
          apiSurface: f.apiSurface,
          couplingScore: f.couplingScore,
          isTestFile: f.isTestFile,
        }));
        const plan = optimizer.optimize(
          items,
          args.budget,
          args.taskType as ContextTaskType | undefined,
        );
        return json({
          success: true,
          plan: {
            totalTokens: plan.totalTokens,
            allocatedTokens: plan.allocatedTokens,
            files: plan.files,
            excludedFiles: plan.excludedFiles,
            compressionStrategy: plan.compressionStrategy,
          },
        });
      } catch (error) {
        return json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

/** check_kg_integrity — knowledge-graph consistency violations + repairs. */
function registerCheckKgIntegrityTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'check_kg_integrity',
    {
      title: 'KG Integrity Check',
      description:
        'Check the knowledge graph for stale nodes (missing/moved files, stale imports/functions, orphans) with machine-readable repair suggestions.\n' +
        'WHEN to call: after renames/moves, when imports fail to resolve, or before trusting graph queries.\n' +
        'Set fix=true to apply safe automatic repairs (returns the full report).',
      inputSchema: {
        fix: z
          .boolean()
          .default(false)
          .describe('Apply automatic repairs (rename relink, stale-node removal)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(100)
          .describe('Maximum violations to return'),
      },
    },
    async (args) => {
      try {
        const guard = new IntegrityGuard(deps.projectRoot);
        if (args.fix) {
          const report = guard.generateReport();
          return json({
            success: true,
            repaired: report.repaired,
            orphans: report.orphans,
            violationCount: report.violations.length,
            violations: report.violations.slice(0, args.limit),
          });
        }
        const violations = guard.checkConsistency();
        return json({
          success: true,
          violationCount: violations.length,
          violations: violations.slice(0, args.limit),
        });
      } catch (error) {
        return json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

/** broadcast_intent — announce this agent's planned work (F16/F17/F45). */
function registerBroadcastIntentTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'broadcast_intent',
    {
      title: 'Broadcast Agent Intent',
      description:
        'Announce what you are about to do to other agents (live intent broadcast with TTL expiry).\n' +
        'WHEN to call: BEFORE starting a multi-step edit on shared files — other agents see the intent and can avoid conflicts.\n' +
        'Intents on private branches are kept local (sanitized) and never persisted to the shared DB.',
      inputSchema: {
        intentType: z.enum(['read', 'write', 'refactor', 'delete']).describe('What you plan to do'),
        targetFiles: z.array(z.string()).min(1).describe('Files the intent covers'),
        agentId: z
          .string()
          .optional()
          .describe('Your agent id (defaults to the server agent name)'),
        description: z.string().optional().describe('Short human-readable description'),
        ttlSeconds: z
          .number()
          .int()
          .min(1)
          .max(86400)
          .optional()
          .describe('Intent lifetime in seconds (default 300)'),
        expectedChanges: z
          .object({
            signatureChanges: z
              .array(z.object({ function: z.string(), oldSig: z.string(), newSig: z.string() }))
              .optional(),
            typeChanges: z
              .array(z.object({ type: z.string(), oldDef: z.string(), newDef: z.string() }))
              .optional(),
            notes: z.array(z.string()).optional(),
          })
          .optional()
          .describe('Planned signature/type changes (F17)'),
      },
    },
    async (args) => {
      try {
        const service = getSharedBroadcastService(deps.db);
        const broadcast = service.broadcastIntent({
          agentId: agentIdentity(deps, args.agentId),
          intentType: args.intentType,
          targetFiles: args.targetFiles,
          timestamp: Date.now(),
          description: args.description,
          ttlSeconds: args.ttlSeconds,
          expectedChanges: args.expectedChanges as ExpectedChanges | undefined,
        });
        return json({
          success: true,
          id: broadcast.id,
          scope: broadcast.scope,
          persisted: broadcast.scope === 'shared' && !!deps.db,
          expiresAt: broadcast.timestamp + (broadcast.ttlSeconds ?? 300) * 1000,
          broadcast,
        });
      } catch (error) {
        return json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

/** check_intent_conflicts — conflict prediction against live intents. */
function registerCheckIntentConflictsTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'check_intent_conflicts',
    {
      title: 'Intent Conflict Check',
      description:
        'Check whether OTHER agents hold live (unexpired) write/refactor/delete intents overlapping your target files.\n' +
        'WHEN to call: before editing files, right after broadcast_intent or when agent_locks check reports nothing but you still want intent-level coordination.',
      inputSchema: {
        targetFiles: z.array(z.string()).min(1).describe('Files you plan to touch'),
        agentId: z
          .string()
          .optional()
          .describe('Your agent id (defaults to the server agent name)'),
      },
    },
    async (args) => {
      try {
        const service = getSharedBroadcastService(deps.db);
        const prediction = service.checkConflict(
          agentIdentity(deps, args.agentId),
          args.targetFiles,
        );
        return json({ success: true, ...prediction });
      } catch (error) {
        return json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

/** find_patterns — cross-project learned-pattern similarity search (F4/F37). */
function registerFindPatternsTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'find_patterns',
    {
      title: 'Find Learned Patterns',
      description:
        'Find previously learned design patterns (interface/class templates) similar to a query in a target project.\n' +
        'WHEN to call: before designing a new interface/class — reuse a pattern that already proved itself elsewhere.\n' +
        'Confidence is the computed similarity score; hash-fallback matches are marked lowConfidence.',
      inputSchema: {
        name: z.string().describe('Pattern/interface name to search for'),
        targetProjectId: z.string().describe('Project id to search patterns in (string)'),
        category: z.string().optional().describe('Pattern category filter hint'),
        description: z.string().optional().describe('Pattern description hint'),
        interfaceName: z
          .string()
          .optional()
          .describe('Interface name of the query template (defaults to name)'),
        methodSignatures: z
          .array(z.string())
          .optional()
          .describe('Method signatures of the query template'),
        parameters: z.array(z.string()).optional().describe('Parameters of the query template'),
        returnType: z.string().optional().describe('Return type of the query template'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum matches'),
      },
    },
    async (args) => {
      try {
        if (!deps.db) return noDb('find_patterns');
        const engine = new CrossProjectPatternEngine(deps.db);
        const abstractTemplate: AbstractTemplate = {
          interfaceName: args.interfaceName ?? args.name,
          methodSignatures: args.methodSignatures ?? [],
          parameters: args.parameters ?? [],
          returnType: args.returnType ?? 'void',
        };
        const queryPattern = buildPattern({
          id: `query-${args.name}`,
          name: args.name,
          category: args.category ?? '',
          description: args.description ?? '',
          codeHash: JSON.stringify(abstractTemplate),
          confidence: 0,
          firstSeen: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          usageCount: 0,
          embedding: computeBagOfWordsEmbedding(abstractTemplate),
          projectId: null,
          abstractionLevel: 'design',
          abstractTemplate,
          variants: [],
        });
        const matches = engine.findSimilarPatternsInProject(
          queryPattern,
          args.targetProjectId,
          deps.db,
        );
        return json({
          success: true,
          count: Math.min(matches.length, args.limit),
          matches: matches.slice(0, args.limit).map((m) => ({
            id: m.id,
            name: m.name,
            category: m.category,
            similarity: m.similarity,
            lowConfidence: m.lowConfidence,
            confidence: m.confidence,
            originProject: m.originProject,
            abstractionLevel: m.abstractionLevel,
            abstractTemplate: m.abstractTemplate,
            successMetrics: m.successMetrics,
          })),
        });
      } catch (error) {
        return json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

/** Register all WP8 capability tools (F38). */
export function registerIntelligenceTools(server: McpServer, deps: McpDependencies): void {
  registerSearchIntentTool(server, deps);
  registerPredictImpactTool(server, deps);
  registerPlanContextBudgetTool(server, deps);
  registerCheckKgIntegrityTool(server, deps);
  registerBroadcastIntentTool(server, deps);
  registerCheckIntentConflictsTool(server, deps);
  registerFindPatternsTool(server, deps);
}
