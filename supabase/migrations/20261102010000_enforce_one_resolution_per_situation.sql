/* One accepted solution/help per situation section, with a durable audit trail. */
alter table public.note_card_decisions
  add column if not exists target_section_key text,
  add column if not exists resolved_at timestamptz;

update public.note_card_decisions
set resolved_at = coalesce(resolved_at, updated_at, created_at)
where choice in ('solved', 'helped') and target_note_id is not null;

create index if not exists note_card_decisions_resolution_history_idx
  on public.note_card_decisions (user_id, target_note_id, resolved_at desc)
  where target_note_id is not null and choice in ('solved', 'helped');

create unique index if not exists note_card_decisions_one_resolution_per_section_idx
  on public.note_card_decisions (user_id, target_note_id, target_section_key)
  where target_note_id is not null
    and target_section_key is not null
    and choice in ('solved', 'helped');

comment on column public.note_card_decisions.target_section_key is
  'Stable fingerprint of the situation passage this answer resolves; used to prevent answer accumulation.';
comment on column public.note_card_decisions.resolved_at is
  'When a solution/help was accepted, retained as the resolution history timestamp.';
