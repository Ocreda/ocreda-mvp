/*
  # Shared-note vaults

  Notes someone shares with you used to be copied into your own notes, in a
  "From <name>" Domain, where they became yours: editable, listed with
  everything else, and searched for cards of their own. Now each person who
  shares with you gets a vault of their own (docs/shared-note-vaults-plan.md):

  - `vaults`: one per (receiver, sharer). `use_in_retrieval` (on by default)
    decides whether your drafts search it. Its notes are `notes` rows with
    `vault_id` set; your own notes have none. Removing a vault removes them.
  - Shared notes are read-only: their text cannot change, and a note cannot
    leave its vault. Only accepting a newer link changes what a vault holds.
  - `accept_shared_link` puts a link's notes in the sharer's vault. A newer
    link from the same person replaces the vault's notes; notes whose text did
    not change keep their row, so cards that cite them stay valid. An older
    link than the one the vault holds changes nothing.
  - `copy_shared_notes`, which older app versions call, now does the same.
  - Notes copied before this change move into vaults when their text still
    matches the link they came from. Edited ones stay yours.
  - Semantic search only reads vaults that are used in retrieval.

  The vault survives a revoked link and a deleted sharer account: the
  receiver already has the copy. `sharer_id` therefore has no foreign key.
*/

create table if not exists public.vaults (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sharer_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  use_in_retrieval boolean not null default true,
  -- The link whose notes the vault holds, and when that link was made, kept
  -- apart so a deleted link still tells a newer share from an older one.
  link_id uuid references public.share_links(id) on delete set null,
  link_created_at timestamptz,
  accepted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, sharer_id)
);

alter table public.vaults enable row level security;

drop policy if exists "Users can select own vaults" on public.vaults;
drop policy if exists "Users can update own vaults" on public.vaults;
drop policy if exists "Users can delete own vaults" on public.vaults;
create policy "Users can select own vaults" on public.vaults
  for select to authenticated using (auth.uid() = user_id);
create policy "Users can update own vaults" on public.vaults
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete own vaults" on public.vaults
  for delete to authenticated using (auth.uid() = user_id);

-- Vaults are made only by accept_shared_link; people may switch retrieval and remove them.
grant select, delete on public.vaults to authenticated;
grant update (use_in_retrieval) on public.vaults to authenticated;

alter table public.notes
  add column if not exists vault_id uuid references public.vaults(id) on delete cascade;

create index if not exists notes_user_vault_created_idx
  on public.notes (user_id, vault_id, created_at desc);

alter table public.share_link_copies
  add column if not exists vault_id uuid references public.vaults(id) on delete set null;

/* A shared note's words are the sharer's: they cannot be edited, and the note cannot leave its vault. */
create or replace function public.keep_vault_notes_read_only()
returns trigger
language plpgsql
as $$
begin
  if old.vault_id is not null and (new.raw_text is distinct from old.raw_text or new.vault_id is distinct from old.vault_id) then
    raise exception 'Shared notes cannot be changed';
  end if;
  return new;
end;
$$;

drop trigger if exists notes_vault_read_only on public.notes;
create trigger notes_vault_read_only
  before update on public.notes
  for each row execute function public.keep_vault_notes_read_only();

/*
  Puts a link's notes in the sharer's vault, made on first use.
  Returns { vault_id, vault_name, status, notes }, where status is:
  - "added": the vault was made with these notes;
  - "updated": a newer link replaced what the vault held;
  - "already": the vault already holds this link;
  - "older": the vault holds a newer link from this person, so nothing changed.
*/
create or replace function public.accept_shared_link(link_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  link public.share_links%rowtype;
  vault public.vaults%rowtype;
  sharer text;
  existed boolean;
  inserted integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into link from public.share_links where token = link_token and revoked_at is null;
  if not found then raise exception 'This link is no longer shared'; end if;
  if link.user_id = auth.uid() then raise exception 'These are your own notes'; end if;

  sharer := left(public.sharer_display_name(link.user_id), 80);
  select * into vault from public.vaults where user_id = auth.uid() and sharer_id = link.user_id for update;
  existed := found;

  if existed and vault.link_id = link.id then
    return jsonb_build_object('vault_id', vault.id, 'vault_name', vault.name, 'status', 'already', 'notes', 0);
  end if;
  if existed and vault.link_created_at is not null and vault.link_created_at > link.created_at then
    return jsonb_build_object('vault_id', vault.id, 'vault_name', vault.name, 'status', 'older', 'notes', 0);
  end if;

  if existed then
    update public.vaults
      set name = sharer, link_id = link.id, link_created_at = link.created_at, accepted_at = now()
      where id = vault.id
      returning * into vault;
    -- Notes no longer in the link go; unchanged ones keep their row.
    delete from public.notes note
    where note.vault_id = vault.id
      and not exists (select 1 from public.share_link_notes shared where shared.link_id = link.id and shared.raw_text = note.raw_text);
  else
    insert into public.vaults (user_id, sharer_id, name, link_id, link_created_at)
    values (auth.uid(), link.user_id, sharer, link.id, link.created_at)
    returning * into vault;
  end if;

  -- Dated when the sharer wrote them, so the vault reads in their order.
  insert into public.notes (user_id, raw_text, is_sample, vault_id, created_at)
  select auth.uid(), shared.raw_text, false, vault.id, shared.noted_at
  from (
    select distinct on (raw_text) raw_text, noted_at
    from public.share_link_notes
    where link_id = link.id
    order by raw_text, position
  ) shared
  where not exists (select 1 from public.notes note where note.vault_id = vault.id and note.raw_text = shared.raw_text);
  get diagnostics inserted = row_count;

  insert into public.share_link_copies (link_id, user_id, domain_name, vault_id)
  values (link.id, auth.uid(), vault.name, vault.id)
  on conflict (link_id, user_id) do update set domain_name = excluded.domain_name, vault_id = excluded.vault_id;

  return jsonb_build_object(
    'vault_id', vault.id, 'vault_name', vault.name,
    'status', case when existed then 'updated' else 'added' end,
    'notes', inserted
  );
end;
$$;

/* Older app versions call this. It now fills the sharer's vault, and names it as the "Domain". */
create or replace function public.copy_shared_notes(link_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  result := public.accept_shared_link(link_token);
  return jsonb_build_object(
    'domain', result->>'vault_name',
    'notes', coalesce((result->>'notes')::integer, 0),
    'already_copied', result->>'status' in ('already', 'older')
  );
end;
$$;

/*
  What a visitor may see of a link, as before, plus the viewer's vault for
  this sharer: its name, and whether this link is the one it holds
  ("current"), newer than it ("newer"), or older ("older").
*/
create or replace function public.get_shared_link(link_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  link public.share_links%rowtype;
  vault public.vaults%rowtype;
  signed_in boolean := auth.uid() is not null;
begin
  select * into link from public.share_links where token = link_token and revoked_at is null;
  if not found then return null; end if;
  if signed_in then
    select * into vault from public.vaults where user_id = auth.uid() and sharer_id = link.user_id;
  end if;

  return jsonb_build_object(
    'sharer_name', public.sharer_display_name(link.user_id),
    'sharer_avatar_url', (select avatar_url from public.user_settings where user_id = link.user_id),
    'created_at', link.created_at,
    'is_owner', coalesce(auth.uid() = link.user_id, false),
    'copied_to_domain', (select domain_name from public.share_link_copies where link_id = link.id and user_id = auth.uid()),
    'vault', case when vault.id is null then null else jsonb_build_object(
      'id', vault.id,
      'name', vault.name,
      'status', case
        when vault.link_id = link.id then 'current'
        when vault.link_created_at is not null and vault.link_created_at > link.created_at then 'older'
        else 'newer'
      end
    ) end,
    'notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'position', note.position,
        'title', left(btrim(split_part(btrim(note.raw_text), E'\n', 1)), 120),
        'text', case when signed_in or note.position < 3 then note.raw_text else null end,
        'noted_at', note.noted_at
      ) order by note.position)
      from public.share_link_notes note where note.link_id = link.id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.accept_shared_link(text) from public, anon;
revoke all on function public.copy_shared_notes(text) from public, anon;
revoke all on function public.get_shared_link(text) from public;
grant execute on function public.accept_shared_link(text) to authenticated;
grant execute on function public.copy_shared_notes(text) to authenticated;
grant execute on function public.get_shared_link(text) to anon, authenticated;

/*
  Notes copied before vaults existed. For each copy whose link still exists,
  the notes in the receiver's "From <name>" Domain whose text still matches
  the link move into the sharer's vault and out of the Domain. Edited notes
  stay the receiver's own. A Domain left empty is removed.
*/
do $$
declare
  earlier record;
  target public.vaults%rowtype;
  from_domain uuid;
begin
  for earlier in
    select copies.link_id, copies.user_id, copies.domain_name, link.user_id as sharer_id, link.created_at as link_created_at
    from public.share_link_copies copies
    join public.share_links link on link.id = copies.link_id
    where copies.vault_id is null
    order by link.created_at
  loop
    select * into target from public.vaults where user_id = earlier.user_id and sharer_id = earlier.sharer_id;
    if not found then
      insert into public.vaults (user_id, sharer_id, name, link_id, link_created_at)
      values (earlier.user_id, earlier.sharer_id, left(public.sharer_display_name(earlier.sharer_id), 80), earlier.link_id, earlier.link_created_at)
      returning * into target;
    elsif target.link_created_at is null or target.link_created_at < earlier.link_created_at then
      update public.vaults set link_id = earlier.link_id, link_created_at = earlier.link_created_at where id = target.id;
    end if;

    select id into from_domain from public.domains
    where user_id = earlier.user_id and is_sample = false and lower(name) = lower(earlier.domain_name);

    if from_domain is not null then
      with moved as (
        update public.notes note
        set vault_id = target.id
        from public.note_domains filed
        where filed.note_id = note.id
          and filed.domain_id = from_domain
          and note.user_id = earlier.user_id
          and note.vault_id is null
          and exists (select 1 from public.share_link_notes shared where shared.link_id = earlier.link_id and shared.raw_text = note.raw_text)
        returning note.id
      ), unfiled as (
        delete from public.note_domains filed using moved where filed.note_id = moved.id returning filed.note_id
      )
      -- Searches run from notes that are now shared are not shown any more.
      delete from public.note_retrievals saved using unfiled where saved.note_id = unfiled.note_id;

      delete from public.domains empty
      where empty.id = from_domain
        and not exists (select 1 from public.note_domains filed where filed.domain_id = empty.id);
    end if;

    update public.share_link_copies set vault_id = target.id where link_id = earlier.link_id and user_id = earlier.user_id;
  end loop;
end;
$$;

/*
  Semantic search, as in 20261017120000_add_sample_notes.sql, reading your
  own notes and the vaults you use in retrieval.
*/
create or replace function public.match_notes_semantic(
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
      and (
        note.vault_id is null
        or exists (select 1 from public.vaults vault where vault.id = note.vault_id and vault.use_in_retrieval)
      )
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
