import type { Migration } from './types.js';

/** Tables for privacy-preserving search and cross-session intelligence. */
export const intelligenceMigrations: Migration[] = [
  {
    version: 111,
    name: 'search-interactions-and-session-events',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS search_interactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          agent_key TEXT NOT NULL,
          query_hash TEXT NOT NULL CHECK(length(query_hash) = 64),
          result_path TEXT NOT NULL,
          position INTEGER NOT NULL CHECK(position >= 1 AND position <= 1000),
          feedback TEXT NOT NULL CHECK(feedback IN ('selected', 'opened', 'included', 'skipped')),
          features TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_search_interactions_project_query
          ON search_interactions(project_id, query_hash, id);
        CREATE INDEX IF NOT EXISTS idx_search_interactions_agent
          ON search_interactions(project_id, agent_key, id);

        CREATE TABLE IF NOT EXISTS agent_session_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          session_id INTEGER NOT NULL,
          agent_key TEXT NOT NULL,
          event_type TEXT NOT NULL CHECK(event_type IN ('file_touched', 'tool_used', 'pattern', 'outcome')),
          event_key TEXT NOT NULL,
          event_value TEXT,
          success INTEGER CHECK(success IS NULL OR success IN (0, 1)),
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_agent_session_events_project
          ON agent_session_events(project_id, agent_key, event_type, id);
        CREATE INDEX IF NOT EXISTS idx_agent_session_events_session
          ON agent_session_events(session_id, id);
      `);
    },
    down: (db) => {
      db.exec(
        'DROP TABLE IF EXISTS agent_session_events; DROP TABLE IF EXISTS search_interactions;',
      );
    },
  },
];
