-- Phase 2: duplicate-proof offline submissions, reader tips
ALTER TABLE stories ADD COLUMN IF NOT EXISTS client_id VARCHAR(40);
CREATE UNIQUE INDEX IF NOT EXISTS stories_client_uq ON stories(author_id, client_id) WHERE client_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS tips (
  id SERIAL PRIMARY KEY, sub_county_id INT REFERENCES sub_counties(id), hub_id INT REFERENCES hubs(id),
  body TEXT NOT NULL, contact VARCHAR(20), place_name VARCHAR(80), latitude NUMERIC(9,6), longitude NUMERIC(9,6), image_url VARCHAR(255),
  source VARCHAR(10) NOT NULL CHECK (source IN ('app','whatsapp')),
  status VARCHAR(10) NOT NULL DEFAULT 'new' CHECK (status IN ('new','assigned','used','spam')),
  assigned_to INT REFERENCES users(id), who_hash VARCHAR(24), photo_token_hash CHAR(64), created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS tips_idx ON tips(status, hub_id, created_at DESC);
