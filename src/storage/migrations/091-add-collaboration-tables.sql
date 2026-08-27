-- Migration 091: Add collaboration tables (pending_intents) for live intent broadcast
CREATE TABLE IF NOT EXISTS pending_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  intent_type TEXT NOT NULL CHECK(intent_type IN ('read','write','refactor','delete')),
  target_files TEXT NOT NULL,
  session_id TEXT,
  description TEXT,
  broadcast_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL DEFAULT (datetime('now', '+5 minutes'))
);

CREATE INDEX IF NOT EXISTS idx_pending_intents_agent ON pending_intents(agent_id);
CREATE INDEX IF NOT EXISTS idx_pending_intents_type ON pending_intents(intent_type);
