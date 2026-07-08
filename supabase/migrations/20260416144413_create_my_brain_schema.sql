/*
  # My Brain - Personal Knowledge Base Schema

  ## Overview
  Creates the full schema for the My Brain personal knowledge base app
  with pgvector support for semantic search.

  ## New Tables

  ### notes
  - `id` (uuid, PK) - Unique identifier
  - `user_id` (uuid, FK → auth.users) - Owner
  - `title` (text) - Note title
  - `content` (text) - Note body
  - `type` (text) - Category: idea/fact/quote/memory/goal/reference
  - `tags` (text[]) - AI-generated tags
  - `embedding` (vector(1536)) - OpenAI text-embedding-3-small vector
  - `created_at`, `updated_at` (timestamptz)

  ### questions
  - `id` (uuid, PK)
  - `user_id` (uuid, FK → auth.users)
  - `question` (text) - User's question
  - `answer` (text) - Claude's answer
  - `relevant_note_ids` (uuid[]) - Notes used to answer
  - `created_at` (timestamptz)

  ### note_connections
  - `id` (uuid, PK)
  - `note_id_a`, `note_id_b` (uuid, FK → notes) - Connected notes
  - `similarity_score` (float) - Cosine similarity 0-1
  - `created_at` (timestamptz)

  ## Security
  - RLS enabled on all tables
  - Users can only access their own data
  - Authenticated policies for all CRUD operations

  ## Functions
  - `match_notes` - Vector similarity search for a user's notes
  - `update_note_updated_at` - Auto-update updated_at trigger
*/

-- Enable pgvector
create extension if not exists vector;

-- Notes table
create table if not exists notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  title text not null,
  content text not null,
  type text not null check (type in ('idea', 'fact', 'quote', 'memory', 'goal', 'reference')),
  tags text[] default '{}',
  embedding vector(1536),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Questions table
create table if not exists questions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  question text not null,
  answer text,
  relevant_note_ids uuid[] default '{}',
  created_at timestamptz default now()
);

-- Note connections table
create table if not exists note_connections (
  id uuid primary key default gen_random_uuid(),
  note_id_a uuid references notes(id) on delete cascade not null,
  note_id_b uuid references notes(id) on delete cascade not null,
  similarity_score float not null check (similarity_score >= 0 and similarity_score <= 1),
  created_at timestamptz default now(),
  constraint unique_connection unique(note_id_a, note_id_b)
);

-- Indexes
create index if not exists notes_user_id_idx on notes(user_id);
create index if not exists notes_type_idx on notes(type);
create index if not exists notes_created_at_idx on notes(created_at desc);
create index if not exists questions_user_id_idx on questions(user_id);
create index if not exists questions_created_at_idx on questions(created_at desc);
create index if not exists note_connections_note_id_a_idx on note_connections(note_id_a);
create index if not exists note_connections_note_id_b_idx on note_connections(note_id_b);

-- Vector index for similarity search (IVFFlat)
create index if not exists notes_embedding_idx on notes
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Enable RLS
alter table notes enable row level security;
alter table questions enable row level security;
alter table note_connections enable row level security;

-- Notes policies
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

-- Questions policies
create policy "Users can select own questions"
  on questions for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert own questions"
  on questions for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Note connections policies (read only from frontend, writes from edge functions via service_role)
create policy "Users can view connections for own notes"
  on note_connections for select
  to authenticated
  using (
    exists (
      select 1 from notes
      where notes.id = note_connections.note_id_a
      and notes.user_id = auth.uid()
    )
  );

-- Auto-update updated_at
create or replace function update_note_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger notes_updated_at
  before update on notes
  for each row execute function update_note_updated_at();

-- Vector similarity search function
create or replace function match_notes(
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  filter_user_id uuid
)
returns table (
  id uuid,
  title text,
  content text,
  type text,
  tags text[],
  similarity float
)
language sql stable as $$
  select
    n.id,
    n.title,
    n.content,
    n.type,
    n.tags,
    1 - (n.embedding <=> query_embedding) as similarity
  from notes n
  where n.user_id = filter_user_id
    and n.embedding is not null
    and 1 - (n.embedding <=> query_embedding) > match_threshold
  order by n.embedding <=> query_embedding
  limit match_count;
$$;
