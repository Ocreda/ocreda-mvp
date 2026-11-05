import { supabase } from './supabase';
import { IS_LOCAL_MODE, LOCAL_USER_ID } from '@/dev/local-mode';  // DEV-LOCAL-MODE
import { CardChoice, CardDecision, IncomingCardDecision, NoteInsight, SuggestionKind } from './types';

/**
 * What the person chose on suggestion cards, kept beside their notes rather
 * than in them. Signed in, choices live in Supabase (note_card_decisions) and
 * follow them to every device. In local mode, or before that table exists,
 * they live in this browser.
 */

export type NoteCardDecisions = {
  /** Choices on this note's own cards, by card id. */
  own: Record<string, CardDecision>;
  /** Choices made on other notes' cards that mark this one, such as a later note's answer to a problem here. */
  incoming: IncomingCardDecision[];
};

type Row = {
  note_id: string;
  card_id: string;
  choice: string;
  kind: string;
  insight: unknown;
  text: string | null;
  target_note_id: string | null;
};

const CHOICES: CardChoice[] = ['solved', 'downgraded', 'helped', 'merged', 'today', 'earlier', 'both', 'confirmed', 'rejected'];
const KINDS: SuggestionKind[] = ['contradiction', 'solution', 'helps', 'extension', 'insight'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABLE = 'note_card_decisions';

function toDecision(row: Row): CardDecision | null {
  const insight = row.insight as NoteInsight | null;
  if (!CHOICES.includes(row.choice as CardChoice) || !KINDS.includes(row.kind as SuggestionKind)) return null;
  if (!insight || typeof insight !== 'object' || typeof insight.text !== 'string' || !Array.isArray(insight.note_ids)) return null;
  return {
    choice: row.choice as CardChoice,
    kind: row.kind as SuggestionKind,
    insight,
    ...(typeof row.text === 'string' ? { text: row.text } : {}),
    ...(row.target_note_id ? { targetNoteId: row.target_note_id } : {}),
  };
}

function toRow(noteId: string, cardId: string, decision: CardDecision): Row {
  return {
    note_id: noteId,
    card_id: cardId,
    choice: decision.choice,
    kind: decision.kind,
    insight: decision.insight,
    text: decision.text ?? null,
    target_note_id: decision.targetNoteId ?? null,
  };
}

function split(rows: Row[], noteId: string): NoteCardDecisions {
  const own: Record<string, CardDecision> = {};
  const incoming: IncomingCardDecision[] = [];
  for (const row of rows) {
    const decision = toDecision(row);
    if (!decision) continue;
    if (row.note_id === noteId) own[row.card_id] = decision;
    else if (row.target_note_id === noteId) incoming.push({ ...decision, cardId: row.card_id, fromNoteId: row.note_id });
  }
  return { own, incoming };
}

// ---------------------------------------------------------------- browser

function browserKey(userId: string): string {
  return `ocreda-card-decisions:v2:${userId}`;
}

/** The first version kept one entry per note, with no other note it could mark. */
function legacyBrowserKey(userId: string, noteId: string): string {
  return `ocreda-card-decisions:v1:${userId}:${noteId}`;
}

function readBrowserRows(userId: string): Row[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(browserKey(userId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((row): row is Row => row && typeof row.note_id === 'string' && typeof row.card_id === 'string') : [];
  } catch {
    return [];
  }
}

function writeBrowserRows(userId: string, rows: Row[]): void {
  try {
    if (rows.length) localStorage.setItem(browserKey(userId), JSON.stringify(rows));
    else localStorage.removeItem(browserKey(userId));
  } catch {
    // A disabled or full browser store should not block the note workspace.
  }
}

/** Moves a note's first-version entries into the current browser list. */
function adoptLegacyRows(userId: string, noteId: string): void {
  try {
    const raw = localStorage.getItem(legacyBrowserKey(userId, noteId));
    if (!raw) return;
    const legacy = JSON.parse(raw) as Record<string, Omit<Row, 'note_id' | 'card_id' | 'target_note_id'>>;
    const rows = readBrowserRows(userId).filter((row) => row.note_id !== noteId || !(row.card_id in legacy));
    for (const [cardId, value] of Object.entries(legacy)) {
      rows.push({ note_id: noteId, card_id: cardId, choice: value.choice, kind: value.kind, insight: value.insight, text: value.text ?? null, target_note_id: null });
    }
    writeBrowserRows(userId, rows);
    localStorage.removeItem(legacyBrowserKey(userId, noteId));
  } catch {
    // Unreadable old entries are simply left behind.
  }
}

function saveBrowserRow(userId: string, noteId: string, cardId: string, decision: CardDecision | null): void {
  const rows = readBrowserRows(userId).filter((row) => !(row.note_id === noteId && row.card_id === cardId));
  if (decision) rows.push(toRow(noteId, cardId, decision));
  writeBrowserRows(userId, rows);
}

// ---------------------------------------------------------------- supabase

/** The table is added by a migration; until it runs, choices stay in the browser. */
function isMissingTable(error: { code?: string; message?: string }): boolean {
  const message = (error.message ?? '').toLowerCase();
  return error.code === '42P01' || error.code === 'PGRST205' || (message.includes(TABLE) && (message.includes('does not exist') || message.includes('schema cache')));
}

async function signedInUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error('Your session has expired. Sign in again to continue.');
  return data.user.id;
}

/**
 * Choices made in this browser before they were kept in Supabase are sent up
 * once, then cleared here. Rows naming a note that no longer exists, or that
 * the row-level rules refuse, stay in the browser rather than block the rest.
 */
async function uploadBrowserRows(userId: string): Promise<void> {
  const rows = readBrowserRows(userId);
  if (!rows.length) return;
  const kept: Row[] = [];
  for (const row of rows) {
    const { error } = await supabase.from(TABLE).upsert({ ...row, user_id: userId }, { onConflict: 'user_id,note_id,card_id' });
    if (error && isMissingTable(error)) return;
    if (error) kept.push(row);
  }
  writeBrowserRows(userId, kept);
}

// ---------------------------------------------------------------- public

/** The choices on this note's cards, and those other notes made that mark it. */
export async function loadCardDecisions(noteId: string): Promise<NoteCardDecisions> {
  if (IS_LOCAL_MODE) {  // DEV-LOCAL-MODE
    adoptLegacyRows(LOCAL_USER_ID, noteId);
    return split(readBrowserRows(LOCAL_USER_ID), noteId);
  }
  const userId = await signedInUserId();
  adoptLegacyRows(userId, noteId);
  if (UUID.test(noteId)) {
    await uploadBrowserRows(userId).catch(() => undefined);
    const { data, error } = await supabase
      .from(TABLE)
      .select('note_id,card_id,choice,kind,insight,text,target_note_id')
      .or(`note_id.eq.${noteId},target_note_id.eq.${noteId}`);
    if (!error) return split((data ?? []) as Row[], noteId);
    if (!isMissingTable(error)) throw new Error('Could not load your choices on these suggestions.');
  }
  return split(readBrowserRows(userId), noteId);
}

/** Records a choice, or clears it when `decision` is null. */
export async function saveCardDecision(noteId: string, cardId: string, decision: CardDecision | null): Promise<void> {
  if (IS_LOCAL_MODE) {  // DEV-LOCAL-MODE
    saveBrowserRow(LOCAL_USER_ID, noteId, cardId, decision);
    return;
  }
  const userId = await signedInUserId();
  const { error } = decision
    ? await supabase.from(TABLE).upsert({ ...toRow(noteId, cardId, decision), user_id: userId }, { onConflict: 'user_id,note_id,card_id' })
    : await supabase.from(TABLE).delete().eq('user_id', userId).eq('note_id', noteId).eq('card_id', cardId);
  if (!error) return;
  if (!isMissingTable(error)) throw new Error('Could not save your choice on this suggestion.');
  saveBrowserRow(userId, noteId, cardId, decision);
}
