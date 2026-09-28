import { InsightIntent, NoteInsight, RelevanceCoverage, RelevanceProgress, RelevanceResult, RelevantNotesResponse } from '@/lib/types';

const INTENTS: InsightIntent[] = ['stuck', 'planning', 'deciding', 'capturing', 'reflecting', 'learning'];

/** Undefined when the server sent no insight field at all, null when it sent an explicit "nothing". */
function readInsight(value: unknown, resultIds: Set<string>): NoteInsight | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const text = typeof row.text === 'string' ? row.text.trim() : '';
  const action = typeof row.action === 'string' ? row.action.trim() : '';
  const noteIds = Array.isArray(row.note_ids) ? row.note_ids.filter((id): id is string => typeof id === 'string' && resultIds.has(id)) : [];
  if (!text || !action || !noteIds.length) return null;
  return {
    anchor: typeof row.anchor === 'string' ? row.anchor : '',
    intent: INTENTS.includes(row.intent as InsightIntent) ? (row.intent as InsightIntent) : 'reflecting',
    text,
    action,
    note_ids: noteIds,
  };
}

function toRelevantNotesResponse(payload: Record<string, unknown> | null): RelevantNotesResponse {
  const results = payload && Array.isArray(payload.results) ? (payload.results as RelevanceResult[]) : [];
  const rawCoverage = payload?.coverage as Partial<RelevanceCoverage> | undefined;
  const resultIds = new Set(results.map((result) => result.note_id));
  // Servers from before there could be several send one "insight" instead.
  const rawInsights = !payload ? undefined
    : Array.isArray(payload.insights) ? payload.insights
      : 'insight' in payload ? [payload.insight] : undefined;
  const insights = rawInsights
    ?.map((item) => readInsight(item, resultIds))
    .filter((item): item is NoteInsight => Boolean(item));
  const rawSuggestions = payload?.goal_suggestions;
  const goalSuggestions = Array.isArray(rawSuggestions)
    ? rawSuggestions.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
    : [];
  return {
    results,
    summary: typeof payload?.summary === 'string' ? payload.summary.trim() : undefined,
    ...(insights ? { insights } : {}),
    ...(goalSuggestions.length ? { goal_suggestions: goalSuggestions } : {}),
    ...(INTENTS.includes(payload?.note_intent as InsightIntent) ? { note_intent: payload?.note_intent as InsightIntent } : {}),
    ...(payload?.insight_failed === true ? { insight_failed: true } : {}),
    coverage: {
      notes_searched: Number(rawCoverage?.notes_searched ?? 0),
      notes_total: Number(rawCoverage?.notes_total ?? 0),
      complete: rawCoverage?.complete !== false,
    },
  };
}

/**
 * Reads a successful find-relevant-notes response. The client always asks for a
 * progress stream, but a server that predates streaming, or one with nothing to
 * search, answers with plain JSON, so both shapes are accepted here.
 */
export async function readRelevanceResponse(
  response: Response,
  fallbackError: string,
  onProgress?: (progress: RelevanceProgress) => void
): Promise<RelevantNotesResponse> {
  const contentType = response.headers.get('Content-Type') ?? '';
  if (!contentType.includes('application/x-ndjson') || !response.body) {
    return toRelevantNotesResponse((await response.json().catch(() => null)) as Record<string, unknown> | null);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let notesTotal = 0;

  // Returns the final response on "done", throws on "error", and otherwise
  // just forwards progress.
  const handleLine = (line: string): RelevantNotesResponse | null => {
    if (!line.trim()) return null;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }

    if (event.type === 'start') {
      notesTotal = Number(event.notes_total ?? 0);
      onProgress?.({ agents_done: 0, agents_total: Number(event.agents_total ?? 0), matches: 0, notes_total: notesTotal });
    } else if (event.type === 'progress') {
      onProgress?.({
        agents_done: Number(event.agents_done ?? 0),
        agents_total: Number(event.agents_total ?? 0),
        matches: Number(event.matches ?? 0),
        notes_total: notesTotal,
      });
    } else if (event.type === 'error') {
      throw new Error(typeof event.error === 'string' ? event.error : fallbackError);
    } else if (event.type === 'done') {
      return toRelevantNotesResponse(event);
    }
    return null;
  };

  // The server closes the stream straight after "done", so it is read to the
  // end rather than cancelled — cancelling logs every search as an aborted
  // request in the browser's network panel.
  let finished: RelevantNotesResponse | null = null;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      // The connection dropped. Keep a verdict that already arrived.
      if (finished) return finished;
      throw new Error(fallbackError);
    }

    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      finished = finished ?? handleLine(line);
    }

    if (chunk.done) {
      finished = finished ?? handleLine(buffer);
      if (finished) return finished;
      // The stream closed without a verdict, so treat it as a failed search.
      throw new Error(fallbackError);
    }
  }
}
