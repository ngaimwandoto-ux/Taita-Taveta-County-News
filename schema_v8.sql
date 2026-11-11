-- Accounts: owner > editor > hub lead > journalist. Keys are stored hashed, never in plain text.
CREATE TABLE IF NOT EXISTS hubs (
  id SERIAL PRIMARY KEY, name VARCHAR(80) NOT NULL, sub_county_id INT NOT NULL REFERENCES sub_counties(id), active BOOLEAN NOT NULL DEFAULT TRUE);
INSERT INTO hubs(name, sub_county_id) SELECT name || ' hub', id FROM sub_counties;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL,
  role VARCHAR(10) NOT NULL CHECK (role IN ('owner','editor','hub_lead','journalist')),
  hub_id INT REFERENCES hubs(id), sub_county_id INT REFERENCES sub_counties(id), mpesa_phone VARCHAR(12),
  key_hash CHAR(64) UNIQUE NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
  agreed_at TIMESTAMPTZ, last_seen TIMESTAMPTZ, created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(), legacy_contributor_id INT);

-- carry over existing contributors (their keys keep working, now hashed)
INSERT INTO users(name, role, hub_id, sub_county_id, mpesa_phone, key_hash, active, legacy_contributor_id)
SELECT c.name, 'journalist', (SELECT id FROM hubs h WHERE h.sub_county_id = c.sub_county_id ORDER BY id LIMIT 1), c.sub_county_id,
       c.mpesa_phone, encode(sha256(convert_to(c.token, 'UTF8')), 'hex'), c.active, c.id
FROM contributors c WHERE c.token IS NOT NULL;

ALTER TABLE stories ADD COLUMN IF NOT EXISTS author_id INT REFERENCES users(id);
ALTER TABLE stories ADD COLUMN IF NOT EXISTS hub_id INT REFERENCES hubs(id);
ALTER TABLE stories ADD COLUMN IF NOT EXISTS approved_by INT REFERENCES users(id);
UPDATE stories s SET author_id = u.id, hub_id = u.hub_id FROM users u WHERE u.legacy_contributor_id = s.contributor_id;
ALTER TABLE stories DROP CONSTRAINT IF EXISTS stories_status_check;
ALTER TABLE stories ADD CONSTRAINT stories_status_check CHECK (status IN ('draft','ready','approved','rejected'));

CREATE TABLE IF NOT EXISTS audit (
  id BIGSERIAL PRIMARY KEY, actor_id INT REFERENCES users(id), action VARCHAR(40) NOT NULL,
  target VARCHAR(60), detail TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
