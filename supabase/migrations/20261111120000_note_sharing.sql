/*
  # Note sharing

  A person shares notes through a link that needs no account to open.

  - `public_notes`: the notes a person has chosen to share. They are copies of
    private notes (text only), kept in their own table so nothing that reads
    `notes` — lists, search, insights — can ever reach a private note through
    sharing, and the private originals never show twice.
  - `share_links`: a link, valid until revoked. It shares a frozen copy of the
    public notes as they were when it was made (`share_link_notes`), so later
    edits do not change a link already sent.
  - `share_link_copies`: who copied a link's notes into their own account, so
    the same link is not copied twice.

  Visitors never read these tables directly. `get_shared_link` returns what a
  visitor may see: without an account, the first three notes in full and only
  the titles of the rest; signed in, all of them. `copy_shared_notes` copies
  a link's notes into the caller's own notes, filed in a "From <name>" Domain.
*/

create table if not exists public.public_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  raw_text text not null check (char_length(btrim(raw_text)) > 0),
  -- The private note it was copied from, to update the copy instead of adding another.
  source_note_id uuid references public.notes(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists public_notes_user_created_idx
  on public.public_notes (user_id, created_at desc);
-- Not partial, so an upsert can name it. Rows without a source never collide (nulls are distinct).
create unique index if not exists public_notes_user_source_idx
  on public.public_notes (user_id, source_note_id);

create table if not exists public.share_links (
  id uuid primary key default gen_random_uuid(),
  token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists share_links_user_created_idx
  on public.share_links (user_id, created_at desc);

create table if not exists public.share_link_notes (
  link_id uuid not null references public.share_links(id) on delete cascade,
  position integer not null,
  raw_text text not null,
  noted_at timestamptz not null default now(),
  primary key (link_id, position)
);

create table if not exists public.share_link_copies (
  link_id uuid not null references public.share_links(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  domain_name text not null,
  copied_at timestamptz not null default now(),
  primary key (link_id, user_id)
);

drop trigger if exists public_notes_set_updated_at on public.public_notes;
create trigger public_notes_set_updated_at
  before update on public.public_notes
  for each row execute function public.set_workspace_updated_at();

alter table public.public_notes enable row level security;
alter table public.share_links enable row level security;
alter table public.share_link_notes enable row level security;
alter table public.share_link_copies enable row level security;

drop policy if exists "Users can select own public notes" on public.public_notes;
drop policy if exists "Users can insert own public notes" on public.public_notes;
drop policy if exists "Users can update own public notes" on public.public_notes;
drop policy if exists "Users can delete own public notes" on public.public_notes;
create policy "Users can select own public notes" on public.public_notes
  for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own public notes" on public.public_notes
  for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update own public notes" on public.public_notes
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete own public notes" on public.public_notes
  for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "Users can select own share links" on public.share_links;
drop policy if exists "Users can insert own share links" on public.share_links;
drop policy if exists "Users can update own share links" on public.share_links;
create policy "Users can select own share links" on public.share_links
  for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own share links" on public.share_links
  for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update own share links" on public.share_links
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users can select own share link notes" on public.share_link_notes;
drop policy if exists "Users can insert own share link notes" on public.share_link_notes;
create policy "Users can select own share link notes" on public.share_link_notes
  for select to authenticated using (
    exists (select 1 from public.share_links link where link.id = share_link_notes.link_id and link.user_id = auth.uid())
  );
create policy "Users can insert own share link notes" on public.share_link_notes
  for insert to authenticated with check (
    exists (select 1 from public.share_links link where link.id = share_link_notes.link_id and link.user_id = auth.uid())
  );

-- share_link_copies has no policies: only the functions below touch it.

grant select, insert, update, delete on public.public_notes to authenticated;
grant select, insert, update on public.share_links to authenticated;
grant select, insert on public.share_link_notes to authenticated;

/* Makes a link to the caller's public notes as they are now. Returns its token. */
create or replace function public.create_share_link()
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  new_link public.share_links%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not exists (select 1 from public.public_notes where user_id = auth.uid()) then
    raise exception 'Add a note to your public notes before making a link';
  end if;

  insert into public.share_links (user_id) values (auth.uid()) returning * into new_link;

  insert into public.share_link_notes (link_id, position, raw_text, noted_at)
  select new_link.id, row_number() over (order by note.created_at desc, note.id) - 1, note.raw_text, note.created_at
  from public.public_notes note
  where note.user_id = auth.uid();

  return new_link.token;
end;
$$;

/* The name shown for a sharer. Never their email address. */
create or replace function public.sharer_display_name(sharer_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select nullif(btrim(full_name), '') from public.user_settings where user_id = sharer_id),
    (select nullif(btrim(coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name')), '') from auth.users where id = sharer_id),
    'Someone'
  );
$$;

/*
  What a visitor may see of a link, or null when it does not exist or was
  revoked. Without an account: the first three notes in full, and only the
  title (first line) of the rest. Signed in: every note in full.
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
  signed_in boolean := auth.uid() is not null;
begin
  select * into link from public.share_links where token = link_token and revoked_at is null;
  if not found then return null; end if;

  return jsonb_build_object(
    'sharer_name', public.sharer_display_name(link.user_id),
    'sharer_avatar_url', (select avatar_url from public.user_settings where user_id = link.user_id),
    'created_at', link.created_at,
    'is_owner', coalesce(auth.uid() = link.user_id, false),
    'copied_to_domain', (select domain_name from public.share_link_copies where link_id = link.id and user_id = auth.uid()),
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

/*
  Copies a link's notes into the caller's own notes, filed in a
  "From <sharer>" Domain. A link is copied once per person; asking again
  returns the Domain they are already in.
*/
create or replace function public.copy_shared_notes(link_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  link public.share_links%rowtype;
  sharer text;
  target_name text;
  target_id uuid;
  copied integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into link from public.share_links where token = link_token and revoked_at is null;
  if not found then raise exception 'This link is no longer shared'; end if;
  if link.user_id = auth.uid() then raise exception 'These are your own notes'; end if;

  select domain_name into target_name from public.share_link_copies where link_id = link.id and user_id = auth.uid();
  if found then
    return jsonb_build_object('domain', target_name, 'notes', 0, 'already_copied', true);
  end if;

  sharer := public.sharer_display_name(link.user_id);
  target_name := left('From ' || sharer, 80);
  select id into target_id from public.domains
  where user_id = auth.uid() and is_sample = false and lower(name) = lower(target_name);
  if target_id is null then
    insert into public.domains (user_id, name, description, is_sample)
    values (auth.uid(), target_name, left('Notes ' || sharer || ' shared with me.', 600), false)
    returning id into target_id;
  end if;

  -- A millisecond apart, so the copies keep the order they were shared in.
  with inserted as (
    insert into public.notes (user_id, raw_text, is_sample, created_at)
    select auth.uid(), note.raw_text, false, now() - note.position * interval '1 millisecond'
    from public.share_link_notes note
    where note.link_id = link.id
    returning id
  ), filed as (
    insert into public.note_domains (note_id, domain_id)
    select id, target_id from inserted
    returning 1
  )
  select count(*) into copied from filed;

  insert into public.share_link_copies (link_id, user_id, domain_name) values (link.id, auth.uid(), target_name);
  return jsonb_build_object('domain', target_name, 'notes', copied, 'already_copied', false);
end;
$$;

revoke all on function public.create_share_link() from public, anon;
revoke all on function public.sharer_display_name(uuid) from public, anon, authenticated;
revoke all on function public.get_shared_link(text) from public;
revoke all on function public.copy_shared_notes(text) from public, anon;
grant execute on function public.create_share_link() to authenticated;
grant execute on function public.get_shared_link(text) to anon, authenticated;
grant execute on function public.copy_shared_notes(text) to authenticated;
