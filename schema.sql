CREATE TABLE sub_counties (
  id SERIAL PRIMARY KEY, slug VARCHAR(30) UNIQUE NOT NULL, name VARCHAR(50) NOT NULL);
INSERT INTO sub_counties (slug,name) VALUES ('voi','Voi'),('taveta','Taveta'),('mwatate','Mwatate'),('wundanyi','Wundanyi');

-- Bureau: graduates paid per item (main issue, daily feed, photo, podcast segment)
CREATE TABLE contributors (
  id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, sub_county_id INT NOT NULL REFERENCES sub_counties(id),
  mpesa_phone VARCHAR(12), active BOOLEAN DEFAULT TRUE);

CREATE TABLE stories (
  id SERIAL PRIMARY KEY,
  sub_county_id INT NOT NULL REFERENCES sub_counties(id),
  contributor_id INT REFERENCES contributors(id),
  paper VARCHAR(10) NOT NULL CHECK (paper IN ('review','roundup','both')),
  topic VARCHAR(20) NOT NULL CHECK (topic IN ('politics','sports','business','culture','tourism','agriculture','general')),
  placement VARCHAR(10) NOT NULL DEFAULT 'daily' CHECK (placement IN ('issue','daily')),
  status VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected')),
  headline VARCHAR(150) NOT NULL,
  bullets TEXT[] NOT NULL CHECK (array_length(bullets,1) = 3),
  image_url VARCHAR(255), video_url VARCHAR(255), audio_url VARCHAR(255),
  fee_kes INT DEFAULT 0, fee_paid BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(), approved_at TIMESTAMPTZ);
CREATE INDEX stories_feed_idx ON stories (status, sub_county_id, topic, created_at DESC);

CREATE TABLE market_prices (
  id SERIAL PRIMARY KEY, sub_county_id INT NOT NULL REFERENCES sub_counties(id),
  commodity VARCHAR(50) NOT NULL, local_price NUMERIC(10,2) NOT NULL, benchmark_price NUMERIC(10,2),
  updated_at TIMESTAMPTZ DEFAULT NOW());

CREATE TABLE merchants (
  id SERIAL PRIMARY KEY, sub_county_id INT NOT NULL REFERENCES sub_counties(id),
  business_name VARCHAR(100) NOT NULL, tagline VARCHAR(150) NOT NULL, whatsapp VARCHAR(12) NOT NULL,
  latitude NUMERIC(9,6), longitude NUMERIC(9,6),
  checkout_request_id VARCHAR(100) UNIQUE,            -- the ID SAFARICOM returns
  status VARCHAR(10) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','EXPIRED')),
  expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW());

CREATE TABLE payments (
  id SERIAL PRIMARY KEY, merchant_id INT REFERENCES merchants(id),
  mpesa_receipt VARCHAR(30) UNIQUE NOT NULL, amount NUMERIC(10,2) NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());

-- What you show advertisers: scans, plays, issue downloads, merchant taps
CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('qr_scan','page_view','video_play','issue_download','merchant_tap','install')),
  ref VARCHAR(60), sub_county_id INT REFERENCES sub_counties(id), created_at TIMESTAMPTZ DEFAULT NOW());
