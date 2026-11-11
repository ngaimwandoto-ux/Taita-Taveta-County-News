-- Utility layer: one table for every notice type. sub_county_id NULL = whole county.
CREATE TABLE IF NOT EXISTS notices (
  id SERIAL PRIMARY KEY,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('transport','utility','health','school','weather','advisory','tender','job','land','court','event','lostfound','obituary','notice','league','guide','history','alert')),
  sub_county_id INT REFERENCES sub_counties(id),
  lang VARCHAR(2) NOT NULL DEFAULT 'en' CHECK (lang IN ('en','sw')),
  title VARCHAR(150) NOT NULL, body TEXT NOT NULL,
  urgent BOOLEAN DEFAULT FALSE, event_date DATE, expires_on DATE,
  created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS notices_idx ON notices (kind, sub_county_id, created_at DESC);
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS category VARCHAR(30) NOT NULL DEFAULT 'other';
ALTER TABLE market_prices ADD CONSTRAINT market_prices_uq UNIQUE (sub_county_id, commodity);
