import { Command } from 'commander';

/**
 * Builds the complete ProjectMind command tree WITHOUT parsing argv or
 * printing anything. Shared by the interactive CLI entry point and the MCP
 * CLI-parity generator so the two surfaces can never drift apart.
 */
export async function buildProgram(): Promise<Command> {
  const program = new Command();
  program
    .name('projectmind')
    .description('Living Codebase Intelligence Layer for AI Agents');

  const modules: Array<{ path: string; name: string }> = [
    { path: './commands/init.js', name: 'createInitCommand' },
    { path: './commands/scan.js', name: 'createScanCommand' },
    { path: './commands/check.js', name: 'createCheckCommand' },
    { path: './commands/report.js', name: 'createReportCommand' },
    { path: './commands/context.js', name: 'createContextCommand' },
    { path: './commands/session.js', name: 'createSessionCommands' },
    { path: './commands/memory.js', name: 'createMemoryCommand' },
    { path: './commands/scale.js', name: 'createScaleCommand' },
    { path: './commands/debt.js', name: 'createDebtCommand' },
    { path: './commands/genome.js', name: 'createGenomeCommand' },
    { path: './commands/resolve.js', name: 'createResolveCommand' },
    { path: './commands/mcp.js', name: 'createMcpCommand' },
    { path: './commands/health.js', name: 'createHealthCommand' },
    { path: './commands/debug.js', name: 'createDebugCommand' },
    { path: './commands/doctor.js', name: 'createDoctorCommand' },
    { path: './commands/agent.js', name: 'createAgentCommand' },
    { path: './commands/search.js', name: 'createSearchCommand' },
    { path: './commands/impact.js', name: 'createImpactCommand' },
    { path: './commands/debt-prioritize.js', name: 'createDebtPrioritizeCommand' },
    { path: './commands/audit.js', name: 'createAuditCommand' },
    { path: './commands/license.js', name: 'createLicenseCommand' },
    { path: './commands/graph.js', name: 'createGraphCommand' },
    { path: './commands/heatmap.js', name: 'createHeatmapCommand' },
    { path: './commands/ownership.js', name: 'createOwnershipCommand' },
    { path: './commands/adr.js', name: 'createAdrCommand' },
    { path: './commands/dedup.js', name: 'createDedupCommand' },
    { path: './commands/churn.js', name: 'createChurnCommand' },
    { path: './commands/git-insights.js', name: 'createGitInsightsCommand' },
    { path: './commands/refs.js', name: 'createRefsCommand' },
    { path: './commands/def.js', name: 'createDefCommand' },
    { path: './commands/workspace.js', name: 'createWorkspaceCommand' },
    { path: './commands/autopilot.js', name: 'createAutopilotCommand' },
    { path: './commands/api-surface.js', name: 'createApiSurfaceCommand' },
    { path: './commands/layers.js', name: 'createLayersCommand' },
    { path: './commands/coupling.js', name: 'createCouplingCommand' },
    { path: './commands/pr-preview.js', name: 'createPrPreviewCommand' },
    { path: './commands/onboard.js', name: 'createOnboardCommand' },
    { path: './commands/test-quality.js', name: 'createTestQualityCommand' },
    { path: './commands/deps-fresh.js', name: 'createDepsFreshCommand' },
    { path: './commands/refactor-roi.js', name: 'createRefactorRoiCommand' },
    { path: './commands/flags.js', name: 'createFlagsCommand' },
    { path: './commands/secrets-life.js', name: 'createSecretsLifeCommand' },
    { path: './commands/sbom.js', name: 'createSbomCommand' },
    { path: './commands/refactor.js', name: 'createRefactorCommand' },
    { path: './commands/testgen.js', name: 'createTestgenCommand' },
    { path: './commands/docgen.js', name: 'createDocgenCommand' },
    { path: './commands/migrate.js', name: 'createMigrateCommand' },
    { path: './commands/skill-recommend.js', name: 'createSkillRecommendCommand' },
    { path: './commands/context-budget.js', name: 'createContextBudgetCommand' },
    { path: './commands/contract-test.js', name: 'createContractTestCommand' },
    { path: './commands/trace.js', name: 'createTraceCommand' },
    { path: './commands/project.js', name: 'createProjectCommand' },
    { path: './commands/data-flow.js', name: 'createDataFlowCommand' },
    { path: './commands/structural-search.js', name: 'createStructuralSearchCommand' },
    { path: './commands/embed.js', name: 'createEmbedCommand' },
    { path: './commands/taint.js', name: 'createTaintCommand' },
    { path: './commands/init-mcp.js', name: 'createInitMcpCommand' },
    { path: './commands/watch.js', name: 'createWatchCommand' },
    { path: './commands/serve.js', name: 'createServeCommand' }
  ];

  for (const { path, name } of modules) {
    const mod = (await import(path)) as Record<string, () => Command>;
    const factory = mod[name];
    if (typeof factory !== 'function') {
      throw new Error(`Module ${path} does not export ${name}`);
    }
    program.addCommand(factory());
  }

  return program;
}
