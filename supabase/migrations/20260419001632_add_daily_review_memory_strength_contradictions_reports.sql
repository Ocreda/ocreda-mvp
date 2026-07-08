/*
  # Add Daily Review, Memory Strength, Contradictions, and Weekly Reports

  ## New Tables

  ### daily_review_sessions
  - Tracks when each user completed a daily review
  - `id` (uuid, primary key)
  - `user_id` (uuid, references auth.users)
  - `review_date` (date) — the date this session covers (one per user per day)
  - `note_ids` (uuid[]) — the notes shown during this review
  - `created_at` (timestamptz)

  ### daily_review_responses
  - Stores user responses to individual notes during daily review
  - `id` (uuid, primary key)
  - `session_id` (uuid, references daily_review_sessions)
  - `user_id` (uuid)
  - `note_id` (uuid, references notes)
  - `response` (text) — 'relevant' or 'flagged'
  - `created_at` (timestamptz)

  ### note_memory_strength
  - Tracks memory strength score (1-100) per note per user
  - `id` (uuid, primary key)
  - `user_id` (uuid)
  - `note_id` (uuid, references notes)
  - `score` (numeric, default 50) — current strength 1-100
  - `last_accessed` (timestamptz)
  - `access_count` (integer, default 0)
  - `updated_at` (timestamptz)
  - Unique constraint on (user_id, note_id)

  ### note_contradictions
  - Stores detected contradictions between notes
  - `id` (uuid, primary key)
  - `user_id` (uuid)
  - `note_id_a` (uuid, references notes)
  - `note_id_b` (uuid, references notes)
  - `contradiction_summary` (text)
  - `reflection` (text, nullable) — user's written reflection
  - `dismissed` (boolean, default false)
  - `created_at` (timestamptz)

  ### weekly_reports
  - Stores generated weekly brain reports
  - `id` (uuid, primary key)
  - `user_id` (uuid)
  - `week_start` (date) — Monday of the covered week
  - `week_end` (date) — Sunday of the covered week
  - `report_text` (text) — the full narrative report
  - `stats` (jsonb) — raw stats used to generate the report
  - `created_at` (timestamptz)

  ## Security
  - RLS enabled on all tables
  - Users can only access their own data
*/

-- daily_review_sessions
CREATE TABLE IF NOT EXISTS daily_review_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  review_date date NOT NULL DEFAULT CURRENT_DATE,
  note_ids uuid[] DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, review_date)
);

ALTER TABLE daily_review_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own daily review sessions"
  ON daily_review_sessions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own daily review sessions"
  ON daily_review_sessions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own daily review sessions"
  ON daily_review_sessions FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- daily_review_responses
CREATE TABLE IF NOT EXISTS daily_review_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES daily_review_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  response text NOT NULL CHECK (response IN ('relevant', 'flagged')),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE daily_review_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own daily review responses"
  ON daily_review_responses FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own daily review responses"
  ON daily_review_responses FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- note_memory_strength
CREATE TABLE IF NOT EXISTS note_memory_strength (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  score numeric NOT NULL DEFAULT 50 CHECK (score >= 1 AND score <= 100),
  last_accessed timestamptz DEFAULT now(),
  access_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, note_id)
);

ALTER TABLE note_memory_strength ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own memory strength"
  ON note_memory_strength FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own memory strength"
  ON note_memory_strength FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own memory strength"
  ON note_memory_strength FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- note_contradictions
CREATE TABLE IF NOT EXISTS note_contradictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  note_id_a uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  note_id_b uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  contradiction_summary text NOT NULL DEFAULT '',
  reflection text,
  dismissed boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE note_contradictions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own contradictions"
  ON note_contradictions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own contradictions"
  ON note_contradictions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own contradictions"
  ON note_contradictions FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- weekly_reports
CREATE TABLE IF NOT EXISTS weekly_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  week_start date NOT NULL,
  week_end date NOT NULL,
  report_text text NOT NULL DEFAULT '',
  stats jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, week_start)
);

ALTER TABLE weekly_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own weekly reports"
  ON weekly_reports FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own weekly reports"
  ON weekly_reports FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own weekly reports"
  ON weekly_reports FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_daily_review_sessions_user_date ON daily_review_sessions(user_id, review_date);
CREATE INDEX IF NOT EXISTS idx_note_memory_strength_user ON note_memory_strength(user_id);
CREATE INDEX IF NOT EXISTS idx_note_memory_strength_note ON note_memory_strength(note_id);
CREATE INDEX IF NOT EXISTS idx_note_contradictions_user ON note_contradictions(user_id);
CREATE INDEX IF NOT EXISTS idx_weekly_reports_user ON weekly_reports(user_id, week_start DESC);
