/*
  # Add full-text search index on notes

  1. Changes
    - Adds a GIN index on notes(title, content) using to_tsvector for fast PostgreSQL full-text search
    - Index covers both title (coalesced to empty string when null) and content

  2. Notes
    - Uses IF NOT EXISTS so re-running is safe
    - GIN indexes are optimal for tsvector / full-text workloads
*/

CREATE INDEX IF NOT EXISTS notes_search_idx
  ON notes
  USING gin(to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, '')));
