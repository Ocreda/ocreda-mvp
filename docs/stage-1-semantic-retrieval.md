# Stage 1 semantic retrieval

Stage 1 is an experiment foundation, not production surfacing. It adds one semantic embedding per note, an idempotent authenticated worker, exact full-corpus ranking, and Q1/Q2/Q5 experiment endpoints.

It intentionally does **not** add structural vectors, behavioral weighting, a similarity floor, a fixed candidate width, or a production reasoning model.

## Local regression examples

Run:

```bash
npm run test:stage1
```

The executable examples verify:

- a deterministic 50-note Q1 packet always contains all known target notes and preserves complete `raw_text`
- current-version `ready` notes are not embedded twice, while failed/stale notes retry only when explicitly requested
- cosine ordering and score-distribution calculations
- Q5 length-bucket boundaries and isolated/contextual text behavior
- the migration contains no structural vector or ranking floor, keeps multipliers disabled, and paginates exact full-corpus ranking
- every Stage 1/adjacent service-role endpoint verifies the JWT and accepts no browser-supplied `user_id`
- generated summaries and assistant answers are not reused as retrieval context

## Locked configuration

- Provider: Google Gemini Embeddings (uses the existing `GEMINI_API_KEY` secret)
- Model: `gemini-embedding-2`
- Dimension: `768`
- Version: `google:gemini-embedding-2:768:v1`
- Stored input: complete `raw_text`
- Document task type: `RETRIEVAL_DOCUMENT`
- Entry/query task type: `RETRIEVAL_QUERY`

The provider/model choice here applies only to embeddings. It does not choose Gemini as the reasoning model.

## Deployment order

1. Apply `20260830193000_add_stage1_semantic_retrieval.sql`.
2. Deploy `embed-notes`.
3. Deploy `semantic-retrieval-experiment`.
4. Redeploy `process-note`, `handle-message`, and `chat-message` so they use JWT-derived ownership and source-only context.
5. Run the backfill in bounded batches.
6. Run Q1, Q2, and Q5 with the validated entries and known note IDs.

Do not run Q2 until the backfill reports all intended corpus notes as `ready`.

## Authentication contract

Every endpoint requires the signed-in user's access token:

```http
Authorization: Bearer <supabase-access-token>
apikey: <supabase-anon-key>
```

No endpoint accepts `user_id`. Ownership is derived from the JWT, and every service-role query is additionally constrained to that user.

Retrieval and reasoning prompts use complete source-note `raw_text`. Generated summaries and prior assistant answers remain display/history data only and are never supplied as note-retrieval context.

## Embedding and backfill worker

Embed selected notes:

```json
{
  "note_ids": ["uuid"],
  "retry_failed": false,
  "retry_stale_processing": false
}
```

Process the next pending batch:

```json
{
  "limit": 25,
  "retry_failed": false,
  "retry_stale_processing": true
}
```

The worker claims only `pending` notes by default. Failed notes require `retry_failed: true`. A `processing` note can be reclaimed only after fifteen minutes and only with `retry_stale_processing: true`.

Edits reset the note to `pending`. The worker writes an embedding only when the note's `raw_text` still matches the text it embedded, preventing an old in-flight request from overwriting a newer edit.

## Q1 subset preparation

```json
{
  "experiment": "q1_subset",
  "entry_text": "Validated entry text",
  "target_note_ids": ["known-load-bearing-note-uuid"],
  "subset_size": 50,
  "seed": "validated-run-1"
}
```

The response contains fifty complete notes and guarantees that the supplied target notes are present. It does not run a reasoning model; the same payload should be benchmarked against each reasoning-model candidate.

Record each independent reasoning run without selecting a winner in code:

```json
{
  "experiment": "q1_record_result",
  "experiment_id": "q1-subset-experiment-uuid",
  "provider": "provider-name",
  "model": "model-name",
  "run_label": "validated-run-1",
  "response_text": "Complete unmodified model response",
  "selected_note_ids": ["note-uuid"],
  "metrics": { "reviewer_notes": "optional structured metadata" }
}
```

The backend calculates and stores target hits from the original Q1 subset configuration. This records the benchmark evidence while leaving the Claude-versus-Gemini decision open.

## Q2 exact full-corpus ranking

```json
{
  "experiment": "q2_full_rank",
  "entry_text": "Validated entry text",
  "target_note_ids": ["alaska-uuid", "spanish-a-uuid", "spanish-b-uuid"]
}
```

The endpoint returns and persists every ready note's exact cosine rank, similarity, character count, and estimated token count. It also returns score-distribution percentiles and the supplied targets' positions. There is no candidate limit and no similarity threshold.

## Q5 short-note comparison

```json
{
  "experiment": "q5_short_note",
  "note_id": "short-note-uuid",
  "entry_texts": ["Known query one", "Known query two"],
  "variants": [
    { "name": "linked", "context_note_ids": ["linked-note-uuid"] },
    { "name": "page", "context_text": "Parent or page context" },
    { "name": "session", "context_note_ids": ["same-session-note-uuid"] }
  ]
}
```

The endpoint embeds the isolated note and each contextual variant without changing the note's production embedding. For every test entry, it reports the variant's cosine score and exact rank against the rest of the ready corpus.

Each Q5 response and stored configuration labels the note as `<100`, `100-299`, `300-999`, or `1000+` characters so results can be reviewed by the required length buckets.

## Gate output

Stage 1 is complete only when the database contains:

- Q1 subset/model benchmark results
- Q2 full rankings for all validated targets
- Q5 comparisons across the agreed length buckets
- Score distributions for the validated corpus

Candidate width, similarity floor, structural retrieval, and production surfacing remain blocked until those results are reviewed.
