-- Lead story: the story whose big photo fronts the main page
ALTER TABLE stories ADD COLUMN IF NOT EXISTS lead_at TIMESTAMPTZ;
