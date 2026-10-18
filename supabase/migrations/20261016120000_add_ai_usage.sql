/*
  # AI usage tracking

  One row per AI request, written by the Edge Functions with the service role:
  who asked, which feature, which models and providers answered, the tokens,
  and what it cost. It never holds note text.

  Nobody reads it through the app's own key: row-level security is on with no
  policies, so only the service role sees it. The admin page goes through the
  admin-usage function, which checks the caller against app_admins.

  `cost_usd` is OpenRouter's billed figure. Calls made to Google directly
  (document import, embeddings) report tokens but no price, so their cost is
  null rather than zero.

  To make someone an admin, run once in the SQL editor:
    insert into public.app_admins (user_id)
    select id from auth.users where email = '<their email>';
*/

create table if not exists public.ai_usage (
  id bigint generated always as identity primary key,
  -- Kept when the account is deleted, so past spend still adds up.
  user_id uuid references auth.users(id) on delete set null,
  feature text not null check (char_length(feature) between 1 and 80),
  billed_by text not null check (billed_by in ('openrouter', 'google')),
  model text,
  tier text,
  models jsonb not null default '{}'::jsonb,
  providers jsonb not null default '{}'::jsonb,
  steps jsonb not null default '{}'::jsonb,
  calls integer not null default 0 check (calls >= 0),
  input_tokens integer not null default 0,
  cached_input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  reasoning_tokens integer not null default 0,
  cost_usd numeric(12, 6),
  status text not null check (status in ('ok', 'cancelled', 'failed')),
  duration_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_created_idx on public.ai_usage (created_at desc);
create index if not exists ai_usage_user_created_idx on public.ai_usage (user_id, created_at desc);

alter table public.ai_usage enable row level security;
-- No policies: only the service role reads or writes it.

create table if not exists public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);

alter table public.app_admins enable row level security;

-- People may see only whether they themselves are an admin, so the app can show the link.
create policy "Users can see their own admin row" on public.app_admins
  for select to authenticated using (auth.uid() = user_id);
