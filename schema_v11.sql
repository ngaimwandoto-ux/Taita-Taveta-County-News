-- Phase 3: paired stories and votes, fact-checks, school results, markets and traders, sport
ALTER TABLE stories ADD COLUMN IF NOT EXISTS pair_id INT REFERENCES stories(id);
CREATE TABLE IF NOT EXISTS votes (
  id BIGSERIAL PRIMARY KEY, pair_key INT NOT NULL, story_id INT NOT NULL REFERENCES stories(id),
  who_hash VARCHAR(24) NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE (pair_key, who_hash));
ALTER TABLE tips ADD COLUMN IF NOT EXISTS kind VARCHAR(6) NOT NULL DEFAULT 'tip' CHECK (kind IN ('tip','claim'));
ALTER TABLE notices DROP CONSTRAINT IF EXISTS notices_kind_check;
ALTER TABLE notices ADD CONSTRAINT notices_kind_check CHECK (kind IN ('transport','utility','health','school','weather','advisory','tender','job','land','court','event','lostfound','obituary','notice','league','guide','history','alert','factcheck'));
CREATE TABLE IF NOT EXISTS school_results (
  id SERIAL PRIMARY KEY, exam VARCHAR(4) NOT NULL CHECK (exam IN ('KCPE','KCSE')), year INT NOT NULL,
  sub_county_id INT NOT NULL REFERENCES sub_counties(id), school VARCHAR(120) NOT NULL,
  candidates INT, mean_score NUMERIC(6,2), mean_grade VARCHAR(3));
CREATE INDEX IF NOT EXISTS results_idx ON school_results (sub_county_id, exam, year);
CREATE TABLE IF NOT EXISTS markets (
  id SERIAL PRIMARY KEY, name VARCHAR(80) NOT NULL, sub_county_id INT NOT NULL REFERENCES sub_counties(id),
  days TEXT[] NOT NULL, notes VARCHAR(200), active BOOLEAN NOT NULL DEFAULT TRUE);
CREATE TABLE IF NOT EXISTS traders (
  id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, sub_county_id INT NOT NULL REFERENCES sub_counties(id),
  market_id INT REFERENCES markets(id), goods VARCHAR(120), whatsapp VARCHAR(12) NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, created_by INT REFERENCES users(id));
CREATE TABLE IF NOT EXISTS leagues (
  id SERIAL PRIMARY KEY, name VARCHAR(80) NOT NULL, sport VARCHAR(30) NOT NULL DEFAULT 'football',
  sub_county_id INT REFERENCES sub_counties(id), active BOOLEAN NOT NULL DEFAULT TRUE);
CREATE TABLE IF NOT EXISTS matches (
  id SERIAL PRIMARY KEY, league_id INT NOT NULL REFERENCES leagues(id), home VARCHAR(60) NOT NULL, away VARCHAR(60) NOT NULL,
  kickoff TIMESTAMPTZ NOT NULL, venue VARCHAR(80), home_goals INT, away_goals INT,
  status VARCHAR(10) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','played')));
CREATE INDEX IF NOT EXISTS matches_idx ON matches (league_id, status, kickoff);
