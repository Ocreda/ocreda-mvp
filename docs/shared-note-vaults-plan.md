# Shared-note vaults: plan

Status: built (steps 1-3). Not deployed: apply `20261124120000_shared_note_vaults.sql` before deploying the app and functions. Decisions from the 2026-11-23 session (see `decisions.txt`).

## What we decided

- **A vault per sharer.** Notes someone shares with you go into a vault of their own, one level above Domains, kept apart from your own notes. Person A and person B each get a separate vault.
- **One Domain per vault for now.** The sharer's own Domains don't come along.
- **One direction only.** Your drafts search the shared notes. Shared notes never get a search or cards of their own, and nothing you do marks them.
- **"Use in my retrieval" switch per vault, on by default.**
- **Cards built on a shared note name the person** ("Person A's note says…"), kept simple.
- **Accepting a newer link from the same person updates their vault** to the latest versions. Nothing changes until you accept.
- **Not now:** taking a shared note as your own.

## How it works today

- `copy_shared_notes` (`supabase/migrations/20261111120000_note_sharing.sql`) copies a link's notes into the receiver's `notes` as ordinary rows, filed in a "From <name>" Domain. `share_link_copies` records the copy so a link is copied once.
- From then on they are the receiver's notes: editable, listed with everything else, searched by every draft, and searched themselves when opened.
- Retrieval (`supabase/functions/find-relevant-notes/index.ts`) loads the person's notes newest first, capped at `MAX_NOTES = 1000`, filtered only by `user_id` and `is_sample`.

## Data model

New table `vaults`:

| column | notes |
|---|---|
| `id` | uuid |
| `user_id` | the receiver; RLS: own rows only |
| `sharer_id` | the sharer's account. One vault per (`user_id`, `sharer_id`), unique |
| `name` | the sharer's display name at the last accept, e.g. "Person A" |
| `use_in_retrieval` | boolean, default `true` |
| `link_id`, `accepted_at` | the link the vault currently holds, and when it was accepted |

Columns added:

- `notes.vault_id` → `vaults(id) on delete cascade`. `null` means your own note. Removing a vault removes its notes, their embeddings and saved retrievals.
- ~~`domains.vault_id`~~ Not needed while a vault holds one Domain: the vault itself is shown as that Domain, so vault notes never touch `domains` or `note_domains`, and can't collide with your Domain names. Add it when vaults get several Domains.
- `share_link_copies.vault_id`.

Sample mode stays as it is (`is_sample`). Vaults exist only alongside your own notes, not in sample mode. Later, the sample vault could become one more vault, but that is not part of this work.

## Accepting a link

`copy_shared_notes` is rewritten as `accept_shared_link(token)`:

1. Find or create the vault for (receiver, sharer), and its one Domain ("Person A's notes").
2. **First accept:** insert the link's notes with `vault_id` set, file them in the Domain.
3. **Accepting a newer link from the same person:** replace the vault's notes with the link's.
   - Notes whose text is unchanged keep their row, so cards and saved searches that cite them stay valid.
   - Notes no longer in the link are deleted; new ones are inserted.
4. **Accepting an older link** than the one the vault holds does nothing, and the page says the vault already has a newer share.
5. Record the copy in `share_link_copies` with the vault id.

Embeddings: the inserted notes start as `pending`. The same embedding step that runs before a search (`prepareNotesForSemanticSearch` in `lib/notes-api.ts`) must include vault notes.

The share page (`components/SharedLink.tsx`): the button reads "Add to my notes" the first time and "Update Person A's vault" when a vault exists and the link is newer.

## Retrieval

In `find-relevant-notes` and the semantic SQL functions (`match_notes_semantic`, the wide stage-3 search):

- **Notes searched:** your own notes (`vault_id is null`), plus notes from vaults with `use_in_retrieval = true`.
- **Your own notes always come first.** They fill the 1000-note budget before any shared note. Shared notes take what's left, newest first. Without this, a large vault would push your own older notes out of the search.
- **Each shared note carries its source** (vault name) into the prompts, so the agents and the card writer know who wrote it.
- **No search on a shared note.** The app never offers "Find relevant notes" or an automatic search on a vault note. The function also refuses a search whose `exclude_note_id` is a vault note.
- **No outbound cards onto a shared note.** "Your new note solves / helps an earlier note" marks that earlier note, so those relations are dropped when the earlier note is shared. Only your own notes can be marked.
- The "similar" mode search (`page_text` in `lib/notes-api.ts`) follows the same rules.

## Card wording

Kept to a prompt rule plus labels; no new card kinds.

- **Prompt (`supabase/functions/_shared/relevance.ts`):** shared notes are listed as "written by Person A". Rule: never say "you wrote", "you solved this before" or "you contradicted yourself" about them; name the person instead.
  - Solution from a shared note: "Person A's note answers this: …"
  - Contradiction with a shared note: "Person A sees it differently." The choices become "Today stands / Person A's view / Both are true".
  - "Solved before" only ever uses your own notes.
- **Card UI (`app/page.tsx`, `SuggestionCard` and `CardAction`):** "From your notes" becomes "From Person A's notes", and the chips drawn over your note name the person.
- Merging words from a shared note still works; the merged box says "From Person A".

If any part of this turns out more involved than labels and a prompt rule, stop and check before going further.

## App changes

- **Home:** a "Shared with me" row of vault cards, apart from your Domains. Each card shows the name, note count and last update.
- **A vault card's menu:**
  - "Use in my retrieval" switch, on by default
  - "Remove vault", which deletes its notes after a confirmation
- **Opening a vault** lists its notes, using the Domain view in read-only mode.
- **A shared note opened:**
  - read-only: no Edit, no format bar, no suggestions panel
  - header: "Shared by Person A · updated Nov 23"
  - shows whether the vault is used in retrieval
- **Every note list and query filters by vault**, the way each one already filters by sample mode: library, Domains, previews, the sidebar, "used in" lists, share picker. Your lists show `vault_id is null` only.
- **Global search** shows vault notes in their own group, labelled with the person.
- **Local mode** (`dev/local-mode.ts`, the local path in `lib/sharing-api.ts`): vaults stored in the browser the same way, so this can be tried without Supabase.

## Order of work

1. **Schema and accepting.** `vaults` table and columns, `accept_shared_link`, share-page button, vault cards, read-only vault view, every list filtered. Shared notes not searched yet.
2. **Retrieval.** Include vault notes with your notes first, the switch, no search on shared notes, no outbound cards onto them, embedding step.
3. **Card wording.** Prompt rule, labels, contradiction choices.

Each step can ship on its own. The migration in step 1 has to be applied before that code is deployed, like the earlier note migrations.

## Tests

- `scripts/relevance.test.cjs`:
  - shared notes are loaded after your own, and only when switched on
  - outbound relations to shared notes are dropped
  - the prompt names the person
- A SQL check of `accept_shared_link`: first accept, newer link replaces, unchanged notes keep their ids, older link is refused, another person gets another vault.
- In the app (local mode): accept, update, switch off, remove.

## Decided (were open questions)

1. **Notes copied before this change** move into vaults when their text still matches the link they came from; edited ones stay yours. An emptied "From <name>" Domain is removed.
2. **A revoked link** leaves the vault as it is.
3. **The sharer deletes their account:** the vault stays, under the last name it had (`sharer_id` has no foreign key).
