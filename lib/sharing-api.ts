import { supabase } from './supabase';
import { createNote } from './notes-api';
import { assignNotesToDomain, saveDomain } from './domains-api';
import { Note } from './types';
import { IS_LOCAL_MODE, LOCAL_USER_ID } from '@/dev/local-mode';  // DEV-LOCAL-MODE

/**
 * Note sharing. A person copies notes into their public notes, then makes a
 * link to them. A link shares the public notes as they were when it was made
 * and works until it is revoked. Private notes are never readable through it:
 * public notes are separate copies in their own table.
 */

export type PublicNote = { id: string; rawText: string; sourceNoteId: string | null; createdAt: string };
export type ShareLink = { id: string; token: string; createdAt: string; revokedAt: string | null; noteCount: number };
export type SharedNote = { position: number; title: string; /** Null when the visitor must sign in to read it. */ text: string | null; notedAt: string };
export type SharedLinkView = {
  sharerName: string;
  sharerAvatarUrl: string | null;
  isOwner: boolean;
  /** The Domain the viewer already copied these notes into, if they did. */
  copiedToDomain: string | null;
  notes: SharedNote[];
};

/** How many notes a visitor without an account can read in full. */
export const FREE_SHARED_NOTES = 3;

const PENDING_SHARE_KEY = 'ocreda-pending-share';

/** Remembers the link a visitor came from, so signing up brings them back to it. */
export function rememberPendingShare(token: string): void {
  try { localStorage.setItem(PENDING_SHARE_KEY, token); } catch { /* They land on the home page instead. */ }
}

function validToken(token: string | null): string | null {
  return token && /^[0-9a-z-]{8,64}$/i.test(token) ? token : null;
}

export function readPendingShare(): string | null {
  try { return validToken(localStorage.getItem(PENDING_SHARE_KEY)); } catch { return null; }
}

/**
 * Where sign-in should return to. The shared link's token rides in the
 * address itself, so it survives the emailed link being opened in another
 * browser or device, where this browser's storage does not exist.
 */
export function authCallbackUrl(): string {
  const token = readPendingShare();
  return `${window.location.origin}/auth/callback${token ? `?share=${token}` : ''}`;
}

/** The shared link to go back to after signing in: from the address first, then from this browser. */
export function shareToReturnTo(): string | null {
  try {
    return validToken(new URLSearchParams(window.location.search).get('share')) ?? readPendingShare();
  } catch { return readPendingShare(); }
}

export function clearPendingShare(): void {
  try { localStorage.removeItem(PENDING_SHARE_KEY); } catch { /* Nothing stored. */ }
}

export function shareUrl(token: string): string {
  return `${window.location.origin}/s/${token}`;
}

function titleOf(text: string): string {
  return text.trim().split('\n')[0].trim().slice(0, 120);
}

// ── Local development mode: sharing kept in the browser ──────────────────────

type LocalLink = { id: string; token: string; createdAt: string; revokedAt: string | null; notes: Array<{ rawText: string; notedAt: string }>; copiedToDomain: string | null };
type LocalSharing = { publicNotes: PublicNote[]; links: LocalLink[] };
const LOCAL_KEY = 'ocreda-local-sharing';

function readLocal(): LocalSharing {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? 'null') as LocalSharing | null;
    return { publicNotes: parsed?.publicNotes ?? [], links: parsed?.links ?? [] };
  } catch { return { publicNotes: [], links: [] }; }
}

function writeLocal(state: LocalSharing): void {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
}

// ── The sharer's side ────────────────────────────────────────────────────────

async function ownerId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error('Your session has expired. Sign in again to continue.');
  return data.user.id;
}

export async function listPublicNotes(): Promise<PublicNote[]> {
  if (IS_LOCAL_MODE) return readLocal().publicNotes;  // DEV-LOCAL-MODE
  const { data, error } = await supabase.from('public_notes')
    .select('id,raw_text,source_note_id,created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => ({ id: row.id, rawText: row.raw_text, sourceNoteId: row.source_note_id, createdAt: row.created_at }));
}

/**
 * Copies a private note's text into the public notes. Copying the same note
 * again updates its public copy. Nothing else about the note comes along:
 * its insight cards quote other, private notes.
 */
export async function copyNoteToPublic(note: Note): Promise<void> {
  await copyNotesToPublic([note]);
}

const PUBLIC_COPY_BATCH_SIZE = 200;

/** Copies many private notes into the public notes at once; ones already there are updated. */
export async function copyNotesToPublic(notes: Note[]): Promise<void> {
  const shareable = notes.filter((note) => !note.is_sample && note.raw_text.trim());
  if (!shareable.length) return;
  if (IS_LOCAL_MODE) {  // DEV-LOCAL-MODE
    const state = readLocal();
    shareable.forEach((note) => {
      const existing = state.publicNotes.find((item) => item.sourceNoteId === note.id);
      if (existing) existing.rawText = note.raw_text;
      else state.publicNotes.unshift({ id: crypto.randomUUID(), rawText: note.raw_text, sourceNoteId: note.id, createdAt: new Date().toISOString() });
    });
    writeLocal(state);
    return;
  }
  const userId = await ownerId();
  for (let start = 0; start < shareable.length; start += PUBLIC_COPY_BATCH_SIZE) {
    const { error } = await supabase.from('public_notes').upsert(
      shareable.slice(start, start + PUBLIC_COPY_BATCH_SIZE).map((note) => ({ user_id: userId, raw_text: note.raw_text, source_note_id: note.id })),
      { onConflict: 'user_id,source_note_id' },
    );
    if (error) throw error;
  }
}

/** Takes a note out of the public notes. Links already made keep their copy until revoked. */
export async function removePublicNote(id: string): Promise<void> {
  if (IS_LOCAL_MODE) {  // DEV-LOCAL-MODE
    const state = readLocal();
    writeLocal({ ...state, publicNotes: state.publicNotes.filter((note) => note.id !== id) });
    return;
  }
  const { error } = await supabase.from('public_notes').delete().eq('id', id);
  if (error) throw error;
}

/** Copies a public note into the person's own private notes. */
export async function copyPublicNoteToPrivate(note: PublicNote): Promise<void> {
  await createNote(note.rawText);
}

export async function listShareLinks(): Promise<ShareLink[]> {
  if (IS_LOCAL_MODE) {  // DEV-LOCAL-MODE
    return readLocal().links.map((link) => ({ id: link.id, token: link.token, createdAt: link.createdAt, revokedAt: link.revokedAt, noteCount: link.notes.length }));
  }
  const { data, error } = await supabase.from('share_links')
    .select('id,token,created_at,revoked_at,share_link_notes(count)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id, token: row.token, createdAt: row.created_at, revokedAt: row.revoked_at,
    noteCount: Number((row.share_link_notes as Array<{ count: number }> | null)?.[0]?.count ?? 0),
  }));
}

/** Makes a link to the public notes as they are now. Returns its token. */
export async function createShareLink(): Promise<string> {
  if (IS_LOCAL_MODE) {  // DEV-LOCAL-MODE
    const state = readLocal();
    if (!state.publicNotes.length) throw new Error('Add a note to your public notes before making a link');
    const token = crypto.randomUUID().replace(/-/g, '');
    state.links.unshift({
      id: crypto.randomUUID(), token, createdAt: new Date().toISOString(), revokedAt: null, copiedToDomain: null,
      notes: state.publicNotes.map((note) => ({ rawText: note.rawText, notedAt: note.createdAt })),
    });
    writeLocal(state);
    return token;
  }
  const { data, error } = await supabase.rpc('create_share_link');
  if (error) throw error;
  return data as string;
}

/** Stops a link working. Notes people already copied stay theirs. */
export async function revokeShareLink(id: string): Promise<void> {
  if (IS_LOCAL_MODE) {  // DEV-LOCAL-MODE
    const state = readLocal();
    state.links.forEach((link) => { if (link.id === id) link.revokedAt = new Date().toISOString(); });
    writeLocal(state);
    return;
  }
  const { error } = await supabase.from('share_links').update({ revoked_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

// ── The visitor's side ───────────────────────────────────────────────────────

/**
 * What the viewer may see of a link, or null when it does not exist or was
 * revoked. Works without an account. In local development mode there is only
 * one account, so `asVisitor` shows the signed-out view.
 */
export async function getSharedLink(token: string, asVisitor = false): Promise<SharedLinkView | null> {
  if (IS_LOCAL_MODE) {  // DEV-LOCAL-MODE
    const link = readLocal().links.find((item) => item.token === token && !item.revokedAt);
    if (!link) return null;
    return {
      sharerName: 'Local', sharerAvatarUrl: null, isOwner: false, copiedToDomain: asVisitor ? null : link.copiedToDomain,
      notes: link.notes.map((note, position) => ({
        position, title: titleOf(note.rawText), notedAt: note.notedAt,
        text: asVisitor && position >= FREE_SHARED_NOTES ? null : note.rawText,
      })),
    };
  }
  const { data, error } = await supabase.rpc('get_shared_link', { link_token: token });
  if (error) throw error;
  if (!data) return null;
  const view = data as Record<string, unknown>;
  return {
    sharerName: String(view.sharer_name ?? 'Someone'),
    sharerAvatarUrl: typeof view.sharer_avatar_url === 'string' ? view.sharer_avatar_url : null,
    isOwner: view.is_owner === true,
    copiedToDomain: typeof view.copied_to_domain === 'string' ? view.copied_to_domain : null,
    notes: (Array.isArray(view.notes) ? view.notes as Array<Record<string, unknown>> : []).map((note) => ({
      position: Number(note.position), title: String(note.title ?? ''),
      text: typeof note.text === 'string' ? note.text : null, notedAt: String(note.noted_at ?? ''),
    })),
  };
}

/** Copies a link's notes into the viewer's own notes, in a "From <sharer>" Domain. Returns that Domain's name. */
export async function copySharedNotes(token: string): Promise<{ domain: string; alreadyCopied: boolean }> {
  if (IS_LOCAL_MODE) {  // DEV-LOCAL-MODE
    const state = readLocal();
    const link = state.links.find((item) => item.token === token && !item.revokedAt);
    if (!link) throw new Error('This link is no longer shared');
    if (link.copiedToDomain) return { domain: link.copiedToDomain, alreadyCopied: true };
    const domain = 'From Local';
    await saveDomain(LOCAL_USER_ID, false, domain, 'Notes Local shared with me.');
    const ids: string[] = [];
    // Oldest first, so the newest shared note ends up newest here too.
    for (const note of link.notes.slice().reverse()) ids.push((await createNote(note.rawText)).id);
    await assignNotesToDomain(LOCAL_USER_ID, false, ids, domain);
    link.copiedToDomain = domain;
    writeLocal(state);
    return { domain, alreadyCopied: false };
  }
  const { data, error } = await supabase.rpc('copy_shared_notes', { link_token: token });
  if (error) throw error;
  const result = data as Record<string, unknown>;
  return { domain: String(result.domain), alreadyCopied: result.already_copied === true };
}
