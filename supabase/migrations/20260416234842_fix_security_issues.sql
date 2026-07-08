/*
  # Fix Security Issues

  ## Changes

  1. Move `vector` extension from public schema to `extensions` schema
     - Creates dedicated `extensions` schema
     - Moves the vector extension out of the public schema

  2. Fix mutable search_path on `update_note_updated_at` trigger function
     - Recreates with fixed `search_path = ''`

  3. Fix mutable search_path on `match_notes` function
     - Recreates with fixed `search_path = extensions, pg_catalog, public`
     - Required to resolve the vector type and operators properly
*/

-- 1. Create extensions schema and move vector there
CREATE SCHEMA IF NOT EXISTS extensions;

ALTER EXTENSION vector SET SCHEMA extensions;

-- 2. Fix update_note_updated_at trigger function (set fixed search_path)
CREATE OR REPLACE FUNCTION public.update_note_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 3. Fix match_notes function (set fixed search_path, qualify vector type)
CREATE OR REPLACE FUNCTION public.match_notes(
  query_embedding extensions.vector(1536),
  match_threshold float,
  match_count int,
  filter_user_id uuid
)
RETURNS TABLE (
  id uuid,
  title text,
  content text,
  type text,
  tags text[],
  similarity float
)
LANGUAGE sql
STABLE
SET search_path = extensions, pg_catalog, public
AS $$
  SELECT
    n.id,
    n.title,
    n.content,
    n.type,
    n.tags,
    1 - (n.embedding <=> query_embedding) AS similarity
  FROM public.notes n
  WHERE n.user_id = filter_user_id
    AND n.embedding IS NOT NULL
    AND 1 - (n.embedding <=> query_embedding) > match_threshold
  ORDER BY n.embedding <=> query_embedding
  LIMIT match_count;
$$;
