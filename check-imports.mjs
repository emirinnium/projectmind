import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('.projectmind/pm-knowledge.db');
const imports = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN resolved = 1 THEN 1 ELSE 0 END) as resolved FROM imports").get();
console.log('Import stats:', imports);
const sample = db.prepare("SELECT source, resolved, resolved_path FROM imports LIMIT 10").all();
console.log('Sample imports:', sample);