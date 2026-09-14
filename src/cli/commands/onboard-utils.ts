export interface OnboardingStep {
  order: number;
  title: string;
  description: string;
  files: string[];
  estimatedTime: string;
  prerequisites: string[];
  type: 'read' | 'explore' | 'run' | 'exercise';
}

export interface OnboardingPath {
  role: string;
  totalSteps: number;
  totalTime: string;
  steps: OnboardingStep[];
}

export interface ModuleInfo {
  path: string;
  name: string;
  fileCount: number;
  totalBytes: number;
  cognitiveLoad: number;
  agentCoverage: number;
  files: Array<{ relativePath: string }>;
}

export interface ScaleReport {
  modules: ModuleInfo[];
}

export function generateOnboardingPath(
  role: string,
  depth: number,
  report: ScaleReport,
  allFiles: Array<{ relativePath: string }>,
): OnboardingPath {
  const steps: OnboardingStep[] = [];
  let stepOrder = 1;

  steps.push({
    order: stepOrder++,
    title: 'Project Overview & Architecture',
    description:
      'Understand the high-level architecture, module structure, and key design decisions',
    files: ['README.md', 'ARCHITECTURE.md', 'src/index.ts'].filter((f) =>
      allFiles.some((af) => af.relativePath === f),
    ),
    estimatedTime: '30 min',
    prerequisites: [],
    type: 'read',
  });

  steps.push({
    order: stepOrder++,
    title: 'Development Environment Setup',
    description: 'Install dependencies, run build, verify tests pass',
    files: ['package.json', 'tsconfig.json', '.projectmindrc.json', '.pmignore'],
    estimatedTime: '15 min',
    prerequisites: ['Node.js >=22', 'npm'],
    type: 'run',
  });

  if (depth >= 2) {
    const evidenceFiles = existingPaths(
      [
        '.pmignore',
        '.projectmindrc.json',
        'src/core/proof/',
        'src/core/ledger/',
        'src/mcp/security/',
      ],
      allFiles,
    );
    steps.push({
      order: stepOrder++,
      title: 'Evidence-First Agent Workflow',
      description:
        'Practice scan → context → proof → review: inspect bounded evidence, verify freshness, and keep unsupported claims explicitly unverified',
      files: evidenceFiles,
      estimatedTime: '25 min',
      prerequisites: ['ProjectMind CLI installed', 'A completed project scan'],
      type: 'run',
    });
  }

  steps.push({
    order: stepOrder++,
    title: 'Knowledge Graph & Coherence Engine',
    description: 'Run scan, check genome score, understand coherence checking',
    files: ['src/core/coherence/', 'src/core/scale/'],
    estimatedTime: '20 min',
    prerequisites: ['ProjectMind CLI installed'],
    type: 'explore',
  });

  if (role === 'backend' || role === 'fullstack') {
    const backendSteps = generateBackendSteps(depth, stepOrder, report, allFiles);
    steps.push(...backendSteps);
    stepOrder += backendSteps.length;
  }

  if (role === 'frontend' || role === 'fullstack') {
    const frontendSteps = generateFrontendSteps(depth, stepOrder, report, allFiles);
    steps.push(...frontendSteps);
    stepOrder += frontendSteps.length;
  }

  if (role === 'devops') {
    const devOpsSteps = generateDevOpsSteps(depth, stepOrder, report, allFiles);
    steps.push(...devOpsSteps);
    stepOrder += devOpsSteps.length;
  }

  if (role === 'ml') {
    const mlSteps = generateMLSteps(depth, stepOrder, report, allFiles);
    steps.push(...mlSteps);
    stepOrder += mlSteps.length;
  }

  if (depth >= 3) {
    steps.push({
      order: stepOrder++,
      title: 'Architectural Contracts & Guardrails',
      description: 'Understand and customize architectural contracts for the project',
      files: ['src/core/contracts/', '.projectmindrc.json'],
      estimatedTime: '30 min',
      prerequisites: ['Understanding of layer boundaries'],
      type: 'explore',
    });

    steps.push({
      order: stepOrder++,
      title: 'Cognitive Debt & Genome Analysis',
      description: 'Learn to interpret debt reports and genome scores',
      files: ['src/core/debt/', 'src/cli/commands/genome.ts'],
      estimatedTime: '25 min',
      prerequisites: ['Basic coherence understanding'],
      type: 'explore',
    });

    steps.push({
      order: stepOrder++,
      title: 'Agent Session & Memory Management',
      description: 'Learn to track agent work and use persistent memory',
      files: ['src/cli/commands/agent.ts', 'src/cli/commands/memory.ts'],
      estimatedTime: '20 min',
      prerequisites: [],
      type: 'run',
    });
  }

  if (depth >= 4) {
    steps.push({
      order: stepOrder++,
      title: 'Capstone: Add a New Feature End-to-End',
      description: 'Implement a small feature following project patterns: scan → check → commit',
      files: [],
      estimatedTime: '2-4 hours',
      prerequisites: ['All previous steps completed'],
      type: 'exercise',
    });
  }

  const totalTime = steps.reduce((sum, s) => {
    const match = s.estimatedTime.match(/(\d+)/);
    return sum + (match ? parseInt(match[1]) : 0);
  }, 0);

  return {
    role,
    totalSteps: steps.length,
    totalTime: `${totalTime} min (${Math.round((totalTime / 60) * 10) / 10} hrs)`,
    steps,
  };
}

export function generateBackendSteps(
  depth: number,
  startOrder: number,
  report: ScaleReport,
  allFiles: Array<{ relativePath: string }>,
): OnboardingStep[] {
  const steps: OnboardingStep[] = [];
  let order = startOrder;

  steps.push({
    order: order++,
    title: 'Core Domain & Business Logic',
    description: 'Explore domain entities, value objects, and business rules',
    files: findModuleFiles(report, 'domain', allFiles).slice(0, 10),
    estimatedTime: '45 min',
    prerequisites: ['Architecture overview'],
    type: 'explore',
  });

  steps.push({
    order: order++,
    title: 'Application Services & Use Cases',
    description: 'Understand application layer: commands, queries, transactions',
    files: findModuleFiles(report, 'application', allFiles).slice(0, 10),
    estimatedTime: '40 min',
    prerequisites: ['Domain layer understanding'],
    type: 'explore',
  });

  steps.push({
    order: order++,
    title: 'Infrastructure & Data Access',
    description: 'Database layer, repositories, external API integrations',
    files: findModuleFiles(report, 'infrastructure', allFiles).slice(0, 10),
    estimatedTime: '35 min',
    prerequisites: ['Application layer'],
    type: 'explore',
  });

  if (depth >= 3) {
    steps.push({
      order: order++,
      title: 'API Contracts & Versioning',
      description: 'Review API surface, versioning strategy, and breaking change policies',
      files: findModuleFiles(report, 'api', allFiles).slice(0, 5),
      estimatedTime: '30 min',
      prerequisites: ['Application services'],
      type: 'read',
    });
  }

  if (depth >= 4) {
    steps.push({
      order: order++,
      title: 'Exercise: Add a New Domain Entity',
      description: 'Create a new entity with repository, use case, and tests',
      files: [],
      estimatedTime: '2-3 hours',
      prerequisites: ['All backend layers understood'],
      type: 'exercise',
    });
  }

  return steps;
}

export function generateFrontendSteps(
  depth: number,
  startOrder: number,
  report: ScaleReport,
  allFiles: Array<{ relativePath: string }>,
): OnboardingStep[] {
  const steps: OnboardingStep[] = [];
  let order = startOrder;

  steps.push({
    order: order++,
    title: 'Component Architecture & State Management',
    description: 'Component hierarchy, state patterns, and UI architecture',
    files: findModuleFiles(report, 'ui', allFiles)
      .concat(findModuleFiles(report, 'components', allFiles))
      .slice(0, 10),
    estimatedTime: '45 min',
    prerequisites: ['Architecture overview'],
    type: 'explore',
  });

  steps.push({
    order: order++,
    title: 'API Integration & Data Fetching',
    description: 'API client, React Query/SWR patterns, error handling',
    files: findModuleFiles(report, 'api', allFiles).slice(0, 10),
    estimatedTime: '35 min',
    prerequisites: ['Component architecture'],
    type: 'explore',
  });

  if (depth >= 3) {
    steps.push({
      order: order++,
      title: 'Testing Strategy (Unit + E2E)',
      description: 'Component testing, mocking, visual regression, Playwright/Cypress',
      files: findModuleFiles(report, 'tests', allFiles).slice(0, 10),
      estimatedTime: '40 min',
      prerequisites: ['Component & API knowledge'],
      type: 'read',
    });
  }

  return steps;
}

export function generateDevOpsSteps(
  depth: number,
  startOrder: number,
  report: ScaleReport,
  allFiles: Array<{ relativePath: string }>,
): OnboardingStep[] {
  const steps: OnboardingStep[] = [];
  let order = startOrder;

  steps.push({
    order: order++,
    title: 'Build & CI/CD Pipeline',
    description: 'Build process, CI/CD configuration, deployment strategies',
    files: Array.from(
      new Set([
        ...['.github/workflows/', '.gitlab-ci.yml', 'Dockerfile', 'package.json scripts'].filter(
          (f) => allFiles.some((af) => af.relativePath.includes(f.replace('.yml', ''))),
        ),
        ...findModuleFiles(report, 'ci', allFiles),
        ...findModuleFiles(report, 'devops', allFiles),
      ]),
    ).slice(0, 10),
    estimatedTime: '40 min',
    prerequisites: [],
    type: 'read',
  });

  steps.push({
    order: order++,
    title: 'Monitoring, Logging & Observability',
    description: 'Metrics, traces, alerts, and debugging production issues',
    files: ['monitoring/', 'observability/', 'src/core/monitoring/'],
    estimatedTime: '30 min',
    prerequisites: ['CI/CD understanding'],
    type: 'explore',
  });

  if (depth >= 3) {
    steps.push({
      order: order++,
      title: 'Security & Compliance Automation',
      description: 'Secret scanning, dependency auditing, compliance checks',
      files: ['.github/workflows/security.yml', 'src/cli/commands/audit.ts'],
      estimatedTime: '30 min',
      prerequisites: ['CI/CD pipeline'],
      type: 'run',
    });
  }

  return steps;
}

export function generateMLSteps(
  depth: number,
  startOrder: number,
  report: ScaleReport,
  allFiles: Array<{ relativePath: string }>,
): OnboardingStep[] {
  const steps: OnboardingStep[] = [];
  let order = startOrder;

  steps.push({
    order: order++,
    title: 'ML Pipeline & Feature Engineering',
    description: 'Data pipelines, feature stores, model training workflows',
    files: findModuleFiles(report, 'ml', allFiles)
      .concat(findModuleFiles(report, 'data', allFiles))
      .slice(0, 10),
    estimatedTime: '60 min',
    prerequisites: ['TypeScript/JavaScript tooling basics'],
    type: 'explore',
  });

  steps.push({
    order: order++,
    title: 'Model Serving & A/B Testing',
    description: 'Model deployment, canary releases, feature flags for ML',
    files: findModuleFiles(report, 'serving', allFiles).slice(0, 5),
    estimatedTime: '40 min',
    prerequisites: ['Pipeline understanding'],
    type: 'read',
  });

  if (depth >= 3) {
    steps.push({
      order: order++,
      title: 'Model Monitoring & Governance',
      description: 'Model drift, observability, evaluation and release governance',
      files: findModuleFiles(report, 'monitor', allFiles)
        .concat(findModuleFiles(report, 'model', allFiles))
        .slice(0, 10),
      estimatedTime: '35 min',
      prerequisites: ['Model serving basics'],
      type: 'explore',
    });
  }

  return steps;
}

function findModuleFiles(
  report: ScaleReport,
  moduleName: string,
  allFiles: Array<{ relativePath: string }>,
): string[] {
  const module = report.modules.find((m) =>
    m.path.toLowerCase().includes(moduleName.toLowerCase()),
  );
  if (module) {
    return module.files?.map((f) => f.relativePath) || [];
  }
  return allFiles
    .filter((f) => f.relativePath.toLowerCase().includes(moduleName.toLowerCase()))
    .map((f) => f.relativePath);
}

function existingPaths(paths: string[], allFiles: Array<{ relativePath: string }>): string[] {
  return paths.filter((candidate) => {
    const prefix = candidate.endsWith('/') ? candidate : `${candidate}/`;
    return allFiles.some(
      (file) => file.relativePath === candidate || file.relativePath.startsWith(prefix),
    );
  });
}

export function generateMarkdownOnboarding(path: OnboardingPath): string {
  const lines = [
    `# Onboarding Path: ${path.role.charAt(0).toUpperCase() + path.role.slice(1)}`,
    '',
    `**Total Steps:** ${path.totalSteps} | **Estimated Time:** ${path.totalTime}`,
    `**Generated:** ${new Date().toISOString().split('T')[0]}`,
    '',
    '---',
    '',
  ];

  for (const step of path.steps) {
    const typeIcon =
      step.type === 'read'
        ? '📖'
        : step.type === 'explore'
          ? '🔍'
          : step.type === 'run'
            ? '▶️'
            : '💪';
    lines.push(`## Step ${step.order}: ${step.title} ${typeIcon}`, '');
    lines.push(`**Description:** ${step.description}`, '');
    lines.push(`**Time:** ${step.estimatedTime} | **Type:** ${step.type}`, '');

    if (step.prerequisites.length > 0) {
      lines.push(`**Prerequisites:** ${step.prerequisites.join(', ')}`, '');
    }

    if (step.files.length > 0) {
      lines.push(`**Key Files:**`, '');
      for (const file of step.files) {
        lines.push(`- \`${file}\``);
      }
      lines.push('');
    }
  }

  lines.push('---', '');
  lines.push(`**Total:** ${path.totalSteps} steps, ~${path.totalTime}`);

  return lines.join('\n');
}

export async function runInteractiveOnboarding(path: OnboardingPath): Promise<void> {
  const { createInterface } = await import('node:readline/promises');
  const { stdin, stdout } = await import('node:process');
  const { output } = await import('@/cli/utils/shared.js');

  // A non-interactive caller (CI, MCP, redirected stdin) must never hang.
  if (!stdin.isTTY || !stdout.isTTY) {
    output.raw(generateMarkdownOnboarding(path));
    return;
  }

  const readline = createInterface({ input: stdin, output: stdout });
  try {
    output.section(`Interactive onboarding: ${path.role}`);
    output.info('Press Enter after each step, or type q to stop.');
    for (const step of path.steps) {
      output.section(`Step ${step.order}/${path.totalSteps}: ${step.title}`);
      output.info(step.description);
      output.kv('Estimated time', step.estimatedTime);
      if (step.files.length > 0) output.list(step.files);
      const answer = await readline.question('Continue? [Enter/q] ');
      if (answer.trim().toLowerCase() === 'q') {
        output.info(`Stopped after step ${step.order}.`);
        return;
      }
    }
    output.success('Onboarding path completed.');
  } finally {
    readline.close();
  }
}
