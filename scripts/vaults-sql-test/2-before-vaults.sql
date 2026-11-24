insert into auth.users (id, raw_user_meta_data) values
 ('aaaaaaaa-0000-0000-0000-000000000001', '{"full_name":"Alice"}'),
 ('bbbbbbbb-0000-0000-0000-000000000002', '{"full_name":"Bob"}'),
 ('cccccccc-0000-0000-0000-000000000003', '{"full_name":"Carol"}');
-- Alice shares two notes (link 1), Bob copies them the old way and edits one.
set test.uid = 'aaaaaaaa-0000-0000-0000-000000000001';
insert into public.public_notes (user_id, raw_text) values (auth.uid(), 'Alice idea one'), (auth.uid(), 'Alice idea two');
select public.create_share_link() as link1 \gset
update public.share_links set created_at = now() - interval '2 days';
set test.uid = 'bbbbbbbb-0000-0000-0000-000000000002';
select public.copy_shared_notes(:'link1');
update public.notes set raw_text = 'Alice idea two, edited by Bob' where raw_text = 'Alice idea two';
insert into public.notes (user_id, raw_text) values (auth.uid(), 'Bob own note');
