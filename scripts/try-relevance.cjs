#!/usr/bin/env node
/*
 * Runs the find-relevant-notes fan-out locally against a set of notes, using
 * the same chunking, prompt, parsing, and merging code the deployed Edge
 * Function uses. Needs only a Gemini API key — no Supabase, no auth, no deploy.
 *
 *   OPENROUTER_API_KEY=...  npm run try:relevance
 *
 * With no arguments it runs the handpicked eval in notes/: the draft from
 * notes/test-notes/entry.txt against all 100 notes in notes/all-notes.json,
 * then scores the model's picks against yours from test-notes.json.
 *
 * Overrides:
 *   --notes <file>     JSON array of strings, or text with "---" between notes
 *   --draft <file|text>
 *   --expected <file>  ground truth: {notes:[{id,title,explanation}]}
 *   --goal <text>      what the person is working toward, as a Domain description
 *                      would supply it; compare runs with and without it
 *   --basic            use the cheaper "Basic" model instead of "Best"
 */

const fs = require('fs');
const path = require('path');
const {
  findDraftSections, findInsight, mergeAgentResults, runRelevanceAgents,
  DEFAULT_AGENT_COUNT: AGENT_COUNT,
  DEFAULT_AGENT_CONCURRENCY: AGENT_CONCURRENCY,
} = require('../.relevance-build/relevance.js');
const { generateWithGemini, isRetryableGeminiError, modelForTier } = require('../.relevance-build/gemini.js');

// Per idea. Kept high so the eval sees everything that cleared its bar.
const MAX_RESULTS = 50;
const INSIGHT_SYSTEM_PROMPT =
  'You help a person act on their own past notes. You respond with a JSON object and nothing else.';
const SECTION_SYSTEM_PROMPT =
  "You divide a person's note into the separate ideas it contains. You respond with a JSON object and nothing else.";
const AGENT_SYSTEM_PROMPT =
  "You identify meaningful relationships between a person's notes. You respond with a JSON array and nothing else.";

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CORPUS = path.join(ROOT, 'notes/all-notes.json');
const DEFAULT_DRAFT = path.join(ROOT, 'notes/test-notes/entry.txt');
const DEFAULT_TRUTH = path.join(ROOT, 'notes/test-notes/test-notes.json');

const RELATION_SHORT = { supports: 'supports ', extends: 'adds to  ', contradicts: 'contra.  ', question: 'question ', parallel: 'parallel ', helps: 'helps    ', solves: 'solves   ' };

/*
 * The original synthetic corpus, kept available behind --sample. Unlike the
 * real notes it contains deliberate contradictions, so it is the only fixture
 * that exercises the contradicts/question relation types. `expect` is used
 * only for scoring afterwards; it never reaches the model.
 */
const SAMPLE_DRAFT = `Rethinking how we charge

Per-seat pricing is quietly capping our own growth. Every new teammate a customer adds costs them more, so the people who'd get the most value out of the product are the ones most discouraged from spreading it. I think we should move to usage-based pricing before renewals in Q3.`;

const SAMPLE_NOTES = [
  { expect: 'supports', text: 'Call with Maya at Northwind. She admitted she stopped inviting teammates because every seat was another $12/mo. Her words: the tool got punished for being useful.' },
  { expect: 'supports', text: 'Pulled our expansion numbers. Accounts that reach three or more seats in month one churn about 40% less. Only 11% of accounts ever get there.' },
  { expect: 'contradicts', text: 'Decision from the March offsite: per-seat pricing stays as is. It is predictable, finance can forecast it, and revisiting is a distraction. Do not reopen this before next year.' },
  { expect: 'contradicts', text: 'Dev warned me that usage-based billing wrecked forecasting at his last company. Investors hated the revenue volatility and it came up in every board meeting.' },
  { expect: 'extends', text: 'Linear moved off pure per-seat last year. Their write-up claims net revenue retention climbed 18 points in the two quarters after.' },
  { expect: 'question', text: 'Still unresolved: how does variable billing survive enterprise procurement? Every RFP we have seen demands one fixed annual number up front.' },
  { expect: 'question', text: 'If we charge per action, what stops someone batching a whole month of work into one enormous call to game the meter?' },
  { expect: null, text: 'Squat form cue that finally worked: think about spreading the floor apart with your feet rather than pushing down into it.' },
  { expect: null, text: 'From the Ursula Le Guin essay: the trouble with utopia is that it is always someone else describing where you should want to live.' },
  { expect: null, text: 'Standup notes. Deploy is blocked on the migration review. Priya is out Thursday. Nobody has claimed the flaky integration test yet.' },
  { expect: null, text: 'Bread: 500g flour, 375g water, 10g salt, 100g starter. Autolyse an hour before adding salt. Cold proof overnight, bake at 250C with steam.' },
  { expect: null, text: 'The onboarding illustration set feels off. Too many gradients competing with the product screenshots behind them.' },
  { expect: null, text: 'Booked the Lisbon flights for April. Need to sort out the apartment before the end of the month or prices jump.' },
  { expect: null, text: 'Interview debrief: strong systems thinking, walked through the sharding tradeoff unprompted. Weak on the frontend exercise but that is coachable.' },
  { expect: null, text: 'Idea for the blog: nobody writes honestly about how boring most of the work is. The interesting part is maybe two hours a week.' },
  { expect: null, text: 'My laptop fan spins up whenever the design tool is open in a background tab. Probably worth just quitting it.' },
  { expect: null, text: 'Reminder: the dentist moved the appointment to the 14th at 8:30am. Do not schedule anything before ten that day.' },
  { expect: null, text: 'Reading note on attention: the claim is not that focus is scarce, but that the value of uninterrupted time compounds and we price it as if it were linear.' },
  { expect: null, text: 'The support inbox is drowning in password reset requests. Half of them are people who signed up with Google and forgot.' },
  { expect: null, text: 'Overheard on the train: someone explaining to their kid why the moon follows the car. Best answer was that it is very far away and very patient.' },
  { expect: null, text: 'Try switching the landing page headline to something concrete. The current one could describe any company in the category.' },
  { expect: null, text: 'Garden: the tomatoes went in too early last year and got hit by the late frost. Wait until after the first week of May.' },
  { expect: null, text: 'Note on hiring: every time we have compromised on the written communication bar it has cost us more time than the open role did.' },
  { expect: null, text: 'The CI runner is out of disk again. Someone should put a cleanup step in the nightly job instead of clearing it by hand each week.' },
  { expect: null, text: 'Book idea I will never write: a history of software told entirely through the changelogs of abandoned projects.' },
  { expect: null, text: 'Coffee place on Wilson closes at 2pm on weekends now. The one further down stays open but the espresso is much worse.' },
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--notes') args.notes = argv[++i];
    else if (argv[i] === '--draft') args.draft = argv[++i];
    else if (argv[i] === '--expected') args.expected = argv[++i];
    else if (argv[i] === '--sample') args.sample = true;
    else if (argv[i] === '--goal') args.goal = argv[++i];
    else if (argv[i] === '--basic') args.basic = true;
  }
  return args;
}

function readNotesFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('A JSON notes file must contain an array of strings.');
    return parsed.map(String);
  }
  return raw.split(/^---$/m).map((chunk) => chunk.trim()).filter(Boolean);
}

/** First line of a note, which these notes use as a title. */
function titleOf(text) {
  return (text.split('\n')[0] || '').trim().slice(0, 46);
}

function wrap(text, width, indent) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > width) { lines.push(line.trim()); line = word; }
    else line += ' ' + word;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.map((l) => indent + l).join('\n');
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('\nSet OPENROUTER_API_KEY first. Get a free one at https://openrouter.ai/keys\n');
    console.error('  PowerShell:  $env:OPENROUTER_API_KEY = "your-key"; npm run try:relevance');
    console.error('  bash:        OPENROUTER_API_KEY=your-key npm run try:relevance\n');
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));

  let texts;
  let corpusLabel;
  if (args.sample) {
    texts = SAMPLE_NOTES.map((note) => note.text);
    corpusLabel = 'built-in sample';
  } else {
    const corpusFile = args.notes ? path.resolve(args.notes) : DEFAULT_CORPUS;
    if (!fs.existsSync(corpusFile)) {
      console.error(`\nNo notes found at ${corpusFile}. Pass --notes <file>, or --sample for the built-in set.\n`);
      process.exit(1);
    }
    texts = readNotesFile(corpusFile);
    corpusLabel = path.relative(ROOT, corpusFile);
  }

  const draftText = args.draft
    ? (fs.existsSync(args.draft) ? fs.readFileSync(args.draft, 'utf8') : args.draft)
    : args.sample ? SAMPLE_DRAFT : fs.readFileSync(DEFAULT_DRAFT, 'utf8');

  // Ids mirror the corpus filenames: all-notes.json[0] is 001-*.txt.
  const notes = texts.map((text, index) => ({
    id: String(index + 1).padStart(3, '0'),
    raw_text: text,
    summary: null,
    created_at: new Date(Date.now() - index * 86400000).toISOString(),
  }));
  const textById = new Map(notes.map((n) => [n.id, n.raw_text]));

  // Ground truth: which notes a human marked relevant, and why.
  const picks = new Map();
  let truthLabel = '';

  if (args.sample) {
    SAMPLE_NOTES.forEach((note, index) => {
      if (!note.expect) return;
      picks.set(String(index + 1).padStart(3, '0'), {
        order: picks.size + 1,
        title: titleOf(note.text),
        why: `labelled "${note.expect}"`,
      });
    });
    truthLabel = 'built-in labels';
  } else {
    const truthFile = args.expected ? path.resolve(args.expected) : DEFAULT_TRUTH;
    if (fs.existsSync(truthFile)) {
      const truth = JSON.parse(fs.readFileSync(truthFile, 'utf8'));
      for (const note of truth.notes ?? []) {
        picks.set(note.id, { order: note.order, title: note.title, why: note.explanation ?? '' });
        const corpusTitle = titleOf(textById.get(note.id) ?? '');
        if (note.title && corpusTitle && !corpusTitle.toLowerCase().startsWith(note.title.toLowerCase().slice(0, 12))) {
          console.warn(`  ! id ${note.id} is "${corpusTitle}" in the corpus but "${note.title}" in the picks`);
        }
      }
      truthLabel = path.relative(ROOT, truthFile);
    }
  }

  console.log(`\nDraft:\n${wrap(draftText.trim(), 74, '  ')}`);
  console.log(`\nCorpus: ${corpusLabel} (${notes.length} notes)`);
  console.log(`Goal: ${args.goal || '(not stated)'}`);
  const model = modelForTier(args.basic ? 'basic' : 'best');
  console.log(`Model: ${model}`);
  if (picks.size) console.log(`Your picks: ${truthLabel} (${picks.size} notes)`);
  console.log(`\nSearching across ${AGENT_COUNT} agents, ${AGENT_CONCURRENCY} at a time...\n`);

  const started = Date.now();
  const draft = draftText.trim();
  const sections = await findDraftSections({
    draft,
    generate: (prompt) =>
      generateWithGemini(SECTION_SYSTEM_PROMPT, [{ role: 'user', content: prompt }], apiKey, model, {
        responseMimeType: 'application/json',
        temperature: 0.2,
        maxOutputTokens: 3000,
      }),
    onError: (error) => console.log(`  idea split unusable, using paragraphs: ${error.message}`),
  });
  console.log(`Ideas (${sections.length}):`);
  sections.forEach((section) => console.log(`  [${section.id}] ${section.label || '(paragraph)'}: ${section.text.slice(0, 60).replace(/\s+/g, ' ')}...`));
  console.log('');
  const { outcomes } = await runRelevanceAgents({
    draft,
    notes,
    sections,
    goal: args.goal || null,
    agentCount: AGENT_COUNT,
    concurrency: AGENT_CONCURRENCY,
    isRetryable: isRetryableGeminiError,
    generate: (prompt) =>
      generateWithGemini(AGENT_SYSTEM_PROMPT, [{ role: 'user', content: prompt }], apiKey, model, {
        responseMimeType: 'application/json',
        temperature: 0.2,
      }),
    onAgentSettled: (index, outcome) => {
      const label = outcome.results ? `${String(outcome.results.length).padStart(2)} hit(s)` : 'FAILED';
      console.log(`  agent ${String(index + 1).padStart(2)}  ${String(outcome.chunkSize).padStart(3)} notes  ->  ${label}`);
    },
  });

  const createdAtById = new Map(notes.map((n) => [n.id, n.created_at]));
  const { results, notesSearched } = mergeAgentResults(outcomes, createdAtById, MAX_RESULTS);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\nSearched ${notesSearched} of ${notes.length} notes in ${elapsed}s. ${results.length} scored relevant.`);
  if (notesSearched < notes.length) {
    console.log(`  WARNING: ${notes.length - notesSearched} notes went unread because an agent failed.`);
  }

  console.log('\n' + '='.repeat(78));
  console.log('RANKED RESULTS' + (picks.size ? '   [#n] = your pick order, [--] = not one of your picks' : ''));
  console.log('='.repeat(78));

  results.forEach((result, index) => {
    const pick = picks.get(result.note_id);
    const tag = picks.size ? (pick ? `[#${String(pick.order).padStart(2)}]` : '[ --]') : '';
    const pct = `${Math.round(result.relevance_score * 100)}%`;
    console.log(`\n${String(index + 1).padStart(2)}. ${tag} ${pct.padStart(4)}  ${RELATION_SHORT[result.relation_type]} ${result.direction === 'outbound' ? 'OUT' : 'in '} idea ${result.section_id.padEnd(5)} ${result.note_id} ${titleOf(textById.get(result.note_id))}`);
    if (result.gist) console.log(wrap(`Gist: ${result.gist}`, 72, '      '));
    console.log(wrap(`AI:  ${result.explanation}`, 72, '      '));
    if (pick && pick.why) console.log(wrap(`You: ${pick.why}`, 72, '      '));
  });

  const outcome = await findInsight({
    draft,
    context: { domain: 'Eval', goal: args.goal || null },
    notes,
    results,
    sections,
    excludeNoteId: null,
    generate: (prompt) =>
      generateWithGemini(INSIGHT_SYSTEM_PROMPT, [{ role: 'user', content: prompt }], apiKey, model, {
        responseMimeType: 'application/json',
        temperature: 0.2,
        maxOutputTokens: 8000,
      }),
  });

  console.log('\n' + '='.repeat(78));
  console.log('INSIGHT');
  console.log('='.repeat(78));
  outcome.insights.forEach((insight, index) => {
    console.log(`\n  #${index + 1}  intent ${insight.intent}, idea ${insight.section_id}`);
    console.log(wrap(`anchor:  ${insight.anchor ? `"${insight.anchor}"` : '(quote not found in draft - no highlight)'}`, 72, '  '));
    console.log(wrap(`insight: ${insight.text}`, 72, '  '));
    console.log(wrap(`action:  ${insight.action}`, 72, '  '));
    console.log(`  cites    ${insight.note_ids.map((id) => `${id} ${titleOf(textById.get(id))}`).join('; ')}`);
  });
  if (!outcome.insights.length) console.log('  (none - nothing in the notes would change the next step)');
  if (outcome.goal_suggestions.length) console.log(`  goal chips: ${outcome.goal_suggestions.join(' | ')}`);

  if (!picks.size) return;

  const returned = new Set(results.map((r) => r.note_id));
  const found = [...picks.keys()].filter((id) => returned.has(id));
  const missed = [...picks.keys()].filter((id) => !returned.has(id));
  const extra = results.filter((r) => !picks.has(r.note_id));
  const rankById = new Map(results.map((r, i) => [r.note_id, i + 1]));
  const topN = results.slice(0, picks.size).filter((r) => picks.has(r.note_id)).length;

  console.log('\n' + '='.repeat(78));
  console.log('MATCHUP');
  console.log('='.repeat(78));
  console.log(`  agreed     ${found.length}/${picks.size} of your picks were surfaced by the AI`);
  console.log(`  in top ${String(picks.size).padStart(2)}  ${topN}/${picks.size} of the AI's highest-ranked results were your picks`);
  console.log(`  missed     ${missed.length} you picked, the AI did not return`);
  console.log(`  extra      ${extra.length} the AI returned that you did not pick`);

  if (missed.length) {
    console.log('\n  MISSED — you picked these, the AI did not:');
    for (const id of missed) {
      console.log(`    ${id} ${titleOf(textById.get(id))}`);
      console.log(wrap(`your reason: ${picks.get(id).why}`, 66, '        '));
    }
  }
  if (extra.length) {
    console.log('\n  EXTRA — the AI surfaced these, you did not pick them:');
    for (const r of extra) {
      console.log(`    ${r.note_id} (rank ${rankById.get(r.note_id)}, ${Math.round(r.relevance_score * 100)}%) ${titleOf(textById.get(r.note_id))}`);
      console.log(wrap(r.explanation, 66, '        '));
    }
  }
  console.log('\n  Note: "extra" is disagreement, not error — the AI may have found');
  console.log('  something real that you passed over, or it may be reaching.\n');
}

main().catch((error) => {
  console.error(`\nFailed: ${error.message}\n`);
  process.exit(1);
});
