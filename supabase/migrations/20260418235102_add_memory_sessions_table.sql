/*
  # Create memory_sessions table

  ## Summary
  Adds a new `memory_sessions` table to store "Find a Memory" recovery sessions.
  Each session records:
  - The initial memory fragment the user described
  - The full conversation (questions + answers) as a JSON array
  - The resolved note ID once the user finds their memory
  - A chain of related note IDs that the AI surfaced during recovery

  ## New Tables
  - `memory_sessions`
    - `id` (uuid, primary key)
    - `user_id` (uuid, references auth.users)
    - `fragment` (text) — the initial memory description
    - `conversation` (jsonb) — array of {role, text} objects
    - `resolved_note_id` (uuid, nullable) — the note the user identified as their memory
    - `chain_note_ids` (text[]) — ordered list of note IDs surfaced during the session
    - `created_at` (timestamptz)
    - `updated_at` (timestamptz)

  ## Security
  - RLS enabled
  - Users can only read, insert, update, and delete their own sessions
*/

CREATE TABLE IF NOT EXISTS memory_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fragment text NOT NULL DEFAULT '',
  conversation jsonb NOT NULL DEFAULT '[]',
  resolved_note_id uuid REFERENCES notes(id) ON DELETE SET NULL,
  chain_note_ids text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE memory_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own memory sessions"
  ON memory_sessions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own memory sessions"
  ON memory_sessions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own memory sessions"
  ON memory_sessions FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own memory sessions"
  ON memory_sessions FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS memory_sessions_user_id_idx ON memory_sessions(user_id);
CREATE INDEX IF NOT EXISTS memory_sessions_created_at_idx ON memory_sessions(created_at DESC);
