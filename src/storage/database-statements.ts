import { DatabaseSync } from 'node:sqlite';

const stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>();

export function getStatement(sql: string, db: DatabaseSync): ReturnType<DatabaseSync['prepare']> {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

export function clearStatementCache(): void {
  stmtCache.clear();
}
