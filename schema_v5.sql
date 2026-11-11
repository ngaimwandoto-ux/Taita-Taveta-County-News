-- WhatsApp: people who message your number, their sub-county, language and opt-in
CREATE TABLE IF NOT EXISTS wa_users (
  phone VARCHAR(20) PRIMARY KEY, sub_county_id INT REFERENCES sub_counties(id),
  lang VARCHAR(2) NOT NULL DEFAULT 'en' CHECK (lang IN ('en','sw')),
  subscribed BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW());
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_kind_check;
ALTER TABLE events ADD CONSTRAINT events_kind_check CHECK (kind IN ('qr_scan','page_view','video_play','issue_download','merchant_tap','install','wa_message'));
