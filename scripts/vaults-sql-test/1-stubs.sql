create role authenticated; create role anon;
create schema auth;
create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create table public.user_settings (user_id uuid primary key, full_name text, avatar_url text);
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  raw_text text not null,
  is_sample boolean not null default false,
  embedding_status text not null default 'pending',
  created_at timestamptz not null default now()
);
create table public.domains (id uuid primary key default gen_random_uuid(), user_id uuid not null, name text not null, description text, is_sample boolean not null default false);
create table public.note_domains (note_id uuid references public.notes(id) on delete cascade, domain_id uuid references public.domains(id) on delete cascade, primary key (note_id));
create table public.note_retrievals (user_id uuid, note_id uuid references public.notes(id) on delete cascade, primary key (user_id, note_id));
create function public.set_workspace_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
