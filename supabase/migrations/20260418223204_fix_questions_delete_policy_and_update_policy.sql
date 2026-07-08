/*
  # Fix questions table RLS policies

  ## Changes
  - Add DELETE policy so authenticated users can delete their own questions
  - Add UPDATE policy so authenticated users can update their own question answers

  ## Why
  Previously the questions table had no DELETE or UPDATE policies, meaning:
  - Deletions via the frontend client (anon key) silently failed — questions came back on reload
  - Answer edits via the frontend client also failed silently

  ## Security
  Both policies check auth.uid() = user_id so users can only affect their own rows.
*/

CREATE POLICY "Users can delete own questions"
  ON questions
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own questions"
  ON questions
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
