/*
  # Add category field to notes table

  1. Changes
    - `notes` table: add `category` column (text, nullable) to store AI-assigned category name
    - `notes` table: add `category_updated_at` column to track when categorization was last run

  2. Notes
    - category is a free-form text label determined by Claude based on the user's entire note collection
    - nullable because new notes have no category until the categorization job runs
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'notes' AND column_name = 'category'
  ) THEN
    ALTER TABLE notes ADD COLUMN category text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'notes' AND column_name = 'category_updated_at'
  ) THEN
    ALTER TABLE notes ADD COLUMN category_updated_at timestamptz;
  END IF;
END $$;
