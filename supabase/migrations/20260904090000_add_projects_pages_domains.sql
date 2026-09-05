/*
  # Stage 2: server-owned Projects, Pages and Domains

  Browser storage is migrated through an idempotent authenticated RPC. The
  browser remains a temporary recovery copy, never the runtime source of truth.
*/

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 80),
  description text not null default '' check (char_length(description) <= 500),
  legacy_client_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists projects_user_legacy_client_idx
  on public.projects (user_id, legacy_client_id)
  where legacy_client_id is not null;
create index if not exists projects_user_updated_idx
  on public.projects (user_id, updated_at desc);

create table if not exists public.project_pages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 100),
  content text not null default '',
  content_hash text not null default '',
  legacy_client_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists project_pages_project_legacy_client_idx
  on public.project_pages (project_id, legacy_client_id)
  where legacy_client_id is not null;
create index if not exists project_pages_user_project_updated_idx
  on public.project_pages (user_id, project_id, updated_at desc);

create table if not exists public.domains (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text not null default '' check (char_length(description) <= 600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create index if not exists domains_user_created_idx
  on public.domains (user_id, created_at);

create table if not exists public.note_domains (
  note_id uuid not null references public.notes(id) on delete cascade,
  domain_id uuid not null references public.domains(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (note_id, domain_id)
);

create index if not exists note_domains_domain_idx
  on public.note_domains (domain_id, note_id);

create table if not exists public.browser_storage_migrations (
  user_id uuid not null references auth.users(id) on delete cascade,
  migration_key text not null,
  details jsonb not null default '{}'::jsonb,
  completed_at timestamptz not null default now(),
  primary key (user_id, migration_key)
);

create or replace function public.set_workspace_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_workspace_updated_at();

drop trigger if exists project_pages_set_updated_at on public.project_pages;
create trigger project_pages_set_updated_at
  before update on public.project_pages
  for each row execute function public.set_workspace_updated_at();

drop trigger if exists domains_set_updated_at on public.domains;
create trigger domains_set_updated_at
  before update on public.domains
  for each row execute function public.set_workspace_updated_at();

create extension if not exists pgcrypto with schema extensions;

create or replace function public.prepare_project_page_content_hash()
returns trigger
language plpgsql
security invoker
set search_path = public, extensions
as $$
begin
  new.content_hash := encode(
    extensions.digest(coalesce(new.title, '') || E'\n\n' || coalesce(new.content, ''), 'sha256'),
    'hex'
  );
  return new;
end;
$$;

drop trigger if exists project_pages_prepare_content_hash on public.project_pages;
create trigger project_pages_prepare_content_hash
  before insert or update of title, content on public.project_pages
  for each row execute function public.prepare_project_page_content_hash();

alter table public.projects enable row level security;
alter table public.project_pages enable row level security;
alter table public.domains enable row level security;
alter table public.note_domains enable row level security;
alter table public.browser_storage_migrations enable row level security;

create policy "Users can select own projects" on public.projects
  for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own projects" on public.projects
  for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update own projects" on public.projects
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete own projects" on public.projects
  for delete to authenticated using (auth.uid() = user_id);

create policy "Users can select own project pages" on public.project_pages
  for select to authenticated using (
    auth.uid() = user_id and exists (
      select 1 from public.projects project
      where project.id = project_pages.project_id and project.user_id = auth.uid()
    )
  );
create policy "Users can insert own project pages" on public.project_pages
  for insert to authenticated with check (
    auth.uid() = user_id and exists (
      select 1 from public.projects project
      where project.id = project_pages.project_id and project.user_id = auth.uid()
    )
  );
create policy "Users can update own project pages" on public.project_pages
  for update to authenticated using (
    auth.uid() = user_id and exists (
      select 1 from public.projects project
      where project.id = project_pages.project_id and project.user_id = auth.uid()
    )
  ) with check (
    auth.uid() = user_id and exists (
      select 1 from public.projects project
      where project.id = project_pages.project_id and project.user_id = auth.uid()
    )
  );
create policy "Users can delete own project pages" on public.project_pages
  for delete to authenticated using (
    auth.uid() = user_id and exists (
      select 1 from public.projects project
      where project.id = project_pages.project_id and project.user_id = auth.uid()
    )
  );

create policy "Users can select own domains" on public.domains
  for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own domains" on public.domains
  for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update own domains" on public.domains
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete own domains" on public.domains
  for delete to authenticated using (auth.uid() = user_id);

create policy "Users can select own note domains" on public.note_domains
  for select to authenticated using (
    exists (select 1 from public.notes note where note.id = note_domains.note_id and note.user_id = auth.uid())
    and exists (select 1 from public.domains domain where domain.id = note_domains.domain_id and domain.user_id = auth.uid())
  );
create policy "Users can insert own note domains" on public.note_domains
  for insert to authenticated with check (
    exists (select 1 from public.notes note where note.id = note_domains.note_id and note.user_id = auth.uid())
    and exists (select 1 from public.domains domain where domain.id = note_domains.domain_id and domain.user_id = auth.uid())
  );
create policy "Users can update own note domains" on public.note_domains
  for update to authenticated using (
    exists (select 1 from public.notes note where note.id = note_domains.note_id and note.user_id = auth.uid())
    and exists (select 1 from public.domains domain where domain.id = note_domains.domain_id and domain.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.notes note where note.id = note_domains.note_id and note.user_id = auth.uid())
    and exists (select 1 from public.domains domain where domain.id = note_domains.domain_id and domain.user_id = auth.uid())
  );
create policy "Users can delete own note domains" on public.note_domains
  for delete to authenticated using (
    exists (select 1 from public.notes note where note.id = note_domains.note_id and note.user_id = auth.uid())
    and exists (select 1 from public.domains domain where domain.id = note_domains.domain_id and domain.user_id = auth.uid())
  );

create policy "Users can read own browser migration markers" on public.browser_storage_migrations
  for select to authenticated using (auth.uid() = user_id);
create policy "Users can write own browser migration markers" on public.browser_storage_migrations
  for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update own browser migration markers" on public.browser_storage_migrations
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update, delete on public.project_pages to authenticated;
grant select, insert, update, delete on public.domains to authenticated;
grant select, insert, update, delete on public.note_domains to authenticated;
grant select, insert, update on public.browser_storage_migrations to authenticated;

create or replace function public.set_note_domain(note_ids uuid[], selected_domain_id uuid default null)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if coalesce(array_length(note_ids, 1), 0) > 500 then raise exception 'Too many notes'; end if;
  if selected_domain_id is not null and not exists (
    select 1 from public.domains where id = selected_domain_id and user_id = auth.uid()
  ) then raise exception 'Domain not found'; end if;

  delete from public.note_domains assignment
  using public.notes note
  where assignment.note_id = note.id
    and note.id = any(note_ids)
    and note.user_id = auth.uid();

  if selected_domain_id is not null then
    insert into public.note_domains (note_id, domain_id)
    select note.id, selected_domain_id
    from public.notes note
    where note.id = any(note_ids) and note.user_id = auth.uid()
    on conflict do nothing;
  end if;
end;
$$;

revoke all on function public.set_note_domain(uuid[], uuid) from public;
grant execute on function public.set_note_domain(uuid[], uuid) to authenticated;

/*
  Idempotently import the validated recovery payload. Ownership always comes
  from auth.uid(); IDs and user IDs inside browser JSON are never trusted.
*/
create or replace function public.import_legacy_workspace(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  project_item jsonb;
  page_item jsonb;
  domain_item jsonb;
  assignment_item jsonb;
  saved_project_id uuid;
  saved_domain_id uuid;
  imported_projects integer := 0;
  imported_pages integer := 0;
  imported_domains integer := 0;
  imported_assignments integer := 0;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(coalesce(payload, '{}'::jsonb)) <> 'object' then raise exception 'Invalid migration payload'; end if;

  for domain_item in select value from jsonb_array_elements(coalesce(payload->'domains', '[]'::jsonb)) loop
    if nullif(btrim(domain_item->>'name'), '') is null then continue; end if;
    insert into public.domains (user_id, name, description, created_at, updated_at)
    values (
      auth.uid(), left(btrim(domain_item->>'name'), 80), left(coalesce(domain_item->>'description', ''), 600),
      coalesce((domain_item->>'created_at')::timestamptz, now()), now()
    )
    on conflict (user_id, name) do update set description = excluded.description
    returning id into saved_domain_id;
    imported_domains := imported_domains + 1;
  end loop;

  for project_item in select value from jsonb_array_elements(coalesce(payload->'projects', '[]'::jsonb)) loop
    if nullif(btrim(project_item->>'title'), '') is null or nullif(project_item->>'legacy_id', '') is null then continue; end if;
    insert into public.projects (user_id, title, description, legacy_client_id, created_at, updated_at)
    values (
      auth.uid(), left(btrim(project_item->>'title'), 80), left(coalesce(project_item->>'description', ''), 500),
      left(project_item->>'legacy_id', 200), coalesce((project_item->>'created_at')::timestamptz, now()),
      coalesce((project_item->>'updated_at')::timestamptz, now())
    )
    on conflict (user_id, legacy_client_id) where legacy_client_id is not null
    do update set title = excluded.title, description = excluded.description, updated_at = excluded.updated_at
    returning id into saved_project_id;
    imported_projects := imported_projects + 1;

    for page_item in select value from jsonb_array_elements(coalesce(project_item->'pages', '[]'::jsonb)) loop
      if nullif(page_item->>'legacy_id', '') is null then continue; end if;
      insert into public.project_pages (project_id, user_id, title, content, legacy_client_id, created_at, updated_at)
      values (
        saved_project_id, auth.uid(), left(coalesce(nullif(btrim(page_item->>'title'), ''), 'Untitled page'), 100),
        coalesce(page_item->>'content', ''), left(page_item->>'legacy_id', 200),
        coalesce((page_item->>'created_at')::timestamptz, now()), coalesce((page_item->>'updated_at')::timestamptz, now())
      )
      on conflict (project_id, legacy_client_id) where legacy_client_id is not null
      do update set title = excluded.title, content = excluded.content, updated_at = excluded.updated_at;
      imported_pages := imported_pages + 1;
    end loop;
  end loop;

  for assignment_item in select value from jsonb_array_elements(coalesce(payload->'note_domains', '[]'::jsonb)) loop
    if coalesce(assignment_item->>'note_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then continue; end if;
    select id into saved_domain_id from public.domains
    where user_id = auth.uid() and lower(name) = lower(left(btrim(assignment_item->>'domain_name'), 80))
    order by created_at limit 1;
    if saved_domain_id is not null and exists (
      select 1 from public.notes where id = (assignment_item->>'note_id')::uuid and user_id = auth.uid()
    ) then
      insert into public.note_domains (note_id, domain_id)
      values ((assignment_item->>'note_id')::uuid, saved_domain_id)
      on conflict do nothing;
      imported_assignments := imported_assignments + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'projects', imported_projects, 'pages', imported_pages,
    'domains', imported_domains, 'note_domains', imported_assignments
  );
end;
$$;

revoke all on function public.import_legacy_workspace(jsonb) from public;
grant execute on function public.import_legacy_workspace(jsonb) to authenticated;

/*
 * Bootstrap the old category string only for installations that still have it.
 * Some production schemas removed this compatibility column before Stage 2.
 */
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'notes'
      and column_name = 'category'
  ) then
    execute $bootstrap$
      insert into public.domains (user_id, name)
      select distinct note.user_id, left(btrim(note.category), 80)
      from public.notes note
      where nullif(btrim(note.category), '') is not null
      on conflict (user_id, name) do nothing
    $bootstrap$;

    execute $bootstrap$
      insert into public.note_domains (note_id, domain_id)
      select note.id, domain.id
      from public.notes note
      join public.domains domain
        on domain.user_id = note.user_id
       and lower(domain.name) = lower(btrim(note.category))
      where nullif(btrim(note.category), '') is not null
      on conflict do nothing
    $bootstrap$;
  end if;
end;
$$;
