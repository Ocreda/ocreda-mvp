# Stages 2 and 3: Supabase workspace and semantic surfacing

## Stage 2

- `projects`, `project_pages`, `domains`, and `note_domains` are the source of truth.
- Every root record is protected by authenticated ownership RLS.
- Junction policies verify both the note owner and Domain owner.
- `project_pages.content_hash` is generated from complete title and content.
- The legacy `notes.category` value is bootstrapped into Domains once and remains only as a compatibility mirror.
- `page_to_note_usage` is intentionally absent until provenance semantics are implemented.

### Browser migration

On the first authenticated load the client:

1. Checks `browser_storage_migrations`.
2. Reads and validates the three legacy localStorage sources.
3. Calls the authenticated, idempotent `import_legacy_workspace` RPC.
4. Reloads the Supabase workspace and verifies Project, Page, and Domain identifiers.
5. Writes the server migration marker only after verification.
6. Retains the browser values as a recovery copy. Runtime reads and writes use Supabase only.

## Stage 3

`semantic-retrieval` embeds page/query text and calls `match_notes_semantic` using the authenticated JWT. The RPC derives ownership from `auth.uid()` and returns complete note text, semantic rank, similarity, and length metadata.

The endpoint then:

1. Separates active-page near-duplicates at a configurable default of `0.95`.
2. Applies MMR with configurable lambda (`0.72` default) to preserve opposing or diverse candidates.
3. Returns at most 60 candidates and never fills the pool below the configured floor.

The similarity floor defaults to the neutral value `0` until Q3 selects a value from observed Stage 1 score distributions. Behavioral weighting remains off, structural vectors remain absent, and generated assistant output is never used as retrieval context.

Both live page surfacing and Instant Retrieval now call this semantic endpoint. There is no local word-overlap fallback in either production surfacing path.
