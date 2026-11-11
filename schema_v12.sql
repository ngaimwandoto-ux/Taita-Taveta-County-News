-- Phase 4: verified badge, event ticketing, rates and advertiser reports, insight subscriptions
CREATE TABLE IF NOT EXISTS charges (
  id SERIAL PRIMARY KEY, public_id VARCHAR(32) UNIQUE NOT NULL,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('badge','ticket')), ref_id INT NOT NULL, phone VARCHAR(12), amount INT NOT NULL,
  checkout_request_id VARCHAR(100) UNIQUE,
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','underpaid')),
  receipt VARCHAR(30) UNIQUE, created_at TIMESTAMPTZ DEFAULT NOW());
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS verified_by INT REFERENCES users(id);
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS badge_paid_until TIMESTAMPTZ;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS report_token VARCHAR(32) UNIQUE;
UPDATE merchants SET report_token = md5(random()::text || clock_timestamp()::text || id::text) WHERE report_token IS NULL;

CREATE TABLE IF NOT EXISTS ticketed_events (
  id SERIAL PRIMARY KEY, title VARCHAR(120) NOT NULL, description VARCHAR(500), venue VARCHAR(120), starts_at TIMESTAMPTZ NOT NULL,
  sub_county_id INT REFERENCES sub_counties(id), price_kes INT NOT NULL CHECK (price_kes >= 0), capacity INT NOT NULL CHECK (capacity > 0),
  organiser VARCHAR(100) NOT NULL, organiser_phone VARCHAR(12), commission_pct INT NOT NULL DEFAULT 10,
  active BOOLEAN NOT NULL DEFAULT TRUE, paid_out_at TIMESTAMPTZ, created_by INT REFERENCES users(id));
CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY, event_id INT NOT NULL REFERENCES ticketed_events(id), code VARCHAR(10) UNIQUE NOT NULL,
  buyer_name VARCHAR(80), buyer_phone VARCHAR(12),
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','used','cancelled')),
  charge_id INT REFERENCES charges(id), created_at TIMESTAMPTZ DEFAULT NOW(), used_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS tickets_event_idx ON tickets(event_id, status);

CREATE TABLE IF NOT EXISTS rates (
  id SERIAL PRIMARY KEY, name VARCHAR(80) NOT NULL, price_kes INT NOT NULL, unit VARCHAR(30) NOT NULL,
  details VARCHAR(300), active BOOLEAN NOT NULL DEFAULT TRUE);
CREATE TABLE IF NOT EXISTS price_history (
  id BIGSERIAL PRIMARY KEY, sub_county_id INT NOT NULL REFERENCES sub_counties(id), commodity VARCHAR(50) NOT NULL,
  local_price NUMERIC(10,2) NOT NULL, benchmark_price NUMERIC(10,2), recorded_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS price_history_idx ON price_history(commodity, sub_county_id, recorded_at);
CREATE TABLE IF NOT EXISTS insight_clients (
  id SERIAL PRIMARY KEY, org VARCHAR(120) NOT NULL, contact VARCHAR(120), key_hash CHAR(64) UNIQUE NOT NULL,
  active_until DATE NOT NULL, created_by INT REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW());
