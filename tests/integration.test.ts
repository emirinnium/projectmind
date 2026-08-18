import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { initDatabase, setDatabase, closeDatabase } from '../src/storage/database.js';
import { SCHEMA_SQL } from '../src/storage/schema.js';
import { KnowledgeGraph } from '../src/storage/knowledge-graph.js';
import { CoherenceEngine } from '../src/core/coherence-engine.js';
import { DebtTracker } from '../src/core/debt-tracker.js';
import { ScaleManager } from '../src/core/scale-manager.js';
import { parseFile } from '../src/parser/ast-parser.js';
import { PatternLibrary } from '../src/parser/pattern-extractor.js';
import { textToEmbedding, cosineSimilarity } from '../src/parser/embeddings.js';

const TEST_DB = join(process.cwd(), 'tests', 'tmp-test.db');
const PROJECT_ROOT = join(process.cwd());
const SRC_DIR = join(PROJECT_ROOT, 'src');

async function testDatabase(): Promise<void> {
  const dbDir = dirname(TEST_DB);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  if (existsSync(TEST_DB)) rmSync(TEST_DB);

  const db = initDatabase(TEST_DB);
  db.exec(SCHEMA_SQL);
  setDatabase(db);

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
  assert(emb1.length === 128, `Embedding dimension: ${emb1.length}`);

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
  const genome = debt.computeGenome();
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

  closeDatabase();

  if (existsSync(TEST_DB)) rmSync(TEST_DB);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

testDatabase().catch(console.error);
