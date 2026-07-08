/*
  # Add note_relations table

  ## Overview
  Creates a new note_relations table for storing semantic relationships between notes,
  identified by Claude AI when a note is saved.

  ## New Tables

  ### note_relations
  - `id` (uuid, PK) - Unique identifier
  - `note_id` (uuid, FK → notes) - The source note
  - `related_note_id` (uuid, FK → notes) - The related note
  - `reason` (text) - Claude's explanation of the relationship
  - `created_at` (timestamptz)

  ## Security
  - RLS enabled
  - Users can view relations where they own the source note
  - Service role key used for inserts from edge functions

  ## Notes
  - Unique constraint on (note_id, related_note_id) to avoid duplicates
  - Cascade deletes when either note is deleted
*/

CREATE TABLE IF NOT EXISTS note_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid REFERENCES notes(id) ON DELETE CASCADE NOT NULL,
  related_note_id uuid REFERENCES notes(id) ON DELETE CASCADE NOT NULL,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz DEFAULT now(),
  CONSTRAINT unique_note_relation UNIQUE (note_id, related_note_id)
);

CREATE INDEX IF NOT EXISTS note_relations_note_id_idx ON note_relations(note_id);
CREATE INDEX IF NOT EXISTS note_relations_related_note_id_idx ON note_relations(related_note_id);

ALTER TABLE note_relations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view relations for own notes"
  ON note_relations FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM notes
      WHERE notes.id = note_relations.note_id
      AND notes.user_id = auth.uid()
    )
  );
