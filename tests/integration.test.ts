import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initDatabase, closeDatabase } from '../src/storage/database.js';
import { SCHEMA_SQL } from '../src/storage/schema.js';
import { KnowledgeGraph } from '../src/storage/knowledge-graph.js';
import { CoherenceEngine } from '../src/core/coherence/engine.js';
import { DebtTracker } from '../src/core/debt/tracker.js';
import { ScaleManager } from '../src/core/scale/manager.js';
import { parseFile } from '../src/parser/ast-parser.js';
import { PatternLibrary } from '../src/parser/pattern-extractor.js';
import { textToEmbedding, cosineSimilarity } from '../src/parser/embeddings.js';

const TEST_DB = join(process.cwd(), 'tests', `tmp-test-${randomUUID()}.db`);
const PROJECT_ROOT = join(process.cwd());
const SRC_DIR = join(PROJECT_ROOT, 'src');

async function testDatabase(): Promise<void> {
  const dbDir = dirname(TEST_DB);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  
  // Retry cleanup to handle Windows file locking
  for (let i = 0; i < 5; i++) {
    try {
      if (existsSync(TEST_DB)) rmSync(TEST_DB);
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  // Use initDatabase to set up the global singleton for KnowledgeGraph helpers
  const db = initDatabase(TEST_DB);
  db.exec(SCHEMA_SQL);

  const kg = new KnowledgeGraph(db);
  const coherence = new CoherenceEngine(db);
  const debt = new DebtTracker(db, kg, coherence);
  const scale = new ScaleManager(db, kg);
  const patterns = new PatternLibrary(db);

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string): void {
    if (condition) {
      passed++;
      console.log(`  ✓ ${message}`);
    } else {
      failed++;
      console.error(`  ✗ ${message}`);
    }
  }

  console.log('\n=== Test: Database Initialization ===');
  assert(db !== null, 'Database initialized');

  console.log('\n=== Test: SQL Schema ===');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  assert(tables.some((t) => t.name === 'files'), 'files table exists');
  assert(tables.some((t) => t.name === 'functions'), 'functions table exists');
  assert(tables.some((t) => t.name === 'classes'), 'classes table exists');
  assert(tables.some((t) => t.name === 'patterns'), 'patterns table exists');
  assert(tables.some((t) => t.name === 'agent_sessions'), 'agent_sessions table exists');
  assert(tables.some((t) => t.name === 'debt_items'), 'debt_items table exists');
  assert(tables.some((t) => t.name === 'coherence_decisions'), 'coherence_decisions table exists');
  assert(tables.some((t) => t.name === 'project_genome'), 'project_genome table exists');

  console.log('\n=== Test: File Parsing ===');
  const testFile = join(SRC_DIR, 'parser', 'embeddings.ts');
  const content = readFileSync(testFile, 'utf-8');
  const struct = parseFile(testFile, content);

  assert(struct !== null, 'Parse TypeScript file');
  if (struct) {
    assert(struct.language === 'typescript', `Language detected: ${struct.language}`);
    assert(struct.functions.length > 0, `Functions found: ${struct.functions.length}`);
    assert(struct.hash.length > 0, 'File hash generated');
    assert(struct.lines > 0, `Line count: ${struct.lines}`);
  }

  console.log('\n=== Test: Knowledge Graph ===');
  const fileId = await kg.upsertFile(struct!, 'parser/embeddings.ts');
  assert(fileId > 0, `File stored with ID: ${fileId}`);
  kg.storeFileDetails(fileId, struct!);

  const fileInfo = kg.getFileByPath(testFile);
  assert(fileInfo !== null, 'File retrieved from KG');
  assert(fileInfo!.relativePath === 'parser/embeddings.ts', 'Relative path stored correctly');

  console.log('\n=== Test: Pattern Extraction ===');
  const extractedPatterns = patterns.extractPatterns(struct!);
  assert(extractedPatterns.length > 0, `Patterns extracted: ${extractedPatterns.length}`);

  const coherenceScore = patterns.getCoherenceScore();
  assert(coherenceScore > 0, `Pattern coherence score: ${coherenceScore.toFixed(3)}`);

  console.log('\n=== Test: Embedding & Similarity ===');
  const emb1 = textToEmbedding('hello world');
  const emb2 = textToEmbedding('world hello');
  const emb3 = textToEmbedding('completely different');
  assert(emb1.length === 768, `Embedding dimension: ${emb1.length}`);

  const sim1 = cosineSimilarity(emb1, emb2);
  const sim2 = cosineSimilarity(emb1, emb3);
  assert(sim1 > 0.5, `Similar texts have high similarity: ${sim1.toFixed(3)}`);
  assert(sim2 < sim1, `Different texts have lower similarity: ${sim2.toFixed(3)} < ${sim1.toFixed(3)}`);

  console.log('\n=== Test: Coherence Check (Fast) ===');
  const result = await coherence.checkCoherence({
    code: 'function test() { return 1; }',
    filePath: 'test.ts',
    fastOnly: true,
  });
  assert(result.verdict !== undefined, `Verdict: ${result.verdict}`);
  assert(result.confidence > 0, `Confidence: ${result.confidence}`);
  assert(result.reasoningTrace.length > 0, `Reasoning trace length: ${result.reasoningTrace.length}`);
  assert(result.responseTimeMs >= 0, `Response time: ${result.responseTimeMs}ms`);

  console.log('\n=== Test: Coherence Check (Caching) ===');
  const cachedResult = await coherence.checkCoherence({
    code: 'function test() { return 1; }',
    filePath: 'test.ts',
    fastOnly: true,
  });
  assert(cachedResult.verdict === result.verdict, 'Cached result matches');

  console.log('\n=== Test: Agent Session ===');
  const sessionId = kg.startAgentSession('test-agent');
  assert(sessionId > 0, `Session started: ${sessionId}`);

  kg.storeMemory(sessionId, 'test-scope', 'key1', JSON.stringify({ value: 'test' }));
  const memories = kg.getMemory('test-scope', 'key1');
  assert(memories.length === 1, 'Memory stored and retrieved');
  assert(JSON.stringify(memories[0].value) === JSON.stringify({ value: 'test' }), 'Memory value matches');

  kg.endAgentSession(sessionId);
  const sessions = kg.getAgentSessions('test-agent');
  assert(sessions.length > 0, 'Session persisted in history');

  console.log('\n=== Test: Debt Tracker ===');
  // Use Promise.race with timeout to prevent CI hangs
  const genomePromise = debt.computeGenome();
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('computeGenome timeout after 30s')), 30_000)
  );
  const genome = await Promise.race([genomePromise, timeoutPromise]);
  assert(genome.coherenceScore > 0, `Genome score: ${genome.coherenceScore.toFixed(3)}`);
  assert(genome.coherenceScore <= 1.0, `Genome score <= 1.0`);

  const report = debt.getReport();
  assert(report.totalItems >= 0, `Debt items: ${report.totalItems}`);
  assert(report.bySeverity.high >= 0, 'High severity tracked');
  assert(report.bySeverity.medium >= 0, 'Medium severity tracked');
  assert(report.bySeverity.low >= 0, 'Low severity tracked');

  console.log('\n=== Test: Scale Manager ===');
  const scaleReport = scale.getScaleReport();
  assert(scaleReport.totalFiles > 0, `Total files: ${scaleReport.totalFiles}`);
  assert(scaleReport.totalLines > 0, `Total lines: ${scaleReport.totalLines}`);
  assert(Object.keys(scaleReport.languages).length > 0, 'Languages detected');
  assert(scaleReport.modules.length > 0, `Modules found: ${scaleReport.modules.length}`);
  assert(scaleReport.topHotspots.length > 0, `Hotspots found: ${scaleReport.topHotspots.length}`);
  assert(scaleReport.uncoveredFiles.length > 0, `Uncovered files: ${scaleReport.uncoveredFiles.length}`);

  const agentProfiles = scale.getAgentProfiles();
  assert(agentProfiles.length > 0, `Agent profiles: ${agentProfiles.length}`);

  const heatmap = scale.getCoverageHeatmap();
  assert(heatmap.length > 0, `Heatmap entries: ${heatmap.length}`);

  console.log('\n=== Test: Agent Memory Bridge ===');
  const sessionMemories = kg.getMemory('test-scope');
  assert(sessionMemories.length > 0, `Session memories: ${sessionMemories.length}`);

  console.log('\n=== Test: Agent Touched Files ===');
  kg.markAgentTouched('parser/embeddings.ts', 'test-agent');
  const touchedFiles = kg.getAgentTouchedFiles();
  assert(touchedFiles.length > 0, `Touched files: ${touchedFiles.length}`);

  console.log('\n=== Test: File Finder ===');
  const allFiles = kg.getAllFiles();
  assert(allFiles.length > 0, `All files: ${allFiles.length}`);

  console.log('\n=== Test: Project Management ===');
  const project = kg.createProject('test-project', PROJECT_ROOT, 'Test project');
  assert(project.id > 0, `Project created with ID: ${project.id}`);
  assert(project.name === 'test-project', 'Project name matches');
  assert(project.rootPath === PROJECT_ROOT, 'Project root path matches');

  const projects = kg.listProjects();
  assert(projects.length >= 1, `Projects listed: ${projects.length}`);
  assert(projects.some((p) => p.name === 'test-project'), 'New project in list');

  const switchResult = kg.switchProject(project.id);
  assert(switchResult.success, 'Switched to new project');
  assert(switchResult.project?.id === project.id, 'Switched project ID matches');

  const currentProject = kg.getCurrentProject();
  assert(currentProject?.id === project.id, 'Current project matches switched project');

  console.log('\n=== Test: Dynamic Tracing ===');
  // First insert functions to reference in dynamic calls
  db.prepare('INSERT INTO functions (file_id, name, signature, start_line, end_line, complexity) VALUES (?, ?, ?, ?, ?, ?)')
    .run(1, 'caller', 'caller()', 1, 3, 1);
  db.prepare('INSERT INTO functions (file_id, name, signature, start_line, end_line, complexity) VALUES (?, ?, ?, ?, ?, ?)')
    .run(1, 'callee', 'callee()', 5, 7, 1);
  db.prepare('INSERT INTO functions (file_id, name, signature, start_line, end_line, complexity) VALUES (?, ?, ?, ?, ?, ?)')
    .run(1, 'caller2', 'caller2()', 9, 11, 1);
  db.prepare('INSERT INTO functions (file_id, name, signature, start_line, end_line, complexity) VALUES (?, ?, ?, ?, ?, ?)')
    .run(1, 'callee2', 'callee2()', 13, 15, 1);

  kg.ingestDynamicCalls([
    {
      fromFunctionName: 'caller',
      toFunctionName: 'callee',
      workloadId: 'test-workload',
      callCount: 3,
      staticMissed: true,
    },
    {
      fromFunctionName: 'caller2',
      toFunctionName: 'callee2',
      workloadId: 'test-workload',
      callCount: 1,
      staticMissed: false,
    },
  ]);

  const dynamicCalls = kg.getDynamicCalls('test-workload');
  assert(dynamicCalls.length === 2, `Dynamic calls: ${dynamicCalls.length}`);

  const allDynamicCalls = kg.getAllDynamicCalls();
  assert(allDynamicCalls.length >= 2, `All dynamic calls: ${allDynamicCalls.length}`);

  const staticMissed = kg.getStaticMissedCalls();
  assert(staticMissed.length >= 1, `Static missed calls: ${staticMissed.length}`);
  assert(staticMissed[0].staticMissed === true, 'Static missed flag preserved');

  const cleared = kg.clearDynamicCalls('test-workload');
  assert(cleared === 2, `Cleared ${cleared} dynamic calls`);

  console.log('\n=== Test: Data-Flow / Taint Analysis ===');
  const flow = kg.recordDataFlow({
    fromResourceQualifiedName: 'fs.readFile("./input.txt")',
    fromResourceKind: 'FILE',
    fromResourceIdentity: './input.txt',
    toResourceQualifiedName: 'processInput',
    toResourceKind: 'NETWORK',
    toResourceIdentity: 'http://evil.com',
    kind: 'arg',
    via: 'processInput',
    sourceFunctionName: 'loadData',
    targetFunctionName: 'sendData',
  });
  assert(flow.id > 0, `Data flow recorded: ${flow.id}`);
  assert(flow.fromResource.qualifiedName === 'fs.readFile("./input.txt")', 'From resource matches');
  assert(flow.toResource.qualifiedName === 'processInput', 'To resource matches');

  const flows = kg.getDataFlows();
  assert(flows.length >= 1, `Data flows: ${flows.length}`);
  assert(flows[0].kind === 'arg', 'Flow kind preserved');

  const resourceFlows = kg.getResourceFlows('fs.readFile("./input.txt")');
  assert(resourceFlows.length >= 1, `Resource flows: ${resourceFlows.length}`);

  const clearedFlows = kg.clearDataFlows();
  assert(clearedFlows >= 1, `Cleared ${clearedFlows} data flows`);

  // Cleanup using closeDatabase
  closeDatabase();

  // Retry cleanup to handle Windows file locking
  for (let i = 0; i < 5; i++) {
    try {
      if (existsSync(TEST_DB)) rmSync(TEST_DB);
      if (existsSync(TEST_DB + '-shm')) rmSync(TEST_DB + '-shm');
      if (existsSync(TEST_DB + '-wal')) rmSync(TEST_DB + '-wal');
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

testDatabase().catch((e) => {
  console.error(e);
  process.exit(1);
});
