-- Story map: every story can carry a pin
ALTER TABLE stories ADD COLUMN IF NOT EXISTS latitude NUMERIC(9,6);
ALTER TABLE stories ADD COLUMN IF NOT EXISTS longitude NUMERIC(9,6);
ALTER TABLE stories ADD COLUMN IF NOT EXISTS place_name VARCHAR(80);
CREATE INDEX IF NOT EXISTS stories_map_idx ON stories (status, created_at DESC) WHERE latitude IS NOT NULL;
