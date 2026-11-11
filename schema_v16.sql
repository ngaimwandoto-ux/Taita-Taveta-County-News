-- Phase 7: lost and found, missing persons, chamas, unclaimed-body notices, food and nightlife guide
ALTER TABLE board_posts DROP CONSTRAINT IF EXISTS board_posts_board_check;
ALTER TABLE board_posts ADD CONSTRAINT board_posts_board_check CHECK (board IN ('memorial','celebration','legal','lostfound','missing','chama','coroner'));

CREATE TABLE IF NOT EXISTS venues (
  id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, kind VARCHAR(10) NOT NULL CHECK (kind IN ('restaurant','bar','club','lodge','cafe')),
  sub_county_id INT NOT NULL REFERENCES sub_counties(id), address VARCHAR(160), phone VARCHAR(12), hours VARCHAR(80), description VARCHAR(300),
  promo_text VARCHAR(200), promo_until DATE, menu_verified_at TIMESTAMPTZ, active BOOLEAN NOT NULL DEFAULT TRUE);
CREATE TABLE IF NOT EXISTS menu_items (
  id SERIAL PRIMARY KEY, venue_id INT NOT NULL REFERENCES venues(id), item VARCHAR(80) NOT NULL, price_kes INT NOT NULL CHECK (price_kes > 0),
  category VARCHAR(6) NOT NULL CHECK (category IN ('food','drink')), active BOOLEAN NOT NULL DEFAULT TRUE, updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS menu_idx ON menu_items (active, lower(item));
