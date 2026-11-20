/*
  # Saved retrievals

  The last retrieval run for a note: its related notes, sections and insight
  cards. Until now it was kept only in the browser, so opening the same note
  on another device ran every AI call again. Kept here, it follows the person
  to every device, and a note is searched again only when it changes.

  One row per note. `version` is the app's saved-retrieval format, so a
  format change makes old rows unused rather than misread. `signature` is the
  note text, Domain goal and AI mode the search ran with; the app compares it
  with the current note to tell when the result is out of date.
  Deleting a note deletes its row.
*/

create table if not exists public.note_retrievals (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  note_id uuid not null references public.notes(id) on delete cascade,
  version text not null check (char_length(version) between 1 and 20),
  signature text not null check (char_length(signature) between 1 and 200),
  mode text not null check (mode in ('similar', 'relevant')),
  search jsonb not null check (jsonb_typeof(search) = 'object' and pg_column_size(search) <= 2097152),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, note_id)
);

-- Opening a note lists the other notes whose retrieval used it.
create index if not exists note_retrievals_search_idx
  on public.note_retrievals using gin (search jsonb_path_ops);

drop trigger if exists note_retrievals_set_updated_at on public.note_retrievals;
create trigger note_retrievals_set_updated_at
  before update on public.note_retrievals
  for each row execute function public.set_workspace_updated_at();

alter table public.note_retrievals enable row level security;

create policy "Users can select own retrievals" on public.note_retrievals
  for select to authenticated using (auth.uid() = user_id);

-- The note must be the person's own.
create policy "Users can insert own retrievals" on public.note_retrievals
  for insert to authenticated with check (
    auth.uid() = user_id
    and exists (select 1 from public.notes note where note.id = note_id and note.user_id = auth.uid())
  );

create policy "Users can update own retrievals" on public.note_retrievals
  for update to authenticated using (auth.uid() = user_id) with check (
    auth.uid() = user_id
    and exists (select 1 from public.notes note where note.id = note_id and note.user_id = auth.uid())
  );

create policy "Users can delete own retrievals" on public.note_retrievals
  for delete to authenticated using (auth.uid() = user_id);
