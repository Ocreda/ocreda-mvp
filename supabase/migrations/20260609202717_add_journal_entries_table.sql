CREATE TABLE IF NOT EXISTS journal_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date        date NOT NULL,
  content     text NOT NULL DEFAULT '',
  mood        smallint CHECK (mood BETWEEN 1 AND 5),
  ai_summary  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, date)
);

ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_journal_entries" ON journal_entries FOR SELECT
  TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "insert_own_journal_entries" ON journal_entries FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "update_own_journal_entries" ON journal_entries FOR UPDATE
  TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "delete_own_journal_entries" ON journal_entries FOR DELETE
  TO authenticated USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS journal_entries_user_date_idx ON journal_entries (user_id, date DESC);
