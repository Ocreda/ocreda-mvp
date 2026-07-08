/*
  # Add pinned_notes table

  ## Summary
  Creates a table to store note pins with optional expiry timestamps and daily check tracking.

  ## New Tables
  - `pinned_notes`
    - `id` (uuid, primary key)
    - `user_id` (uuid, references auth.users)
    - `note_id` (uuid, references notes, cascade delete)
    - `pinned_until` (timestamptz, nullable — null means "always pinned")
    - `checked_today` (boolean, default false — resets daily)
    - `checked_date` (date, nullable — the date checked_today applies to)
    - `created_at` (timestamptz)
    - Unique constraint on (user_id, note_id)

  ## Security
  - RLS enabled
  - Users can only read/write their own pin records
*/

CREATE TABLE IF NOT EXISTS pinned_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  note_id uuid REFERENCES notes(id) ON DELETE CASCADE NOT NULL,
  pinned_until timestamptz DEFAULT NULL,
  checked_today boolean DEFAULT false NOT NULL,
  checked_date date DEFAULT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT unique_user_note_pin UNIQUE (user_id, note_id)
);

ALTER TABLE pinned_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own pins"
  ON pinned_notes FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own pins"
  ON pinned_notes FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own pins"
  ON pinned_notes FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own pins"
  ON pinned_notes FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_pinned_notes_user_id ON pinned_notes(user_id);
CREATE INDEX IF NOT EXISTS idx_pinned_notes_note_id ON pinned_notes(note_id);
