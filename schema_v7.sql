-- Breaking tag: set by the editor on approval, shown in red for 24 hours
ALTER TABLE stories ADD COLUMN IF NOT EXISTS breaking BOOLEAN NOT NULL DEFAULT FALSE;
