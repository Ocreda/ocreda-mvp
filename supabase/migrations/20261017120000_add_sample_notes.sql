/*
  Sample notes: a ready-made vault people can explore before, or beside,
  their own notes. They are ordinary rows in the person's own notes table,
  flagged is_sample, so row-level security, embeddings and deletion all work
  as they do for any note.

  The two sets never mix. While someone is exploring the samples, only sample
  notes are listed and searched; otherwise only their own notes are. Notes
  written while exploring are sample notes too.

  Domains are not touched here: the app keeps them in the browser, with the
  sample Domains stored apart from the person's own.
*/

alter table public.notes
  add column if not exists is_sample boolean not null default false;

create index if not exists notes_user_sample_created_idx
  on public.notes (user_id, is_sample, created_at desc);

/*
  Semantic search gains include_samples. It chooses which set is searched,
  never both, and defaults to the person's own notes so existing callers keep
  their behaviour.
*/
drop function if exists public.match_notes_semantic(
  extensions.vector,
  integer,
  double precision,
  double precision
);

create function public.match_notes_semantic(
  query_embedding extensions.vector(768),
  candidate_limit integer default 60,
  similarity_floor double precision default 0,
  duplicate_threshold double precision default 0.95,
  include_samples boolean default false
)
returns table (
  note_id uuid,
  similarity double precision,
  raw_rank bigint,
  note_length integer,
  token_count integer,
  raw_text text,
  embedding_text text,
  is_near_duplicate boolean
)
language plpgsql
security invoker
set search_path = public, extensions
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if candidate_limit < 1 or candidate_limit > 60 then
    raise exception 'candidate_limit must be between 1 and 60';
  end if;
  if similarity_floor < -1 or similarity_floor > 1 then
    raise exception 'similarity_floor must be between -1 and 1';
  end if;
  if duplicate_threshold < 0.8 or duplicate_threshold > 1 then
    raise exception 'duplicate_threshold must be between 0.8 and 1';
  end if;

  return query
  with eligible as materialized (
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
      and note.is_sample = coalesce(include_samples, false)
      and note.embedding_status = 'ready'
      and note.embedding_version =
        'google:gemini-embedding-2:768:retrieval-prefix-v2'
      and note.semantic_embedding is not null
      and 1 - (note.semantic_embedding <=> query_embedding) >= similarity_floor
  ),
  duplicate_total as (
    select count(*)::bigint as total
    from eligible
    where eligible.similarity >= duplicate_threshold
  ),
  near_duplicates as (
    select
      duplicate.note_id,
      duplicate.similarity,
      row_number() over (order by duplicate.distance, duplicate.note_id) as raw_rank,
      duplicate.note_length,
      duplicate.token_count,
      duplicate.raw_text,
      duplicate.embedding_text,
      true as is_near_duplicate
    from eligible duplicate
    where duplicate.similarity >= duplicate_threshold
    order by duplicate.distance, duplicate.note_id
    limit candidate_limit
  ),
  normal_candidates as (
    select
      candidate.note_id,
      candidate.similarity,
      duplicate_total.total +
        row_number() over (order by candidate.distance, candidate.note_id) as raw_rank,
      candidate.note_length,
      candidate.token_count,
      candidate.raw_text,
      candidate.embedding_text,
      false as is_near_duplicate
    from eligible candidate
    cross join duplicate_total
    where candidate.similarity < duplicate_threshold
    order by candidate.distance, candidate.note_id
    limit candidate_limit
  )
  select combined.*
  from (
    select * from near_duplicates
    union all
    select * from normal_candidates
  ) as combined
  order by combined.raw_rank, combined.note_id;
end;
$$;

revoke all on function public.match_notes_semantic(
  extensions.vector,
  integer,
  double precision,
  double precision,
  boolean
) from public;
grant execute on function public.match_notes_semantic(
  extensions.vector,
  integer,
  double precision,
  double precision,
  boolean
) to authenticated;
