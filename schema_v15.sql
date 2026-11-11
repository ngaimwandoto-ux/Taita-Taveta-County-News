-- Phase 6: fares, clinics, road status, new notice types, memorial / celebration / legal boards
ALTER TABLE notices DROP CONSTRAINT IF EXISTS notices_kind_check;
ALTER TABLE notices ADD CONSTRAINT notices_kind_check CHECK (kind IN ('transport','utility','health','school','weather','advisory','tender','job','land','court','event','lostfound','obituary','notice','league','guide','history','alert','factcheck','bursary','participation','announcement'));
ALTER TABLE charges DROP CONSTRAINT IF EXISTS charges_kind_check;
ALTER TABLE charges ADD CONSTRAINT charges_kind_check CHECK (kind IN ('badge','ticket','board'));

CREATE TABLE IF NOT EXISTS fares (
  id SERIAL PRIMARY KEY, from_place VARCHAR(60) NOT NULL, to_place VARCHAR(60) NOT NULL,
  mode VARCHAR(10) NOT NULL CHECK (mode IN ('matatu','bus','sgr','boda','taxi')), fare_kes INT NOT NULL CHECK (fare_kes > 0),
  operator VARCHAR(80), whatsapp VARCHAR(12), pinned BOOLEAN NOT NULL DEFAULT FALSE, active BOOLEAN NOT NULL DEFAULT TRUE, updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS fares_idx ON fares (active, updated_at DESC);

CREATE TABLE IF NOT EXISTS facilities (
  id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, kind VARCHAR(10) NOT NULL CHECK (kind IN ('hospital','clinic','pharmacy')),
  sub_county_id INT NOT NULL REFERENCES sub_counties(id), phone VARCHAR(12), services VARCHAR(200), hours VARCHAR(80),
  open_24h BOOLEAN NOT NULL DEFAULT FALSE, featured_until DATE, active BOOLEAN NOT NULL DEFAULT TRUE);

CREATE TABLE IF NOT EXISTS road_status (
  id SERIAL PRIMARY KEY, road VARCHAR(80) UNIQUE NOT NULL, status VARCHAR(8) NOT NULL CHECK (status IN ('clear','patchy','heavy')),
  note VARCHAR(200), updated_at TIMESTAMPTZ DEFAULT NOW(), updated_by INT REFERENCES users(id));

-- One table for the three notice boards. Published posts are never edited, only removed.
CREATE TABLE IF NOT EXISTS board_posts (
  id SERIAL PRIMARY KEY, board VARCHAR(12) NOT NULL CHECK (board IN ('memorial','celebration','legal')),
  sub_county_id INT REFERENCES sub_counties(id), title VARCHAR(150) NOT NULL, summary TEXT NOT NULL,
  event_date DATE, venue VARCHAR(120), contact_phone VARCHAR(12), extra JSONB NOT NULL DEFAULT '{}', photo_url VARCHAR(255),
  tier VARCHAR(8) NOT NULL DEFAULT 'basic' CHECK (tier IN ('basic','featured')),
  status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('awaiting_payment','pending','published','removed')),
  fee_kes INT NOT NULL DEFAULT 0, paid BOOLEAN NOT NULL DEFAULT FALSE,
  confirmed_at TIMESTAMPTZ, confirmed_by INT REFERENCES users(id), confirm_note VARCHAR(200),
  published_at TIMESTAMPTZ, expires_on DATE, content_hash CHAR(64), print_edition VARCHAR(60), removed_reason VARCHAR(200),
  token_hash CHAR(64) NOT NULL, who_hash VARCHAR(24), created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS board_idx ON board_posts (board, status, expires_on);
