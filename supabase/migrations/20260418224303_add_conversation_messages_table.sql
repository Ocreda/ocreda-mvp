/*
  # Add conversation_messages table

  ## Summary
  Enables multi-turn conversation threads tied to each question.

  ## New Tables
  - `conversation_messages`
    - `id` (uuid, primary key)
    - `question_id` (uuid, FK → questions.id on delete cascade)
    - `user_id` (uuid, FK → auth.users)
    - `role` (text) — 'user' or 'assistant'
    - `content` (text) — message body
    - `relevant_note_ids` (uuid[]) — notes referenced in this message
    - `created_at` (timestamptz)

  ## Security
  - RLS enabled; authenticated users can only read/write their own messages
  - Cascade delete: removing a question removes all its messages
*/

CREATE TABLE IF NOT EXISTS conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL DEFAULT '',
  relevant_note_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_messages_question_id_idx ON conversation_messages(question_id);
CREATE INDEX IF NOT EXISTS conversation_messages_user_id_idx ON conversation_messages(user_id);

ALTER TABLE conversation_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own conversation messages"
  ON conversation_messages FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own conversation messages"
  ON conversation_messages FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own conversation messages"
  ON conversation_messages FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
