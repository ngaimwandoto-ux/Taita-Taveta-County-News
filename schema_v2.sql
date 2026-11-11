-- Run once on top of schema.sql: personal tokens for contributors
ALTER TABLE contributors ADD COLUMN IF NOT EXISTS token VARCHAR(64) UNIQUE;
