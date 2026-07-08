/*
  # Enable RLS on All Tables

  ## Summary
  Several tables have RLS policies defined but RLS is not actually enabled,
  and two tables (notes, questions) have no RLS at all.

  This migration enables RLS on all affected tables and adds missing policies
  for notes and questions.

  ## Tables with existing policies (just need RLS enabled)
  - conversation_messages
  - daily_review_responses
  - daily_review_sessions
  - memory_sessions
  - note_connections
  - note_contradictions
  - note_memory_strength
  - note_relations
  - weekly_reports

  ## Tables needing RLS + new policies
  - notes (no RLS, no policies)
  - questions (no RLS, no policies)
*/

-- Enable RLS on all tables that have policies but RLS was disabled
ALTER TABLE public.conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_review_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_review_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_contradictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_memory_strength ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_reports ENABLE ROW LEVEL SECURITY;

-- Enable RLS on notes and questions (currently fully open)
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;

-- Add policies for notes
CREATE POLICY "Users can read own notes"
  ON public.notes FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own notes"
  ON public.notes FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own notes"
  ON public.notes FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own notes"
  ON public.notes FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Add policies for questions
CREATE POLICY "Users can read own questions"
  ON public.questions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own questions"
  ON public.questions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own questions"
  ON public.questions FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own questions"
  ON public.questions FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
