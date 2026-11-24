# Vaults migration test

Checks `supabase/migrations/20261124120000_shared_note_vaults.sql` against a
throwaway local Postgres (no Supabase, no pgvector), with stand-ins for the
tables it touches.

1. `1-stubs.sql`: minimal `auth`, `notes`, `domains` and friends.
2. `supabase/migrations/20261111120000_note_sharing.sql`, as it is.
3. `2-before-vaults.sql`: Alice shares, Bob copies the old way and edits one.
4. The vaults migration, without its last part (`match_notes_semantic` needs pgvector).
5. `4-accept-scenarios.sql`: newer link, same link again, older link, a second
   sharer, read-only shared notes, own link, revoked link, removing a vault.

```sh
initdb -D /tmp/pgvaults -U postgres -A trust && pg_ctl -D /tmp/pgvaults -o "-p 54329" start
psql -p 54329 -U postgres -v ON_ERROR_STOP=1 -f scripts/vaults-sql-test/1-stubs.sql
psql -p 54329 -U postgres -v ON_ERROR_STOP=1 -f supabase/migrations/20261111120000_note_sharing.sql
psql -p 54329 -U postgres -v ON_ERROR_STOP=1 -f scripts/vaults-sql-test/2-before-vaults.sql
sed '/^\/\*$/{N;/Semantic search, as in/Q}' supabase/migrations/20261124120000_shared_note_vaults.sql > /tmp/vaults.sql
psql -p 54329 -U postgres -v ON_ERROR_STOP=1 -f /tmp/vaults.sql
psql -p 54329 -U postgres -f scripts/vaults-sql-test/4-accept-scenarios.sql
```

Each step in `4-accept-scenarios.sql` prints what to expect next to what happened.
