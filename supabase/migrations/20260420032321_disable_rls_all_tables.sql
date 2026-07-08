/*
  # Disable RLS on all tables

  This is a single-user personal app. Authentication has been removed entirely.
  All RLS policies are dropped and RLS is disabled on every table so that the
  anonymous Supabase client can read and write freely without a session token.

  Tables affected:
    - notes
    - note_relations
    - note_connections
    - questions
    - conversation_messages
    - memory_sessions
    - note_memory_strength
    - daily_review_sessions
    - daily_review_responses
    - note_contradictions
    - weekly_reports
*/

ALTER TABLE notes DISABLE ROW LEVEL SECURITY;
ALTER TABLE note_relations DISABLE ROW LEVEL SECURITY;
ALTER TABLE note_connections DISABLE ROW LEVEL SECURITY;
ALTER TABLE questions DISABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_messages DISABLE ROW LEVEL SECURITY;
ALTER TABLE memory_sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE note_memory_strength DISABLE ROW LEVEL SECURITY;
ALTER TABLE daily_review_sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE daily_review_responses DISABLE ROW LEVEL SECURITY;
ALTER TABLE note_contradictions DISABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_reports DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can select own notes" ON notes;
DROP POLICY IF EXISTS "Users can insert own notes" ON notes;
DROP POLICY IF EXISTS "Users can update own notes" ON notes;
DROP POLICY IF EXISTS "Users can delete own notes" ON notes;

DROP POLICY IF EXISTS "Users can select own note_relations" ON note_relations;
DROP POLICY IF EXISTS "Users can insert own note_relations" ON note_relations;
DROP POLICY IF EXISTS "Users can update own note_relations" ON note_relations;
DROP POLICY IF EXISTS "Users can delete own note_relations" ON note_relations;

DROP POLICY IF EXISTS "Users can select own questions" ON questions;
DROP POLICY IF EXISTS "Users can insert own questions" ON questions;
DROP POLICY IF EXISTS "Users can update own questions" ON questions;
DROP POLICY IF EXISTS "Users can delete own questions" ON questions;

DROP POLICY IF EXISTS "Users can select own conversation_messages" ON conversation_messages;
DROP POLICY IF EXISTS "Users can insert own conversation_messages" ON conversation_messages;

DROP POLICY IF EXISTS "Users can select own memory_sessions" ON memory_sessions;
DROP POLICY IF EXISTS "Users can insert own memory_sessions" ON memory_sessions;
DROP POLICY IF EXISTS "Users can update own memory_sessions" ON memory_sessions;

DROP POLICY IF EXISTS "Users can select own note_memory_strength" ON note_memory_strength;
DROP POLICY IF EXISTS "Users can insert own note_memory_strength" ON note_memory_strength;
DROP POLICY IF EXISTS "Users can update own note_memory_strength" ON note_memory_strength;

DROP POLICY IF EXISTS "Users can select own daily_review_sessions" ON daily_review_sessions;
DROP POLICY IF EXISTS "Users can insert own daily_review_sessions" ON daily_review_sessions;

DROP POLICY IF EXISTS "Users can select own daily_review_responses" ON daily_review_responses;
DROP POLICY IF EXISTS "Users can insert own daily_review_responses" ON daily_review_responses;

DROP POLICY IF EXISTS "Users can select own note_contradictions" ON note_contradictions;
DROP POLICY IF EXISTS "Users can insert own note_contradictions" ON note_contradictions;
DROP POLICY IF EXISTS "Users can update own note_contradictions" ON note_contradictions;

DROP POLICY IF EXISTS "Users can select own weekly_reports" ON weekly_reports;
DROP POLICY IF EXISTS "Users can insert own weekly_reports" ON weekly_reports;
DROP POLICY IF EXISTS "Users can update own weekly_reports" ON weekly_reports;
