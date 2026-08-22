import { initDatabase, setDatabase, closeDatabase } from '../dist/storage/database.js';
import { SCHEMA_SQL } from '../dist/storage/schema.js';
import { KnowledgeGraph } from '../dist/storage/knowledge-graph.js';

const db = initDatabase('.projectmind/pm-knowledge.db');
db.exec(SCHEMA_SQL);
setDatabase(db);
const kg = new KnowledgeGraph(db);

const target =
  kg.getFileByPath('src/cli/utils/logger.ts') ??
  kg.getAllFiles().find((f) => f.relativePath.endsWith('logger.ts'));
if (!target) {
  console.log('TARGET NOT FOUND');
  process.exit(1);
}
console.log('Target:', target.relativePath);
const deps = kg.getDependents(target.id);
console.log('Dependents found:', deps.length);
for (const d of deps.slice(0, 8)) console.log('  <-', d.relativePath);

// Also verify impact analysis data path for a core module
const engineFile = kg.getAllFiles().find((f) => f.relativePath === 'src/core/coherence/engine.ts');
if (engineFile) {
  const d2 = kg.getDependents(engineFile.id);
  console.log('coherence/engine.ts dependents:', d2.length);
}
closeDatabase();
