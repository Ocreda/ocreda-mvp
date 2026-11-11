import { readFileSync } from 'fs';
import path from 'path';
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
  type SearchFunnel,
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
  "You identify meaningful relationships between a person's notes. You respond with a JSON object and nothing else.";

/** Enough of the key to tell which one the server loaded, without printing it. */
function maskKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 12)}...${key.slice(-4)}` : '(too short to be a real key)';
}

/**
 * The key written in .env.local, read from the file itself. Next.js never lets
 * .env.local override a variable the terminal already has, so a key set in the
 * terminal for another project would otherwise win here silently and fail.
 */
function envLocalKey(): string | null {
  try {
    const text = readFileSync(path.join(process.cwd(), '.env.local'), 'utf8');
    const value = text.match(/^[ \t]*OPENROUTER_API_KEY[ \t]*=(.*)$/m)?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    return value || null;
  } catch {
    return null;
  }
}

let warnedAboutTerminalKey = false;

/** The .env.local key when there is one, and otherwise whatever the terminal has. */
function openRouterKey(): string | null {
  const fileKey = envLocalKey();
  const terminalKey = process.env.OPENROUTER_API_KEY?.trim() || null;
  if (fileKey && terminalKey && fileKey !== terminalKey && !warnedAboutTerminalKey) {
    warnedAboutTerminalKey = true;
    console.warn(`[local] This terminal has its own OPENROUTER_API_KEY (${maskKey(terminalKey)}), different from .env.local (${maskKey(fileKey)}). Using .env.local. To clear the terminal's: Remove-Item Env:OPENROUTER_API_KEY`);
  }
  return fileKey ?? terminalKey;
}

/**
 * Wraps a model call so a failure prints its real reason (a 401 for a dead
 * key, a 402 for no credits, a 429 for rate limiting) before the shared code
 * turns it into a generic "every agent failed".
 */
function withFailureLog(label: string, call: (prompt: string, signal?: AbortSignal) => Promise<string>) {
  return async (prompt: string, signal?: AbortSignal) => {
    try {
      return await call(prompt, signal);
    } catch (error) {
      // A call dropped because the person left the note is not a failure.
      if (!signal?.aborted) console.error(`[local] ${label} failed:`, error instanceof Error ? error.message : error);
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

  const apiKey = openRouterKey();
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

  // Printing the key's ends shows which one is in use, should a search fail.
  console.log(`[local] find-relevant-notes: ${notes.length} notes, ${tier} mode (${model}), OpenRouter key ${maskKey(apiKey)}`);

  const draft = draftText;
  const insightFor = (results: RelevanceResult[], sections: DraftSection[], signal?: AbortSignal) =>
    findInsight({
      draft,
      context: goalContext,
      notes,
      results,
      sections,
      excludeNoteId,
      generate: (prompt) => withFailureLog('insight call', (text, callSignal) =>
        generateWithGemini(INSIGHT_SYSTEM_PROMPT, [{ role: 'user', content: text }], apiKey, model, {
          responseMimeType: 'application/json',
          temperature: 0.2,
          maxOutputTokens: 8000,
        }, callSignal))(prompt, signal),
    });
  const findSections = (text: string, signal?: AbortSignal) =>
    findDraftSections({
      draft: text,
      generate: (prompt) => withFailureLog('idea split', (splitPrompt, callSignal) =>
        generateWithGemini(SECTION_SYSTEM_PROMPT, [{ role: 'user', content: splitPrompt }], apiKey, model, {
          responseMimeType: 'application/json',
          temperature: 0.2,
          maxOutputTokens: 3000,
        }, callSignal))(prompt, signal),
      onError: (error) => { if (!signal?.aborted) console.error('[local] idea split unusable, searching by paragraph:', error instanceof Error ? error.message : error); },
    });
  const searchOptions = {
    onFunnel: (funnel: SearchFunnel) => console.log('[local] find-relevant-notes funnel', JSON.stringify({ tier, notes: notes.length, ...funnel })),
    findSections,
    findInsight: insightFor,
    draft,
    notes,
    goal: goalContext.goal,
    agentCount: DEFAULT_AGENT_COUNT,
    concurrency: DEFAULT_AGENT_CONCURRENCY,
    isRetryable: isRetryableGeminiError,
    generate: withFailureLog('agent call', (prompt: string, signal?: AbortSignal) =>
      generateWithGemini(AGENT_SYSTEM_PROMPT, [{ role: 'user', content: prompt }], apiKey, model, {
        responseMimeType: 'application/json',
        temperature: 0.2,
      }, signal)),
  };

  if (body?.stream === true) {
    const stream = streamRelevanceSearch({
      ...searchOptions,
      signal: request.signal,
      onCancelled: (stage) => console.log(`[local] search cancelled ${stage}: the note was left, so no more calls were made`),
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
      signal: request.signal,
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
