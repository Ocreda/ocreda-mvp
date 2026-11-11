/*
  # Domains in the database

  Domains used to live only in each browser (localStorage): the list with each
  Domain's goal, the pinned ones, and which note is in which Domain. So they
  did not follow a person to another device. They now live in the `domains`
  and `note_domains` tables from 20260904090000, which the app stopped using
  when that change was rolled back in the browser code.

  Added here:
  - `domains.is_sample` keeps the sample vault's Domains apart from the
    person's own, like `notes.is_sample`. A name is unique within each set,
    ignoring case, so a sample "Business" and your own "Business" can coexist.
  - `domains.pinned_at` marks the pinned Domains (at most three, enforced by
    the app), oldest pin first.
  - One Domain per note, which is what the app has always assumed.
  - Functions the app calls by Domain name, since it refers to Domains by name.
  - `import_domains`, which each browser calls once to upload what it stored,
    and which also files the sample vault's Domains.

  Rows written by the September version are out of date: the browser was the
  source of truth again from then until now. The first upload for each person
  therefore replaces them; uploads from their other browsers then merge in.
*/

alter table public.domains add column if not exists is_sample boolean not null default false;
alter table public.domains add column if not exists pinned_at timestamptz;

-- Names were unique per person, case-sensitively. They become unique per
-- person and set, ignoring case; older duplicates are dropped first.
do $$
declare
  existing record;
begin
  for existing in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.domains'::regclass and con.contype = 'u'
  loop
    execute format('alter table public.domains drop constraint %I', existing.conname);
  end loop;
end;
$$;

delete from public.domains duplicate
using public.domains kept
where duplicate.user_id = kept.user_id
  and duplicate.is_sample = kept.is_sample
  and lower(duplicate.name) = lower(kept.name)
  and (kept.created_at, kept.id) < (duplicate.created_at, duplicate.id);

create unique index if not exists domains_user_sample_name_idx
  on public.domains (user_id, is_sample, lower(name));

-- One Domain per note: keep the newest assignment of any note that has more.
delete from public.note_domains older
using public.note_domains newer
where older.note_id = newer.note_id
  and (newer.created_at, newer.domain_id) > (older.created_at, older.domain_id);

create unique index if not exists note_domains_one_per_note_idx
  on public.note_domains (note_id);

-- Replaced by import_domains; its ON CONFLICT target no longer exists.
drop function if exists public.import_legacy_workspace(jsonb);

/* The id of one of the caller's Domains, matched by name ignoring case. */
create or replace function public.find_domain_id(domain_name text, sample boolean)
returns uuid
language sql
stable
security invoker
set search_path = public
as $$
  select id from public.domains
  where user_id = auth.uid()
    and is_sample = sample
    and lower(name) = lower(left(btrim(coalesce(domain_name, '')), 80))
  limit 1;
$$;

/*
  Creates a Domain, or updates the one named original_name (a rename) or
  domain_name. Its notes follow a rename, since they point at its id.
*/
create or replace function public.save_domain(
  domain_name text,
  domain_description text,
  sample boolean,
  original_name text default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  clean_name text := left(btrim(coalesce(domain_name, '')), 80);
  clean_description text := left(btrim(coalesce(domain_description, '')), 600);
  target_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if clean_name = '' then raise exception 'A Domain needs a title'; end if;

  if original_name is not null then
    target_id := public.find_domain_id(original_name, sample);
  end if;
  if target_id is null then
    target_id := public.find_domain_id(clean_name, sample);
  end if;

  if target_id is null then
    insert into public.domains (user_id, name, description, is_sample)
    values (auth.uid(), clean_name, clean_description, sample);
  else
    update public.domains set name = clean_name, description = clean_description
    where id = target_id;
  end if;
end;
$$;

/* Deletes a Domain. Its notes are left without one. */
create or replace function public.delete_domain(domain_name text, sample boolean)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  delete from public.domains where id = public.find_domain_id(domain_name, sample);
end;
$$;

create or replace function public.set_domain_pinned(domain_name text, sample boolean, pinned boolean)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  update public.domains
  set pinned_at = case when pinned then coalesce(pinned_at, now()) else null end
  where id = public.find_domain_id(domain_name, sample);
end;
$$;

/*
  Puts notes in a Domain, creating it if needed, or takes them out of any
  Domain when domain_name is null or empty. Only the caller's notes from the
  same set (sample or not) are assigned.
*/
create or replace function public.assign_notes_to_domain(note_ids uuid[], domain_name text, sample boolean)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  clean_name text := left(btrim(coalesce(domain_name, '')), 80);
  target_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if coalesce(array_length(note_ids, 1), 0) > 5000 then raise exception 'Too many notes'; end if;

  if clean_name <> '' then
    target_id := public.find_domain_id(clean_name, sample);
    if target_id is null then
      insert into public.domains (user_id, name, is_sample)
      values (auth.uid(), clean_name, sample)
      returning id into target_id;
    end if;
  end if;

  delete from public.note_domains assignment
  using public.notes note
  where assignment.note_id = note.id
    and note.id = any(note_ids)
    and note.user_id = auth.uid();

  if target_id is not null then
    insert into public.note_domains (note_id, domain_id)
    select note.id, target_id
    from public.notes note
    where note.id = any(note_ids) and note.user_id = auth.uid() and note.is_sample = sample
    on conflict (note_id) do update set domain_id = excluded.domain_id;
  end if;
end;
$$;

/*
  Saves a set of Domains, pins and note assignments:
    { "domains": [{ "name", "description", "created_at" }],
      "pinned": ["name", ...],
      "note_domains": [{ "note_id", "domain_name" }] }

  from_browser = true: one browser's stored Domains, uploaded once per browser.
  The first upload for a person (per set) replaces whatever the database had;
  later uploads from other browsers merge in, and what the browser says wins.

  from_browser = false: fills gaps only (the sample vault's Domains). Existing
  goals, pins and assignments are kept.
*/
create or replace function public.import_domains(payload jsonb, sample boolean, from_browser boolean)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  marker text := case when sample then 'domains-v2-sample' else 'domains-v2' end;
  replacing boolean := false;
  item jsonb;
  clean_name text;
  clean_description text;
  existing_id uuid;
  note_uuid uuid;
  pin_count integer;
  saved_domains integer := 0;
  saved_assignments integer := 0;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(coalesce(payload, '{}'::jsonb)) <> 'object' then raise exception 'Invalid Domain payload'; end if;

  if from_browser then
    -- Claiming the marker decides, atomically, which upload is the first.
    insert into public.browser_storage_migrations (user_id, migration_key, details)
    values (auth.uid(), marker, jsonb_build_object('source', 'localStorage'))
    on conflict (user_id, migration_key) do nothing;
    replacing := found;
    if replacing then
      delete from public.domains where user_id = auth.uid() and is_sample = sample;
    end if;
  end if;

  for item in select value from jsonb_array_elements(coalesce(payload->'domains', '[]'::jsonb)) loop
    clean_name := left(btrim(coalesce(item->>'name', '')), 80);
    if clean_name = '' then continue; end if;
    clean_description := left(btrim(coalesce(item->>'description', '')), 600);
    existing_id := public.find_domain_id(clean_name, sample);
    if existing_id is null then
      insert into public.domains (user_id, name, description, is_sample, created_at)
      values (auth.uid(), clean_name, clean_description, sample, coalesce((item->>'created_at')::timestamptz, now()));
      saved_domains := saved_domains + 1;
    elsif from_browser and clean_description <> '' then
      update public.domains set description = clean_description where id = existing_id;
    end if;
  end loop;

  select count(*) into pin_count from public.domains
  where user_id = auth.uid() and is_sample = sample and pinned_at is not null;
  if from_browser or pin_count = 0 then
    for item in select value from jsonb_array_elements(coalesce(payload->'pinned', '[]'::jsonb)) loop
      exit when pin_count >= 3;
      existing_id := public.find_domain_id(item #>> '{}', sample);
      if existing_id is null then continue; end if;
      -- clock_timestamp() moves within a transaction, so pins keep their order.
      update public.domains set pinned_at = clock_timestamp() where id = existing_id and pinned_at is null;
      if found then pin_count := pin_count + 1; end if;
    end loop;
  end if;

  for item in select value from jsonb_array_elements(coalesce(payload->'note_domains', '[]'::jsonb)) loop
    if coalesce(item->>'note_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then continue; end if;
    note_uuid := (item->>'note_id')::uuid;
    existing_id := public.find_domain_id(item->>'domain_name', sample);
    if existing_id is null or not exists (
      select 1 from public.notes where id = note_uuid and user_id = auth.uid() and is_sample = sample
    ) then continue; end if;
    if from_browser then
      insert into public.note_domains (note_id, domain_id) values (note_uuid, existing_id)
      on conflict (note_id) do update set domain_id = excluded.domain_id;
    else
      insert into public.note_domains (note_id, domain_id) values (note_uuid, existing_id)
      on conflict (note_id) do nothing;
    end if;
    if found then saved_assignments := saved_assignments + 1; end if;
  end loop;

  return jsonb_build_object('replaced', replacing, 'domains', saved_domains, 'note_domains', saved_assignments);
end;
$$;

revoke all on function public.find_domain_id(text, boolean) from public, anon;
revoke all on function public.save_domain(text, text, boolean, text) from public, anon;
revoke all on function public.delete_domain(text, boolean) from public, anon;
revoke all on function public.set_domain_pinned(text, boolean, boolean) from public, anon;
revoke all on function public.assign_notes_to_domain(uuid[], text, boolean) from public, anon;
revoke all on function public.import_domains(jsonb, boolean, boolean) from public, anon;
grant execute on function public.find_domain_id(text, boolean) to authenticated;
grant execute on function public.save_domain(text, text, boolean, text) to authenticated;
grant execute on function public.delete_domain(text, boolean) to authenticated;
grant execute on function public.set_domain_pinned(text, boolean, boolean) to authenticated;
grant execute on function public.assign_notes_to_domain(uuid[], text, boolean) to authenticated;
grant execute on function public.import_domains(jsonb, boolean, boolean) to authenticated;
