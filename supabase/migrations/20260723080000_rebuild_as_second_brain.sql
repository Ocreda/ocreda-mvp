/*
  # Rebuild schema for general-purpose second brain

  Drops the categorization/memory-strength/contradiction/journal/canvas feature set
  and replaces `notes` with a simpler shape: freeform text plus an optional
  resolved target date/time-of-day (only set for task-like notes). Rebuilds a
  lightweight `note_relations` table so answers can show "connects to N other notes".

  `questions` and `conversation_messages` are untouched — they already power the
  Gemini-based Q&A/chat flow this app is built around.
*/

-- Drop dependent/legacy tables no longer used
drop table if exists note_contradictions cascade;
drop table if exists daily_review_responses cascade;
drop table if exists daily_review_sessions cascade;
drop table if exists note_memory_strength cascade;
drop table if exists weekly_reports cascade;
drop table if exists memory_sessions cascade;
drop table if exists journal_entries cascade;
drop table if exists pinned_notes cascade;
drop table if exists note_canvas_positions cascade;
drop table if exists note_connections cascade;
drop table if exists note_relations cascade;
drop table if exists notes cascade;

-- Notes: freeform capture, optional resolved target date for task-like notes
create table notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  raw_text text not null,
  summary text,
  target_date date,
  time_of_day text check (time_of_day in ('morning', 'afternoon', 'evening', 'night')),
  created_at timestamptz default now()
);

create index notes_user_id_idx on notes(user_id);
create index notes_target_date_idx on notes(user_id, target_date);
create index notes_created_at_idx on notes(created_at desc);

alter table notes enable row level security;

create policy "Users can select own notes"
  on notes for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert own notes"
  on notes for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can update own notes"
  on notes for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own notes"
  on notes for delete
  to authenticated
  using (auth.uid() = user_id);

-- Lightweight note-to-note relations, just enough to show "connects to N other notes"
create table note_relations (
  id uuid primary key default gen_random_uuid(),
  note_id uuid references notes(id) on delete cascade not null,
  related_note_id uuid references notes(id) on delete cascade not null,
  reason text,
  created_at timestamptz default now(),
  constraint unique_note_relation unique (note_id, related_note_id)
);

create index note_relations_note_id_idx on note_relations(note_id);

alter table note_relations enable row level security;

create policy "Users can select relations for own notes"
  on note_relations for select
  to authenticated
  using (
    exists (
      select 1 from notes
      where notes.id = note_relations.note_id
      and notes.user_id = auth.uid()
    )
  );
