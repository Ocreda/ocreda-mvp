import { NextResponse } from 'next/server';
import {
  findDraftSections,
  findInsight,
  readGoalContext,
  searchRelevance,
  searchResponseFields,
  streamRelevanceSearch,
  DEFAULT_AGENT_CONCURRENCY,
  DEFAULT_AGENT_COUNT,
  MAX_RESULTS_PER_SECTION,
  MIN_DRAFT_CHARS,
  type DraftSection,
  type NoteLike,
  type RelevanceResult,
} from '@/supabase/functions/_shared/relevance';
import { generateWithGemini, isRetryableGeminiError, modelForTier, readModelTier } from '@/supabase/functions/_shared/gemini';

/**
 * Development-only stand-in for the find-relevant-notes Edge Function, so the
 * UI can be exercised without Supabase. It runs the identical fan-out from
 * _shared/relevance.ts; the only difference is that the notes arrive in the
 * request body rather than being read from the database, because in local mode
 * they live in the browser.
 *
 * This route has no authentication, so it refuses to run unless local mode is
 * explicitly enabled — otherwise a deployment would expose an open endpoint
 * that spends your Gemini quota.
 */


const MAX_NOTES = 1000;

const INSIGHT_SYSTEM_PROMPT =
  'You help a person act on their own past notes. You respond with a JSON object and nothing else.';
const SECTION_SYSTEM_PROMPT =
  "You divide a person's note into the separate ideas it contains. You respond with a JSON object and nothing else.";

const AGENT_SYSTEM_PROMPT =
  "You identify meaningful relationships between a person's notes. You respond with a JSON array and nothing else.";

/** Enough of the key to tell which one the server loaded, without printing it. */
function maskKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 12)}...${key.slice(-4)}` : '(too short to be a real key)';
}

/**
 * Wraps a model call so a failure prints its real reason (a 401 for a dead
 * key, a 402 for no credits, a 429 for rate limiting) before the shared code
 * turns it into a generic "every agent failed".
 */
function withFailureLog(label: string, call: (prompt: string) => Promise<string>) {
  return async (prompt: string) => {
    try {
      return await call(prompt);
    } catch (error) {
      console.error(`[local] ${label} failed:`, error instanceof Error ? error.message : error);
      throw error;
    }
  };
}

function isNoteLike(value: unknown): value is NoteLike {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && typeof row.raw_text === 'string';
}

export async function POST(request: Request) {
  if (process.env.NEXT_PUBLIC_LOCAL_MODE !== '1') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'Set OPENROUTER_API_KEY in .env.local, then restart the dev server.' },
      { status: 500 }
    );
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const draftText = typeof body?.draft_text === 'string' ? body.draft_text.trim() : '';
  if (draftText.length < MIN_DRAFT_CHARS) {
    return NextResponse.json({ error: 'Write a little more before searching for related notes.' }, { status: 400 });
  }

  const notes = (body && Array.isArray(body.notes) ? body.notes : [])
    .filter(isNoteLike)
    .slice(0, MAX_NOTES)
    .map((note) => ({
      id: note.id,
      raw_text: note.raw_text,
      summary: note.summary ?? null,
      created_at: note.created_at ?? new Date().toISOString(),
      category: typeof note.category === 'string' ? note.category : null,
    }));
  const goalContext = readGoalContext(body?.domain);
  const tier = readModelTier(body?.model_tier);
  const model = modelForTier(tier);
  const excludeNoteId = typeof body?.exclude_note_id === 'string' ? body.exclude_note_id : null;

  if (notes.length === 0) {
    return NextResponse.json({
      results: [],
      coverage: { notes_searched: 0, notes_total: 0, complete: true },
    });
  }

  // Next.js prefers a variable already set in the shell over .env.local, so a
  // stale key can hide here. Printing its ends shows which one is in use.
  console.log(`[local] find-relevant-notes: ${notes.length} notes, ${tier} mode (${model}), OpenRouter key ${maskKey(apiKey)}`);

  const draft = draftText;
  const insightFor = (results: RelevanceResult[], sections: DraftSection[]) =>
    findInsight({
      draft,
      context: goalContext,
      notes,
      results,
      sections,
      excludeNoteId,
      generate: withFailureLog('insight call', (prompt) =>
        generateWithGemini(INSIGHT_SYSTEM_PROMPT, [{ role: 'user', content: prompt }], apiKey, model, {
          responseMimeType: 'application/json',
          temperature: 0.2,
          maxOutputTokens: 8000,
        })),
    });
  const findSections = (text: string) =>
    findDraftSections({
      draft: text,
      generate: withFailureLog('idea split', (prompt) =>
        generateWithGemini(SECTION_SYSTEM_PROMPT, [{ role: 'user', content: prompt }], apiKey, model, {
          responseMimeType: 'application/json',
          temperature: 0.2,
          maxOutputTokens: 3000,
        })),
      onError: (error) => console.error('[local] idea split unusable, searching by paragraph:', error instanceof Error ? error.message : error),
    });
  const searchOptions = {
    maxPerSection: MAX_RESULTS_PER_SECTION,
    findSections,
    findInsight: insightFor,
    draft,
    notes,
    goal: goalContext.goal,
    agentCount: DEFAULT_AGENT_COUNT,
    concurrency: DEFAULT_AGENT_CONCURRENCY,
    isRetryable: isRetryableGeminiError,
    generate: withFailureLog('agent call', (prompt: string) =>
      generateWithGemini(AGENT_SYSTEM_PROMPT, [{ role: 'user', content: prompt }], apiKey, model, {
        responseMimeType: 'application/json',
        temperature: 0.2,
      })),
  };

  if (body?.stream === true) {
    const stream = streamRelevanceSearch({
      ...searchOptions,
      allFailedMessage: 'Every agent failed — check your OPENROUTER_API_KEY and the terminal output.',
      failedMessage: 'Relevance search failed. Check the terminal output.',
      onError: (error) =>
        console.error('[local] find-relevant-notes stream failed:', error instanceof Error ? error.message : error),
    });
    return new Response(stream, {
      headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' },
    });
  }

  try {
    const outcome = await searchRelevance({
      ...searchOptions,
      onError: (error) => console.error('[local] follow-up failed:', error instanceof Error ? error.message : error),
    });

    if (outcome.notesSearched === 0) {
      return NextResponse.json(
        { error: 'Every agent failed — check your OPENROUTER_API_KEY and the terminal output.' },
        { status: 502 }
      );
    }
    return NextResponse.json(searchResponseFields(outcome));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[local] find-relevant-notes failed:', message);
    return NextResponse.json({ error: `Relevance search failed: ${message}` }, { status: 500 });
  }
}
