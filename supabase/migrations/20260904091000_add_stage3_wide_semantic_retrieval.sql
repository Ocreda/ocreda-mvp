/* Stage 3: ownership-safe wide semantic candidate retrieval. */

create or replace function public.match_notes_semantic(
  query_embedding extensions.vector(768),
  candidate_limit integer default 60,
  similarity_floor double precision default 0
)
returns table (
  note_id uuid,
  similarity double precision,
  raw_rank bigint,
  note_length integer,
  token_count integer,
  raw_text text,
  embedding_text text
)
language plpgsql
security invoker
set search_path = public, extensions
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if candidate_limit < 1 or candidate_limit > 100 then raise exception 'candidate_limit must be between 1 and 100'; end if;
  if similarity_floor < -1 or similarity_floor > 1 then raise exception 'similarity_floor must be between -1 and 1'; end if;

  return query
  with nearest as (
    select
      note.id as note_id,
      1 - (note.semantic_embedding <=> query_embedding) as similarity,
      note.semantic_embedding <=> query_embedding as distance,
      note.character_count as note_length,
      note.token_count,
      note.raw_text,
      note.semantic_embedding::text as embedding_text
    from public.notes note
    where note.user_id = auth.uid()
      and note.embedding_status = 'ready'
      and note.semantic_embedding is not null
      and 1 - (note.semantic_embedding <=> query_embedding) >= similarity_floor
    order by note.semantic_embedding <=> query_embedding, note.id
    limit candidate_limit
  )
  select nearest.note_id, nearest.similarity,
    row_number() over (order by nearest.distance, nearest.note_id) as raw_rank,
    nearest.note_length, nearest.token_count, nearest.raw_text, nearest.embedding_text
  from nearest
  order by nearest.distance, nearest.note_id;
end;
$$;

revoke all on function public.match_notes_semantic(extensions.vector, integer, double precision) from public;
grant execute on function public.match_notes_semantic(extensions.vector, integer, double precision) to authenticated;
