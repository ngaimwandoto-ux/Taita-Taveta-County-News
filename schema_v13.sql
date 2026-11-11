-- Phase 5: optional full story text (for the printed supplement and "Read full story" in the app)
ALTER TABLE stories ADD COLUMN IF NOT EXISTS body TEXT;
