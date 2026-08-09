alter table note_relations add column if not exists confidence double precision not null default 1;
alter table note_relations add column if not exists weight double precision not null default 1;
alter table note_relations add column if not exists feedback text check (feedback in ('accepted', 'rejected'));

create or replace function apply_connection_feedback(
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
  update note_relations
  set weight = greatest(0.01, weight * p_multiplier), feedback = p_feedback
  where (note_id = p_note_id and related_note_id = p_related_note_id)
     or (note_id = p_related_note_id and related_note_id = p_note_id);
$$;
