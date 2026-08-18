import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('.projectmind/pm-knowledge.db');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name));
const importsSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name='imports'").get();
console.log('Imports schema:', importsSchema?.sql);