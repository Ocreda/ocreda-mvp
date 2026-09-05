import { assert, assertEquals } from 'jsr:@std/assert@1';
import { normalizeLegacyWorkspace } from '../../../lib/workspace-migration.ts';
import { diversifyCandidates, parseVector, partitionNearDuplicates, type SemanticCandidate } from './stage3.ts';

function candidate(id: string, similarity: number, embedding: number[], rawRank: number): SemanticCandidate {
  return { note_id: id, similarity, embedding, raw_rank: rawRank, note_length: 100, token_count: 25, raw_text: `Complete note ${id}` };
}

Deno.test('Stage 3 parses pgvector text without losing dimensions', () => {
  assertEquals(parseVector('[0.1,-0.2,0.3]'), [0.1, -0.2, 0.3]);
});

Deno.test('browser migration preserves complete pages and validates assignments', () => {
  const userId = 'user-example';
  const noteId = '123e4567-e89b-42d3-a456-426614174000';
  const storage = new Map<string, string>([
    [`ocreda-muses:${userId}`, JSON.stringify([{ title: 'Building', description: 'Founder notes', createdAt: '2026-01-01T00:00:00Z' }])],
    [`ocreda-projects:${userId}`, JSON.stringify([{ id: 'project-1', title: 'Ocreda', description: 'Product', pages: [{ id: 'page-1', title: 'Retrieval', content: 'Complete page text must survive unchanged.' }], createdAt: '2026-01-01T00:00:00Z' }])],
    [`ocreda-note-muses:${userId}`, JSON.stringify({ [noteId]: 'Building', 'not-a-uuid': 'Ignored' })],
  ]);
  const payload = normalizeLegacyWorkspace(userId, (key) => storage.get(key) ?? null, '2026-09-04T00:00:00.000Z');
  assertEquals(payload.projects.length, 1);
  assertEquals((payload.projects[0].pages as Array<Record<string, unknown>>)[0].content, 'Complete page text must survive unchanged.');
  assertEquals(payload.domains[0].name, 'Building');
  assertEquals(payload.note_domains, [{ note_id: noteId, domain_name: 'Building' }]);
});

Deno.test('Stage 3 separates near-duplicates instead of using them as resonance slots', () => {
  const input = [candidate('duplicate', 0.97, [1, 0], 1), candidate('connection', 0.83, [0.8, 0.2], 2)];
  const result = partitionNearDuplicates(input, 0.95);
  assertEquals(result.nearDuplicates.map((item) => item.note_id), ['duplicate']);
  assertEquals(result.candidates.map((item) => item.note_id), ['connection']);
});

Deno.test('MMR preserves a lower-ranked opposing pole over a redundant result', () => {
  const input = [
    candidate('position-a', 0.90, [1, 0], 1),
    candidate('position-a-copy', 0.89, [0.999, 0.001], 2),
    candidate('position-b', 0.84, [0, 1], 3),
  ];
  const selected = diversifyCandidates(input, 2, 0.55);
  assertEquals(selected.map((item) => item.note_id), ['position-a', 'position-b']);
  assert(selected[1].diversified_rank === 2);
});

Deno.test('MMR returns fewer than the limit instead of adding filler', () => {
  const selected = diversifyCandidates([candidate('only', 0.7, [1, 0], 1)], 60);
  assertEquals(selected.length, 1);
});

Deno.test('Stage 2 schema has ownership RLS, junction ownership, and no premature provenance table', async () => {
  const migration = await Deno.readTextFile(new URL('../../migrations/20260904090000_add_projects_pages_domains.sql', import.meta.url));
  for (const table of ['projects', 'project_pages', 'domains', 'note_domains']) {
    assert(migration.includes(`alter table public.${table} enable row level security`));
  }
  assert(migration.includes('auth.uid() = user_id'));
  assert(migration.includes('project.user_id = auth.uid()'));
  assert(migration.includes('note.user_id = auth.uid()'));
  assert(migration.includes('domain.user_id = auth.uid()'));
  assert(!migration.includes('page_to_note_usage'));
  assert(migration.includes('import_legacy_workspace'));
});

Deno.test('Stage 3 RPC derives ownership from auth context and has no free-form user id', async () => {
  const migration = await Deno.readTextFile(new URL('../../migrations/20260904091000_add_stage3_wide_semantic_retrieval.sql', import.meta.url));
  assert(migration.includes('note.user_id = auth.uid()'));
  assert(!migration.includes('filter_user_id'));
  assert(migration.includes('similarity_floor'));
  assert(migration.includes('candidate_limit'));
  assert(migration.includes('note.raw_text'));
});

Deno.test('production semantic endpoint does not use behavioral weights or generated summaries', async () => {
  const endpoint = await Deno.readTextFile(new URL('../semantic-retrieval/index.ts', import.meta.url));
  assert(endpoint.includes("behavioral_weighting: false"));
  assert(!endpoint.includes('note_relations'));
  assert(!endpoint.includes('.summary'));
});

Deno.test('live page surfacing and Instant Retrieval have no word-overlap fallback', async () => {
  const page = await Deno.readTextFile(new URL('../../../app/page.tsx', import.meta.url));
  assert(!page.includes('sharedWordScore'));
  assert(!page.includes('keywordScore'));
  assert(page.match(/retrieveSemanticNotes\(/g)?.length === 2);
});
