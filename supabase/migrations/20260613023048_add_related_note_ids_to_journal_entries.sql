ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS related_note_ids text[] DEFAULT '{}';
