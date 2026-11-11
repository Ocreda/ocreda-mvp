import { supabase } from './supabase';
import { workspaceScope } from './sample-mode';
import { IS_LOCAL_MODE } from '@/dev/local-mode';  // DEV-LOCAL-MODE

/**
 * Domains, which are pinned, and which note is in which Domain.
 *
 * They are stored in the database (`domains`, `note_domains`), so they follow
 * a person to every device. The sample vault's Domains are kept apart with
 * `is_sample`, like its notes. Domains are referred to by name, ignoring case,
 * as everywhere in the app.
 *
 * They used to be stored only in the browser. Each browser uploads what it
 * stored once (uploadBrowserDomains) and keeps it as a recovery copy. Local
 * development mode has no database, so there the browser keys stay the store.
 */

export type StoredDomain = { title: string; description: string; createdAt: string };

export type DomainState = {
  domains: StoredDomain[];
  /** Pinned Domain names, oldest pin first, at most three. */
  pinned: string[];
  /** Domain name by note id. */
  assignments: Record<string, string>;
};

const PAGE_SIZE = 1000;
const ASSIGN_BATCH_SIZE = 1000;
const MAX_PINNED = 3;

const domainsKey = (scope: string) => `ocreda-muses:${scope}`;
const legacyDomainsKey = (scope: string) => `ocreda-cortexes:${scope}`;
const pinnedKey = (scope: string) => `ocreda-pinned-muses:${scope}`;
const assignmentsKey = (scope: string) => `ocreda-note-muses:${scope}`;
/** Set once this browser's Domains are in the database. Ends with the scope, so leaving the samples clears it. */
const uploadedKey = (scope: string) => `ocreda-domains-uploaded:v2:${scope}`;

function readJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
  } catch {
    return null;
  }
}

function cleanName(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 80) : '';
}

function cleanDate(value: unknown): string {
  if (typeof value !== 'string') return new Date().toISOString();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function sameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** What a browser has stored for one workspace, cleaned up. */
function readBrowserState(scope: string): DomainState {
  const stored = readJson(domainsKey(scope));
  const source = Array.isArray(stored) && stored.length ? stored : readJson(legacyDomainsKey(scope));
  const byName = new Map<string, StoredDomain>();
  (Array.isArray(source) ? source : []).forEach((item) => {
    const record = item as Record<string, unknown> | null;
    const title = cleanName(record?.title);
    if (!title || byName.has(title.toLowerCase())) return;
    byName.set(title.toLowerCase(), {
      title,
      description: typeof record?.description === 'string' ? record.description.trim().slice(0, 600) : '',
      createdAt: cleanDate(record?.createdAt),
    });
  });

  const storedPins = readJson(pinnedKey(scope));
  const pinned = Array.from(new Set((Array.isArray(storedPins) ? storedPins : []).map(cleanName).filter(Boolean))).slice(0, MAX_PINNED);

  const storedAssignments = readJson(assignmentsKey(scope));
  const assignments: Record<string, string> = {};
  if (storedAssignments && typeof storedAssignments === 'object' && !Array.isArray(storedAssignments)) {
    Object.entries(storedAssignments as Record<string, unknown>).forEach(([noteId, name]) => {
      const title = cleanName(name);
      if (title) assignments[noteId] = title;
    });
  }
  return { domains: Array.from(byName.values()), pinned, assignments };
}

function writeBrowserState(scope: string, state: DomainState): void {
  localStorage.setItem(domainsKey(scope), JSON.stringify(state.domains));
  localStorage.setItem(pinnedKey(scope), JSON.stringify(state.pinned));
  localStorage.setItem(assignmentsKey(scope), JSON.stringify(state.assignments));
}

/** Local development mode: applies a change to the browser-stored Domains. */
function updateBrowserState(userId: string, sample: boolean, change: (state: DomainState) => DomainState): void {
  const scope = workspaceScope(userId, sample);
  writeBrowserState(scope, change(readBrowserState(scope)));
}

function toPayload(state: DomainState) {
  return {
    domains: state.domains.map((domain) => ({ name: domain.title, description: domain.description, created_at: domain.createdAt })),
    pinned: state.pinned,
    note_domains: Object.entries(state.assignments).map(([noteId, name]) => ({ note_id: noteId, domain_name: name })),
  };
}

export async function loadDomains(userId: string, sample: boolean): Promise<DomainState> {
  if (IS_LOCAL_MODE) return readBrowserState(workspaceScope(userId, sample));  // DEV-LOCAL-MODE

  const { data: domainRows, error: domainError } = await supabase.from('domains')
    .select('id,name,description,created_at,pinned_at')
    .eq('user_id', userId)
    .eq('is_sample', sample)
    .order('created_at');
  if (domainError) throw domainError;
  const rows = domainRows ?? [];
  const nameById = new Map(rows.map((row) => [row.id as string, row.name as string]));

  const assignments: Record<string, string> = {};
  if (rows.length) {
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase.from('note_domains')
        .select('note_id,domain_id')
        .in('domain_id', Array.from(nameById.keys()))
        .order('note_id')
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      (data ?? []).forEach((row) => {
        const name = nameById.get(row.domain_id as string);
        if (name) assignments[row.note_id as string] = name;
      });
      if (!data || data.length < PAGE_SIZE) break;
    }
  }

  return {
    domains: rows.map((row) => ({ title: row.name, description: row.description ?? '', createdAt: row.created_at })),
    pinned: rows
      .filter((row) => row.pinned_at)
      .sort((left, right) => String(left.pinned_at).localeCompare(String(right.pinned_at)))
      .map((row) => row.name as string)
      .slice(0, MAX_PINNED),
    assignments,
  };
}

/**
 * Uploads the Domains this browser stored before they moved to the database,
 * once per browser and workspace. The first upload for an account replaces
 * what the database had; uploads from other browsers merge in.
 */
export async function uploadBrowserDomains(userId: string, sample: boolean): Promise<void> {
  if (IS_LOCAL_MODE) return;  // DEV-LOCAL-MODE
  const scope = workspaceScope(userId, sample);
  if (localStorage.getItem(uploadedKey(scope)) === 'done') return;
  const { error } = await supabase.rpc('import_domains', { payload: toPayload(readBrowserState(scope)), sample, from_browser: true });
  if (error) throw error;
  localStorage.setItem(uploadedKey(scope), 'done');
}

/** Adds Domains, pins and assignments that are missing, keeping everything already there. */
export async function addMissingDomains(userId: string, sample: boolean, additions: DomainState): Promise<void> {
  if (IS_LOCAL_MODE) {  // DEV-LOCAL-MODE
    updateBrowserState(userId, sample, (state) => ({
      domains: [...state.domains, ...additions.domains.filter((domain) => !state.domains.some((existing) => sameName(existing.title, domain.title)))],
      pinned: state.pinned.length ? state.pinned : additions.pinned.slice(0, MAX_PINNED),
      assignments: { ...additions.assignments, ...state.assignments },
    }));
    return;
  }
  const { error } = await supabase.rpc('import_domains', { payload: toPayload(additions), sample, from_browser: false });
  if (error) throw error;
}

/** Creates a Domain, or updates it; with originalTitle, renames that one (its notes follow). */
export async function saveDomain(userId: string, sample: boolean, title: string, description: string, originalTitle: string | null = null): Promise<void> {
  if (IS_LOCAL_MODE) {  // DEV-LOCAL-MODE
    updateBrowserState(userId, sample, (state) => {
      const from = originalTitle ?? title;
      const existing = state.domains.find((domain) => sameName(domain.title, from)) ?? state.domains.find((domain) => sameName(domain.title, title));
      const renamed = (name: string) => (existing && sameName(name, existing.title) ? title : name);
      return {
        domains: [
          ...state.domains.filter((domain) => domain !== existing),
          { title, description, createdAt: existing?.createdAt ?? new Date().toISOString() },
        ],
        pinned: state.pinned.map(renamed),
        assignments: Object.fromEntries(Object.entries(state.assignments).map(([noteId, name]) => [noteId, renamed(name)])),
      };
    });
    return;
  }
  const { error } = await supabase.rpc('save_domain', { domain_name: title, domain_description: description, sample, original_name: originalTitle });
  if (error) throw error;
}

/** Deletes a Domain. Its notes are left without one. */
export async function deleteDomain(userId: string, sample: boolean, title: string): Promise<void> {
  if (IS_LOCAL_MODE) {  // DEV-LOCAL-MODE
    updateBrowserState(userId, sample, (state) => ({
      domains: state.domains.filter((domain) => !sameName(domain.title, title)),
      pinned: state.pinned.filter((name) => !sameName(name, title)),
      assignments: Object.fromEntries(Object.entries(state.assignments).filter(([, name]) => !sameName(name, title))),
    }));
    return;
  }
  const { error } = await supabase.rpc('delete_domain', { domain_name: title, sample });
  if (error) throw error;
}

export async function setDomainPinned(userId: string, sample: boolean, title: string, pinned: boolean): Promise<void> {
  if (IS_LOCAL_MODE) {  // DEV-LOCAL-MODE
    updateBrowserState(userId, sample, (state) => ({
      ...state,
      pinned: pinned
        ? (state.pinned.some((name) => sameName(name, title)) ? state.pinned : [...state.pinned, title]).slice(0, MAX_PINNED)
        : state.pinned.filter((name) => !sameName(name, title)),
    }));
    return;
  }
  const { error } = await supabase.rpc('set_domain_pinned', { domain_name: title, sample, pinned });
  if (error) throw error;
}

/** Puts notes in a Domain (created if needed), or takes them out of any Domain with null. */
export async function assignNotesToDomain(userId: string, sample: boolean, noteIds: string[], title: string | null): Promise<void> {
  if (!noteIds.length) return;
  if (IS_LOCAL_MODE) {  // DEV-LOCAL-MODE
    updateBrowserState(userId, sample, (state) => {
      const assignments = { ...state.assignments };
      noteIds.forEach((noteId) => {
        if (title) assignments[noteId] = title;
        else delete assignments[noteId];
      });
      return { ...state, assignments };
    });
    return;
  }
  for (let start = 0; start < noteIds.length; start += ASSIGN_BATCH_SIZE) {
    const { error } = await supabase.rpc('assign_notes_to_domain', {
      note_ids: noteIds.slice(start, start + ASSIGN_BATCH_SIZE), domain_name: title, sample,
    });
    if (error) throw error;
  }
}
