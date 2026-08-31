/*
  # Stage 1: semantic retrieval experiment foundation

  Restores one semantic embedding per note without enabling production
  surfacing or behavioural ranking. The historical connection-weight
  migration remains untouched; it is migration history, but the new engine
  does not read those weights.
*/

create schema if not exists extensions;
create extension if not exists vector with schema extensions;

alter table public.notes
  add column if not exists semantic_embedding extensions.vector(768),
  add column if not exists embedding_provider text,
  add column if not exists embedding_model text,
  add column if not exists embedding_dimension integer,
  add column if not exists embedding_version text,
  add column if not exists embedding_status text not null default 'pending',
  add column if not exists embedding_error text,
  add column if not exists embedding_attempts integer not null default 0,
  add column if not exists embedding_started_at timestamptz,
  add column if not exists embedded_at timestamptz,
  add column if not exists embedding_source_hash text,
  add column if not exists character_count integer not null default 0,
  add column if not exists token_count integer not null default 0,
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  alter table public.notes
    add constraint notes_embedding_status_check
    check (embedding_status in ('pending', 'processing', 'ready', 'failed'));
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.notes
    add constraint notes_embedding_dimension_check
    check (embedding_dimension is null or embedding_dimension = 768);
exception
  when duplicate_object then null;
end $$;

create or replace function public.prepare_note_semantic_embedding()
returns trigger
language plpgsql
security invoker
set search_path = public, extensions
as $$
begin
  new.updated_at := now();
  new.character_count := char_length(coalesce(new.raw_text, ''));
  new.token_count := case
    when new.character_count = 0 then 0
    else greatest(1, ceil(new.character_count::numeric / 4)::integer)
  end;

  if tg_op = 'INSERT' or new.raw_text is distinct from old.raw_text then
    new.semantic_embedding := null;
    new.embedding_provider := null;
    new.embedding_model := null;
    new.embedding_dimension := null;
    new.embedding_version := null;
    new.embedding_status := 'pending';
    new.embedding_error := null;
    new.embedding_attempts := 0;
    new.embedding_started_at := null;
    new.embedded_at := null;
    new.embedding_source_hash := null;
  end if;

  return new;
end;
$$;

drop trigger if exists prepare_note_semantic_embedding_trigger on public.notes;
create trigger prepare_note_semantic_embedding_trigger
  before insert or update on public.notes
  for each row execute function public.prepare_note_semantic_embedding();

update public.notes
set
  character_count = char_length(coalesce(raw_text, '')),
  token_count = case
    when char_length(coalesce(raw_text, '')) = 0 then 0
    else greatest(1, ceil(char_length(raw_text)::numeric / 4)::integer)
  end,
  embedding_status = case
    when semantic_embedding is not null then 'ready'
    else 'pending'
  end;

create index if not exists notes_semantic_embedding_hnsw_idx
  on public.notes
  using hnsw (semantic_embedding extensions.vector_cosine_ops)
  where semantic_embedding is not null;

create index if not exists notes_embedding_backfill_idx
  on public.notes (user_id, embedding_status, created_at)
  where embedding_status <> 'ready';

/*
  Exact ranking is intentional here. Stage 1 must inspect every rank in the
  user's corpus, so the experiment RPC disables approximate index scans for
  the duration of the call and does not accept a caller-supplied user id.
*/
create or replace function public.rank_notes_semantically_exact(
  query_embedding extensions.vector(768),
  result_offset integer default 0,
  result_limit integer default 500
)
returns table (
  note_id uuid,
  rank bigint,
  similarity double precision,
  character_count integer,
  token_count integer
)
language plpgsql
security invoker
set search_path = public, extensions
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  perform set_config('enable_indexscan', 'off', true);
  perform set_config('enable_bitmapscan', 'off', true);

  if result_offset < 0 or result_limit < 1 or result_limit > 1000 then
    raise exception 'Invalid result page';
  end if;

  return query
  select
    ranked.note_id,
    ranked.rank,
    ranked.similarity,
    ranked.character_count,
    ranked.token_count
  from (
    select
      n.id as note_id,
      row_number() over (order by n.semantic_embedding <=> query_embedding, n.id) as rank,
      1 - (n.semantic_embedding <=> query_embedding) as similarity,
      n.character_count,
      n.token_count
    from public.notes n
    where n.user_id = auth.uid()
      and n.embedding_status = 'ready'
      and n.semantic_embedding is not null
  ) ranked
  order by ranked.rank
  offset result_offset
  limit result_limit;
end;
$$;

revoke all on function public.rank_notes_semantically_exact(extensions.vector, integer, integer) from public;
grant execute on function public.rank_notes_semantically_exact(extensions.vector, integer, integer) to authenticated;

create table if not exists public.semantic_retrieval_experiments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  experiment_type text not null check (experiment_type in ('q1_subset', 'q2_full_rank', 'q5_short_note')),
  entry_text text,
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.semantic_retrieval_experiment_results (
  experiment_id uuid not null references public.semantic_retrieval_experiments(id) on delete cascade,
  variant text not null default 'semantic',
  note_id uuid not null references public.notes(id) on delete cascade,
  rank integer not null,
  similarity double precision not null,
  character_count integer not null,
  token_count integer not null,
  primary key (experiment_id, variant, note_id)
);

create table if not exists public.semantic_reasoning_benchmark_results (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null references public.semantic_retrieval_experiments(id) on delete cascade,
  provider text not null,
  model text not null,
  run_label text not null default 'default',
  response_text text not null,
  selected_note_ids uuid[] not null default '{}'::uuid[],
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists semantic_retrieval_experiments_user_created_idx
  on public.semantic_retrieval_experiments (user_id, created_at desc);

alter table public.semantic_retrieval_experiments enable row level security;
alter table public.semantic_retrieval_experiment_results enable row level security;
alter table public.semantic_reasoning_benchmark_results enable row level security;

create policy "Users can read own semantic retrieval experiments"
  on public.semantic_retrieval_experiments for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users can insert own semantic retrieval experiments"
  on public.semantic_retrieval_experiments for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Users can delete own semantic retrieval experiments"
  on public.semantic_retrieval_experiments for delete
  to authenticated
  using (user_id = auth.uid());

create policy "Users can read own semantic retrieval results"
  on public.semantic_retrieval_experiment_results for select
  to authenticated
  using (
    exists (
      select 1
      from public.semantic_retrieval_experiments experiment
      where experiment.id = semantic_retrieval_experiment_results.experiment_id
        and experiment.user_id = auth.uid()
    )
  );

create policy "Users can insert own semantic retrieval results"
  on public.semantic_retrieval_experiment_results for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.semantic_retrieval_experiments experiment
      where experiment.id = semantic_retrieval_experiment_results.experiment_id
        and experiment.user_id = auth.uid()
    )
    and exists (
      select 1
      from public.notes note
      where note.id = semantic_retrieval_experiment_results.note_id
        and note.user_id = auth.uid()
    )
  );

create policy "Users can read own semantic reasoning benchmarks"
  on public.semantic_reasoning_benchmark_results for select
  to authenticated
  using (
    exists (
      select 1
      from public.semantic_retrieval_experiments experiment
      where experiment.id = semantic_reasoning_benchmark_results.experiment_id
        and experiment.user_id = auth.uid()
    )
  );

create policy "Users can insert own semantic reasoning benchmarks"
  on public.semantic_reasoning_benchmark_results for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.semantic_retrieval_experiments experiment
      where experiment.id = semantic_reasoning_benchmark_results.experiment_id
        and experiment.user_id = auth.uid()
        and experiment.experiment_type = 'q1_subset'
    )
    and not exists (
      select 1
      from unnest(semantic_reasoning_benchmark_results.selected_note_ids) selected(note_id)
      where not exists (
        select 1
        from public.notes note
        where note.id = selected.note_id
          and note.user_id = auth.uid()
      )
    )
  );

grant select, insert, delete on public.semantic_retrieval_experiments to authenticated;
grant select, insert on public.semantic_retrieval_experiment_results to authenticated;
grant select, insert on public.semantic_reasoning_benchmark_results to authenticated;

/*
  The multiplier model is archived, not erased from migration history. Keep
  recording the legacy accept/reject value while preventing it from changing
  ranking behaviour during beta.
*/
update public.note_relations set weight = 1 where weight <> 1;

create or replace function public.apply_connection_feedback(
  p_note_id uuid,
  p_related_note_id uuid,
  p_multiplier double precision,
  p_feedback text
)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.note_relations
  set weight = 1, feedback = p_feedback
  where (note_id = p_note_id and related_note_id = p_related_note_id)
     or (note_id = p_related_note_id and related_note_id = p_note_id);
$$;
