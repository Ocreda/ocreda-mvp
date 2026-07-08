/*
  # Make notes.title nullable and add empty-string safe default

  The title column is NOT NULL with no default. If any code path passes
  an empty string or null, the insert fails. Making it nullable removes
  this failure mode — the application layer will always supply a title,
  but the DB will no longer reject inserts that don't.

  1. Changes
    - notes.title: remove NOT NULL constraint (make nullable)
    - notes.title: add DEFAULT '' so inserts without title succeed
*/

ALTER TABLE notes ALTER COLUMN title DROP NOT NULL;
ALTER TABLE notes ALTER COLUMN title SET DEFAULT '';
