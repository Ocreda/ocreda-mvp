/*
 * Tests for the pure logic behind find-relevant-notes. No network, no Supabase.
 *   npm run test:relevance
 */

const assert = require('assert');
const {
  dealIntoChunks,
  parseAgentResponse,
  mergeAgentResults,
  searchFunnel,
  runRelevanceAgents,
  streamRelevanceSearch,
  truncate,
  splitIntoParagraphs,
  parseSectionResponse,
  findDraftSections,
  wholeDraftSection,
  searchRelevance,
  maxInsightsFor,
  buildPrompt,
  RELATION_MIN_LEVEL,
  buildInsightPrompt,
  parseInsightResponse,
  findAnchor,
  findInsight,
  readGoalContext,
  recentDomainNotes,
  selectInsightMatches,
  diversifyByRelation,
  recencyBoost,
  splitNoteTitle,
} = require('../.relevance-build/relevance.js');

let passed = 0;
const pending = [];

function test(name, fn) {
  pending.push([name, fn]);
}

async function run() {
  for (const [name, fn] of pending) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      console.error(`FAIL  ${name}\n      ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${pending.length} passed\n`);
}

const note = (id, createdAt = '2026-01-01') => ({ id, raw_text: id, summary: null, created_at: createdAt });
const ids = (n) => Array.from({ length: n }, (_, i) => note(`id-${i}`));

// ---------------------------------------------------------------- chunking

test('500 notes across 10 agents gives 50 each, nothing lost or duplicated', () => {
  const chunks = dealIntoChunks(ids(500), 10);
  assert.strictEqual(chunks.length, 10);
  chunks.forEach((c) => assert.strictEqual(c.length, 50));
  assert.strictEqual(new Set(chunks.flat().map((n) => n.id)).size, 500);
});

test('uneven split spreads the remainder rather than dropping it', () => {
  const chunks = dealIntoChunks(ids(23), 10);
  assert.strictEqual(chunks.flat().length, 23);
  assert.deepStrictEqual(chunks.map((c) => c.length), [3, 3, 3, 2, 2, 2, 2, 2, 2, 2]);
});

test('round-robin interleaves by age instead of grouping eras', () => {
  const chunks = dealIntoChunks([note('a'), note('b'), note('c'), note('d'), note('e'), note('f')], 3);
  assert.deepStrictEqual(chunks[0].map((n) => n.id), ['a', 'd']);
  assert.deepStrictEqual(chunks[1].map((n) => n.id), ['b', 'e']);
});

test('fewer notes than agents yields one note per chunk, no empty chunks', () => {
  const chunks = dealIntoChunks(ids(3), 10);
  assert.strictEqual(chunks.length, 3);
  chunks.forEach((c) => assert.strictEqual(c.length, 1));
});

test('empty corpus yields no chunks', () => {
  assert.deepStrictEqual(dealIntoChunks([], 10), []);
});

// ------------------------------------------------------------- parsing

const allowed = new Set(['keep-1', 'keep-2']);
const row = (over) => JSON.stringify([{ note_id: 'keep-1', level: 4, relation_type: 'supports', explanation: 'because', ...over }]);

test('accepts a well-formed row', () => {
  const out = parseAgentResponse(row(), allowed);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].relation_type, 'supports');
  assert.strictEqual(out[0].level, 4);
  assert.strictEqual(out[0].relevance_score, 0.8, 'ranked as level / 5');
});

test('drops a hallucinated id the agent was never shown', () => {
  assert.deepStrictEqual(parseAgentResponse(row({ note_id: 'not-in-chunk' }), allowed), []);
});

test('drops a level under the minimum for its relation', () => {
  assert.deepStrictEqual(parseAgentResponse(row({ level: 3 }), allowed), []);
});

test('clamps a level above 5, and rounds one that is not whole', () => {
  assert.strictEqual(parseAgentResponse(row({ level: 9 }), allowed)[0].level, 5);
  assert.strictEqual(parseAgentResponse(row({ level: '4.4' }), allowed)[0].level, 4);
});

test('drops a non-numeric level, and a row that sends only the old score', () => {
  assert.deepStrictEqual(parseAgentResponse(row({ level: 'high' }), allowed), []);
  assert.deepStrictEqual(parseAgentResponse(row({ level: undefined, relevance_score: 0.9 }), allowed), []);
});

test('falls back to "extends" for an unknown relation type', () => {
  assert.strictEqual(parseAgentResponse(row({ relation_type: 'vibes' }), allowed)[0].relation_type, 'extends');
});

test('drops a row with no explanation', () => {
  assert.deepStrictEqual(parseAgentResponse(row({ explanation: '   ' }), allowed), []);
});

test('keeps the gist alongside the explanation', () => {
  const out = parseAgentResponse(row({ gist: '  what the note says  ' }), allowed);
  assert.strictEqual(out[0].gist, 'what the note says');
  assert.strictEqual(out[0].explanation, 'because');
});

test('keeps the exact candidate passage used for retrieval', () => {
  const out = parseAgentResponse(row({ matched_text: '  the exact source words  ' }), allowed);
  assert.strictEqual(out[0].matched_text, 'the exact source words');
});

test('keeps a row with no gist, leaving it empty', () => {
  const out = parseAgentResponse(row({ gist: 42 }), allowed);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].gist, '');
});

test('survives a ```json fence', () => {
  assert.strictEqual(parseAgentResponse('```json\n' + row() + '\n```', allowed).length, 1);
});

test('survives prose wrapped around the array', () => {
  assert.strictEqual(parseAgentResponse(`Sure! Here you go:\n${row()}\nHope that helps.`, allowed).length, 1);
});

test('an empty array is a valid answer, not an error', () => {
  assert.deepStrictEqual(parseAgentResponse('[]', allowed), []);
});

test('unparseable output yields nothing rather than throwing', () => {
  assert.deepStrictEqual(parseAgentResponse('I could not do that.', allowed), []);
  assert.deepStrictEqual(parseAgentResponse('[{broken', allowed), []);
  assert.deepStrictEqual(parseAgentResponse('{"note_id":"keep-1"}', allowed), []);
});

const result = (over = {}) => ({ note_id: 'keep-1', level: 4, relation_type: 'supports', explanation: 'because', ...over });

test('reads the {"results": [...]} object agents are asked for', () => {
  const out = parseAgentResponse(JSON.stringify({ results: [result(), result({ note_id: 'keep-2' })] }), allowed);
  assert.deepStrictEqual(out.map((r) => r.note_id), ['keep-1', 'keep-2']);
});

test('a lone result sent as a bare object is still read, not lost', () => {
  assert.strictEqual(parseAgentResponse(JSON.stringify(result()), allowed).length, 1);
});

test('a list under some other key is still read', () => {
  assert.strictEqual(parseAgentResponse(JSON.stringify({ matches: [result()] }), allowed).length, 1);
});

test('an empty results object means nothing matched', () => {
  assert.deepStrictEqual(parseAgentResponse('{"results": []}', allowed), []);
});

test('the agent prompt asks for an object, which JSON-object mode allows on every provider', () => {
  const prompt = buildPrompt('d', [note('a')]);
  assert.ok(prompt.includes('{"results": [{"note_id"'));
  assert.ok(prompt.includes('respond with ONLY the JSON object'));
});

test('keeps only the first of a repeated id', () => {
  const dupes = JSON.stringify([
    { note_id: 'keep-1', level: 5, relation_type: 'supports', explanation: 'first' },
    { note_id: 'keep-1', level: 3, relation_type: 'extends', explanation: 'second' },
  ]);
  const out = parseAgentResponse(dupes, allowed);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].explanation, 'first');
});

test('skips null entries without dropping good ones', () => {
  const mixed = JSON.stringify([null, { note_id: 'keep-2', level: 4, relation_type: 'question', explanation: 'ok' }]);
  assert.strictEqual(parseAgentResponse(mixed, allowed).length, 1);
});

// ------------------------------------------------------------- streaming

async function readEvents(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.trim().split('\n').map((line) => JSON.parse(line));
}

// Every note in a chunk is scored relevant, so matches track what has finished.
const matchEveryNote = (prompt) =>
  Promise.resolve(JSON.stringify([...prompt.matchAll(/^ID: (\S+)$/gm)].map((m) => ({
    note_id: m[1], level: 4, relation_type: 'supports', gist: 'g', explanation: 'e',
  }))));

const streamOptions = (over) => ({
  draft: 'a draft long enough to search',
  notes: ids(6),
  agentCount: 3,
  concurrency: 3,
  generate: matchEveryNote,
  isRetryable: () => false,
  maxPerSection: 50,
  allFailedMessage: 'all failed',
  failedMessage: 'failed',
  ...over,
});

test('stream reports start, one progress per agent, then done', async () => {
  const events = await readEvents(streamRelevanceSearch(streamOptions()));
  assert.deepStrictEqual(events.map((e) => e.type), ['start', 'progress', 'progress', 'progress', 'done']);
  assert.deepStrictEqual(events[0], { type: 'start', notes_total: 6, agents_total: 3 });
  assert.deepStrictEqual(events.slice(1, 4).map((e) => e.agents_done), [1, 2, 3]);
  assert.strictEqual(events[3].matches, 6);
  assert.strictEqual(events[4].results.length, 6);
  assert.deepStrictEqual(events[4].coverage, { notes_searched: 6, notes_total: 6, complete: true });
});

test('stream includes a combined summary of the final matches', async () => {
  const events = await readEvents(streamRelevanceSearch(streamOptions({
    summarize: async (results) => `Summary of ${results.length} notes`,
  })));
  assert.strictEqual(events.at(-1).summary, 'Summary of 6 notes');
});

test('summary failure does not hide retrieved notes', async () => {
  const events = await readEvents(streamRelevanceSearch(streamOptions({
    summarize: async () => { throw new Error('summary unavailable'); },
  })));
  assert.strictEqual(events.at(-1).type, 'done');
  assert.strictEqual(events.at(-1).results.length, 6);
});

test('stream reports progress before the slowest agent finishes', async () => {
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  let calls = 0;
  const generate = (prompt) => (calls++ === 0 ? slow.then(() => matchEveryNote(prompt)) : matchEveryNote(prompt));
  const reader = streamRelevanceSearch(streamOptions({ generate })).getReader();
  const decoder = new TextDecoder();
  let text = '';
  while ((text.match(/"progress"/g) ?? []).length < 2) {
    text += decoder.decode((await reader.read()).value, { stream: true });
  }
  assert.ok(!text.includes('"done"'), 'done arrived before the slow agent was released');
  releaseSlow();
  await reader.cancel();
});

test('stream ends in an error event when every agent fails', async () => {
  const events = await readEvents(streamRelevanceSearch(streamOptions({ generate: () => Promise.reject(new Error('down')) })));
  assert.deepStrictEqual(events.at(-1), { type: 'error', error: 'all failed' });
  assert.ok(events.filter((e) => e.type === 'progress').every((e) => e.matches === 0));
});

// ------------------------------------------------------------- merging

const res = (id, score) => ({ note_id: id, level: Math.round(score * 5), relevance_score: score, relation_type: 'extends', explanation: 'x' });

test('ranks by score across agents, highest first', () => {
  const { results } = mergeAgentResults(
    [
      { chunkSize: 2, results: [res('low', 0.55)] },
      { chunkSize: 2, results: [res('high', 0.95)] },
      { chunkSize: 2, results: [res('mid', 0.7)] },
    ],
    new Map(),
    50
  );
  assert.deepStrictEqual(results.map((r) => r.note_id), ['high', 'mid', 'low']);
});

test('a failed agent is excluded from the searched count', () => {
  const { notesSearched } = mergeAgentResults(
    [{ chunkSize: 50, results: [] }, { chunkSize: 50, results: null }, { chunkSize: 50, results: [] }],
    new Map(),
    50
  );
  assert.strictEqual(notesSearched, 100, 'the failed agent’s 50 notes must not count as searched');
});

test('all agents succeeding counts every note', () => {
  const outcomes = Array.from({ length: 10 }, () => ({ chunkSize: 50, results: [] }));
  assert.strictEqual(mergeAgentResults(outcomes, new Map(), 50).notesSearched, 500);
});


test('caps the returned list at the per-section limit', () => {
  const many = Array.from({ length: 80 }, (_, i) => res(`n-${i}`, 0.5 + i / 1000));
  assert.strictEqual(mergeAgentResults([{ chunkSize: 80, results: many }], new Map(), 50).results.length, 50);
});

test('the same note from two agents keeps the higher score', () => {
  const { results } = mergeAgentResults(
    [{ chunkSize: 1, results: [res('dupe', 0.6)] }, { chunkSize: 1, results: [res('dupe', 0.9)] }],
    new Map(),
    50
  );
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].relevance_score, 0.9);
});

test('every agent failing reports nothing searched', () => {
  const { results, notesSearched } = mergeAgentResults(
    [{ chunkSize: 50, results: null }, { chunkSize: 50, results: null }],
    new Map(),
    50
  );
  assert.strictEqual(notesSearched, 0);
  assert.deepStrictEqual(results, []);
});

// --------------------------------------------------------- orchestration

const okResponse = (id) => JSON.stringify([{ note_id: id, level: 4, relation_type: 'supports', explanation: 'ok' }]);
const never = () => false;
const always = () => true;

test('a fan-out where every agent succeeds reads the whole corpus', async () => {
  const { outcomes } = await runRelevanceAgents({
    draft: 'draft', notes: ids(50), agentCount: 10, concurrency: 5,
    generate: async () => '[]', isRetryable: never,
  });
  assert.strictEqual(outcomes.length, 10);
  assert.strictEqual(outcomes.reduce((sum, o) => sum + o.chunkSize, 0), 50);
  outcomes.forEach((o) => assert.ok(Array.isArray(o.results)));
});

test('one permanently failing agent does not sink the others', async () => {
  let call = 0;
  const { outcomes } = await runRelevanceAgents({
    draft: 'draft', notes: ids(30), agentCount: 3, concurrency: 3,
    generate: async () => { if (call++ === 1) throw new Error('boom'); return '[]'; },
    isRetryable: never,
  });
  const failed = outcomes.filter((o) => o.results === null);
  assert.strictEqual(failed.length, 1, 'exactly one agent should be marked unread');
  assert.strictEqual(outcomes.filter((o) => o.results !== null).length, 2);
});

test('a retryable failure is retried and can then succeed', async () => {
  const attempts = new Map();
  const { outcomes } = await runRelevanceAgents({
    draft: 'draft', notes: [note('id-0')], agentCount: 1, concurrency: 1,
    generate: async (prompt) => {
      const n = (attempts.get(prompt) ?? 0) + 1;
      attempts.set(prompt, n);
      if (n === 1) throw new Error('429');
      return okResponse('id-0');
    },
    isRetryable: always,
  });
  assert.strictEqual([...attempts.values()][0], 2, 'should have taken a second attempt');
  assert.strictEqual(outcomes[0].results.length, 1);
});

test('a non-retryable failure is not retried', async () => {
  let calls = 0;
  const { outcomes } = await runRelevanceAgents({
    draft: 'draft', notes: [note('id-0')], agentCount: 1, concurrency: 1,
    generate: async () => { calls++; throw new Error('bad request'); },
    isRetryable: never,
  });
  assert.strictEqual(calls, 1);
  assert.strictEqual(outcomes[0].results, null);
});

test('an agent that fails twice is reported unread, not empty', async () => {
  const { outcomes } = await runRelevanceAgents({
    draft: 'draft', notes: [note('id-0')], agentCount: 1, concurrency: 1,
    generate: async () => { throw new Error('429'); },
    isRetryable: always,
  });
  assert.strictEqual(outcomes[0].results, null, 'null means unread; [] would mean "read, nothing relevant"');
});

test('concurrency limit is respected', async () => {
  let inFlight = 0; let peak = 0;
  await runRelevanceAgents({
    draft: 'draft', notes: ids(100), agentCount: 10, concurrency: 3,
    generate: async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return '[]';
    },
    isRetryable: never,
  });
  assert.ok(peak <= 3, `expected at most 3 concurrent calls, saw ${peak}`);
});

test('results only survive if the id belongs to that agent’s own chunk', async () => {
  // Every agent claims note id-0, but only one was actually shown it.
  const { outcomes } = await runRelevanceAgents({
    draft: 'draft', notes: ids(10), agentCount: 10, concurrency: 5,
    generate: async () => okResponse('id-0'), isRetryable: never,
  });
  const total = outcomes.reduce((sum, o) => sum + (o.results?.length ?? 0), 0);
  assert.strictEqual(total, 1, 'the other nine agents’ claims on id-0 must be rejected');
});

// ------------------------------------------------------------ draft prep

test('a long draft reaches the agents whole, middle included', () => {
  const long = 'A'.repeat(4000) + 'MIDDLE-IDEA' + 'B'.repeat(5000) + 'ZZZ-TAIL';
  assert.ok(buildPrompt(long, [note('a')]).includes(long));
});

test('truncate only trims past the limit', () => {
  assert.strictEqual(truncate('abc', 10), 'abc');
  assert.strictEqual(truncate('abcdef', 3), 'abc...');
});

// ------------------------------------------------------------------ goal

test('goal context keeps trimmed strings and drops anything else', () => {
  assert.deepStrictEqual(readGoalContext({ name: '  Beta  testing ', goal: ' Find users ' }), { domain: 'Beta testing', goal: 'Find users' });
  assert.deepStrictEqual(readGoalContext({ name: '', goal: 42 }), { domain: null, goal: null });
  assert.deepStrictEqual(readGoalContext(null), { domain: null, goal: null });
  assert.strictEqual(readGoalContext({ goal: 'x'.repeat(1000) }).goal.length, 300);
});

test('the goal appears in the agent prompt only when there is one', () => {
  const withGoal = buildPrompt('my draft', [note('a')], 'Validate pricing');
  assert.ok(withGoal.includes('<goal>\nValidate pricing\n</goal>'));
  assert.ok(!buildPrompt('my draft', [note('a')]).includes('<goal>'));
});

test('the goal does not disturb the shared prompt prefix that caching relies on', () => {
  const prefix = (text) => text.slice(0, text.indexOf('<draft>'));
  assert.strictEqual(prefix(buildPrompt('d', [note('a')], 'Some goal')), prefix(buildPrompt('d', [note('a')])));
});

// ------------------------------------------------------------------ anchor

test('an anchor is found despite case, spacing and curly quotes', () => {
  const text = 'Call went well.\nThe tester said she’d  pay $20/month for this.';
  const span = findAnchor(text, "the tester said she'd pay $20/month");
  assert.ok(span);
  assert.strictEqual(text.slice(span.start, span.end), 'The tester said she’d  pay $20/month');
});

test('an anchor wrapped in quotes or trailing an ellipsis still matches', () => {
  const text = 'I am struggling to find the first 10 users for the product.';
  const span = findAnchor(text, '"struggling to find the first 10 users..."');
  assert.strictEqual(text.slice(span.start, span.end), 'struggling to find the first 10 users');
});

test('an anchor that is not in the text, or is too short, is rejected', () => {
  assert.strictEqual(findAnchor('I need more users', 'I need more customers'), null);
  assert.strictEqual(findAnchor('I need more users', 'more'), null);
});

// ------------------------------------------------------------------ insight

const DRAFT = 'Tester said she would pay $20/month for this if it synced with Notion. She got lost on the empty home screen.';
const insightIds = new Set(['n1', 'n2']);
const PAST = new Map([
  ['n1', 'Pricing test in March: two testers said $10 was the most they would pay. Nobody took $15.'],
  ['n2', 'Sam got lost on the empty home screen too. A sample note would have helped.'],
]);
const parseOpts = (askForGoal = false) => ({ draft: DRAFT, allowedNoteIds: insightIds, askForGoal, noteTextById: PAST });
const quote = (text, noteId = 'n1') => ({ note_id: noteId, text });
const card = (over = {}) => ({
  kind: 'helps', anchor: 'she would pay $20/month', text: 'In March {1}.', quotes: [quote('two testers said $10 was the most')],
  idea: 'ask the next tester to pick $10 or $20', note_ids: ['n1'], ...over,
});
const insightJson = (over = {}) => JSON.stringify({ intent: 'capturing', insights: [card(over)] });
const first = (raw, opts = parseOpts()) => parseInsightResponse(raw, opts).insights[0];

test('a well-formed insight is kept, with its anchor taken from the draft itself', () => {
  const insight = first(insightJson());
  assert.strictEqual(insight.anchor, 'she would pay $20/month');
  assert.strictEqual(insight.intent, 'capturing');
  assert.deepStrictEqual(insight.note_ids, ['n1']);
});

test('an empty insights list is a valid answer, not a failure, and still says what the note is doing', () => {
  const raw = JSON.stringify({ intent: 'learning', insights: [] });
  assert.deepStrictEqual(parseInsightResponse(raw, parseOpts()), { insights: [], goal_suggestions: [], intent: 'learning', failed: false });
});

test('a missing or unknown note intent is reported as null, not guessed', () => {
  assert.strictEqual(parseInsightResponse(JSON.stringify({ insights: [] }), parseOpts()).intent, null);
  assert.strictEqual(parseInsightResponse(JSON.stringify({ intent: 'daydreaming', insights: [] }), parseOpts()).intent, null);
});

test('a reply cut off mid-JSON is a failure, not "nothing useful"', () => {
  const cut = '{"intent": "capturing", "insights": [{"anchor": "she would pay';
  assert.strictEqual(parseInsightResponse(cut, parseOpts()).failed, true);
});

test('an older single "insight" reply is still read', () => {
  const raw = JSON.stringify({ intent: 'capturing', insight: card() });
  assert.strictEqual(parseInsightResponse(raw, parseOpts()).insights.length, 1);
});

test('up to three insights are kept, each on its own passage', () => {
  const raw = JSON.stringify({ intent: 'capturing', insights: [
    card(),
    card({ anchor: 'got lost on the empty home screen', text: 'Sam {1}.', quotes: [quote('got lost on the empty home screen too', 'n2')] }),
    card({ anchor: 'synced with Notion', text: 'Then: {1}.', quotes: [quote('Nobody took $15.')] }),
    card({ anchor: 'Tester said', text: 'Also {1}.', quotes: [quote('A sample note would have helped', 'n2')] }),
  ] });
  const { insights } = parseInsightResponse(raw, parseOpts());
  assert.deepStrictEqual(insights.map((i) => i.anchor), ['she would pay $20/month', 'got lost on the empty home screen', 'synced with Notion']);
});

test('an insight whose passage overlaps an earlier one is dropped as the same issue', () => {
  const raw = JSON.stringify({ intent: 'capturing', insights: [
    card(),
    card({ anchor: 'would pay $20/month for this', text: 'Again {1}.' }),
  ] });
  assert.strictEqual(parseInsightResponse(raw, parseOpts()).insights.length, 1);
});

test('a repeated insight is dropped', () => {
  const raw = JSON.stringify({ intent: 'capturing', insights: [card(), card({ anchor: '' })] });
  assert.strictEqual(parseInsightResponse(raw, parseOpts()).insights.length, 1);
});

test('invented citations are dropped, and a quote from a note it was not given drops the card', () => {
  assert.deepStrictEqual(first(insightJson({ note_ids: ['n1', 'made-up'] })).note_ids, ['n1']);
  assert.strictEqual(first(insightJson({ quotes: [quote('two testers said $10 was the most', 'made-up')] })), undefined);
});

test('a helps card without its idea is dropped rather than shown half-formed', () => {
  assert.strictEqual(first(insightJson({ idea: '  ' })), undefined);
});

test('quotes are taken from the note itself, so a slip in the model\'s copy never shows', () => {
  const insight = first(insightJson({ quotes: [quote('Two testers said $10 was the  most')] }));
  assert.deepStrictEqual(insight.quotes, [quote('two testers said $10 was the most')]);
});

test('a sentence that quotes words the note does not have is dropped, not shown as theirs', () => {
  assert.strictEqual(first(insightJson({ quotes: [quote('three testers wanted a yearly plan')] })), undefined);
  assert.strictEqual(first(insightJson({ text: 'In March {2}.' })), undefined, 'a placeholder with no quote behind it');
  assert.strictEqual(first(insightJson({ text: 'In March they were cheap.' })), undefined, 'a card must carry their words');
});

test('placeholders are renumbered in use order, and the model\'s own quotation marks are dropped', () => {
  const insight = first(insightJson({ text: 'Then ‘{2}’, after {1}.', quotes: [quote('two testers said $10 was the most'), quote('Nobody took $15.')] }));
  assert.strictEqual(insight.text, 'Then {1}, after {2}.');
  assert.deepStrictEqual(insight.quotes.map((q) => q.text), ['Nobody took $15.', 'two testers said $10 was the most']);
});

test('a solution carries its answer word for word from the note, or is dropped', () => {
  const solved = first(insightJson({ kind: 'solution', idea: undefined, answer: quote('nobody took $15') }));
  assert.strictEqual(solved.kind, 'solution');
  assert.deepStrictEqual(solved.answer, quote('Nobody took $15'));
  assert.strictEqual(solved.action, 'Nobody took $15');
  assert.strictEqual(first(insightJson({ kind: 'solution', answer: quote('most people would pay $30') })), undefined);
  assert.strictEqual(first(insightJson({ kind: 'extension' })), undefined, 'an extension needs the words it would merge');
});

test('a helps idea completes "Might help to ...", whatever way the model starts it', () => {
  assert.strictEqual(first(insightJson({ idea: 'Might help to: Say the price and just wait' })).action, 'say the price and just wait');
  assert.strictEqual(first(insightJson({ idea: 'AI demos first' })).action, 'AI demos first');
});

test('a contradiction needs no action, and a card with no kind takes its note\'s relation', () => {
  assert.strictEqual(first(insightJson({ kind: 'contradiction', idea: undefined })).action, '');
  const opts = { ...parseOpts(), relationOfNote: new Map([['n1', 'contradicts']]) };
  assert.strictEqual(first(insightJson({ kind: undefined }), opts).kind, 'contradiction');
  assert.strictEqual(first(insightJson({ kind: undefined })), undefined, 'no kind and nothing to infer it from');
});

test('a paraphrased anchor keeps the card but loses the highlight', () => {
  const insight = first(insightJson({ anchor: 'she is willing to spend twenty dollars' }));
  assert.ok(insight);
  assert.strictEqual(insight.anchor, '');
});

test('an unknown intent falls back to "reflecting"', () => {
  const raw = JSON.stringify({ ...JSON.parse(insightJson()), intent: 'daydreaming' });
  assert.strictEqual(first(raw).intent, 'reflecting');
});

test('a note\'s first line is its title, kept apart from the text; a one-line note is all text', () => {
  assert.deepStrictEqual(splitNoteTitle('Counting test\n\nRan the test. 94% accuracy.'), { title: 'Counting test', text: 'Ran the test. 94% accuracy.' });
  assert.deepStrictEqual(splitNoteTitle('  Just one line here  '), { title: '', text: 'Just one line here' });
  assert.deepStrictEqual(splitNoteTitle('Title only\n\n   '), { title: '', text: 'Title only' });
});

const LONG_NOTE = 'Ran the camera counting test at the depot over the weekend. Accuracy: 94% accuracy across 400 cars, with the misses almost all at night. Rain did not seem to matter at all.';
const quoteCard = (text) => JSON.stringify({ intent: 'capturing', insights: [card({ quotes: [quote(text)] })] });
const longOpts = { ...parseOpts(), noteTextById: new Map([['n1', LONG_NOTE]]) };

test('a quote that is nearly the whole note is dropped; only the part that matters may be quoted', () => {
  assert.strictEqual(first(quoteCard(LONG_NOTE), longOpts), undefined);
  assert.strictEqual(first(quoteCard('94% accuracy across 400 cars'), longOpts).quotes[0].text, '94% accuracy across 400 cars');
  const short = { ...parseOpts(), noteTextById: new Map([['n1', 'No more free pilots.']]) };
  assert.ok(first(quoteCard('No more free pilots.'), short), 'a one-sentence note can only be quoted whole');
});

test('a quote from a note\'s title is never accepted', async () => {
  const notes = [{ ...note('n1'), raw_text: `Counting test results\n\n${LONG_NOTE}` }];
  const reply = (quoted) => async () => JSON.stringify({ intent: 'capturing', insights: [{
    kind: 'helps', anchor: 'pay', text: 'You found {1}.', quotes: [{ note_id: 'n1', text: quoted }], idea: 'use the number', note_ids: ['n1'],
  }] });
  const run = (quoted) => findInsight({ draft: 'Would they pay?', context: { domain: null, goal: null }, notes, results: [hit('n1', 0.9)], excludeNoteId: null, generate: reply(quoted) });
  assert.strictEqual((await run('Counting test results')).insights.length, 0);
  assert.strictEqual((await run('94% accuracy across 400 cars')).insights.length, 1);
});

test('the insight prompt shows each past note\'s title apart from the text it may quote', () => {
  const prompt = buildInsightPrompt({
    draft: 'd', context: { domain: null, goal: 'g' }, recentNotes: [],
    matches: [{ note: { ...note('a'), raw_text: 'Counting test\n\nRan it: 94% accuracy.' }, result: hit('a', 0.9) }],
  });
  assert.ok(prompt.includes('Title: Counting test'));
  assert.ok(prompt.includes('Text:\nRan it: 94% accuracy.'));
  assert.ok(prompt.includes('Never quote a Title'));
});

const outboundOpts = { ...parseOpts(), directionOfNote: new Map([['n1', 'outbound']]) };
const outboundSolution = (over = {}) => insightJson({
  kind: 'solution', idea: undefined, anchor: 'she would pay $20/month',
  text: 'In March {1}.', problem: quote('two testers said $10 was the most'),
  answer: { note_id: 'this', text: 'she would pay $20/month for this' }, ...over,
});

test('a card on notes the draft helps is outbound; others are inbound', () => {
  assert.strictEqual(first(insightJson(), outboundOpts).direction, 'outbound');
  assert.strictEqual(first(insightJson()).direction, 'inbound');
});

test('an outbound solution keeps the earlier note\'s problem and the draft\'s own answer, both word for word', () => {
  const insight = first(outboundSolution(), outboundOpts);
  assert.strictEqual(insight.kind, 'solution');
  assert.deepStrictEqual(insight.problem, quote('two testers said $10 was the most'));
  assert.deepStrictEqual(insight.answer, { note_id: '', text: 'she would pay $20/month for this' }, 'the answer is the draft\'s words, marked with an empty note id');
  assert.strictEqual(insight.action, 'she would pay $20/month for this');
});

test('an outbound solution without its problem, or with an answer the draft does not have, is dropped', () => {
  assert.strictEqual(first(outboundSolution({ problem: undefined }), outboundOpts), undefined);
  assert.strictEqual(first(outboundSolution({ problem: quote('words the old note never had at all') }), outboundOpts), undefined);
  assert.strictEqual(first(outboundSolution({ answer: { note_id: 'this', text: 'she would gladly pay forty dollars' } }), outboundOpts), undefined);
});

test('an inbound solution ignores any problem field', () => {
  const insight = first(insightJson({ kind: 'solution', idea: undefined, answer: quote('nobody took $15'), problem: quote('two testers said $10 was the most') }));
  assert.strictEqual(insight.problem, null);
  assert.strictEqual(insight.answer.note_id, 'n1');
});

test('an outbound extension is dropped: there is nothing of theirs to merge into this note', () => {
  assert.strictEqual(first(insightJson({ kind: 'extension', answer: quote('nobody took $15') }), outboundOpts), undefined);
});

test('the insight prompt keeps dates out of the card sentence, which the card already shows correctly', () => {
  const prompt = buildInsightPrompt({ draft: 'd', context: { domain: null, goal: 'g' }, recentNotes: [], matches: [{ note: note('a'), result: hit('a', 0.9) }] });
  assert.ok(prompt.includes('never write a date or a day'));
  assert.ok(!/On Sep \d/.test(prompt), 'no example sentence models a date');
});

test('the insight prompt allows an outbound solution, with the draft as its answer', () => {
  const prompt = buildInsightPrompt({ draft: 'd', context: { domain: null, goal: 'g' }, recentNotes: [], matches: [{ note: note('a'), result: hit('a', 0.9) }] });
  assert.ok(prompt.includes('When the note being written answers a problem or open question in that past note, give "solution"'));
  assert.ok(prompt.includes('"note_id": "this"'));
});

test('goal suggestions are kept only when asked for, deduplicated and capped at three', () => {
  const raw = JSON.stringify({ intent: 'capturing', insights: [], goal_suggestions: ['Validate pricing', 'Validate pricing', 'Find users', 'Raise money', 'Hire'] });
  assert.deepStrictEqual(parseInsightResponse(raw, parseOpts(true)).goal_suggestions, ['Validate pricing', 'Find users', 'Raise money']);
  assert.deepStrictEqual(parseInsightResponse(raw, parseOpts(false)).goal_suggestions, []);
});

test('unparseable insight output is reported as a failure rather than throwing', () => {
  assert.deepStrictEqual(parseInsightResponse('no json here', parseOpts(true)), { insights: [], goal_suggestions: [], intent: null, failed: true });
});

const hit = (id, score, relation = 'supports') => ({ note_id: id, relevance_score: score, relation_type: relation, gist: '', explanation: 'why' });

test('every match that cleared its bar feeds the insight, in rank order', () => {
  const matches = selectInsightMatches([hit('a', 0.9), hit('b', 0.62, 'extends'), hit('gone', 0.8)], [note('a'), note('b')]);
  assert.deepStrictEqual(matches.map((m) => m.note.id), ['a', 'b'], 'only notes that no longer exist are left out');
});

test('without a cap, every match that cleared its bar is kept', () => {
  const many = Array.from({ length: 8 }, (_, i) => res(`n${i}`, 0.9 - i * 0.02));
  assert.strictEqual(mergeAgentResults([{ chunkSize: 8, results: many }], new Map()).results.length, 8);
});

test('recent Domain notes are newest first, same Domain only, without the note itself', () => {
  const notes = [
    { ...note('old', '2026-01-01'), category: 'Beta' },
    { ...note('new', '2026-03-01'), category: ' beta ' },
    { ...note('self', '2026-04-01'), category: 'Beta' },
    { ...note('other', '2026-05-01'), category: 'Cooking' },
  ];
  assert.deepStrictEqual(recentDomainNotes(notes, 'Beta', 'self').map((n) => n.id), ['new', 'old']);
  assert.deepStrictEqual(recentDomainNotes(notes, null, null), []);
});

test('the insight prompt asks for goal suggestions only when the Domain has no goal', () => {
  const base = { draft: 'd', recentNotes: [], matches: [{ note: note('a'), result: hit('a', 0.9) }] };
  assert.ok(buildInsightPrompt({ ...base, context: { domain: 'Beta', goal: null } }).includes('GOAL_SUGGESTIONS'));
  assert.ok(!buildInsightPrompt({ ...base, context: { domain: 'Beta', goal: 'Find users' } }).includes('GOAL_SUGGESTIONS'));
  assert.ok(!buildInsightPrompt({ ...base, context: { domain: null, goal: null } }).includes('GOAL_SUGGESTIONS'));
});

test('the insight prompt asks for their own words, connected, and never for text to put in the note', () => {
  const prompt = buildInsightPrompt({
    draft: 'Pricing is unclear.', context: { domain: 'Product', goal: 'Choose pricing' }, recentNotes: [],
    matches: [{ note: note('a'), result: hit('a', 0.9, 'solves') }],
  });
  assert.ok(prompt.includes('THEIR WORDS, NOT YOURS'));
  assert.ok(prompt.includes('Whenever such an answer exists, give this card'));
  assert.ok(prompt.includes('"quotes": [{"note_id"'));
  assert.ok(!prompt.includes('added to the note'));
});

test('no matches means no insight call at all', async () => {
  let calls = 0;
  const out = await findInsight({
    draft: 'd', context: { domain: null, goal: null }, notes: [note('a')], results: [], excludeNoteId: null,
    generate: async () => { calls++; return '{}'; },
  });
  assert.strictEqual(calls, 0);
  assert.deepStrictEqual(out, { insights: [], goal_suggestions: [], intent: null, failed: false }, 'skipped is not failed');
});

test('stream carries the insights, the first one alone for older clients, and goal suggestions', async () => {
  const insight = { anchor: 'a', intent: 'capturing', text: 't', action: 'x', note_ids: ['id-0'] };
  const events = await readEvents(streamRelevanceSearch(streamOptions({
    findInsight: async () => ({ insights: [insight], goal_suggestions: ['Find users'], intent: 'capturing', failed: false }),
  })));
  const done = events.at(-1);
  assert.strictEqual(done.type, 'done');
  assert.deepStrictEqual(done.insights, [insight]);
  assert.deepStrictEqual(done.insight, insight);
  assert.deepStrictEqual(done.goal_suggestions, ['Find users']);
  assert.strictEqual(done.note_intent, 'capturing');
  assert.strictEqual(done.insight_failed, false);
  assert.strictEqual(done.summary, undefined);
});

test('a failing insight step still delivers the matches', async () => {
  const events = await readEvents(streamRelevanceSearch(streamOptions({
    findInsight: async () => { throw new Error('model down'); },
  })));
  const done = events.at(-1);
  assert.strictEqual(done.type, 'done');
  assert.ok(done.results.length > 0);
  assert.deepStrictEqual(done.insights, []);
  assert.strictEqual(done.insight, null);
  assert.strictEqual(done.insight_failed, true, 'the app must be able to tell a failure from "nothing useful"');
});

test('without an insight step, "done" has no insight fields at all', async () => {
  const events = await readEvents(streamRelevanceSearch(streamOptions()));
  assert.ok(!('insight' in events.at(-1)));
  assert.ok(!('insights' in events.at(-1)));
});

// ------------------------------------------------------------ direction

const NOW = Date.parse('2026-06-15');
const aged = new Map([['older', '2025-01-01'], ['newer', '2026-06-01']]);
const dir = (id, score, direction, relation = 'extends') => ({ ...res(id, score), direction, relation_type: relation });

test('outbound: between equally strong problems, the recent one wins', () => {
  const { results } = mergeAgentResults([{ chunkSize: 2, results: [dir('older', 0.8, 'outbound'), dir('newer', 0.8, 'outbound')] }], aged, 50, NOW);
  assert.deepStrictEqual(results.map((r) => r.note_id), ['newer', 'older']);
});

test('inbound: solutions are not aged, so a tie keeps its order', () => {
  const { results } = mergeAgentResults([{ chunkSize: 2, results: [dir('older', 0.8, 'inbound'), dir('newer', 0.8, 'inbound')] }], aged, 50, NOW);
  assert.deepStrictEqual(results.map((r) => r.note_id), ['older', 'newer']);
});

test('contradictions ignore recency even when outbound', () => {
  const { results } = mergeAgentResults([{ chunkSize: 2, results: [
    dir('older', 0.9, 'outbound', 'contradicts'), dir('newer', 0.9, 'outbound', 'contradicts'),
  ] }], aged, 50, NOW);
  assert.deepStrictEqual(results.map((r) => r.note_id), ['older', 'newer']);
});

test('recency is a boost, never enough to beat a clearly stronger match', () => {
  const { results } = mergeAgentResults([{ chunkSize: 2, results: [dir('older', 0.9, 'outbound'), dir('newer', 0.8, 'outbound')] }], aged, 50, NOW);
  assert.deepStrictEqual(results.map((r) => r.note_id), ['older', 'newer']);
});

test('the recency boost fades with age and needs a date', () => {
  const r = dir('x', 0.8, 'outbound');
  assert.strictEqual(recencyBoost(r, '2026-06-01', NOW), 0.03);
  assert.strictEqual(recencyBoost(r, '2026-04-01', NOW), 0.015);
  assert.strictEqual(recencyBoost(r, '2025-01-01', NOW), 0);
  assert.strictEqual(recencyBoost(r, undefined, NOW), 0);
  assert.strictEqual(recencyBoost(dir('x', 0.8, 'inbound'), '2026-06-01', NOW), 0);
});

test('direction is read from the agent, defaulting to inbound', () => {
  assert.strictEqual(parseAgentResponse(row({ direction: 'outbound' }), allowed)[0].direction, 'outbound');
  assert.strictEqual(parseAgentResponse(row(), allowed)[0].direction, 'inbound');
  assert.strictEqual(parseAgentResponse(row({ direction: 'sideways' }), allowed)[0].direction, 'inbound');
});

test('the insight prompt tells the model which way each note points', () => {
  const prompt = buildInsightPrompt({
    draft: 'd', context: { domain: null, goal: 'g' }, recentNotes: [],
    matches: [{ note: note('a'), result: { ...hit('a', 0.9), direction: 'outbound' } }],
  });
  assert.ok(prompt.includes('Direction: outbound'));
  assert.ok(prompt.includes('"learning"'));
});

// ------------------------------------------------------ relation bars, variety

test('the prompt states the same minimum levels the server enforces', () => {
  const prompt = buildPrompt('a draft', [{ id: 'n1', raw_text: 'a note', summary: null, created_at: '2026-01-01' }]);
  assert.ok(prompt.includes('"level": <integer 1-5>'), 'agents answer with a level, not a score');
  assert.ok(prompt.includes('level 4 for solves, helps, supports, contradicts, question, and parallel; level 3 for extends'));
  assert.deepStrictEqual(RELATION_MIN_LEVEL, { solves: 4, helps: 4, supports: 4, contradicts: 4, question: 4, parallel: 4, extends: 3 });
});

test('each relation is held to its own minimum level', () => {
  const at = (relation, level) => parseAgentResponse(row({ relation_type: relation, level }), allowed).length;
  for (const relation of ['solves', 'helps', 'supports', 'contradicts', 'question', 'parallel']) {
    assert.strictEqual(at(relation, 3), 0, `${relation} needs level 4`);
    assert.strictEqual(at(relation, 4), 1);
  }
  assert.strictEqual(at('extends', 3), 1, 'extends needs only level 3');
  assert.strictEqual(at('extends', 2), 0);
});

test('helps and solves are recognised relations', () => {
  assert.strictEqual(parseAgentResponse(row({ relation_type: 'solves' }), allowed)[0].relation_type, 'solves');
  assert.strictEqual(parseAgentResponse(row({ relation_type: 'helps' }), allowed)[0].relation_type, 'helps');
});

test('variety lets a near-tie of another relation past a run of the same one', () => {
  const ranked = [hit('s1', 0.9), hit('s2', 0.89), hit('s3', 0.88), hit('c1', 0.86, 'contradicts')];
  assert.deepStrictEqual(diversifyByRelation(ranked).map((r) => r.note_id), ['s1', 'c1', 's2', 's3']);
});

test('variety never lets a much weaker match jump a strong one', () => {
  const ranked = [hit('s1', 0.95), hit('s2', 0.94), hit('e1', 0.61, 'extends')];
  assert.deepStrictEqual(diversifyByRelation(ranked).map((r) => r.note_id), ['s1', 's2', 'e1']);
});

test('variety stops at the limit', () => {
  assert.strictEqual(diversifyByRelation([hit('a', 0.9), hit('b', 0.8), hit('c', 0.7)], 2).length, 2);
});

// ------------------------------------------------------------- sections

const IDEAS_DRAFT = 'Tester said she would pay $20/month if it synced with Notion.\n\nShe got lost on the empty home screen. Nobody knew what to do first.\n\nSeparately, I keep pushing the investor update back a week.';
const ideasReply = (...ideas) => JSON.stringify({ ideas: ideas.map(([starts_with, label]) => ({ starts_with, label })) });

test('paragraphs split at blank lines, trimmed, with offsets into the draft', () => {
  const draft = '  First idea here.\n\n\nSecond one\nstill second.\n';
  const sections = splitIntoParagraphs(draft);
  assert.deepStrictEqual(sections.map((s) => s.text), ['First idea here.', 'Second one\nstill second.']);
  assert.deepStrictEqual(sections.map((s) => s.id), ['1', '2']);
  sections.forEach((s) => assert.strictEqual(draft.slice(s.start, s.end), s.text));
});

test('ideas run from where each starts to where the next starts, and cover the whole draft', () => {
  const sections = parseSectionResponse(ideasReply(['Tester said she would pay', 'Pricing'], ['Separately, I keep pushing the investor update', 'Investor update']), IDEAS_DRAFT);
  assert.strictEqual(sections.length, 2);
  assert.ok(sections[0].text.startsWith('Tester said'));
  assert.ok(sections[0].text.endsWith('Nobody knew what to do first.'), 'the paragraph with no idea of its own stays with the one before it');
  assert.strictEqual(sections[1].text, 'Separately, I keep pushing the investor update back a week.');
  assert.deepStrictEqual(sections.map((s) => s.label), ['Pricing', 'Investor update']);
});

test('an idea can start inside a paragraph', () => {
  const sections = parseSectionResponse(ideasReply(['Tester said she would pay', 'Pricing'], ['She got lost on the empty home screen', 'Onboarding'], ['Nobody knew what to do first', 'First step']), IDEAS_DRAFT);
  assert.deepStrictEqual(sections.map((s) => s.text.slice(0, 12)), ['Tester said ', 'She got lost', 'Nobody knew ']);
});

test('the first idea also takes any text before its opening words', () => {
  const sections = parseSectionResponse(ideasReply(['She got lost on the empty home screen', 'Onboarding']), IDEAS_DRAFT);
  assert.strictEqual(sections.length, 1);
  assert.strictEqual(sections[0].text, IDEAS_DRAFT);
});

test('opening words that are not in the draft, or are out of order, fold into the idea before', () => {
  const sections = parseSectionResponse(ideasReply(
    ['Separately, I keep pushing the investor update', 'Investor'],
    ['Tester said she would pay', 'Pricing'],
    ['words that never appear anywhere at all', 'Made up'],
  ), IDEAS_DRAFT);
  assert.strictEqual(sections.length, 1);
  assert.strictEqual(sections[0].text, IDEAS_DRAFT);
});

test('an unusable idea split is reported as null', () => {
  assert.strictEqual(parseSectionResponse('not json', IDEAS_DRAFT), null);
  assert.strictEqual(parseSectionResponse('{"ideas": []}', IDEAS_DRAFT), null);
  assert.strictEqual(parseSectionResponse(ideasReply(['nothing like the note at all', 'x']), IDEAS_DRAFT), null);
});

test('a short single paragraph is one idea without a model call', async () => {
  let calls = 0;
  const sections = await findDraftSections({ draft: 'One short thought about pricing.', generate: async () => { calls++; return ''; } });
  assert.strictEqual(calls, 0);
  assert.deepStrictEqual(sections.map((s) => s.text), ['One short thought about pricing.']);
});

test('a failed or unusable idea split falls back to paragraphs, never losing text', async () => {
  const failed = await findDraftSections({ draft: IDEAS_DRAFT, generate: async () => { throw new Error('down'); } });
  assert.strictEqual(failed.length, 3);
  const garbled = await findDraftSections({ draft: IDEAS_DRAFT, generate: async () => 'nope' });
  assert.strictEqual(garbled.length, 3);
});

test('agents see the whole draft with each idea numbered, and only when there are several', () => {
  const prompt = buildPrompt(IDEAS_DRAFT, [note('a')], null, splitIntoParagraphs(IDEAS_DRAFT));
  assert.ok(prompt.includes('<idea id="1">\nTester said'));
  assert.ok(prompt.includes('<idea id="3">\nSeparately'));
  assert.ok(!buildPrompt(IDEAS_DRAFT, [note('a')], null, wholeDraftSection(IDEAS_DRAFT)).includes('<idea id='));
});

test('ideas do not disturb the shared prompt prefix that caching relies on', () => {
  const prefix = (text) => text.slice(0, text.indexOf('<draft>'));
  assert.strictEqual(prefix(buildPrompt(IDEAS_DRAFT, [note('a')], null, splitIntoParagraphs(IDEAS_DRAFT))), prefix(buildPrompt('d', [note('a')])));
});

test('each match is tagged with its idea, and an unknown idea means the whole draft', () => {
  const ids3 = ['1', '2', '3'];
  assert.strictEqual(parseAgentResponse(row({ idea: 2 }), allowed, ids3)[0].section_id, '2');
  assert.strictEqual(parseAgentResponse(row({ idea: '3' }), allowed, ids3)[0].section_id, '3');
  assert.strictEqual(parseAgentResponse(row({ idea: 'whole' }), allowed, ids3)[0].section_id, 'whole');
  assert.strictEqual(parseAgentResponse(row({ idea: 9 }), allowed, ids3)[0].section_id, 'whole');
  assert.strictEqual(parseAgentResponse(row({ idea: 'whole' }), allowed, ['1'])[0].section_id, '1', 'with one section, every match is about it');
});

const inSection = (id, score, section, relation = 'extends') => ({ ...res(id, score), relation_type: relation, section_id: section });

test('each idea keeps its own best three, so the main idea cannot crowd out the rest', () => {
  const big = Array.from({ length: 6 }, (_, i) => inSection(`big-${i}`, 0.95 - i / 100, '1'));
  const small = [inSection('small-0', 0.66, '2'), inSection('small-1', 0.65, '2')];
  const { results } = mergeAgentResults([{ chunkSize: 8, results: [...big, ...small] }], new Map(), 3);
  assert.deepStrictEqual(results.map((r) => r.note_id), ['big-0', 'big-1', 'big-2', 'small-0', 'small-1']);
});

test('there is no cap for the note as a whole', () => {
  const many = Array.from({ length: 7 }, (_, s) => [0, 1, 2].map((i) => inSection(`s${s}-${i}`, 0.9 - i / 100, String(s + 1)))).flat();
  assert.strictEqual(mergeAgentResults([{ chunkSize: 21, results: many }], new Map(), 3).results.length, 21);
});

const TWO_IDEAS = 'Tester said she would pay $20/month for this.\n\nI keep pushing the investor update back a week.';
const TWO_SECTIONS = splitIntoParagraphs(TWO_IDEAS);

test('an insight belongs to the idea its passage is in', () => {
  const raw = JSON.stringify({ intent: 'capturing', insights: [
    card({ anchor: 'pushing the investor update back', text: 'Like when {1}.', quotes: [quote('Sam got lost on the empty home screen', 'n2')] }),
    card(),
  ] });
  const { insights } = parseInsightResponse(raw, { draft: TWO_IDEAS, allowedNoteIds: insightIds, askForGoal: false, sections: TWO_SECTIONS, noteTextById: PAST });
  assert.deepStrictEqual(insights.map((i) => i.section_id), ['2', '1']);
});

test('an insight without a passage goes where its notes point', () => {
  const raw = JSON.stringify({ intent: 'capturing', insights: [card({ anchor: 'not in the draft at all', note_ids: ['n2'] })] });
  const out = parseInsightResponse(raw, {
    draft: TWO_IDEAS, allowedNoteIds: insightIds, askForGoal: false, sections: TWO_SECTIONS, sectionOfNote: new Map([['n2', '2']]), noteTextById: PAST,
  });
  assert.strictEqual(out.insights[0].section_id, '2');
});

test('a draft with several ideas may get one insight per idea, plus one for the whole', () => {
  assert.strictEqual(maxInsightsFor(splitIntoParagraphs(IDEAS_DRAFT)), 4);
  assert.strictEqual(maxInsightsFor(wholeDraftSection(IDEAS_DRAFT)), 3);
  const prompt = buildInsightPrompt({
    draft: IDEAS_DRAFT, context: { domain: null, goal: 'g' }, recentNotes: [],
    matches: [{ note: note('a'), result: { ...hit('a', 0.9), section_id: '2' } }], sections: splitIntoParagraphs(IDEAS_DRAFT),
  });
  assert.ok(prompt.includes('at most one insight per idea'));
  assert.ok(prompt.includes('Idea: 2'));
});

test('the search splits the draft once and reads every note once, whatever the number of ideas', async () => {
  let agentCalls = 0;
  let splitCalls = 0;
  const outcome = await searchRelevance({
    ...streamOptions(),
    draft: IDEAS_DRAFT,
    generate: (prompt) => { agentCalls++; return matchEveryNote(prompt); },
    findSections: async (draft) => { splitCalls++; return splitIntoParagraphs(draft); },
  });
  assert.strictEqual(splitCalls, 1);
  assert.strictEqual(agentCalls, 3, 'one call per agent, not one per idea');
  assert.strictEqual(outcome.sections.length, 3);
  assert.strictEqual(outcome.notesSearched, 6);
});

test('the insight step is given the sections the search used', async () => {
  let seen = null;
  await searchRelevance({
    ...streamOptions(),
    draft: IDEAS_DRAFT,
    findSections: async (draft) => splitIntoParagraphs(draft),
    findInsight: async (_results, sections) => { seen = sections; return { insights: [], goal_suggestions: [], intent: null, failed: false }; },
  });
  assert.strictEqual(seen.length, 3);
});

test('a throwing idea split still searches, by paragraph', async () => {
  const outcome = await searchRelevance({ ...streamOptions(), draft: IDEAS_DRAFT, findSections: async () => { throw new Error('down'); } });
  assert.strictEqual(outcome.sections.length, 3);
  assert.ok(outcome.results.length > 0);
});

test('a search cancelled during the idea split never starts its agents', async () => {
  const cancel = new AbortController();
  let agentCalls = 0;
  await assert.rejects(searchRelevance({
    ...streamOptions(),
    signal: cancel.signal,
    findSections: async (draft) => { cancel.abort(); return splitIntoParagraphs(draft); },
    generate: async (prompt) => { agentCalls++; return matchEveryNote(prompt); },
  }), { name: 'SearchCancelledError' });
  assert.strictEqual(agentCalls, 0);
});

test('a search cancelled while its agents run makes no insight call and no retries', async () => {
  const cancel = new AbortController();
  let agentCalls = 0;
  let insightCalls = 0;
  await assert.rejects(searchRelevance({
    ...streamOptions(),
    signal: cancel.signal,
    isRetryable: () => true,
    generate: async () => { agentCalls++; cancel.abort(); throw new Error('dropped'); },
    findInsight: async () => { insightCalls++; return { insights: [], goal_suggestions: [], intent: null, failed: false }; },
  }), { name: 'SearchCancelledError' });
  assert.strictEqual(agentCalls, 1, 'no retry, and no agent starts once the search is cancelled');
  assert.strictEqual(insightCalls, 0);
});

test('the model calls are given the search\'s signal, so a running call can be dropped', async () => {
  const cancel = new AbortController();
  const seen = [];
  await searchRelevance({ ...streamOptions(), signal: cancel.signal, generate: (prompt, signal) => { seen.push(signal); return matchEveryNote(prompt); } });
  assert.ok(seen.length > 0 && seen.every((signal) => signal === cancel.signal));
});

test('cancelling the stream stops the search before its insight call, quietly', async () => {
  let insightCalls = 0;
  let cancelledAt = null;
  let errors = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const stream = streamRelevanceSearch(streamOptions({
    generate: async (prompt) => { await gate; return matchEveryNote(prompt); },
    findInsight: async () => { insightCalls++; return { insights: [], goal_suggestions: [], intent: null, failed: false }; },
    onCancelled: (stage) => { cancelledAt = stage; },
    onError: () => { errors++; },
  }));
  const reader = stream.getReader();
  await reader.read(); // the "start" event
  await reader.cancel();
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.strictEqual(insightCalls, 0);
  assert.ok(cancelledAt, 'the route is told the search stopped early');
  assert.strictEqual(errors, 0, 'a cancelled search is not reported as a failure');
});

test('a signal that has already fired cancels the search before anything runs', async () => {
  const cancel = new AbortController();
  cancel.abort();
  let calls = 0;
  await assert.rejects(searchRelevance({ ...streamOptions(), signal: cancel.signal, generate: async () => { calls++; return '[]'; } }), { name: 'SearchCancelledError' });
  assert.strictEqual(calls, 0);
});

test('the done event carries the sections', async () => {
  const events = await readEvents(streamRelevanceSearch(streamOptions({ draft: IDEAS_DRAFT, findSections: async (draft) => splitIntoParagraphs(draft) })));
  const done = events.at(-1);
  assert.strictEqual(done.type, 'done');
  assert.deepStrictEqual(done.sections.map((s) => s.id), ['1', '2', '3']);
});

// ------------------------------------------------------------- funnel

test('a match under its bar is reported for measuring, never kept', () => {
  const below = [];
  const out = parseAgentResponse(row({ relation_type: 'parallel', level: 3 }), allowed, [], below);
  assert.strictEqual(out.length, 0);
  assert.deepStrictEqual(below, [{ note_id: 'keep-1', relation_type: 'parallel', level: 3 }]);
});

test('merging reports what the per-idea cap cut', () => {
  const { results, cutByCap } = mergeAgentResults(
    [{ chunkSize: 4, results: [res('a', 0.9), res('b', 0.8), res('c', 0.75), res('d', 0.62)] }],
    new Map(),
    3
  );
  assert.strictEqual(results.length, 3);
  assert.deepStrictEqual(cutByCap.map((r) => r.note_id), ['d']);
});

test('the funnel counts each step, scores but no text', () => {
  const funnel = searchFunnel(
    [
      { chunkSize: 5, results: [res('a', 1), res('b', 0.6)], belowBar: [{ note_id: 'x', relation_type: 'parallel', level: 3 }] },
      { chunkSize: 5, results: null },
    ],
    [res('a', 1), res('b', 0.6)],
    [res('c', 0.6)],
    { insights: [{}], goal_suggestions: [], intent: null, failed: false }
  );
  assert.deepStrictEqual(funnel, {
    returned: 3, below_bar: { parallel: [3] }, passed_bar: 2, cut_by_cap: [3], kept: 2, cards: 1,
  });
});

test('a finished search reports its funnel', async () => {
  let funnel = null;
  await searchRelevance({ ...streamOptions(), onFunnel: (value) => { funnel = value; } });
  assert.strictEqual(funnel.returned, 6);
  assert.strictEqual(funnel.kept, 6);
  assert.strictEqual(funnel.cards, null, 'no insight step was given');
});

run();
