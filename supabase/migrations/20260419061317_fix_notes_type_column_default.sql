/*
  # Fix notes type column

  The `type` column on the notes table is NOT NULL with no default value.
  This causes every INSERT that doesn't specify a type to fail silently.

  1. Changes
    - Add a default value of 'note' to the `type` column so inserts without
      an explicit type succeed.
*/

ALTER TABLE notes ALTER COLUMN type SET DEFAULT 'note';
