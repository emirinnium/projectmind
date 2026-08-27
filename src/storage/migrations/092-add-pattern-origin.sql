-- Migration 092: Add pattern origin (project_id) and team_memories project linkage
ALTER TABLE patterns ADD COLUMN project_id INTEGER;
ALTER TABLE team_memories ADD COLUMN project_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_patterns_project ON patterns(project_id);
CREATE INDEX IF NOT EXISTS idx_team_memories_project ON team_memories(project_id);
