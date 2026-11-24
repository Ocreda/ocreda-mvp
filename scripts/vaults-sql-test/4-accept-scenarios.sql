\set QUIET on
select id as kept_before from public.notes where raw_text = 'Alice idea one' \gset
-- Alice changes note two, adds note three, makes link 2.
set test.uid = 'aaaaaaaa-0000-0000-0000-000000000001';
update public.public_notes set raw_text = 'Alice idea two, revised' where raw_text = 'Alice idea two';
insert into public.public_notes (user_id, raw_text) values (auth.uid(), 'Alice idea three');
select public.create_share_link() as link2 \gset
select token as link1 from public.share_links order by created_at limit 1 \gset
set test.uid = 'bbbbbbbb-0000-0000-0000-000000000002';
\echo '-- link 2 seen before accepting (expect newer):'
select public.get_shared_link(:'link2')->'vault'->>'status';
\echo '-- accept link 2 (expect updated, 2 new):'
select public.accept_shared_link(:'link2')->>'status' as status, public.accept_shared_link(:'link2')->>'status' as again;
\echo '-- vault notes now:'
select raw_text, id = :'kept_before' as same_row from public.notes where vault_id is not null order by raw_text;
\echo '-- old link 1 (expect older, and get_shared_link older):'
select public.accept_shared_link(:'link1')->>'status', public.get_shared_link(:'link1')->'vault'->>'status';
\echo '-- old app call on link 2 (expect already_copied true):'
select public.copy_shared_notes(:'link2');
\echo '-- Carol shares; Bob gets a second vault:'
set test.uid = 'cccccccc-0000-0000-0000-000000000003';
insert into public.public_notes (user_id, raw_text) values (auth.uid(), 'Carol idea');
select public.create_share_link() as link3 \gset
set test.uid = 'bbbbbbbb-0000-0000-0000-000000000002';
select public.accept_shared_link(:'link3')->>'status';
select name, (select count(*) from notes n where n.vault_id = v.id) as notes from vaults v order by name;
\echo '-- shared notes are read-only (expect error):'
\set ON_ERROR_STOP off
update public.notes set raw_text = 'hacked' where raw_text = 'Carol idea';
update public.notes set vault_id = null where raw_text = 'Carol idea';
\echo '-- own notes still editable:'
update public.notes set raw_text = 'Bob own note!' where raw_text = 'Bob own note' returning raw_text;
\echo '-- Alice cannot accept her own link, revoked link refused:'
set test.uid = 'aaaaaaaa-0000-0000-0000-000000000001';
select public.accept_shared_link(:'link2');
update public.share_links set revoked_at = now() where token = :'link3';
set test.uid = 'bbbbbbbb-0000-0000-0000-000000000002';
select public.accept_shared_link(:'link3');
\echo '-- revoked link: vault stays (expect Carol 1):'
select name, (select count(*) from notes n where n.vault_id = v.id) from vaults v where name = 'Carol';
\echo '-- removing a vault removes its notes:'
delete from vaults where name = 'Carol';
select count(*) as carol_notes_left from notes where raw_text = 'Carol idea';
