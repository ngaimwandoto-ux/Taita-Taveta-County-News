-- Phase 1: freezes, recovery, edit history, public corrections
ALTER TABLE users ADD COLUMN IF NOT EXISTS frozen BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_hash CHAR(64);
ALTER TABLE hubs ADD COLUMN IF NOT EXISTS frozen BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS story_edits (
  id BIGSERIAL PRIMARY KEY, story_id INT NOT NULL REFERENCES stories(id), editor_id INT REFERENCES users(id),
  before JSONB, after JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS corrections (
  id SERIAL PRIMARY KEY, story_id INT NOT NULL REFERENCES stories(id), note VARCHAR(300) NOT NULL,
  created_by INT REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS corrections_story_idx ON corrections(story_id);
