/*
  # Add theme preference to user_settings

  ## Changes
  - `user_settings` table: add `theme` column (text, default 'auto')
    - Allowed values: 'light', 'dark', 'auto'
    - 'auto' follows the device system preference
    - 'light' / 'dark' force the respective theme regardless of device setting

  ## Notes
  - Existing rows default to 'auto' so no user experience changes on deploy
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_settings' AND column_name = 'theme'
  ) THEN
    ALTER TABLE user_settings ADD COLUMN theme text NOT NULL DEFAULT 'auto';
  END IF;
END $$;
