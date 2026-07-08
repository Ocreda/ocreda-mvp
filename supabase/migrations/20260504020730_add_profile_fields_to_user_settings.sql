/*
  # Add profile fields to user_settings

  1. Changes to `user_settings` table
    - Add `full_name` (text) — user's display name, nullable
    - Add `avatar_url` (text) — URL to profile photo in storage, nullable

  2. Security
    - No new tables; existing RLS on user_settings covers these columns
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_settings' AND column_name = 'full_name'
  ) THEN
    ALTER TABLE user_settings ADD COLUMN full_name text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_settings' AND column_name = 'avatar_url'
  ) THEN
    ALTER TABLE user_settings ADD COLUMN avatar_url text;
  END IF;
END $$;
