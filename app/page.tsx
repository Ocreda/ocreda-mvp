'use client';

import { NoteBodyEditor, type NoteBodyEditorHandle, type NoteFormat } from '@/components/NoteBodyEditor';
import { inlineRuns, LINE_MARKER, plainNoteText, previewNoteText, stripInlineMarkdown, type InlineRun } from '@/lib/note-markdown';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Bold, Check, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, Filter, FolderPlus, Grid2X2, Italic, Layers3, List, ListOrdered, Loader as Loader2, Mic, MoreHorizontal, PanelRightOpen, Pin, Plus, RefreshCw, Rows3, ScanSearch, Search, Share2, Trash2, Upload, X } from 'lucide-react';
import type { RelevanceProgress } from '@/lib/types';
import NoteImporter, { ImportDomainDraft, ImportNoteDraft } from '@/components/NoteImporter';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useAuth } from '@/lib/auth-context';
import { createNote, deleteNote, findRelevantNotes, findSimilarNotes, getNotes, importNotes, MIN_RELEVANCE_DRAFT_CHARS, processNote, updateNote } from '@/lib/notes-api';
import { addMissingDomains, assignNotesToDomain, deleteDomain, DomainState, loadDomains, saveDomain, setDomainPinned, uploadBrowserDomains } from '@/lib/domains-api';
import { supabase } from '@/lib/supabase';
import { prepareImportedNoteText } from '@/lib/import-note-content';
import { IS_LOCAL_MODE } from '@/dev/local-mode';  // DEV-LOCAL-MODE
import { CardChoice, CardDecision, CardKind, DomainGoal, IncomingCardDecision, InsightIntent, Note, NoteInsight, NoteRelationType, RelevanceCoverage, RelevanceResult, RelevanceSection, SuggestionKind } from '@/lib/types';
import { loadCardDecisions, saveCardDecision } from '@/lib/card-decisions';
import { loadNotesUsing, loadSharedRetrieval, SharedRetrieval, storeSharedRetrieval } from '@/lib/saved-retrievals';
import { defaultNoteTitle, findAnchor, readNoteTitle, RELATED_NOTES_PAGE_SIZE, splitIntoParagraphs } from '@/supabase/functions/_shared/relevance';
import { getAiMode, useAiMode } from '@/lib/ai-mode';
import { setSampleMode, useSampleMode, workspaceScope } from '@/lib/sample-mode';
import { isSampleGuide, loadSampleVault, SampleVault } from '@/lib/sample-vault';
import { copyNotesToPublic } from '@/lib/sharing-api';
import { listVaults, removeVault, setVaultInRetrieval, Vault } from '@/lib/vaults-api';
import { FeedbackButton } from '@/components/FeedbackButton';

type MuseMeta = { title: string; description: string; createdAt: string };
type ProjectPage = { id: string; title: string; content: string; sourceNoteIds: string[]; createdAt: string; updatedAt: string };
type CortexProject = { id: string; title: string; description: string; content: string; pages: ProjectPage[]; createdAt: string; updatedAt: string };
type NoteEditorState = { note: Note | null; title: string; body: string; muse: string; context: 'domain' };
type MuseEditorState = { originalTitle: string | null; title: string; description: string };
type ProjectEditorState = { project: CortexProject | null; title: string; description: string };
type SpeechRecognitionLike = {
  lang: string; continuous: boolean; interimResults: boolean;
  start: () => void; stop: () => void;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
  onerror: (() => void) | null; onend: (() => void) | null;
};

const ORPHANS_MUSE = 'Orphans';
const ORPHANS_DESCRIPTION = 'Notes waiting to be placed in a Domain.';
const ORPHANS_MIGRATION_VERSION = 'v1';
const HOME_HISTORY_KEY = 'ocreda-home-view';
const SAMPLE_EXIT_NOTICE = 'Back to your notes. Sample notes you wrote are kept with the samples.';

function cleanCategory(value: string | null | undefined): string | null {
  const clean = value?.trim().replace(/\s+/g, ' ') ?? '';
  return clean || null;
}

/**
 * The Domain a search is made from, with its description standing in as the
 * goal. Null for notes outside any Domain, which are searched on their text alone.
 */
function domainGoalFor(category: string | null | undefined, muses: MuseMeta[]): DomainGoal | null {
  const name = cleanCategory(category);
  if (!name || name.toLowerCase() === ORPHANS_MUSE.toLowerCase()) return null;
  const meta = muses.find((muse) => muse.title.toLowerCase() === name.toLowerCase());
  return { name, goal: meta?.description.trim() ?? '' };
}

/**
 * A note's title and body. Line one is the title, as notes are stored, unless
 * the note was saved without one: then the title is its first five words and
 * the body is all of its text. That reading also fixes notes saved before,
 * whose whole text sat in the title. `written` is false for a made-up title.
 */
/**
 * A note's title and body for showing it. The title is plain text: a short
 * note is its own title, so its bold or other markers would otherwise show as
 * symbols in headings and labels.
 */
function splitNote(note: Note): { title: string; body: string; hasTitle: boolean; written: boolean } {
  const { title, body, written } = readNoteTitle(note.raw_text);
  const plainTitle = plainNoteText(title);
  return { title: plainTitle, body, hasTitle: Boolean(plainTitle), written };
}

/**
 * What the title field and the body editor start with. A one-line note (a
 * short note, which is its own title, or a lone heading) opens in the body
 * editor, so its formatting can still be changed there; saving it again
 * stores the same text. The title field is empty when the person never wrote one.
 */
function editableNote(note: Note): { title: string; body: string } {
  const { title, body, written } = readNoteTitle(note.raw_text);
  const text = note.raw_text.trim();
  if (written && !body && !text.includes('\n')) return { title: '', body: text };
  return { title: written ? title : '', body };
}

/**
 * The stored text for a title and body. With no title, a note longer than five
 * words gets its first five words and "..." as one, so the text stays in the body.
 */
function composeNoteText(title: string, body: string): string {
  const cleanBody = body.trim();
  const cleanTitle = title.trim() || (cleanBody ? defaultNoteTitle(cleanBody) : '');
  if (!cleanBody) return cleanTitle;
  // A note of five words or fewer is its own title.
  if (!title.trim() && !cleanTitle.endsWith('...')) return cleanBody;
  return `${cleanTitle}\n\n${cleanBody}`;
}

const MAX_LABEL_CHARS = 60;

/** Cuts text to a label's length at a word break, so a long first line reads as a name. */
function shortLabel(text: string): string {
  if (text.length <= MAX_LABEL_CHARS) return text;
  const cut = text.slice(0, MAX_LABEL_CHARS + 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > MAX_LABEL_CHARS / 2 ? cut.slice(0, lastSpace) : cut.slice(0, MAX_LABEL_CHARS)).replace(/[\s,.;:!?-]+$/, '')}…`;
}

/**
 * A one-line label for a note in lists, menus, and cards, where something must
 * show. A note's first line is its title, but a note with no real title has a
 * whole sentence there, so every label is kept short.
 */
function noteLabel(note: Note): string {
  const { title, hasTitle } = splitNote(note);
  if (hasTitle) return shortLabel(title);
  return shortLabel(notePreview(note)) || 'Untitled note';
}

function notePreview(note: Note): string {
  const { body } = splitNote(note);
  return (body || note.raw_text)
    // Bullet and heading markers, which only carry meaning at the start of a
    // line. Stripping "-" everywhere turned "per-seat" into "perseat".
    .replace(/^[\s>]*[#>\-*+]+[ \t]*/gm, '')
    // Inline emphasis, which always wraps text rather than sitting inside it.
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(value));
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return hash;
}

// Bump the version whenever the wording of saved summaries or reasons changes,
// so notes opened before the change are retrieved again instead of showing the
// old text. v2: summaries and gists speak to the user in the second person.
// v3: results carry a goal-aware insight, and the goal is part of the signature.
// v4: up to three insights, and relations gain helps and solves.
// v5: every match says which way help flows (inbound or outbound).
// v6: one search splits the note into ideas and tags each match with its idea.
// v7: results also carry the exact passage used from every retrieved note.
// v8: cards quote the person's own words and name their kind and action.
// v9: a note can be the solution to an earlier note's problem.
// The AI mode is part of the signature, so switching Basic/Best searches again.
const SAVED_RETRIEVAL_VERSION = 'v9';

function savedRetrievalKey(userId: string, noteId: string): string {
  return `ocreda-saved-retrieval:${SAVED_RETRIEVAL_VERSION}:${userId}:${noteId}`;
}

/** Changing the note, its Domain's goal, or the AI mode makes saved retrieval stale. */
function retrievalInputSignature(rawText: string, goal: string, aiMode: ReturnType<typeof getAiMode>): string {
  // "best" keeps the signature it had before modes existed, so saved results stay valid.
  const mode = aiMode === 'basic' ? ':basic' : '';
  return `${rawText.length}:${stableHash(rawText)}:${stableHash(goal)}${mode}`;
}

function noteSignature(note: Note, goal: string): string {
  return retrievalInputSignature(note.raw_text, goal, getAiMode());
}

type SavedRetrieval = { mode: 'similar' | 'relevant'; search: RelevanceSearch; signature: string; savedAt: string };

function readSavedRetrieval(userId: string, note: Note): SavedRetrieval | null {
  try {
    return checkSavedRetrieval(JSON.parse(localStorage.getItem(savedRetrievalKey(userId, note.id)) ?? 'null'));
  } catch {
    return null;
  }
}

/** A saved retrieval, from this browser or the database, if it is complete enough to show. */
function checkSavedRetrieval(value: unknown): SavedRetrieval | null {
  try {
    const saved = value as {
      signature?: string; mode?: string; search?: RelevanceSearch; savedAt?: string;
    } | null;
    // Keep a valid older retrieval visible after the note or Domain changes.
    // Its signature is returned so the UI can mark it stale and offer an
    // explicit re-retrieval instead of silently running AI again.
    if (typeof saved?.signature !== 'string' || !Array.isArray(saved.search?.results) || !saved.search?.coverage) return null;
    if (!saved.search.results.every((result) => result && typeof result.note_id === 'string' && typeof result.gist === 'string')) return null;
    if (saved.search.summary !== undefined && typeof saved.search.summary !== 'string') return null;
    if (saved.mode !== 'similar' && saved.mode !== 'relevant') return null;
    // Older similarity-only responses have empty explanations. Do not reuse
    // them in the annotated reading view, where every card needs a reason.
    if (saved.mode === 'relevant' && !saved.search.results.every((result) => typeof result.explanation === 'string' && result.explanation.trim())) return null;
    // Copies saved before the database kept them have no date: any shared copy is newer.
    const savedAt = typeof saved.savedAt === 'string' ? saved.savedAt : '';
    return { mode: saved.mode, search: saved.search, signature: saved.signature, savedAt };
  } catch {
    return null;
  }
}

/** Keeps a retrieval in this browser, for showing it instantly next time. */
function cacheSavedRetrieval(userId: string, noteId: string, saved: Omit<SavedRetrieval, 'search'> & { search: unknown }): void {
  try {
    localStorage.setItem(savedRetrievalKey(userId, noteId), JSON.stringify(saved));
  } catch {
    // A full or disabled browser store should not prevent the note itself from being saved.
  }
}

/** Saves a finished retrieval here and in the database, so every device shows it without searching again. */
function persistSavedRetrieval(userId: string, note: Note, goal: string, mode: 'similar' | 'relevant', search: RelevanceSearch, signature = noteSignature(note, goal)): void {
  cacheSavedRetrieval(userId, note.id, { signature, mode, search, savedAt: new Date().toISOString() });
  storeSharedRetrieval(note.id, SAVED_RETRIEVAL_VERSION, { signature, mode, search });
}

/** A retrieval saved on another device, checked like a browser copy. */
function fromShared(shared: SharedRetrieval | null): SavedRetrieval | null {
  return shared ? checkSavedRetrieval(shared) : null;
}

function safeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return fallback;
}

/**
 * The Domains of one workspace (the person's own, or the sample vault's).
 * First uploads what this browser stored before Domains moved to the
 * database; a failed upload is reported and tried again on the next load.
 * With the sample vault, also files its Domains when it was just copied in,
 * or has none yet. Notes the person wrote or moved keep their Domain.
 */
async function loadDomainState(userId: string, sample: boolean, vault?: SampleVault): Promise<{ state: DomainState; uploadFailed: boolean }> {
  let uploadFailed = false;
  try {
    await uploadBrowserDomains(userId, sample);
  } catch {
    uploadFailed = true;
  }
  let state = await loadDomains(userId, sample);
  if (vault && (vault.copied || (!state.domains.length && !Object.keys(state.assignments).length))) {
    // One millisecond apart, so the Domains keep the vault's order.
    const start = Date.now() - vault.domains.length;
    const assignments: Record<string, string> = {};
    vault.notes.forEach((note) => {
      const domain = vault.domainOf(note);
      if (domain) assignments[note.id] = domain;
    });
    await addMissingDomains(userId, sample, {
      domains: vault.domains.map((domain, index) => ({ title: domain.title, description: domain.description, createdAt: new Date(start + index).toISOString() })),
      pinned: [vault.pinnedDomain],
      assignments,
    });
    state = await loadDomains(userId, sample);
  }
  return { state, uploadFailed };
}

const DOMAIN_UPLOAD_ERROR = 'Your Domains from this browser could not be saved to your account yet. They will be tried again the next time you open Ocreda.';

function readStoredList<T>(key: string): T[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function createProjectId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `project-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createPageId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeProject(project: Omit<CortexProject, 'pages'> & { pages?: ProjectPage[] }): CortexProject {
  const pages = Array.isArray(project.pages)
    ? project.pages.filter((page) => page && typeof page.id === 'string' && typeof page.title === 'string').map((page) => ({
      ...page,
      content: typeof page.content === 'string' ? page.content : '',
      sourceNoteIds: Array.isArray(page.sourceNoteIds) ? page.sourceNoteIds.filter((id): id is string => typeof id === 'string') : [],
      createdAt: page.createdAt || project.createdAt,
      updatedAt: page.updatedAt || project.updatedAt,
    }))
    : [];
  if (!pages.length && project.content?.trim()) {
    pages.push({ id: `${project.id}-legacy-page`, title: project.title, content: project.content, sourceNoteIds: [], createdAt: project.createdAt, updatedAt: project.updatedAt });
  }
  return { ...project, content: project.content ?? '', pages };
}

function OcredaMark({ className = '' }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/ocreda-logo.png" alt="" aria-hidden="true" className={`object-contain ${className}`} />;
}

export default function OcredaHome() {
  const { user } = useAuth();
  const sampleMode = useSampleMode(user?.id);
  // Domains, their notes, pins and projects are stored apart for the sample
  // vault, so the two sets never mix.
  const scope = user ? workspaceScope(user.id, sampleMode) : null;
  const [notes, setNotes] = useState<Note[]>([]);
  // Which workspace the notes in state belong to, while a switch is loading.
  const [notesScope, setNotesScope] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [shareNotice, setShareNotice] = useState('');
  const loadRequestRef = useRef(0);
  const [museMeta, setMuseMeta] = useState<MuseMeta[]>([]);
  const [pinnedMuseTitles, setPinnedMuseTitles] = useState<string[]>([]);
  const [projects, setProjects] = useState<CortexProject[]>([]);
  const [view, setView] = useState<'cortex' | 'muses'>('cortex');
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState('');
  const [noteEditor, setNoteEditor] = useState<NoteEditorState | null>(null);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  // Set only for note-to-note navigation. It drives the contextual return
  // arrow; notes opened from a list or project deliberately have no arrow.
  const [previousNoteId, setPreviousNoteId] = useState<string | null>(null);
  const [activeNoteRetrievalMode, setActiveNoteRetrievalMode] = useState<'similar' | 'relevant'>('relevant');
  // Note-to-note navigation enables this so the destination restores or finds
  // its own connections without requiring another click.
  const [activeNoteAutoSearch, setActiveNoteAutoSearch] = useState(true);
  const [museEditor, setMuseEditor] = useState<MuseEditorState | null>(null);
  const [projectEditor, setProjectEditor] = useState<ProjectEditorState | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [activeMuse, setActiveMuse] = useState<string | null>(null);
  const [showUnsorted, setShowUnsorted] = useState(false);
  // Notes others shared with you, one vault per person, kept apart from your own.
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [activeVaultId, setActiveVaultId] = useState<string | null>(null);
  const [activeSharedNoteId, setActiveSharedNoteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [error, setError] = useState('');
  const [importError, setImportError] = useState('');
  const [importProgress, setImportProgress] = useState<{ completed: number; total: number } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const orphanMigrationStartedRef = useRef(false);
  const orphanCleanupStartedRef = useRef(false);
  // While this browser's Domains are not uploaded, its notes may look unsorted.
  const domainUploadFailedRef = useRef(false);
  const historySurfaceActiveRef = useRef(false);
  const userId = user?.id ?? null;

  const resetToDashboard = useCallback(() => {
    setNoteEditor(null);
    setActiveNoteId(null);
    setPreviousNoteId(null);
    setMuseEditor(null);
    setProjectEditor(null);
    setActiveProjectId(null);
    setActivePageId(null);
    setActiveMuse(null);
    setShowUnsorted(false);
    setActiveVaultId(null);
    setActiveSharedNoteId(null);
    setView('cortex');
    setImportOpen(false);
  }, []);

  // All workspaces on the home page are React state rather than separate
  // routes. Give them a real history entry so the mobile browser/OS Back
  // button returns to the dashboard instead of leaving `/` for `/auth`.
  useEffect(() => {
    window.history.replaceState({ ...window.history.state, [HOME_HISTORY_KEY]: 'dashboard' }, '', window.location.href);
    const onPopState = (event: PopStateEvent) => {
      if (window.location.pathname !== '/') return;
      historySurfaceActiveRef.current = false;
      resetToDashboard();
      // Forward navigation must not resurrect a stale UI snapshot that React
      // can no longer restore. It remains a safe dashboard entry instead.
      if (event.state?.[HOME_HISTORY_KEY] === 'surface') {
        window.history.replaceState({ ...event.state, [HOME_HISTORY_KEY]: 'dashboard' }, '', window.location.href);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [resetToDashboard]);

  const hasInAppSurface = Boolean(
    noteEditor || activeNoteId || museEditor || projectEditor || activeProjectId
    || activeMuse || showUnsorted || view === 'muses' || importOpen || activeVaultId || activeSharedNoteId
  );

  useEffect(() => {
    if (hasInAppSurface && !historySurfaceActiveRef.current) {
      window.history.pushState({ ...window.history.state, [HOME_HISTORY_KEY]: 'surface' }, '', window.location.href);
      historySurfaceActiveRef.current = true;
      return;
    }
    if (!hasInAppSurface && historySurfaceActiveRef.current) {
      historySurfaceActiveRef.current = false;
      if (window.history.state?.[HOME_HISTORY_KEY] === 'surface') window.history.back();
    }
  }, [hasInAppSurface]);

  const load = useCallback(async () => {
    // A switch between the two sets can overtake a load still on its way.
    const request = ++loadRequestRef.current;
    try {
      if (!userId) return;
      let loaded: Note[];
      let domains: Awaited<ReturnType<typeof loadDomainState>>;
      // Shared notes go with your own notes only, never with the samples.
      let loadedVaults: Vault[] = [];
      if (sampleMode) {
        const vault = await loadSampleVault();
        if (request !== loadRequestRef.current) return;
        domains = await loadDomainState(userId, true, vault);
        loaded = vault.notes;
      } else {
        [loaded, domains, loadedVaults] = await Promise.all([
          getNotes(),
          loadDomainState(userId, false),
          // A vault that fails to load leaves your own notes working.
          listVaults().catch((err) => { console.error('Could not load shared notes:', err); return [] as Vault[]; }),
        ]);
      }
      if (request !== loadRequestRef.current) return;
      // The latest load decides which Domains show, so a switch always ends
      // with the Domains of the notes it loaded.
      const { state, uploadFailed } = domains;
      domainUploadFailedRef.current = uploadFailed;
      if (uploadFailed) setError(DOMAIN_UPLOAD_ERROR);
      setMuseMeta(state.domains);
      setPinnedMuseTitles(state.pinned);
      // A note's Domain comes only from the Domain records.
      setNotes(loaded.map((note) => ({ ...note, category: state.assignments[note.id] ?? null })));
      setVaults(loadedVaults);
      setNotesScope(scope);
    }
    catch (err) {
      if (request === loadRequestRef.current) {
        setError(safeErrorMessage(err, sampleMode ? 'Unable to load the sample notes.' : 'Unable to load your notes.'));
      }
    }
    finally { if (request === loadRequestRef.current) setLoading(false); }
  }, [sampleMode, scope, userId]);
  useEffect(() => { void load(); }, [load]);

  // Switching between the sample notes and your own starts from the dashboard.
  const previousSampleModeRef = useRef(sampleMode);
  useEffect(() => {
    if (previousSampleModeRef.current === sampleMode) return;
    const leftSamples = previousSampleModeRef.current;
    previousSampleModeRef.current = sampleMode;
    resetToDashboard();
    setNotes([]);
    setLoading(true);
    setError('');
    setNotice(leftSamples ? SAMPLE_EXIT_NOTICE : '');
  }, [resetToDashboard, sampleMode]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 6000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  // Lets every full-screen surface start below the sample banner.
  useEffect(() => {
    document.body.classList.toggle('ocreda-sample-mode', sampleMode);
    return () => document.body.classList.remove('ocreda-sample-mode');
  }, [sampleMode]);

  const exitSampleMode = () => {
    if (!user) return;
    const unsavedDraft = noteEditor && !noteEditor.note && (noteEditor.title.trim() || noteEditor.body.trim());
    if (unsavedDraft && !confirm('Leave this note and go back to your notes? This note has not been saved.')) return;
    setSampleMode(user.id, false);
  };

  useEffect(() => {
    if (!user || !scope) return;
    // Domains load with the notes, from the database.
    const projectKey = `ocreda-projects:${scope}`;
    const legacy = readStoredList<MuseMeta>(`ocreda-cortexes:${scope}`).filter((item) => item && typeof item.title === 'string');

    const storedProjects = readStoredList<CortexProject>(projectKey).filter((item) => item && typeof item.id === 'string' && typeof item.title === 'string').map(normalizeProject);
    if (storedProjects.length) {
      setProjects(storedProjects);
    } else if (legacy.length) {
      const migrated = legacy.map((item) => ({
        id: createProjectId(),
        title: item.title,
        description: item.description,
        content: '',
        pages: [],
        createdAt: item.createdAt,
        updatedAt: item.createdAt,
      }));
      setProjects(migrated);
      localStorage.setItem(projectKey, JSON.stringify(migrated));
    } else {
      setProjects([]);
    }
    if (IS_LOCAL_MODE) {  // DEV-LOCAL-MODE
      setDisplayName('you');
    } else {
      supabase.from('user_settings').select('full_name').eq('user_id', user.id).maybeSingle().then(({ data }) => {
        const authName = String(user.user_metadata?.full_name ?? user.user_metadata?.name ?? '').trim();
        setDisplayName(data?.full_name?.trim() || authName || user.email?.split('@')[0] || 'you');
      });
    }
  }, [scope, user]);

  /** The signed-in account, for saving Domains. */
  const requireUserId = (): string => {
    if (!userId) throw new Error('Your session has expired. Sign in again to continue.');
    return userId;
  };

  const togglePinnedMuse = async (title: string) => {
    const validPinned = pinnedMuseTitles.filter((pinned) => muses.some((muse) => muse.title.toLowerCase() === pinned.toLowerCase()));
    const exists = validPinned.some((pinned) => pinned.toLowerCase() === title.toLowerCase());
    if (!exists && validPinned.length >= 3) {
      setError('You can pin up to 3 Domains. Unpin one before adding another.');
      return;
    }
    try {
      await setDomainPinned(requireUserId(), sampleMode, title, !exists);
      setPinnedMuseTitles(exists ? validPinned.filter((pinned) => pinned.toLowerCase() !== title.toLowerCase()) : [...validPinned, title]);
      setError('');
    } catch (err) { setError(safeErrorMessage(err, exists ? 'Unable to unpin this Domain.' : 'Unable to pin this Domain.')); }
  };

  const persistProjects = useCallback((next: CortexProject[]) => {
    setProjects(next);
    if (scope) localStorage.setItem(`ocreda-projects:${scope}`, JSON.stringify(next));
  }, [scope]);

  /** Shows notes in a Domain once it is saved. */
  const showMuseAssignments = useCallback((noteIds: string[], category: string | null) => {
    if (!noteIds.length) return;
    const ids = new Set(noteIds);
    setNotes((current) => current.map((note) => ids.has(note.id) ? { ...note, category, category_updated_at: new Date().toISOString() } : note));
  }, []);

  useEffect(() => {
    // The sample vault arrives sorted, so this is for your own notes only.
    if (!user || loading || sampleMode || notesScope !== scope || orphanMigrationStartedRef.current || domainUploadFailedRef.current) return;
    const migrationKey = `ocreda-orphans-migration:${ORPHANS_MIGRATION_VERSION}:${user.id}`;
    if (localStorage.getItem(migrationKey) === 'complete') return;

    orphanMigrationStartedRef.current = true;
    const uncategorizedIds = notes.filter((note) => !cleanCategory(note.category)).map((note) => note.id);
    // Nothing to sort: a new account keeps its welcome screen instead of an empty Orphans Domain.
    if (!uncategorizedIds.length) {
      localStorage.setItem(migrationKey, 'complete');
      return;
    }
    const existingOrphans = museMeta.find((muse) => muse.title.toLowerCase() === ORPHANS_MUSE.toLowerCase());

    const migrate = async () => {
      try {
        if (!existingOrphans) {
          await saveDomain(user.id, false, ORPHANS_MUSE, ORPHANS_DESCRIPTION);
          setMuseMeta((current) => [...current, { title: ORPHANS_MUSE, description: ORPHANS_DESCRIPTION, createdAt: new Date().toISOString() }]);
        }
        await assignNotesToDomain(user.id, false, uncategorizedIds, ORPHANS_MUSE);
        showMuseAssignments(uncategorizedIds, ORPHANS_MUSE);
        localStorage.setItem(migrationKey, 'complete');
      } catch (err) {
        orphanMigrationStartedRef.current = false;
        setError(safeErrorMessage(err, 'Unable to move existing uncategorized notes to Orphans.'));
      }
    };
    void migrate();
  }, [loading, museMeta, notes, notesScope, sampleMode, scope, showMuseAssignments, user]);

  const muses = useMemo(() => {
    const map = new Map<string, MuseMeta>();
    museMeta.forEach((item) => { const title = cleanCategory(item.title); if (title) map.set(title.toLowerCase(), { ...item, title }); });
    notes.forEach((note) => {
      const title = cleanCategory(note.category);
      if (title && !map.has(title.toLowerCase())) map.set(title.toLowerCase(), { title, description: '', createdAt: note.created_at });
    });
    return Array.from(map.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [museMeta, notes]);

  /** Saves a goal picked from the one-tap suggestions as the Domain's description. */
  const setDomainGoal = async (domainTitle: string, goal: string) => {
    const key = domainTitle.toLowerCase();
    const existing = museMeta.find((item) => item.title.toLowerCase() === key);
    try { await saveDomain(requireUserId(), sampleMode, existing?.title ?? domainTitle, goal); }
    catch (err) { setError(safeErrorMessage(err, 'Unable to save this Domain’s goal.')); return; }
    setMuseMeta(existing
      ? museMeta.map((item) => item.title.toLowerCase() === key ? { ...item, description: goal } : item)
      // A Domain that exists only through its notes' category gets its metadata now.
      : [...museMeta, { title: domainTitle, description: goal, createdAt: muses.find((item) => item.title.toLowerCase() === key)?.createdAt ?? new Date().toISOString() }]);
  };

  const notesByMuse = useMemo(() => {
    const grouped = new Map<string, Note[]>();
    muses.forEach((muse) => grouped.set(muse.title, []));
    notes.forEach((note) => {
      const category = cleanCategory(note.category);
      if (!category) return;
      const canonical = muses.find((muse) => muse.title.toLowerCase() === category.toLowerCase())?.title ?? category;
      grouped.set(canonical, [...(grouped.get(canonical) ?? []), note]);
    });
    return grouped;
  }, [muses, notes]);

  // Orphans is a temporary inbox, not a permanent empty Domain. Once every
  // note has been placed (or deleted), remove it from the shared Domain store.
  useEffect(() => {
    if (!userId || loading || saving || notesScope !== scope || importProgress || domainUploadFailedRef.current) return;
    if (notes.some((note) => !cleanCategory(note.category))) return;
    const hasOrphanNotes = notes.some((note) => cleanCategory(note.category)?.toLowerCase() === ORPHANS_MUSE.toLowerCase());
    const hasOrphanMeta = museMeta.some((muse) => muse.title.toLowerCase() === ORPHANS_MUSE.toLowerCase());
    if (hasOrphanNotes || !hasOrphanMeta) { orphanCleanupStartedRef.current = false; return; }
    if (orphanCleanupStartedRef.current) return;
    orphanCleanupStartedRef.current = true;
    deleteDomain(userId, sampleMode, ORPHANS_MUSE)
      .then(() => {
        setMuseMeta((current) => current.filter((muse) => muse.title.toLowerCase() !== ORPHANS_MUSE.toLowerCase()));
        setPinnedMuseTitles((current) => current.filter((title) => title.toLowerCase() !== ORPHANS_MUSE.toLowerCase()));
        if (activeMuse?.toLowerCase() === ORPHANS_MUSE.toLowerCase()) setActiveMuse(null);
      })
      .catch((err) => {
        orphanCleanupStartedRef.current = false;
        setError(safeErrorMessage(err, 'Unable to remove the empty Orphans Domain.'));
      });
  }, [activeMuse, importProgress, loading, museMeta, notes, notesScope, sampleMode, saving, scope, userId]);

  const unsortedNotes = useMemo(() => notes.filter((note) => !cleanCategory(note.category)), [notes]);
  const isEmpty = !loading && notes.length === 0 && muses.length === 0 && vaults.length === 0;
  const sharedNotes = useMemo(() => vaults.flatMap((vault) => vault.notes), [vaults]);
  const hasSearchableShared = vaults.some((vault) => vault.useInRetrieval && vault.notes.length > 0);
  const toggleVaultRetrieval = async (vault: Vault) => {
    const on = !vault.useInRetrieval;
    const apply = (value: boolean) => setVaults((current) => current.map((item) => item.id === vault.id ? { ...item, useInRetrieval: value } : item));
    apply(on);
    try { await setVaultInRetrieval(vault.id, on); }
    catch (err) { apply(!on); setError(safeErrorMessage(err, 'That vault setting could not be saved.')); }
  };
  const deleteVault = async (vault: Vault) => {
    const count = vault.notes.length;
    if (!window.confirm(`Remove ${vault.name}’s vault? Its ${count} ${count === 1 ? 'note leaves' : 'notes leave'} your Ocreda. You can add them again from ${vault.name}’s link.`)) return;
    setSaving(true);
    try {
      await removeVault(vault.id);
      setVaults((current) => current.filter((item) => item.id !== vault.id));
      setActiveVaultId(null);
      setActiveSharedNoteId(null);
    } catch (err) { setError(safeErrorMessage(err, 'The vault could not be removed.')); }
    finally { setSaving(false); }
  };
  const flashSaved = () => { setSavedOpen(true); window.setTimeout(() => setSavedOpen(false), 1350); };
  const closeLibrary = useCallback(() => { setActiveMuse(null); setShowUnsorted(false); setView('cortex'); }, []);
  const openMuse = useCallback((title: string) => {
    setActiveMuse(title);
    setShowUnsorted(false);
    setView('muses');
  }, []);
  /**
   * The Domain a new note goes to unless one is picked: the last one used,
   * meaning the Domain of the note most recently written into or moved into a
   * real Domain (decided Nov 25). Read from the notes, so it holds on every
   * device. Orphans only when no note is in a Domain that still exists.
   */
  const lastUsedDomain = useMemo(() => {
    const existing = new Map(muses.map((muse) => [muse.title.toLowerCase(), muse.title]));
    let latest: { title: string; at: string } | null = null;
    for (const note of notes) {
      const domain = cleanCategory(note.category);
      const title = domain ? existing.get(domain.toLowerCase()) : undefined;
      if (!title || title.toLowerCase() === ORPHANS_MUSE.toLowerCase()) continue;
      const at = [note.created_at, note.category_updated_at ?? ''].sort().pop() ?? note.created_at;
      if (!latest || at > latest.at) latest = { title, at };
    }
    return latest?.title ?? ORPHANS_MUSE;
  }, [muses, notes]);
  const openNewNote = (muse = lastUsedDomain) => { setError(''); setNoteEditor({ note: null, title: '', body: '', muse, context: 'domain' }); };
  const openExistingNote = (note: Note, autoSearch = true, fromNoteId: string | null = null) => {
    setError('');
    // A shared note opens read-only, with no search of its own.
    if (note.vault_id) { setActiveSharedNoteId(note.id); return; }
    setActiveNoteRetrievalMode('relevant');
    setActiveNoteAutoSearch(autoSearch);
    setPreviousNoteId(fromNoteId);
    setActiveNoteId(note.id);
  };
  const createMuseFromEditor = (value: string) => {
    const requested = cleanCategory(value);
    if (!requested) return;
    const existing = muses.find((item) => item.title.toLowerCase() === requested.toLowerCase());
    if (existing) {
      setNoteEditor((current) => current ? { ...current, muse: existing.title } : current);
      return;
    }
    // A Domain without a clear goal makes relevance less useful. Finish its
    // required goal in the Domain editor before it can be selected here.
    setMuseEditor({ originalTitle: null, title: requested, description: '' });
  };

  const saveNote = async (findRelevant = false) => {
    if (!noteEditor) return;
    const title = noteEditor.title.trim(); const body = noteEditor.body.trim();
    if (!title && !body) { setError('Write something before saving.'); return; }
    const rawText = composeNoteText(title, body);
    const category = cleanCategory(noteEditor.muse) ?? ORPHANS_MUSE;
    if (findRelevant && category.toLowerCase() === ORPHANS_MUSE.toLowerCase()) {
      setError('Choose a Domain before finding related notes.');
      return;
    }
    setSaving(true); setError('');
    try {
      let savedNoteId: string;
      let domainError = '';
      if (noteEditor.note) {
        const updated = await updateNote(noteEditor.note.id, rawText, category);
        if (cleanCategory(noteEditor.note.category) !== category) await assignNotesToDomain(requireUserId(), sampleMode, [updated.id], category);
        setNotes((current) => current.map((note) => note.id === updated.id ? { ...updated, category } : note));
        savedNoteId = updated.id;
      } else {
        const created = await createNote(rawText, category);
        // The note exists now, so a failure to file it must not invite saving it twice.
        let savedCategory: string | null = category;
        if (category) {
          try { await assignNotesToDomain(requireUserId(), sampleMode, [created.id], category); }
          catch (err) {
            savedCategory = category.toLowerCase() === ORPHANS_MUSE.toLowerCase() ? ORPHANS_MUSE : null;
            domainError = safeErrorMessage(err, 'The note was saved, but not its Domain.');
          }
        }
        setNotes((current) => [{ ...created, category: savedCategory }, ...current]);
        if (savedCategory && savedCategory.toLowerCase() !== ORPHANS_MUSE.toLowerCase()) processNote(created.id).catch(() => {});
        savedNoteId = created.id;
      }
      setNoteEditor(null); setActiveNoteRetrievalMode('relevant'); setActiveNoteAutoSearch(true); setPreviousNoteId(null); setActiveNoteId(savedNoteId);
      if (domainError) setError(domainError);
      else if (!findRelevant) flashSaved();
    } catch (err) { setError(safeErrorMessage(err, 'Unable to save this note.')); }
    finally { setSaving(false); }
  };

  const removeNote = async () => {
    if (!noteEditor?.note || !confirm('Delete this note? This cannot be undone.')) return;
    setSaving(true);
    try { const noteId = noteEditor.note.id; await deleteNote(noteId); setNotes((current) => current.filter((note) => note.id !== noteId)); setNoteEditor(null); }
    catch (err) { setError(safeErrorMessage(err, 'Unable to delete this note.')); }
    finally { setSaving(false); }
  };

  const updateReadingNote = async (noteId: string, rawText: string) => {
    const current = notes.find((note) => note.id === noteId);
    if (!current || !rawText.trim()) return;
    setSaving(true); setError('');
    try {
      // Only update text: a pending autosave must not undo a Domain change.
      const updated = await updateNote(noteId, rawText);
      setNotes((items) => items.map((note) => note.id === noteId ? { ...updated, category: note.category, category_updated_at: note.category_updated_at } : note));
    } catch (err) { setError(safeErrorMessage(err, 'Unable to save this note.')); throw err; }
    finally { setSaving(false); }
  };

  const changeReadingNoteDomain = async (noteId: string, category: string | null) => {
    const current = notes.find((note) => note.id === noteId);
    const nextCategory = cleanCategory(category);
    if (!current || cleanCategory(current.category) === nextCategory) return;
    setSaving(true); setError('');
    try {
      await assignNotesToDomain(requireUserId(), sampleMode, [noteId], nextCategory);
      showMuseAssignments([noteId], nextCategory);
      if (cleanCategory(current.category)?.toLowerCase() === ORPHANS_MUSE.toLowerCase() && nextCategory?.toLowerCase() !== ORPHANS_MUSE.toLowerCase()) {
        processNote(noteId).catch(() => {});
      }
    } catch (err) { setError(safeErrorMessage(err, 'Unable to change this note’s Domain.')); }
    finally { setSaving(false); }
  };

  const removeReadingNote = async (note: Note) => {
    if (!confirm('Delete this page? This cannot be undone.')) return;
    setSaving(true); setError('');
    try {
      // Its Domain assignment is deleted with it.
      await deleteNote(note.id);
      setNotes((items) => items.filter((item) => item.id !== note.id));
      if (activeNoteId === note.id) setActiveNoteId(null);
      if (previousNoteId === note.id) setPreviousNoteId(null);
    } catch (err) { setError(safeErrorMessage(err, 'Unable to delete this page.')); }
    finally { setSaving(false); }
  };

  /** Copies a note's text into the public notes; a link is made from there. */
  const shareNotes = async (shared: Note[]) => {
    if (!shared.length) return;
    setError('');
    try {
      await copyNotesToPublic(shared);
      setShareNotice(shared.length === 1
        ? `“${splitNote(shared[0]).title || 'This note'}” is in your public notes.`
        : `${shared.length} notes are in your public notes.`);
    } catch (err) { setError(safeErrorMessage(err, 'Unable to copy to your public notes.')); }
  };
  const shareNote = (note: Note) => shareNotes([note]);

  const saveMuse = async () => {
    if (!museEditor) return;
    const title = cleanCategory(museEditor.title);
    const description = museEditor.description.trim();
    if (!title) { setError('Add a title for this Domain.'); return; }
    if (!description) { setError('Add a clear goal for this Domain.'); return; }
    if (muses.some((item) => item.title.toLowerCase() === title.toLowerCase() && item.title !== museEditor.originalTitle)) { setError('A Domain with this title already exists.'); return; }
    setSaving(true); setError('');
    try {
      // A rename takes the Domain's notes and pin with it.
      await saveDomain(requireUserId(), sampleMode, title, description, museEditor.originalTitle);
      if (museEditor.originalTitle && museEditor.originalTitle !== title) {
        showMuseAssignments((notesByMuse.get(museEditor.originalTitle) ?? []).map((note) => note.id), title);
      }
      const originalKey = museEditor.originalTitle?.toLowerCase();
      const next = museMeta.filter((item) => item.title.toLowerCase() !== originalKey && item.title.toLowerCase() !== title.toLowerCase());
      next.push({ title, description, createdAt: museMeta.find((item) => item.title.toLowerCase() === originalKey)?.createdAt ?? new Date().toISOString() });
      setMuseMeta(next);
      if (museEditor.originalTitle && museEditor.originalTitle !== title) {
        setPinnedMuseTitles(pinnedMuseTitles.map((pinned) => pinned.toLowerCase() === museEditor.originalTitle?.toLowerCase() ? title : pinned));
      }
      if (activeMuse === museEditor.originalTitle) setActiveMuse(title);
      if (!museEditor.originalTitle) {
        setNoteEditor((current) => current ? { ...current, muse: title } : current);
        const orphanNote = activeNoteId ? notes.find((note) => note.id === activeNoteId && cleanCategory(note.category)?.toLowerCase() === ORPHANS_MUSE.toLowerCase()) : null;
        if (orphanNote) await changeReadingNoteDomain(orphanNote.id, title);
      }
      setMuseEditor(null); flashSaved();
    } catch (err) { setError(safeErrorMessage(err, 'Unable to save this Domain.')); }
    finally { setSaving(false); }
  };

  const removeMuse = async (title: string) => {
    if (!confirm(`Delete “${title}”? Its notes will move to ${ORPHANS_MUSE}.`)) return;
    setSaving(true);
    try {
      // Its notes are left without a Domain.
      await deleteDomain(requireUserId(), sampleMode, title);
      showMuseAssignments((notesByMuse.get(title) ?? []).map((note) => note.id), null);
      setMuseMeta(museMeta.filter((item) => item.title.toLowerCase() !== title.toLowerCase()));
      setPinnedMuseTitles(pinnedMuseTitles.filter((pinned) => pinned.toLowerCase() !== title.toLowerCase()));
      setActiveMuse(null);
    } catch (err) { setError(safeErrorMessage(err, 'Unable to delete this Domain.')); }
    finally { setSaving(false); }
  };

  const saveProject = () => {
    if (!projectEditor) return;
    const title = cleanCategory(projectEditor.title);
    if (!title) { setError('Add a title for this project.'); return; }
    const now = new Date().toISOString();
    const nextProject: CortexProject = projectEditor.project
      ? { ...projectEditor.project, title, description: projectEditor.description.trim(), updatedAt: now }
      : { id: createProjectId(), title, description: projectEditor.description.trim(), content: '', pages: [], createdAt: now, updatedAt: now };
    persistProjects(projectEditor.project
      ? projects.map((project) => project.id === nextProject.id ? nextProject : project)
      : [...projects, nextProject]);
    setProjectEditor(null);
    setActiveProjectId(nextProject.id);
    setActivePageId(null);
    flashSaved();
  };

  const updateProject = (updated: CortexProject) => {
    persistProjects(projects.map((project) => project.id === updated.id ? { ...updated, updatedAt: new Date().toISOString() } : project));
  };

  const createProjectPage = (projectId: string) => {
    const now = new Date().toISOString();
    const page: ProjectPage = { id: createPageId(), title: 'Untitled page', content: '', sourceNoteIds: [], createdAt: now, updatedAt: now };
    persistProjects(projects.map((project) => project.id === projectId ? { ...project, pages: [...project.pages, page], updatedAt: now } : project));
    setActivePageId(page.id);
  };

  const updateProjectPage = (projectId: string, updatedPage: ProjectPage) => {
    persistProjects(projects.map((project) => project.id === projectId ? { ...project, pages: project.pages.map((page) => page.id === updatedPage.id ? { ...updatedPage, updatedAt: new Date().toISOString() } : page), updatedAt: new Date().toISOString() } : project));
  };

  const removeProjectPage = (projectId: string, pageId: string) => {
    const project = projects.find((item) => item.id === projectId);
    const page = project?.pages.find((item) => item.id === pageId);
    if (!project || !page || !confirm(`Delete “${page.title}”?`)) return;
    persistProjects(projects.map((item) => item.id === projectId ? { ...item, pages: item.pages.filter((candidate) => candidate.id !== pageId), updatedAt: new Date().toISOString() } : item));
    setActivePageId(null);
  };

  const removeProject = (projectId: string) => {
    const project = projects.find((item) => item.id === projectId);
    if (!project || !confirm(`Delete “${project.title}”?`)) return;
    persistProjects(projects.filter((item) => item.id !== projectId));
    setActiveProjectId(null);
    setActivePageId(null);
  };

  const handleImport = async (drafts: ImportNoteDraft[], requestedDomains: ImportDomainDraft[]) => {
    setImportError('');
    try {
      const now = new Date().toISOString();
      const importDomainMap = new Map(muses.map((muse) => [muse.title.toLowerCase(), muse]));
      requestedDomains.forEach((domain) => {
        const title = cleanCategory(domain.title);
        if (!title) return;
        const key = title.toLowerCase();
        if (!importDomainMap.has(key)) {
          importDomainMap.set(key, {
            title: key === ORPHANS_MUSE.toLowerCase() ? ORPHANS_MUSE : title,
            description: domain.description.trim(),
            createdAt: now,
          });
        }
      });
      if (!importDomainMap.has(ORPHANS_MUSE.toLowerCase())) {
        importDomainMap.set(ORPHANS_MUSE.toLowerCase(), {
          title: ORPHANS_MUSE,
          description: ORPHANS_DESCRIPTION,
          createdAt: now,
        });
      }

      const importDomains = Array.from(importDomainMap.values());
      const orphanTitle = importDomainMap.get(ORPHANS_MUSE.toLowerCase())?.title ?? ORPHANS_MUSE;
      const inputs = drafts.map((draft) => {
        const rawText = prepareImportedNoteText(draft.rawText);
        return { rawText, category: orphanTitle };
      });
      const imported = await importNotes(
        inputs,
        (completed, total) => setImportProgress({ completed, total })
      );

      const categorized = imported.map((note, index) => ({ ...note, category: inputs[index].category }));
      try {
        const owner = requireUserId();
        const nextMeta = new Map(museMeta.map((muse) => [muse.title.toLowerCase(), muse]));
        const newDomains = importDomains.filter((domain) => !nextMeta.has(domain.title.toLowerCase()));
        // Domains first, so their goals are saved before notes are filed in them.
        for (const domain of newDomains) await saveDomain(owner, sampleMode, domain.title, domain.description);
        newDomains.forEach((domain) => nextMeta.set(domain.title.toLowerCase(), domain));
        setMuseMeta(Array.from(nextMeta.values()));

        const idsByDomain = new Map<string, string[]>();
        categorized.forEach((note) => idsByDomain.set(note.category!, [...(idsByDomain.get(note.category!) ?? []), note.id]));
        for (const [category, noteIds] of Array.from(idsByDomain)) await assignNotesToDomain(owner, sampleMode, noteIds, category);
        setNotes((current) => [...categorized, ...current]);
        setImportProgress(null); setImportOpen(false); flashSaved();
      } catch (err) {
        // The notes are saved, so importing again would copy them twice. Show what was saved.
        setImportProgress(null); setImportOpen(false);
        await load();
        setError(`Your notes were imported, but not all of them could be filed in their Domains. ${safeErrorMessage(err, '')}`.trim());
      }
    } catch (err) { setImportProgress(null); setImportError(safeErrorMessage(err, 'Your notes could not be imported.')); throw err; }
  };

  if (loading) return <div className="flex h-[100dvh] items-center justify-center overflow-hidden bg-white"><Loader2 className="h-7 w-7 animate-spin text-[#477bea]" /></div>;

  const activeProject = activeProjectId ? projects.find((project) => project.id === activeProjectId) ?? null : null;
  const activePage = activeProject && activePageId ? activeProject.pages.find((page) => page.id === activePageId) ?? null : null;
  const activeNote = activeNoteId ? notes.find((note) => note.id === activeNoteId) ?? null : null;
  const activeVault = activeVaultId ? vaults.find((vault) => vault.id === activeVaultId) ?? null : null;
  const activeSharedNote = activeSharedNoteId ? sharedNotes.find((note) => note.id === activeSharedNoteId) ?? null : null;
  const previousNote = previousNoteId ? notes.find((note) => note.id === previousNoteId) ?? null : null;

  return (
    <main className={`light h-[100dvh] w-full overflow-hidden bg-white text-[#141414] ${sampleMode ? 'pt-[var(--sample-banner-height)]' : ''}`}>
      {sampleMode && <SampleBanner onExit={exitSampleMode} />}
      <section className="relative flex h-full w-full flex-col overflow-hidden bg-white">
        {activeProject && activePage ? <ProjectPageWorkspace key={activePage.id} project={activeProject} page={activePage} notes={notes} muses={muses} projects={projects} saving={saving} onBack={() => setActivePageId(null)} onChange={(page) => updateProjectPage(activeProject.id, page)} onAddNote={() => openNewNote()} onOpenNote={openExistingNote} onOpenPage={(project, page) => { setActiveProjectId(project.id); setActivePageId(page.id); }} onDelete={() => removeProjectPage(activeProject.id, activePage.id)} />
          : activeProject ? <ProjectPagesGrid project={activeProject} onBack={() => { setActiveProjectId(null); setActivePageId(null); }} onAddPage={() => createProjectPage(activeProject.id)} onOpenPage={(page) => setActivePageId(page.id)} onEdit={() => setProjectEditor({ project: activeProject, title: activeProject.title, description: activeProject.description })} onDelete={() => removeProject(activeProject.id)} />
          : isEmpty ? <EmptyWorkspace displayName={displayName} userEmail={user?.email ?? ''} existingDomains={muses} onAddNote={() => openNewNote()} onImport={handleImport} onOpenImport={() => setImportOpen(true)} onTrySamples={user && !sampleMode ? () => setSampleMode(user.id, true) : undefined} importError={importError} progress={importProgress} />
          : activeVault ? <VaultDetail vault={activeVault} busy={saving} onClose={() => setActiveVaultId(null)} onOpenNote={(note) => setActiveSharedNoteId(note.id)} onToggleRetrieval={() => void toggleVaultRetrieval(activeVault)} onRemove={() => void deleteVault(activeVault)} />
          : activeMuse || showUnsorted ? <MuseDetail title={showUnsorted ? ORPHANS_MUSE : activeMuse ?? ''} notes={showUnsorted ? unsortedNotes : notesByMuse.get(activeMuse ?? '') ?? []} isUnsorted={showUnsorted} busy={saving} onClose={closeLibrary} onAddNote={() => openNewNote(showUnsorted ? ORPHANS_MUSE : activeMuse ?? ORPHANS_MUSE)} onOpenNote={openExistingNote} onEdit={() => { const meta = muses.find((item) => item.title === activeMuse); if (meta) setMuseEditor({ originalTitle: meta.title, title: meta.title, description: meta.description }); }} onDelete={() => { if (activeMuse) void removeMuse(activeMuse); }} onShare={sampleMode || showUnsorted ? undefined : () => void shareNotes(notesByMuse.get(activeMuse ?? '') ?? [])} />
          : view === 'muses' ? <MuseGrid muses={muses} projects={projects} notes={notes} notesByMuse={notesByMuse} busy={saving} onClose={closeLibrary} onAddNote={(muse) => openNewNote(muse ?? ORPHANS_MUSE)} onAddMuse={() => setMuseEditor({ originalTitle: null, title: '', description: '' })} onEditMuse={(muse) => setMuseEditor({ originalTitle: muse.title, title: muse.title, description: muse.description })} onDeleteMuse={(title) => void removeMuse(title)} onOpenNote={openExistingNote} />
          : <CortexHome vaults={vaults} onOpenVault={(vault) => setActiveVaultId(vault.id)} onToggleVaultRetrieval={(vault) => void toggleVaultRetrieval(vault)} onRemoveVault={(vault) => void deleteVault(vault)} projects={projects} muses={muses} pinnedMuseTitles={pinnedMuseTitles} notes={notes} notesByMuse={notesByMuse} userEmail={user?.email ?? ''} busy={saving} onOpenMuses={() => setView('muses')} onOpenMuse={openMuse} onTogglePin={togglePinnedMuse} onAddMuse={() => setMuseEditor({ originalTitle: null, title: '', description: '' })} onAddNote={() => openNewNote()} onOpenImport={() => setImportOpen(true)} onOpenPage={(project, page) => { setActiveProjectId(project.id); setActivePageId(page.id); }} onOpenNote={openExistingNote} onMoveNote={(noteId, domain) => void changeReadingNoteDomain(noteId, domain)} />}
        {notice && !error && <div role="status" aria-live="polite" className="fixed bottom-5 left-1/2 z-40 max-w-[90vw] -translate-x-1/2 rounded-lg bg-[#202020] px-4 py-3 text-sm text-white shadow-xl">{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss" className="ml-4"><X className="inline h-4 w-4" /></button></div>}
        {error && !noteEditor && !museEditor && !projectEditor && <div role="alert" className="fixed bottom-5 left-1/2 z-40 max-w-[90vw] -translate-x-1/2 rounded-lg bg-[#202020] px-4 py-3 text-sm text-white shadow-xl">{error}<button type="button" onClick={() => setError('')} aria-label="Dismiss error" className="ml-4"><X className="inline h-4 w-4" /></button></div>}
      </section>
      {activeNote && <NoteReadingWorkspace key={activeNote.id} note={activeNote} previousNote={previousNote} allNotes={notes} sharedNotes={sharedNotes} hasSearchableShared={hasSearchableShared} muses={muses} projects={projects} saving={saving} userId={scope ?? 'local'} initialRetrievalMode={activeNoteRetrievalMode} autoSearch={activeNoteAutoSearch} onClose={() => { setActiveNoteId(null); setPreviousNoteId(null); }} onReturnToPrevious={() => { if (previousNote) { setActiveNoteAutoSearch(false); setActiveNoteId(previousNote.id); setPreviousNoteId(null); } }} onAddNote={() => { setActiveNoteId(null); setPreviousNoteId(null); openNewNote(cleanCategory(activeNote.category) ?? ORPHANS_MUSE); }} onOpenNote={(note, autoSearch) => openExistingNote(note, autoSearch, activeNote.id)} onOpenPage={(project, page) => { setActiveNoteId(null); setPreviousNoteId(null); setActiveProjectId(project.id); setActivePageId(page.id); }} onUpdate={updateReadingNote} onChangeDomain={(category) => void changeReadingNoteDomain(activeNote.id, category)} onCreateDomain={() => setMuseEditor({ originalTitle: null, title: '', description: '' })} onDelete={removeReadingNote} onShare={shareNote} onSetDomainGoal={setDomainGoal} onImport={() => { setActiveNoteId(null); setPreviousNoteId(null); setImportError(''); setImportOpen(true); }} />}
      {activeSharedNote && <SharedNoteView note={activeSharedNote} vault={vaults.find((vault) => vault.id === activeSharedNote.vault_id) ?? null} onClose={() => setActiveSharedNoteId(null)} />}
      {shareNotice && <div role="status" aria-live="polite" className="fixed bottom-5 left-1/2 z-[95] flex max-w-[90vw] -translate-x-1/2 items-center gap-3 rounded-lg bg-[#202020] px-4 py-3 text-sm text-white shadow-xl"><span>{shareNotice}</span><Link href="/sharing" className="shrink-0 font-medium text-[#a8c4ff] hover:underline">Make a link</Link><button type="button" onClick={() => setShareNotice('')} aria-label="Dismiss"><X className="h-4 w-4" /></button></div>}
      {noteEditor && <NoteEditor state={noteEditor} muses={muses} notes={notes} saving={saving} error={error} onChange={setNoteEditor} onCreateMuse={createMuseFromEditor} onClose={() => { setNoteEditor(null); setError(''); }} onSave={() => void saveNote()} onFindRelevantNotes={() => void saveNote(true)} onImport={() => { setImportError(''); setImportOpen(true); }} onDelete={noteEditor.note ? () => void removeNote() : undefined} />}
      {museEditor && <MuseEditor state={museEditor} saving={saving} error={error} onChange={setMuseEditor} onClose={() => { setMuseEditor(null); setError(''); }} onSave={() => void saveMuse()} />}
      {projectEditor && <ProjectEditor state={projectEditor} error={error} onChange={setProjectEditor} onClose={() => { setProjectEditor(null); setError(''); }} onSave={saveProject} />}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="light w-[calc(100vw-48px)] max-w-[480px] overflow-visible border-[#e6e7eb] bg-white p-0 text-[#141414] shadow-xl [&>button]:!-right-4 [&>button]:!-top-4 [&>button]:flex [&>button]:h-9 [&>button]:w-9 [&>button]:items-center [&>button]:justify-center [&>button]:rounded-full [&>button]:border [&>button]:border-[#e6e7eb] [&>button]:bg-white [&>button]:opacity-100 [&>button]:shadow-md">
          <div className="max-h-[calc(100dvh-48px)] overflow-y-auto p-6">
            <DialogTitle className="sr-only">Import notes</DialogTitle>
            <NoteImporter onImport={handleImport} importError={importError} existingDomains={muses} centerActions />
            {importProgress && <p className="text-center text-sm text-[#777]" aria-live="polite">Importing {importProgress.completed} of {importProgress.total} notes…</p>}
          </div>
        </DialogContent>
      </Dialog>
      {savedOpen && <SavedConfirmation />}
    </main>
  );
}

function Avatar({ email, onOpenImport }: { email: string; onOpenImport: () => void }) {
  const { user } = useAuth();
  const sampleMode = useSampleMode(user?.id);
  const menuItemClassName = 'cursor-pointer rounded-md px-3 py-2.5 !text-[#252525] hover:!bg-[#e8efff] focus:!bg-[#e8efff] focus:!text-[#1b3f88] data-[highlighted]:!bg-[#e8efff] data-[highlighted]:!text-[#1b3f88]';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Open account menu" className="flex h-9 w-9 items-center justify-center rounded-full bg-[#bd315c] text-sm font-medium text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea] focus-visible:ring-offset-2 sm:h-10 sm:w-10">{(email[0] || 'U').toUpperCase()}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={10} className="w-48 rounded-xl border-[#e6e7eb] bg-white p-1.5 text-[#252525] shadow-lg">
        <DropdownMenuItem asChild className={menuItemClassName}>
          <Link href="/profile">Profile</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className={menuItemClassName}>
          <Link href="/sharing">Sharing</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className={menuItemClassName}>
          <a href="/terms">Terms of use</a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className={menuItemClassName}>
          <a href="/privacy">Privacy policy</a>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1 bg-[#ececef]" />
        <DropdownMenuItem onSelect={onOpenImport} className={menuItemClassName}>Import notes</DropdownMenuItem>
        {user && <DropdownMenuItem onSelect={() => setSampleMode(user.id, !sampleMode)} className={menuItemClassName}>{sampleMode ? 'Back to my notes' : 'Explore sample notes'}</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BetaAndAvatar({ email, feedback = false, onOpenImport }: { email: string; feedback?: boolean; onOpenImport: () => void }) {
  return (
    <div className="flex items-center gap-4">
      <div className="inline-flex overflow-hidden rounded-md border border-[#a8c4ff] text-sm">
        <span className="bg-[#edf3ff] px-4 py-1.5 text-[#477bea]">Beta</span>
        {feedback && <FeedbackButton className="hidden border-l border-[#a8c4ff] sm:block" />}
      </div>
      <Avatar email={email} onOpenImport={onOpenImport} />
    </div>
  );
}

function SampleBanner({ onExit }: { onExit: () => void }) {
  return (
    <div role="status" className="fixed inset-x-0 top-0 z-[120] flex h-[var(--sample-banner-height)] items-center justify-center gap-3 bg-[#1b3f88] px-4 text-xs text-white sm:text-sm">
      <span className="min-w-0 truncate">You&apos;re exploring sample notes.<span className="hidden sm:inline"> Your own notes are hidden.</span></span>
      <button type="button" onClick={onExit} className="shrink-0 rounded-md bg-white px-3 py-1 font-medium text-[#1b3f88] hover:bg-[#e8efff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">Back to my notes</button>
    </div>
  );
}

function EmptyWorkspace({ displayName, userEmail, existingDomains, onAddNote, onImport, onOpenImport, onTrySamples, importError, progress }: {
  displayName: string; userEmail: string; onAddNote: () => void;
  /** Absent while already exploring the samples. */
  onTrySamples?: () => void;
  existingDomains: ImportDomainDraft[];
  onImport: (drafts: ImportNoteDraft[], domains: ImportDomainDraft[]) => Promise<void>; onOpenImport: () => void; importError: string;
  progress: { completed: number; total: number } | null;
}) {
  return (
    <div className={`relative flex h-full min-h-0 flex-col overflow-y-auto bg-white px-5 sm:px-10 ${onTrySamples ? '' : 'md:overflow-hidden'}`}>
      <div className="flex h-[72px] shrink-0 items-start justify-end pt-5 sm:h-[82px] sm:pt-7"><BetaAndAvatar email={userEmail} onOpenImport={onOpenImport} /></div>
      <div className="flex flex-none flex-col items-center justify-start py-5 sm:py-7 md:min-h-0 md:flex-1 md:justify-center">
      <div className="mx-auto w-full max-w-[920px]">
        <div className="text-center">
          <h1 className="flex items-center justify-center gap-3 text-[28px] font-medium tracking-[-0.02em] sm:text-[36px]"><OcredaMark className="h-9 w-9 sm:h-10 sm:w-10" /> Welcome to Ocreda, {displayName || 'you'}</h1>
          <p className="mt-2 text-base text-[#777] sm:text-lg">Let your knowledge proactively come to you without asking</p>
        </div>
        {onTrySamples && <>
          <div className="mt-[clamp(28px,4vh,48px)] flex flex-col items-center gap-4 rounded-[20px] border border-[#a8c4ff] bg-[#edf3ff] px-6 py-5 text-center sm:flex-row sm:text-left">
            <div className="min-w-0 flex-1">
              <h2 className="text-[17px] font-semibold text-[#1b3f88]">See it work before you add anything</h2>
              <p className="mt-1 text-sm leading-relaxed text-[#555]">Explore 68 sample notes kept by a made-up PhD student. Your own notes stay separate, and you can switch back any time.</p>
            </div>
            <button type="button" onClick={onTrySamples} className="h-10 shrink-0 rounded-md bg-[#477bea] px-5 text-sm font-medium text-white hover:bg-[#3d6ed7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea] focus-visible:ring-offset-2">Try it with sample notes</button>
          </div>
          <h2 className="mt-8 text-center text-sm font-normal text-[#8d8d92]">Or start with my own notes</h2>
        </>}
        <div className={`${onTrySamples ? 'mt-4' : 'mt-[clamp(32px,5vh,64px)]'} grid items-start gap-4 md:grid-cols-2`}>
          <NoteImporter onImport={onImport} importError={importError} existingDomains={existingDomains} />
          <div className="flex min-h-[338px] flex-col items-center rounded-[20px] bg-[#f6f6f8] px-8 py-8 text-center">
            <h2 className="text-[17px] font-semibold">Add one note to start.</h2>
            <p className="mt-2 max-w-[330px] text-base leading-relaxed text-[#777]">This way there is a cold start, but you will<br className="hidden sm:block" /> start cleanly.</p>
            <button type="button" onClick={onAddNote} aria-label="Add one note" className="mt-20 flex h-9 w-[145px] items-center justify-center rounded-md bg-[#477bea] text-white hover:bg-[#3d6ed7]"><Plus className="h-5 w-5" /></button>
          </div>
        </div>
        {progress && <div className="mt-6" aria-live="polite"><div className="h-1.5 overflow-hidden rounded-full bg-[#eee]"><div className="h-full bg-[#477bea] transition-all" style={{ width: `${Math.round((progress.completed / progress.total) * 100)}%` }} /></div><p className="mt-2 text-center text-sm text-[#777]">Uploading and organizing {progress.completed} of {progress.total} notes</p></div>}
      </div>
      </div>
    </div>
  );
}

/**
 * Writing a note is the main thing people do, so it has one labelled button
 * in the same corner of Home and of every Domain (decided Nov 25).
 */
function NewNoteButton({ onClick, label, className }: { onClick: () => void; label: string; className: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className={`absolute z-30 flex h-14 items-center gap-2 rounded-full bg-[#477bea] pl-5 pr-6 text-[15px] font-medium text-white shadow-[0_8px_24px_rgba(71,123,234,0.45)] transition hover:-translate-y-0.5 hover:bg-[#3d6ed7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea] focus-visible:ring-offset-2 ${className}`}>
      <Plus className="h-5 w-5" /> New note
    </button>
  );
}

/** A note with no Domain yet: none at all, or still in Orphans. */
function isUnsortedNote(note: Note): boolean {
  const category = cleanCategory(note.category);
  return !category || category.toLowerCase() === ORPHANS_MUSE.toLowerCase();
}

/** When something last happened in a note: written, or moved into its Domain. */
function noteActivity(note: Note): string {
  const moved = note.category_updated_at ?? '';
  return moved > note.created_at ? moved : note.created_at;
}

function shortNoteDate(value: string): string {
  const date = new Date(value);
  const today = localDateKey(new Date().toISOString());
  if (localDateKey(value) === today) return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(date);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

/** The lists behind the Home bar's two halves, in a sheet like the note's suggestions. */
function HomeBarSheet({ kind, muses, notes, notesByMuse, busy, onClose, onOpenMuse, onOpenNote, onManageDomains, onMoveNote }: {
  kind: 'domains' | 'notes'; muses: MuseMeta[]; notes: Note[]; notesByMuse: Map<string, Note[]>; busy: boolean;
  onClose: () => void; onOpenMuse: (title: string) => void; onOpenNote: (note: Note) => void; onManageDomains: () => void;
  onMoveNote: (noteId: string, domain: string) => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const realDomains = muses.filter((muse) => muse.title.toLowerCase() !== ORPHANS_MUSE.toLowerCase());
  const domainRows = realDomains
    .map((muse) => {
      const items = notesByMuse.get(muse.title) ?? [];
      const last = items.reduce((latest, note) => { const at = noteActivity(note); return at > latest ? at : latest; }, '');
      return { muse, count: items.length, last };
    })
    // Most recently used first; Domains with no notes yet go last, newest first.
    .sort((a, b) => (b.last || '').localeCompare(a.last || '') || b.muse.createdAt.localeCompare(a.muse.createdAt));

  const unsorted = notes.filter(isUnsortedNote).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const sorted = notes.filter((note) => !isUnsortedNote(note)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const todayKey = localDateKey(new Date().toISOString());
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const groups: { label: string; items: Note[] }[] = [
    { label: 'Today', items: sorted.filter((note) => localDateKey(note.created_at) === todayKey) },
    { label: 'This week', items: sorted.filter((note) => localDateKey(note.created_at) !== todayKey && note.created_at >= weekAgo) },
    { label: 'Earlier', items: sorted.filter((note) => note.created_at < weekAgo) },
  ].filter((group) => group.items.length);

  const noteRow = (note: Note) => (
    <button type="button" onClick={() => onOpenNote(note)} className="flex w-full min-w-0 flex-col gap-0.5 rounded-lg px-3 py-2.5 text-left hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]">
      <span className="flex min-w-0 items-baseline gap-3"><span className="min-w-0 flex-1 truncate text-sm font-medium text-[#222]">{noteLabel(note)}</span><span className="shrink-0 text-xs text-[#999]">{shortNoteDate(note.created_at)}</span></span>
      <span className="truncate text-xs text-[#8d8d92]">{cleanCategory(note.category) || ORPHANS_MUSE}{notePreview(note) && notePreview(note) !== noteLabel(note) ? ` · ${notePreview(note)}` : ''}</span>
    </button>
  );

  return (
    <div className="fixed inset-0 z-50">
      <button type="button" onClick={onClose} aria-label="Close" tabIndex={-1} className="absolute inset-0 h-full w-full cursor-default bg-black/20" />
      <section role="dialog" aria-modal="true" aria-label={kind === 'domains' ? 'Your Domains' : 'All notes'} className="absolute inset-x-0 bottom-0 mx-auto flex h-[72%] w-full max-w-[640px] flex-col overflow-hidden rounded-t-[20px] bg-[#F7F7F8] shadow-[0_-10px_30px_rgba(10,10,20,0.18)]">
        <button type="button" {...tapOrSwipe(onClose)} aria-label="Close list" title="Close" className="flex h-10 shrink-0 select-none items-center justify-center"><span className="h-[5px] w-10 rounded-full bg-[#C9C9CF]" aria-hidden="true" /></button>
        <h2 className="shrink-0 px-6 pb-2 text-sm font-semibold text-[#222]">{kind === 'domains' ? `${realDomains.length} ${realDomains.length === 1 ? 'Domain' : 'Domains'}` : `${notes.length} ${notes.length === 1 ? 'Note' : 'Notes'}`}</h2>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-8">
          {kind === 'domains' ? <>
            {domainRows.length === 0 && <p className="px-3 py-6 text-sm text-[#8d8d92]">No Domains yet.</p>}
            <ul>
              {domainRows.map(({ muse, count, last }) => <li key={muse.title}>
                <button type="button" onClick={() => onOpenMuse(muse.title)} className="flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]">
                  <Layers3 className="h-4 w-4 shrink-0 text-[#477bea]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-[#222]">{muse.title}</span>
                    <span className="block truncate text-xs text-[#8d8d92]">{count} {count === 1 ? 'note' : 'notes'}{last ? ` · last used ${shortNoteDate(last)}` : ''}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-[#bbb]" />
                </button>
              </li>)}
            </ul>
            <button type="button" onClick={onManageDomains} className="mt-3 px-3 text-sm text-[#477bea] hover:text-[#315fc5]">Manage Domains</button>
          </> : <>
            {unsorted.length > 0 && <section aria-label="Notes that need a Domain" className="mb-4 rounded-xl border border-[#f3d3b4] bg-[#fff7ef] p-2">
              <h3 className="px-3 pb-1 pt-2 text-xs font-semibold text-[#b4570f]">{unsorted.length} {unsorted.length === 1 ? 'note needs' : 'notes need'} a Domain</h3>
              <ul>
                {unsorted.map((note) => <li key={note.id} className="flex min-w-0 items-center gap-2">
                  <div className="min-w-0 flex-1">{noteRow(note)}</div>
                  {realDomains.length > 0 && <select aria-label={`Move “${noteLabel(note)}” to a Domain`} value="" disabled={busy} onChange={(event) => { if (event.target.value) onMoveNote(note.id, event.target.value); }} className="h-9 max-w-[42%] shrink-0 rounded-md border border-[#e0e0e0] bg-white px-2 text-xs text-[#477bea] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea] disabled:opacity-50">
                    <option value="">Move to…</option>
                    {realDomains.map((muse) => <option key={muse.title} value={muse.title}>{muse.title}</option>)}
                  </select>}
                </li>)}
              </ul>
            </section>}
            {groups.map((group) => <section key={group.label} aria-label={group.label} className="mb-3">
              <h3 className="px-3 pb-1 pt-2 text-xs font-normal text-[#8d8d92]">{group.label}</h3>
              <ul>{group.items.map((note) => <li key={note.id}>{noteRow(note)}</li>)}</ul>
            </section>)}
            {notes.length === 0 && <p className="px-3 py-6 text-sm text-[#8d8d92]">No notes yet.</p>}
          </>}
        </div>
      </section>
    </div>
  );
}

function CortexHome({ vaults, onOpenVault, onToggleVaultRetrieval, onRemoveVault, projects, muses, pinnedMuseTitles, notes, notesByMuse, userEmail, busy, onOpenMuses, onOpenMuse, onTogglePin, onAddMuse, onAddNote, onOpenImport, onOpenPage, onOpenNote, onMoveNote }: {
  vaults: Vault[]; onOpenVault: (vault: Vault) => void; onToggleVaultRetrieval: (vault: Vault) => void; onRemoveVault: (vault: Vault) => void;
  projects: CortexProject[]; muses: MuseMeta[]; pinnedMuseTitles: string[]; notes: Note[]; notesByMuse: Map<string, Note[]>; userEmail: string; busy: boolean;
  onOpenMuses: () => void; onOpenMuse: (title: string) => void; onTogglePin: (title: string) => void; onAddMuse: () => void; onAddNote: () => void; onOpenImport: () => void;
  onOpenPage: (project: CortexProject, page: ProjectPage) => void; onOpenNote: (note: Note) => void;
  onMoveNote: (noteId: string, domain: string) => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [barSheet, setBarSheet] = useState<'domains' | 'notes' | null>(null);
  const unsortedCount = notes.filter(isUnsortedNote).length;
  // Orphans is counted as unsorted notes, not as a Domain.
  const domainCount = muses.filter((muse) => muse.title.toLowerCase() !== ORPHANS_MUSE.toLowerCase()).length;
  const pinnedMuses = pinnedMuseTitles.map((title) => muses.find((muse) => muse.title.toLowerCase() === title.toLowerCase())).filter((muse): muse is MuseMeta => Boolean(muse));
  const unpinnedMuses = muses.filter((muse) => !pinnedMuseTitles.some((title) => title.toLowerCase() === muse.title.toLowerCase()));

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-white">
      <header className="relative z-20 flex h-[88px] shrink-0 items-center border-b border-[#eeeeef] px-5 sm:px-8">
        <div className="flex items-center gap-2 text-[#222]">
          <button type="button" onClick={() => setSearchOpen(true)} aria-label="Search notes, pages, and Domains" title="Search notes, pages, and Domains" className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-[#f5f5f6]"><Search className="h-5 w-5" /></button>
          <button type="button" onClick={onOpenImport} aria-label="Import notes" title="Import notes" className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-[#f5f5f6]"><Upload className="h-5 w-5" /></button>
        </div>
        <h1 className="pointer-events-none absolute left-1/2 hidden -translate-x-1/2 text-sm font-normal text-[#b2b2b2] lg:block lg:text-base">Your knowledge</h1>
        <div className="ml-auto"><BetaAndAvatar email={userEmail} feedback onOpenImport={onOpenImport} /></div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-5 pb-40 pt-10 md:pb-28 sm:px-10 lg:px-16">
        {pinnedMuses.length > 0 && <section className="mx-auto mb-14 w-full max-w-[1450px]" aria-label="Pinned Domains">
          <h2 className="mb-6 text-sm font-normal text-[#8d8d92]">Pinned Domains</h2>
          <div className="grid grid-cols-1 gap-x-12 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
            {pinnedMuses.map((muse) => <MuseHomeCard key={muse.title} muse={muse} notes={notesByMuse.get(muse.title) ?? []} pinned onClick={() => onOpenMuse(muse.title)} onTogglePin={() => onTogglePin(muse.title)} />)}
          </div>
        </section>}
        <section className="mx-auto w-full max-w-[1450px]">
          <div className="mb-6 flex items-center justify-between">
            <h2 className="text-sm font-normal text-[#8d8d92]">Domains</h2>
            <button type="button" onClick={onAddMuse} className="text-sm text-[#477bea] hover:text-[#315fc5]">New Domain</button>
          </div>
          <div className="grid grid-cols-1 gap-x-12 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
            {unpinnedMuses.map((muse) => <MuseHomeCard key={muse.title} muse={muse} notes={notesByMuse.get(muse.title) ?? []} pinned={false} onClick={() => onOpenMuse(muse.title)} onTogglePin={() => onTogglePin(muse.title)} />)}
          </div>
        </section>
        {vaults.length > 0 && <section className="mx-auto mt-14 w-full max-w-[1450px]" aria-label="Shared with me">
          <div className="mb-6">
            <h2 className="text-sm font-normal text-[#8d8d92]">Shared with me</h2>
            <p className="mt-1 text-xs text-[#aaa]">Notes other people shared, one vault each. Ocreda brings them up while you write; they stay as they wrote them.</p>
          </div>
          <div className="grid grid-cols-1 gap-x-12 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
            {vaults.map((vault) => <VaultHomeCard key={vault.id} vault={vault} onOpen={() => onOpenVault(vault)} onToggleRetrieval={() => onToggleVaultRetrieval(vault)} onRemove={() => onRemoveVault(vault)} />)}
          </div>
        </section>}
      </main>

      {/* Each half opens its own list (decided Nov 25); the Notes half also counts notes still waiting for a Domain. */}
      <div className="absolute bottom-0 left-1/2 z-20 flex h-16 w-[min(88vw,420px)] -translate-x-1/2 items-stretch overflow-hidden rounded-t-[52px] border border-b-0 border-[#e0e0e0] bg-white text-xs text-[#777] shadow-[0_-4px_16px_rgba(0,0,0,0.10)] transition hover:h-[70px]">
        <button type="button" onClick={() => setBarSheet('domains')} aria-label={`Open your ${domainCount} Domains`} className="flex flex-1 items-center justify-center gap-2 pl-6 hover:text-[#222] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#477bea]">
          <Layers3 className="h-4 w-4 text-[#477bea]" /> {domainCount} {domainCount === 1 ? 'Domain' : 'Domains'}
        </button>
        <span className="my-4 w-px bg-[#ececef]" aria-hidden="true" />
        <button type="button" onClick={() => setBarSheet('notes')} aria-label={`Open all ${notes.length} notes${unsortedCount ? `, ${unsortedCount} ${unsortedCount === 1 ? 'needs' : 'need'} a Domain` : ''}`} className="flex flex-1 items-center justify-center gap-1.5 pr-6 hover:text-[#222] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#477bea]">
          <span>{notes.length} {notes.length === 1 ? 'Note' : 'Notes'}</span>
          {unsortedCount > 0 && <span className="flex items-center gap-1 text-[#b4570f]"><span aria-hidden="true">·</span><span className="h-1.5 w-1.5 rounded-full bg-[#e8892f]" aria-hidden="true" />{unsortedCount} unsorted</span>}
        </button>
      </div>

      {/* On a phone the bar spans the width, so the button sits just above it. */}
      <NewNoteButton onClick={onAddNote} label="Write a new note" className="bottom-[84px] right-4 md:bottom-6 md:right-8" />

      {barSheet && <HomeBarSheet kind={barSheet} muses={muses} notes={notes} notesByMuse={notesByMuse} busy={busy} onClose={() => setBarSheet(null)} onOpenMuse={(title) => { setBarSheet(null); onOpenMuse(title); }} onOpenNote={(note) => { setBarSheet(null); onOpenNote(note); }} onManageDomains={() => { setBarSheet(null); onOpenMuses(); }} onMoveNote={onMoveNote} />}

      {searchOpen && <KnowledgeSearchOverlay request={{ query: '' }} notes={notes} sharedNotes={vaults.flatMap((vault) => vault.notes)} muses={muses} projects={projects} hideProjectColumn onClose={() => setSearchOpen(false)} onOpenPage={(project, page) => { setSearchOpen(false); onOpenPage(project, page); }} onOpenNote={(note) => { setSearchOpen(false); onOpenNote(note); }} />}
    </div>
  );
}

function MuseHomeCard({ muse, notes, pinned, onClick, onTogglePin }: { muse: MuseMeta; notes: Note[]; pinned: boolean; onClick: () => void; onTogglePin: () => void }) {
  const preview = muse.description.trim() || notes.slice(0, 3).map((note) => noteLabel(note)).join('\n') || 'Add notes to build this Domain.';
  return (
    <div className="relative h-[286px]">
      <button type="button" onClick={onClick} aria-label={`Open ${muse.title} Domain`} className="relative flex h-full w-full flex-col overflow-hidden rounded-md border border-[#e0e0e0] bg-[#f7f7f9] p-2 text-left shadow-[0_2px_9px_rgba(0,0,0,0.14)] transition hover:-translate-y-0.5 hover:border-[#8fb1ff] hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]">
        <span className="block min-h-0 flex-1 overflow-hidden rounded bg-white px-5 py-5 text-sm leading-relaxed text-[#777]"><span className="line-clamp-[9] whitespace-pre-line">{preview}</span></span>
        <span className="flex h-10 w-full shrink-0 items-center justify-between gap-3 px-3 pr-11 text-xs"><strong className="min-w-0 truncate font-semibold text-[#666]">{muse.title}</strong><span className="shrink-0 text-[#999]">{notes.length} {notes.length === 1 ? 'entry' : 'entries'}</span></span>
      </button>
      <button type="button" onClick={onTogglePin} aria-label={`${pinned ? 'Unpin' : 'Pin'} ${muse.title} Domain`} aria-pressed={pinned} title={pinned ? 'Unpin Domain' : 'Pin Domain'} className={`absolute bottom-3 right-3 z-10 flex h-8 w-8 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea] ${pinned ? 'text-[#477bea]' : 'text-[#aaa] hover:bg-white hover:text-[#477bea]'}`}><Pin className={`h-4 w-4 ${pinned ? 'fill-current' : ''}`} /></button>
    </div>
  );
}

function ProjectPagesGrid({ project, onBack, onAddPage, onOpenPage, onEdit, onDelete }: {
  project: CortexProject; onBack: () => void; onAddPage: () => void; onOpenPage: (page: ProjectPage) => void; onEdit: () => void; onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return <div className="flex h-full min-h-0 flex-col bg-[#bdbdbd] p-3 sm:p-5">
    <header className="relative flex h-14 shrink-0 items-center px-1 text-white sm:px-2">
      <button type="button" onClick={onBack} aria-label="Close project" title="Close project" className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-white/10"><X className="h-6 w-6" /></button>
      <button type="button" onClick={onAddPage} aria-label="Add page" title="Add page" className="ml-2 flex h-8 w-24 items-center justify-center rounded-md bg-[#477bea] hover:bg-[#3d6ed7]"><Plus className="h-5 w-5" /></button>
      <h1 className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-sm text-white/80">{project.title}</h1>
      <div className="relative ml-auto"><button type="button" onClick={() => setMenuOpen((open) => !open)} aria-label="Project options" className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-white/10"><MoreHorizontal className="h-5 w-5" /></button>{menuOpen && <div className="absolute right-0 top-11 z-20 w-40 overflow-hidden rounded-lg border border-[#ddd] bg-white py-1 text-sm text-[#222] shadow-xl"><button type="button" onClick={() => { setMenuOpen(false); onEdit(); }} className="block w-full px-4 py-2.5 text-left hover:bg-[#f5f5f5]">Edit project</button><button type="button" onClick={() => { setMenuOpen(false); onDelete(); }} className="block w-full px-4 py-2.5 text-left text-red-600 hover:bg-red-50">Delete project</button></div>}</div>
    </header>
    <main className="min-h-0 flex-1 overflow-y-auto rounded-2xl bg-white px-6 py-12 shadow-2xl sm:px-12 lg:px-20">
      {project.description && <p className="mx-auto mb-12 max-w-4xl text-center text-sm leading-relaxed text-[#888]">{project.description}</p>}
      <div className="mx-auto grid max-w-[1350px] grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {project.pages.map((page) => <button key={page.id} type="button" onClick={() => onOpenPage(page)} title={page.title || undefined} className="flex h-[300px] flex-col overflow-hidden rounded-lg border border-[#e3e3e5] bg-white p-6 text-left shadow-[0_2px_8px_rgba(0,0,0,0.1)] transition hover:-translate-y-0.5 hover:border-[#7ca2ff]"><strong className="line-clamp-2 shrink-0 text-base leading-snug">{page.title}</strong><span className="mt-4 block min-h-0 flex-1 overflow-hidden"><span className="line-clamp-[7] whitespace-pre-wrap text-sm leading-relaxed text-[#777]">{page.content || 'Start writing on this page.'}</span></span><span className="mt-4 flex shrink-0 justify-between text-xs text-[#aaa]"><span>Page</span><span>{formatDate(page.updatedAt)}</span></span></button>)}
        <button type="button" onClick={onAddPage} className="flex h-[300px] items-center justify-center rounded-lg border border-dashed border-[#c9d7fa] text-[#477bea] hover:bg-[#f8faff]"><FolderPlus className="h-9 w-9 stroke-[1.6]" /></button>
      </div>
      {!project.pages.length && <p className="mt-8 text-center text-sm text-[#999]">This project is ready for its first page.</p>}
    </main>
  </div>;
}

function ProjectPageWorkspace({ project, page, notes, muses, projects, saving, onBack, onChange, onAddNote, onOpenNote, onOpenPage, onDelete }: {
  project: CortexProject; page: ProjectPage; notes: Note[]; muses: MuseMeta[]; projects: CortexProject[]; saving: boolean;
  onBack: () => void; onChange: (page: ProjectPage) => void;
  onAddNote: () => void; onOpenNote: (note: Note) => void; onOpenPage: (project: CortexProject, page: ProjectPage) => void; onDelete: () => void;
}) {
  const [title, setTitle] = useState(page.title);
  const [content, setContent] = useState(page.content);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [contextOpen, setContextOpen] = useState(true);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [searchRequest, setSearchRequest] = useState<KnowledgeSearchRequest | null>(null);
  const latestChangeRef = useRef(onChange);
  latestChangeRef.current = onChange;

  useEffect(() => {
    if (content === page.content && title === page.title) return;
    setSaveState('saving');
    const timeout = window.setTimeout(() => {
      latestChangeRef.current({ ...page, title: title.trim() || 'Untitled page', content });
      setSaveState('saved');
    }, 550);
    return () => window.clearTimeout(timeout);
  }, [content, page, title]);

  const surfacedNotes = useMemo(() => {
    const context = `${project.title} ${project.description} ${title} ${content}`;
    const ranked = notes.map((note) => ({ note, score: sharedWordScore(context, note.raw_text) }))
      .sort((left, right) => right.score - left.score || right.note.created_at.localeCompare(left.note.created_at));
    const related = ranked.filter((item) => item.score > 0);
    return (related.length ? related : ranked).slice(0, 8).map((item) => item.note);
  }, [content, notes, project.description, project.title, title]);

  useEffect(() => {
    setSelectedNoteId((current) => surfacedNotes.some((note) => note.id === current) ? current : surfacedNotes[0]?.id ?? null);
  }, [surfacedNotes]);

  const selectedNote = surfacedNotes.find((note) => note.id === selectedNoteId) ?? surfacedNotes[0] ?? null;
  const selectedContent = selectedNote ? splitNote(selectedNote) : null;

  const leave = () => {
    if (content !== page.content || title !== page.title) latestChangeRef.current({ ...page, title: title.trim() || 'Untitled page', content });
    onBack();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-white p-3 sm:p-5">
      <header className="relative flex h-14 shrink-0 items-center px-1 sm:px-2">
        <button type="button" onClick={leave} aria-label="Back to project pages" title="Back to project pages" className="flex h-9 w-9 items-center justify-center rounded-md text-[#777] hover:bg-[#f4f4f4]"><ArrowLeft className="h-5 w-5" /></button>
        <span className="mx-3 h-7 w-px bg-[#e5e5e5]" />
        <button type="button" onClick={onAddNote} aria-label="Add a note" title="Add a note" className="flex h-8 w-8 items-center justify-center rounded-md bg-[#477bea] text-white hover:bg-[#3d6ed7]"><Plus className="h-5 w-5" /></button>
        <button type="button" onClick={() => setSearchRequest({ query: '' })} aria-label="Search notes, pages, and Domains" title="Search notes, pages, and Domains" className="flex h-9 w-9 items-center justify-center rounded-md text-[#777] hover:bg-[#f4f4f4]"><Search className="h-5 w-5" /></button>
        <button type="button" onClick={() => setContextOpen((open) => !open)} aria-label={contextOpen ? 'Close retrieved knowledge panels' : 'Open retrieved knowledge panels'} title={contextOpen ? 'Close retrieved knowledge panels' : 'Open retrieved knowledge panels'} aria-expanded={contextOpen} className="ml-1 flex h-9 items-center gap-2 rounded-md px-2 text-xs text-[#777] hover:bg-[#f4f4f4]"><PanelRightOpen className={`h-5 w-5 transition-transform ${contextOpen ? '' : 'rotate-180'}`} /><span className="hidden lg:inline">{contextOpen ? 'Hide retrieval' : 'Show retrieval'}</span></button>
        <span className="pointer-events-none absolute left-1/2 hidden -translate-x-1/2 text-sm text-[#aaa] sm:block">{project.title}</span>
        <div className="relative ml-auto flex items-center gap-2">
          <span className="text-xs text-[#aaa]">{saveState === 'saving' ? 'Saving...' : saveState === 'saved' ? 'Saved' : ''}</span>
          <button type="button" onClick={onDelete} aria-label="Delete page" title="Delete page" className="flex h-9 w-9 items-center justify-center rounded-md text-red-600 hover:bg-red-50"><Trash2 className="h-4 w-4" /></button>
        </div>
      </header>

      <div className={`grid min-h-0 flex-1 overflow-y-auto rounded-xl border border-[#d8d8d8] bg-[#f7f7f9] shadow-[0_2px_9px_rgba(0,0,0,0.13)] lg:overflow-hidden ${contextOpen ? 'lg:grid-cols-[minmax(0,1.05fr)_minmax(330px,.92fr)_330px]' : 'lg:grid-cols-1'}`}>
        <section className="min-h-[520px] overflow-y-auto bg-white px-7 pb-12 pt-12 shadow-[4px_0_12px_rgba(0,0,0,0.12)] sm:px-14 lg:px-[8%]">
          <div className="mx-auto max-w-3xl">
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} aria-label="Page title" className="w-full bg-transparent text-2xl font-semibold text-[#222] outline-none" />
            <p className="mt-3 text-xs text-[#aaa]">Page in {project.title}</p>
            <textarea autoFocus value={content} onChange={(event) => setContent(event.target.value)} placeholder="Write freely. Related notes will surface as your thoughts develop." aria-label={`${title || 'Untitled'} page content`} className="mt-10 min-h-[520px] w-full resize-none bg-transparent text-base leading-[1.7] text-[#333] outline-none placeholder:text-[#b0b0b0]" />
          </div>
        </section>
        {contextOpen && <section className="relative min-h-[420px] overflow-y-auto border-l border-[#dedede] bg-[#f7f7f9] px-8 pb-12 pt-14 sm:px-12 lg:min-h-0">
          {selectedContent && selectedNote ? <article className="mx-auto max-w-xl">{selectedContent.hasTitle && <h2 className="text-lg font-semibold">{selectedContent.title}</h2>}<p className="mt-6 whitespace-pre-wrap text-sm leading-[1.6] text-[#333]">{selectedContent.body || selectedNote.raw_text}</p><div className="mt-8 border-t border-[#ddd] pt-4 text-xs text-[#999]">Domain: {cleanCategory(selectedNote.category) || ORPHANS_MUSE} · {fullNoteDate(selectedNote.created_at)}</div></article> : <div className="flex h-full items-center justify-center text-center"><div><h2 className="text-lg font-semibold">Write to retrieve your knowledge.</h2><p className="mt-3 max-w-sm text-sm leading-relaxed text-[#777]">Related text will appear here as your page develops.</p></div></div>}
        </section>}
        {contextOpen && <aside className="min-h-[420px] overflow-y-auto border-l border-[#dedede] bg-white p-4 lg:min-h-0">
          <h2 className="mb-4 text-center text-sm font-normal text-[#999]">Retrieved for this page</h2>
          <div className="space-y-4">
            {surfacedNotes.map((note) => { const noteContent = splitNote(note); return <button key={note.id} type="button" title={noteContent.title || undefined} onMouseEnter={() => setSelectedNoteId(note.id)} onFocus={() => setSelectedNoteId(note.id)} onClick={() => onOpenNote(note)} className={`flex h-[190px] w-full flex-col overflow-hidden rounded-md border bg-white p-4 text-left shadow-[0_2px_8px_rgba(0,0,0,0.08)] transition hover:border-[#8fb1ff] ${selectedNoteId === note.id ? 'border-[#7ca2ff] ring-1 ring-[#7ca2ff]/30' : 'border-[#e3e3e5]'}`}><span className="flex shrink-0 items-start gap-2">{noteContent.hasTitle && <strong className="line-clamp-2 min-w-0 flex-1 text-sm leading-snug">{defaultNoteTitle(noteContent.title)}</strong>}<span className="ml-auto shrink-0 text-[11px] text-[#477bea]">note</span></span><span className="mt-2 block min-h-0 flex-1 overflow-hidden"><span className="line-clamp-4 text-xs leading-relaxed text-[#777]">{noteContent.body ? previewNoteText(noteContent.body) : notePreview(note)}</span></span><span className="mt-2 flex shrink-0 items-center justify-between gap-2 text-[11px] text-[#aaa]"><span className="min-w-0 truncate">Domain: {cleanCategory(note.category) || ORPHANS_MUSE}</span><span className="shrink-0">{formatDate(note.created_at)}</span></span></button>; })}
            {!surfacedNotes.length && <p className="px-4 py-12 text-center text-sm leading-relaxed text-[#999]">Related notes will appear here as your knowledge base grows.</p>}
          </div>
        </aside>}
      </div>
      {searchRequest && <KnowledgeSearchOverlay request={searchRequest} notes={notes} muses={muses} projects={projects} onClose={() => setSearchRequest(null)} onOpenPage={(nextProject, nextPage) => { setSearchRequest(null); onOpenPage(nextProject, nextPage); }} onOpenNote={(note) => { setSearchRequest(null); onOpenNote(note); }} />}
    </div>
  );
}

type LibrarySort = 'newest' | 'oldest' | 'random' | 'date';
type LibraryLayout = 'grid' | 'large';

function MuseGrid({ muses, projects, notes, notesByMuse, busy, onClose, onAddNote, onAddMuse, onEditMuse, onDeleteMuse, onOpenNote }: {
  muses: MuseMeta[]; projects: CortexProject[]; notes: Note[]; notesByMuse: Map<string, Note[]>; busy: boolean;
  onClose: () => void;
  onAddNote: (muse?: string) => void; onAddMuse: () => void; onEditMuse: (muse: MuseMeta) => void;
  onDeleteMuse: (title: string) => void; onOpenNote: (note: Note) => void;
}) {
  const [selectedMuses, setSelectedMuses] = useState<Set<string>>(new Set());
  const [layout, setLayout] = useState<LibraryLayout>('grid');
  const [sort, setSort] = useState<LibrarySort>('newest');
  const [randomSeed, setRandomSeed] = useState(() => Date.now());
  const [sortOpen, setSortOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [date, setDate] = useState('');
  const [musesOpen, setMusesOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || searchOpen || sortOpen || musesOpen) return;
      if (document.querySelector('[aria-modal="true"], [role="status"]')) return;
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [musesOpen, onClose, searchOpen, sortOpen]);

  const visibleNotes = useMemo(() => {
    const cleanQuery = query.trim().toLowerCase();
    const filtered = notes.filter((note) => {
      const muse = cleanCategory(note.category);
      if (selectedMuses.size && (!muse || !Array.from(selectedMuses).some((item) => item.toLowerCase() === muse.toLowerCase()))) return false;
      if (date && localDateKey(note.created_at) !== date) return false;
      return !cleanQuery || note.raw_text.toLowerCase().includes(cleanQuery) || (muse ?? '').toLowerCase().includes(cleanQuery);
    });
    if (sort === 'oldest') return [...filtered].sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (sort === 'random') return [...filtered].sort((a, b) => stableHash(`${a.id}-${randomSeed}`) - stableHash(`${b.id}-${randomSeed}`));
    return [...filtered].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [date, notes, query, randomSeed, selectedMuses, sort]);

  const firstSelectedMuse = Array.from(selectedMuses)[0];
  const resetLibrary = () => { setSelectedMuses(new Set()); setQuery(''); setSearchOpen(false); setDate(''); setSort('newest'); setSortOpen(false); };
  const toggleLibraryMuse = (title: string) => setSelectedMuses((current) => { const next = new Set(current); if (next.has(title)) next.delete(title); else next.add(title); return next; });

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-white">
      <header className="relative z-20 flex h-[112px] shrink-0 items-end gap-3 overflow-x-auto bg-[#bdbdbd] px-5 pb-4 pt-10 lg:px-7">
        <button type="button" onClick={resetLibrary} className={`h-9 min-w-[96px] shrink-0 rounded-md px-7 text-sm shadow-[0_3px_7px_rgba(0,0,0,0.18)] transition-colors ${selectedMuses.size === 0 ? 'bg-[#202020] text-white' : 'bg-white text-[#222] hover:bg-[#f7f7f7]'}`}>All</button>
        {muses.slice(0, 5).map((muse) => <button key={muse.title} type="button" onClick={() => toggleLibraryMuse(muse.title)} aria-pressed={selectedMuses.has(muse.title)} className={`h-9 min-w-[174px] shrink-0 rounded-md px-5 text-sm shadow-[0_3px_7px_rgba(0,0,0,0.16)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${selectedMuses.has(muse.title) ? 'bg-[#202020] text-white' : 'bg-[#fbfbfd] text-[#ababaf] hover:bg-white hover:text-[#222]'}`}>{muse.title}</button>)}
        <span aria-hidden="true" className="mx-1 h-8 w-px shrink-0 bg-white/65" />
        <button type="button" onClick={() => setMusesOpen(true)} className="ml-auto h-9 min-w-[148px] shrink-0 rounded-md bg-white px-7 text-sm text-[#222] shadow-[0_3px_7px_rgba(0,0,0,0.16)] hover:bg-[#f8f8f8]">See all</button>
        <button type="button" onClick={onAddMuse} className="h-9 min-w-[140px] shrink-0 rounded-md border border-white/90 bg-transparent px-7 text-sm text-white shadow-sm hover:bg-white/10">New Domain</button>
        <button type="button" onClick={onClose} aria-label="Close note library" title="Close note library" className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-md text-white drop-shadow hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"><X className="h-6 w-6" /></button>
      </header>

      <div className="flex min-h-0 flex-1 bg-white">
        <aside className="relative z-10 hidden w-[118px] shrink-0 flex-col items-center justify-center border-r border-[#f1f1f2] py-8 text-[#aaa] sm:flex lg:w-[138px]">
          <button type="button" onClick={() => onAddNote(selectedMuses.size === 1 ? firstSelectedMuse : undefined)} aria-label="Add note" title="Add note" className="flex h-10 w-10 items-center justify-center rounded-md bg-[#477bea] text-white shadow-[0_3px_7px_rgba(0,0,0,0.2)] hover:bg-[#3d6ed7]"><Plus className="h-5 w-5" /></button>
          <span className="mt-16 text-center text-xs text-[#477bea]">{visibleNotes.length} {visibleNotes.length === 1 ? 'entry' : 'entries'}</span>
          <div className="relative mt-7">
            <button type="button" onClick={() => setSortOpen((open) => !open)} aria-label="Sort notes" title="Sort notes" className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-[#f4f4f4]"><Filter className="h-5 w-5" /></button>
            {sortOpen && <div className="absolute left-11 top-0 z-30 w-28 rounded-md border border-[#e5e5e5] bg-white p-2 text-left text-xs text-[#aaa] shadow-xl">{(['newest', 'oldest', 'random', 'date'] as LibrarySort[]).map((option) => <button key={option} type="button" onClick={() => { setSort(option); if (option === 'random') setRandomSeed(Date.now()); if (option !== 'date') setDate(''); setSortOpen(false); }} className={`block w-full rounded px-2 py-1.5 capitalize hover:bg-[#f5f5f5] ${sort === option ? 'text-[#222]' : ''}`}>{option}</button>)}</div>}
          </div>
          {sort === 'date' && <input type="date" value={date} onChange={(event) => setDate(event.target.value)} aria-label="Filter by date" className="mt-3 w-[82px] rounded border border-[#ddd] px-1 py-1 text-[9px] text-[#555] sm:w-24 sm:text-[10px]" />}
          <button type="button" onClick={() => setLayout((value) => value === 'grid' ? 'large' : 'grid')} aria-label={layout === 'grid' ? 'Use large card view' : 'Use grid view'} title={layout === 'grid' ? 'Use large card view' : 'Use grid view'} aria-pressed={layout === 'grid'} className={`mt-3 flex h-10 w-10 items-center justify-center rounded-md transition ${layout === 'grid' ? 'bg-[#f4f4f6] text-[#777]' : 'hover:bg-[#f4f4f4]'}`}>{layout === 'grid' ? <Grid2X2 className="h-5 w-5" /> : <Rows3 className="h-5 w-5" />}</button>
          <button type="button" onClick={() => { setSearchOpen((open) => !open); if (searchOpen) setQuery(''); }} aria-label="Search notes" title="Search notes" className="mt-3 flex h-10 w-10 items-center justify-center rounded-md hover:bg-[#f4f4f4]"><Search className="h-5 w-5" /></button>
        </aside>

        <section className="min-w-0 flex-1 overflow-y-auto px-5 pt-10 sm:px-8 lg:px-12 lg:pt-14">
          {searchOpen && <label className="mb-10 flex h-12 w-full max-w-[330px] items-center rounded-xl bg-[#f7f7f9] px-4 shadow"><Search className="mr-3 h-5 w-5 text-[#aaa]" /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setSearchOpen(false); setQuery(''); } }} placeholder="Search your notes" className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label>}
          <div data-testid="note-library-cards" data-layout={query.trim() ? 'search' : layout} className={`mx-auto grid max-w-[1520px] gap-7 pb-20 lg:gap-x-12 lg:gap-y-10 ${query.trim() ? 'grid-cols-1 xl:grid-cols-2' : layout === 'grid' ? 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1 lg:grid-cols-2'}`}>
            {visibleNotes.map((note) => <LibraryNoteCard key={note.id} note={note} query={query} layout={query.trim() ? 'search' : layout} onClick={() => onOpenNote(note)} />)}
            {!query.trim() && <AddLibraryCard layout={layout} onClick={() => onAddNote(selectedMuses.size === 1 ? firstSelectedMuse : undefined)} />}
          </div>
          {!visibleNotes.length && query.trim() && <p className="pb-20 text-sm text-[#999]">No notes contain “{query.trim()}”.</p>}
        </section>
      </div>

      {musesOpen && <MuseSelector muses={muses} notesByMuse={notesByMuse} selected={selectedMuses} busy={busy} onClose={() => setMusesOpen(false)} onSave={(next) => { setSelectedMuses(next); setMusesOpen(false); }} onCreate={() => { setMusesOpen(false); onAddMuse(); }} onEdit={(muse) => { setMusesOpen(false); onEditMuse(muse); }} onDelete={onDeleteMuse} />}
    </div>
  );
}

function AddLibraryCard({ layout, onClick }: { layout: LibraryLayout; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={`relative overflow-hidden rounded-lg border border-[#e3e3e5] bg-white text-left text-[#477bea] shadow-[0_2px_8px_rgba(0,0,0,0.1)] transition hover:-translate-y-0.5 hover:border-[#a9c0f5] hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea] ${layout === 'grid' ? 'h-[360px] p-8' : 'h-[440px] p-8'}`}><span className="flex items-center gap-2 text-base"><Plus className="h-5 w-5" /> Add</span><span className="absolute inset-x-5 bottom-6 text-center text-sm italic text-[#b4b4b8]">You can always add more</span><span className="sr-only">{layout === 'grid' ? 'grid' : 'large card'} layout</span></button>;
}

function LibraryNoteCard({ note, query, layout, onClick }: { note: Note; query: string; layout: LibraryLayout | 'search'; onClick: () => void }) {
  const content = splitNote(note);
  const isLarge = layout === 'large';
  return <button type="button" onClick={onClick} title={content.title || undefined} className={`flex flex-col overflow-hidden rounded-lg border border-[#e3e3e5] bg-white text-left shadow-[0_2px_8px_rgba(0,0,0,0.1)] transition hover:-translate-y-0.5 hover:border-[#7ca2ff] hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea] ${isLarge ? 'h-[440px] p-8' : 'h-[360px] p-7'}`}>{content.hasTitle && <strong className={`line-clamp-2 shrink-0 leading-snug text-[#151515] ${isLarge ? 'text-lg' : 'text-base'}`}><HighlightedText text={defaultNoteTitle(content.title)} query={query} /></strong>}<span className="mt-4 block min-h-0 flex-1 overflow-hidden"><span className={`whitespace-pre-wrap text-[15px] leading-[1.55] text-[#777] ${isLarge ? 'line-clamp-[11]' : 'line-clamp-[8]'}`}><HighlightedText text={content.body ? previewNoteText(content.body) : notePreview(note)} query={query} /></span></span><span className="mt-4 flex shrink-0 items-center justify-between gap-3 text-xs text-[#aaa]"><span className="min-w-0 truncate">{note.shared_by ? `Shared by ${note.shared_by}` : cleanCategory(note.category) || ORPHANS_MUSE}</span><span className="shrink-0">{formatDate(note.created_at)}</span></span><span className="sr-only">{isLarge ? 'large card' : layout} layout</span></button>;
}

function MuseSelector({ muses, notesByMuse, selected, busy, onClose, onSave, onCreate, onEdit, onDelete }: {
  muses: MuseMeta[]; notesByMuse: Map<string, Note[]>; selected: Set<string>; busy: boolean;
  onClose: () => void; onSave: (selected: Set<string>) => void; onCreate: () => void;
  onEdit: (muse: MuseMeta) => void; onDelete: (title: string) => void;
}) {
  const [draft, setDraft] = useState(() => new Set(selected));
  const [menu, setMenu] = useState<string | null>(null);
  const toggle = (title: string) => setDraft((current) => { const next = new Set(current); if (next.has(title)) next.delete(title); else next.add(title); return next; });
  return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30 p-5 backdrop-blur-[6px]" role="dialog" aria-modal="true" aria-label="Choose Domains" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="relative flex h-[min(78vh,720px)] w-[min(92vw,1220px)] flex-col rounded-xl bg-white shadow-2xl"><button type="button" onClick={onClose} aria-label="Close Domain selector" className="absolute right-2 top-2 z-10 text-[#777] sm:-right-10 sm:-top-10 sm:text-white"><X className="h-7 w-7" /></button><button type="button" onClick={onCreate} aria-label="Create Domain" className="absolute left-3 top-3 flex h-7 w-7 items-center justify-center rounded-md bg-[#477bea] text-white"><Plus className="h-4 w-4" /></button><h2 className="pt-12 text-center text-sm text-[#aaa]">Domains</h2><div className="grid flex-1 grid-cols-1 gap-8 overflow-y-auto px-12 pb-10 pt-14 sm:grid-cols-2 lg:grid-cols-4">{muses.map((muse) => <div key={muse.title} className="relative"><button type="button" onClick={() => toggle(muse.title)} className={`flex h-32 w-full flex-col justify-between rounded-lg p-5 pr-12 text-left shadow-[0_2px_8px_rgba(0,0,0,0.16)] ${draft.has(muse.title) ? 'bg-[#202020] text-white' : 'bg-[#f6f6f8] text-[#777]'}`}><span>{muse.title}</span><span className="text-xs opacity-60">{notesByMuse.get(muse.title)?.length ?? 0} notes</span></button><button type="button" onClick={() => setMenu(menu === muse.title ? null : muse.title)} aria-label={`${muse.title} options`} aria-expanded={menu === muse.title} className={`absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-md ${draft.has(muse.title) ? 'text-white hover:bg-white/15' : 'text-[#555] hover:bg-black/10'}`}><MoreHorizontal className="h-5 w-5" /></button>{menu === muse.title && <div className="absolute right-2 top-11 z-30 w-32 overflow-hidden rounded-md border border-[#ddd] bg-white py-1 text-xs text-[#222] shadow-xl"><button type="button" onClick={() => { setMenu(null); onEdit(muse); }} className="block w-full px-3 py-2 text-left hover:bg-[#f5f5f5]">Edit Domain</button><button type="button" disabled={busy} onClick={() => { setMenu(null); setDraft((current) => { const next = new Set(current); next.delete(muse.title); return next; }); onDelete(muse.title); }} className="block w-full px-3 py-2 text-left text-red-600 hover:bg-red-50">Delete Domain</button></div>}</div>)}<button type="button" onClick={onCreate} aria-label="Add another Domain" className="flex h-32 items-center justify-center rounded-lg text-[#477bea] hover:bg-[#fafafa]"><Plus className="h-7 w-7" /></button></div><button type="button" onClick={() => onSave(draft)} className="absolute bottom-2 right-2 h-8 w-28 rounded-md bg-[#202020] text-sm text-white hover:bg-black">Save</button></div></div>;
}

function MuseDetail({ title, notes, isUnsorted, busy, onClose, onAddNote, onOpenNote, onEdit, onDelete, onShare }: {
  title: string; notes: Note[]; isUnsorted: boolean; busy: boolean; onClose: () => void; onAddNote: () => void;
  onOpenNote: (note: Note) => void; onEdit: () => void; onDelete: () => void;
  /** Copies every note here into the public notes. Left out where sharing does not apply. */
  onShare?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [compact, setCompact] = useState(false);
  // Always newest first: older notes are a scroll away (sort button removed Nov 25).
  const visibleNotes = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = normalized ? notes.filter((note) => note.raw_text.toLowerCase().includes(normalized)) : notes;
    return [...filtered].sort((left, right) => right.created_at.localeCompare(left.created_at));
  }, [notes, query]);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[#bdbdbd] p-3 sm:p-5">
      <header className="relative flex h-16 shrink-0 items-center px-1 text-white sm:px-2">
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => { setSearchOpen((open) => !open); if (searchOpen) setQuery(''); }} aria-label="Search this Domain" title="Search this Domain" className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-white/10"><Search className="h-5 w-5" /></button>
          {/* Compact only changes the widest layout (four columns instead of three), so it is shown only there. */}
          <button type="button" onClick={() => setCompact((value) => !value)} aria-label={compact ? 'Use spacious card view' : 'Use compact card view'} title={compact ? 'Spacious cards' : 'Compact cards'} aria-pressed={compact} className="hidden h-10 w-10 items-center justify-center rounded-md hover:bg-white/10 xl:flex"><Grid2X2 className="h-5 w-5" /></button>
        </div>
        <h1 className="pointer-events-none absolute left-1/2 hidden max-w-[40vw] -translate-x-1/2 truncate text-sm font-normal text-white/90 sm:block">{title}</h1>
        <button type="button" onClick={onClose} aria-label="Close Domain and return home" title="Close Domain and return home" className="ml-auto flex h-10 w-10 items-center justify-center rounded-md text-white drop-shadow hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"><X className="h-6 w-6" /></button>
      </header>

      <section className="relative min-h-0 flex-1 overflow-y-auto rounded-[28px] bg-white px-5 pb-28 pt-9 shadow-[0_14px_40px_rgba(0,0,0,0.12)] sm:px-10 lg:px-16">
      <p className="text-center text-sm font-normal text-[#b2b2b7]">{visibleNotes.length} {visibleNotes.length === 1 ? 'entry' : 'entries'}</p>
      {searchOpen && <label className="mx-auto mt-6 flex h-11 w-full max-w-md items-center rounded-xl bg-[#f7f7f9] px-4 shadow-sm"><Search className="mr-3 h-4 w-4 text-[#aaa]" /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${title}`} className="min-w-0 flex-1 bg-transparent text-sm text-[#222] outline-none placeholder:text-[#aaa]" /></label>}
      {!isUnsorted && <div className="absolute right-5 top-4 sm:right-8"><button type="button" onClick={() => setMenuOpen((value) => !value)} aria-label="Domain options" aria-expanded={menuOpen} className="flex h-10 w-10 items-center justify-center rounded-md text-[#222] hover:bg-[#f4f4f4]"><MoreHorizontal className="h-5 w-5" /></button>{menuOpen && <div className="absolute right-0 top-11 z-10 w-60 overflow-hidden rounded-lg border border-[#ddd] bg-white py-1 text-sm shadow-xl"><button type="button" onClick={() => { setMenuOpen(false); onEdit(); }} className="block w-full px-4 py-2.5 text-left hover:bg-[#f5f5f5]">Edit Domain</button>{onShare && notes.length > 0 && <button type="button" disabled={busy} onClick={() => { setMenuOpen(false); onShare(); }} className="block w-full px-4 py-2.5 text-left hover:bg-[#f5f5f5]">Copy all {notes.length} to public notes</button>}<button type="button" disabled={busy} onClick={() => { setMenuOpen(false); onDelete(); }} className="block w-full px-4 py-2.5 text-left text-red-600 hover:bg-red-50">Delete Domain</button></div>}</div>}
      <div className={`mx-auto mt-14 grid max-w-[1510px] grid-cols-1 gap-8 sm:grid-cols-2 lg:gap-x-12 lg:gap-y-10 ${compact ? 'xl:grid-cols-4' : 'xl:grid-cols-3'}`}>
        {visibleNotes.map((note) => { const content = splitNote(note); return <button key={note.id} type="button" onClick={() => onOpenNote(note)} title={content.title || undefined} className="flex h-[360px] min-w-0 flex-col overflow-hidden rounded-lg border border-[#e3e3e5] bg-white p-7 text-left shadow-[0_2px_8px_rgba(0,0,0,0.1)] transition hover:-translate-y-0.5 hover:border-[#7ca2ff] hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]">{content.hasTitle && <strong className="line-clamp-2 shrink-0 text-base leading-snug text-[#151515]">{defaultNoteTitle(content.title)}</strong>}<span className="mt-4 block min-h-0 flex-1 overflow-hidden"><span className="line-clamp-[8] whitespace-pre-wrap text-[15px] leading-[1.55] text-[#777]">{content.body ? previewNoteText(content.body) : notePreview(note)}</span></span><span className="mt-4 shrink-0 text-right text-xs text-[#aaa]">{formatDate(note.created_at)}</span></button>; })}
      </div>
      {!visibleNotes.length && query.trim() && <p className="mt-8 text-center text-sm text-[#999]">No notes contain “{query.trim()}”.</p>}
      {!notes.length && <p className="mt-8 text-center text-sm text-[#999]">This Domain is ready for its first note.</p>}
      </section>
      <NewNoteButton onClick={onAddNote} label={`Write a new note in ${title}`} className="bottom-6 right-6 sm:bottom-9 sm:right-10" />
    </div>
  );
}

/** The "Use in my retrieval" switch of a vault. */
function RetrievalSwitch({ on, disabled = false, onChange }: { on: boolean; disabled?: boolean; onChange: () => void }) {
  return <button type="button" role="switch" aria-checked={on} aria-label="Use in my retrieval" disabled={disabled} onClick={(event) => { event.stopPropagation(); onChange(); }} className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea] disabled:opacity-50 ${on ? 'bg-[#477bea]' : 'bg-[#d4d4d8]'}`}>
    <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition ${on ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
  </button>;
}

/** A vault on the home screen: the notes one person shared, apart from your own Domains. */
function VaultHomeCard({ vault, onOpen, onToggleRetrieval, onRemove }: { vault: Vault; onOpen: () => void; onToggleRetrieval: () => void; onRemove: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const preview = vault.notes.slice(0, 3).map((note) => noteLabel(note)).join('\n') || 'Nothing in this vault yet.';
  const count = vault.notes.length;
  return (
    <div className="relative h-[286px]">
      <button type="button" onClick={onOpen} aria-label={`Open ${vault.name}’s vault`} className="relative flex h-full w-full flex-col overflow-hidden rounded-md border border-[#dfd6f0] bg-[#f7f5fb] p-2 text-left shadow-[0_2px_9px_rgba(0,0,0,0.14)] transition hover:-translate-y-0.5 hover:border-[#b9a4e3] hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]">
        <span className="block min-h-0 flex-1 overflow-hidden rounded bg-white px-5 py-5 text-sm leading-relaxed text-[#777]"><span className="line-clamp-[9] whitespace-pre-line">{preview}</span></span>
        <span className="flex h-10 w-full shrink-0 items-center justify-between gap-3 px-3 pr-11 text-xs"><strong className="min-w-0 truncate font-semibold text-[#5c4a85]">{vault.name}</strong><span className="shrink-0 text-[#999]">{count} {count === 1 ? 'entry' : 'entries'}</span></span>
      </button>
      {!vault.useInRetrieval && <span className="pointer-events-none absolute right-4 top-4 rounded bg-[#f1f1f3] px-2 py-0.5 text-[11px] text-[#888]">Not searched</span>}
      <button type="button" onClick={() => setMenuOpen((open) => !open)} aria-label={`${vault.name}’s vault options`} aria-expanded={menuOpen} title="Vault options" className="absolute bottom-3 right-3 z-10 flex h-8 w-8 items-center justify-center rounded-md text-[#888] hover:bg-white hover:text-[#5c4a85] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]"><MoreHorizontal className="h-4 w-4" /></button>
      {menuOpen && <div className="absolute bottom-12 right-3 z-20 w-64 overflow-hidden rounded-lg border border-[#ddd] bg-white py-1 text-sm shadow-xl">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5"><span><span className="block text-[#222]">Use in my retrieval</span><span className="block text-xs text-[#999]">Your drafts search these notes</span></span><RetrievalSwitch on={vault.useInRetrieval} onChange={onToggleRetrieval} /></div>
        <button type="button" onClick={() => { setMenuOpen(false); onRemove(); }} className="block w-full px-4 py-2.5 text-left text-red-600 hover:bg-red-50">Remove vault</button>
      </div>}
    </div>
  );
}

/** One person's shared notes, read-only. For now a vault is a single Domain. */
function VaultDetail({ vault, busy, onClose, onOpenNote, onToggleRetrieval, onRemove }: {
  vault: Vault; busy: boolean; onClose: () => void; onOpenNote: (note: Note) => void; onToggleRetrieval: () => void; onRemove: () => void;
}) {
  const [query, setQuery] = useState('');
  const visibleNotes = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? vault.notes.filter((note) => note.raw_text.toLowerCase().includes(normalized)) : vault.notes;
  }, [query, vault.notes]);
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[#c9c2d6] p-3 sm:p-5">
      <header className="relative flex h-16 shrink-0 items-center gap-3 px-1 text-white sm:px-2">
        <label className="flex h-10 w-full max-w-xs items-center rounded-lg bg-white/15 px-3"><Search className="mr-2 h-4 w-4 shrink-0 text-white/80" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${vault.name}’s notes`} aria-label={`Search ${vault.name}’s notes`} className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/70" /></label>
        <h1 className="pointer-events-none absolute left-1/2 hidden max-w-[40vw] -translate-x-1/2 truncate text-sm font-normal text-white/90 sm:block">{vault.name}’s vault</h1>
        <button type="button" onClick={onClose} aria-label="Close vault and return home" title="Close vault and return home" className="ml-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-white drop-shadow hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"><X className="h-6 w-6" /></button>
      </header>
      <section className="relative min-h-0 flex-1 overflow-y-auto rounded-[28px] bg-white px-5 pb-16 pt-8 shadow-[0_14px_40px_rgba(0,0,0,0.12)] sm:px-10 lg:px-16">
        <div className="mx-auto flex max-w-[1510px] flex-wrap items-center justify-between gap-4">
          <p className="text-sm text-[#777]">Shared by {vault.name} · updated {fullNoteDate(vault.acceptedAt)} · {vault.notes.length} {vault.notes.length === 1 ? 'entry' : 'entries'}</p>
          <div className="flex items-center gap-4 text-sm">
            <span className="flex items-center gap-2 text-[#555]">Use in my retrieval <RetrievalSwitch on={vault.useInRetrieval} disabled={busy} onChange={onToggleRetrieval} /></span>
            <button type="button" disabled={busy} onClick={onRemove} className="text-red-600 hover:underline disabled:opacity-50">Remove vault</button>
          </div>
        </div>
        <p className="mx-auto mt-2 max-w-[1510px] text-xs text-[#aaa]">These are {vault.name}’s words, read-only. {vault.useInRetrieval ? 'Your drafts search them for related notes and cards.' : 'Your drafts do not search them while this is off.'}</p>
        <div className="mx-auto mt-10 grid max-w-[1510px] grid-cols-1 gap-8 sm:grid-cols-2 lg:gap-x-12 lg:gap-y-10 xl:grid-cols-3">
          {visibleNotes.map((note) => <LibraryNoteCard key={note.id} note={note} query={query} layout="grid" onClick={() => onOpenNote(note)} />)}
        </div>
        {!visibleNotes.length && <p className="mt-8 text-center text-sm text-[#999]">{query.trim() ? `No notes contain “${query.trim()}”.` : 'Nothing in this vault.'}</p>}
      </section>
    </div>
  );
}

/** A note someone shared with you: read-only, with no search of its own. */
function SharedNoteView({ note, vault, onClose }: { note: Note; vault: Vault | null; onClose: () => void }) {
  const content = splitNote(note);
  const name = note.shared_by || vault?.name || 'Someone';
  return (
    <div className="fixed inset-0 z-[70] bg-black/25 p-3 backdrop-blur-[5px] sm:p-6" role="dialog" aria-modal="true" aria-label={`Shared note: ${content.title || 'Untitled note'}`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="mx-auto flex h-full max-w-4xl flex-col overflow-hidden rounded-xl border border-[#d8d8d8] bg-white shadow-xl">
        <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-[#eee] px-5">
          <p className="min-w-0 truncate text-xs text-[#888]">Shared by <span className="font-medium text-[#5c4a85]">{name}</span> · {fullNoteDate(note.created_at)}</p>
          <button type="button" onClick={onClose} aria-label="Close shared note" className="flex h-9 w-9 items-center justify-center rounded-md text-[#666] hover:bg-[#f4f4f4]"><X className="h-5 w-5" /></button>
        </header>
        <article className="min-h-0 flex-1 overflow-y-auto px-7 py-10 sm:px-12">
          <div className="mx-auto max-w-2xl">
            <h1 className="break-words text-2xl font-semibold text-[#171717]">{content.title || 'Untitled note'}</h1>
            {content.body && <div className="mt-8 text-base leading-[1.7] text-[#2d2d2d]"><FormattedNoteBody text={content.body} /></div>}
          </div>
        </article>
        <footer className="shrink-0 border-t border-[#eee] bg-[#faf9fc] px-5 py-3 text-xs text-[#888]">{name}’s note, read-only. {vault && !vault.useInRetrieval ? 'Your drafts do not search this vault right now.' : 'Ocreda brings it up when it relates to what you write.'}</footer>
      </div>
    </div>
  );
}

type KnowledgeFilter = { kind: 'muse' | 'date'; value: string; label: string };
type KnowledgeSearchRequest = { query: string; filter?: KnowledgeFilter };

function sharedWordScore(left: string, right: string): number {
  const ignored = new Set(['about', 'after', 'again', 'because', 'before', 'being', 'could', 'from', 'have', 'into', 'just', 'more', 'that', 'their', 'there', 'these', 'they', 'this', 'what', 'when', 'where', 'which', 'will', 'with', 'would', 'your']);
  const words = (value: string) => new Set((value.toLowerCase().match(/[a-z0-9']{4,}/g) ?? []).filter((word) => !ignored.has(word)));
  const first = words(left); const second = words(right);
  let score = 0; first.forEach((word) => { if (second.has(word)) score += 1; });
  return score;
}

function fullNoteDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
}

function localDateKey(value: string): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const clean = query.trim();
  if (!clean) return <>{text}</>;
  const exactMatch = text.toLowerCase().includes(clean.toLowerCase());
  const terms = exactMatch ? [clean] : Array.from(new Set(retrievalKeywords(clean))).sort((left, right) => right.length - left.length);
  if (!terms.length) return <>{text}</>;
  const expression = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'ig');
  const termSet = new Set(terms.map((term) => term.toLowerCase()));
  return <>{text.split(expression).map((part, index) => termSet.has(part.toLowerCase()) ? <mark key={`${part}-${index}`} className="rounded-sm bg-[#eaf1ff] px-0.5 text-[#477bea]">{part}</mark> : part)}</>;
}

/** Draws a stretch of note text in its run's style: bold, italic, or both. */
function styledRun(run: InlineRun, content: React.ReactNode, key: React.Key): React.ReactNode {
  const inner = run.italic ? <em>{content}</em> : content;
  return <Fragment key={key}>{run.bold ? <strong>{inner}</strong> : inner}</Fragment>;
}

function InlineNoteFormatting({ text }: { text: string }) {
  return <>{inlineRuns(text).map((run, index) => styledRun(run, text.slice(run.start, run.end), index))}</>;
}

function hasNoteFormatting(text: string): boolean {
  return /(^|\n)#{1,3}\s|(^|\n)(?:[-+*•]\s|\d+\.\s)|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_/.test(text);
}

type NoteMark = { start: number; end: number; label: string; markRef?: React.Ref<HTMLElement> };

/**
 * A line's text with its bold and italic drawn, and the part inside `mark`
 * highlighted. `offset` is where the line starts in the note, since the mark's
 * offsets point into the note's markdown, markers included.
 */
function InlineWithMark({ text, offset, mark }: { text: string; offset: number; mark?: NoteMark }) {
  if (!mark || mark.end <= offset || mark.start >= offset + text.length) return <InlineNoteFormatting text={text} />;
  // Visible runs of the line, each with where it sits in the note and its style.
  const runs = inlineRuns(text, offset);
  const nodes: React.ReactNode[] = [];
  let first = true;
  let lastMarked = -1;
  runs.forEach((run, index) => {
    const cuts = [run.start, Math.min(Math.max(mark.start, run.start), run.end), Math.min(Math.max(mark.end, run.start), run.end), run.end];
    for (let piece = 0; piece < 3; piece++) {
      const [from, to] = [cuts[piece], cuts[piece + 1]];
      if (to <= from) continue;
      const slice = text.slice(from - offset, to - offset);
      let node: React.ReactNode = styledRun(run, slice, 'text');
      if (piece === 1) {
        node = <mark ref={first ? mark.markRef : undefined} className="rounded-sm bg-[#fff4c7] px-0.5 text-inherit underline decoration-[#e5b72f] decoration-2 underline-offset-4 [box-decoration-break:clone]" title={mark.label}>{node}</mark>;
        first = false;
      }
      nodes.push(<Fragment key={`${index}-${piece}`}>{node}</Fragment>);
      if (piece === 1) lastMarked = nodes.length;
    }
  });
  // The label follows the marked words, on the line where they end.
  if (lastMarked !== -1 && mark.end <= offset + text.length) nodes.splice(lastMarked, 0, <span key="label" className="ml-1 inline-block rounded bg-[#fff7d8] px-1 align-[1px] text-[10px] font-medium leading-4 text-[#9a7300]">{mark.label}</span>);
  return <>{nodes}</>;
}

/** Render the lightweight formatting inserted by the note toolbar, with an optional highlighted passage. */
function FormattedNoteBody({ text, mark }: { text: string; mark?: NoteMark }) {
  let lineStart = 0;
  return <div className="space-y-3 break-words">
    {text.split('\n').map((rawLine, index) => {
      const offset = lineStart;
      lineStart += rawLine.length + 1;
      const lineEnd = offset + rawLine.length;
      const inline = (content: string) => <InlineWithMark text={content} offset={lineEnd - content.length} mark={mark} />;
      const heading = rawLine.match(/^(#{1,3})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        const className = level === 1 ? 'pt-2 text-2xl font-semibold leading-snug' : level === 2 ? 'pt-2 text-xl font-semibold leading-snug' : 'pt-1 text-lg font-semibold leading-snug';
        return <div key={index} role="heading" aria-level={Math.min(level + 1, 6)} className={className}>{inline(heading[2])}</div>;
      }
      const bullet = rawLine.match(/^[-+*•]\s+(.*)$/);
      if (bullet) return <div key={index} className="flex gap-3 pl-2"><span aria-hidden="true" className="mt-[0.72em] h-1.5 w-1.5 shrink-0 rounded-full bg-current" /><span>{inline(bullet[1])}</span></div>;
      const numbered = rawLine.match(/^(\d+)\.\s+(.*)$/);
      if (numbered) return <div key={index} className="flex gap-3 pl-1"><span className="min-w-5 shrink-0 text-right text-[#777]">{numbered[1]}.</span><span>{inline(numbered[2])}</span></div>;
      if (!rawLine.trim()) return <div key={index} className="h-2" aria-hidden="true" />;
      return <p key={index} className="whitespace-pre-wrap">{inline(rawLine)}</p>;
    })}
  </div>;
}

function NoteDomainPicker({ category, muses, saving, onChange, showPrefix = false }: {
  category: string | null; muses: MuseMeta[]; saving: boolean;
  onChange: (category: string | null) => void; showPrefix?: boolean;
}) {
  const current = cleanCategory(category);
  const label = current || ORPHANS_MUSE;
  const isOrphans = (title: string) => title.toLowerCase() === ORPHANS_MUSE.toLowerCase();
  const hasOrphansDomain = muses.some((muse) => isOrphans(muse.title));
  const itemClassName = 'flex cursor-pointer items-center justify-between rounded-md px-3 py-2 !text-[#252525] data-[highlighted]:!bg-[#e8efff] data-[highlighted]:!text-[#1b3f88]';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" disabled={saving} aria-label={`Change note Domain, currently ${label}`} className={`inline-flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-left hover:bg-[#edf3ff] hover:text-[#477bea] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea] disabled:opacity-50 ${showPrefix ? 'text-[#999]' : 'max-w-[24vw] text-[#777]'}`}>
          <span className="truncate">{showPrefix ? `Note in ${label}` : label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={showPrefix ? 'start' : 'center'} sideOffset={6} className="z-[60] max-h-72 w-56 overflow-y-auto rounded-lg border-[#e0e0e0] bg-white p-1.5 shadow-xl">
        {!hasOrphansDomain && <DropdownMenuItem disabled={saving} onSelect={() => { if (current) onChange(null); }} className={itemClassName}>
          {ORPHANS_MUSE} {!current && <Check className="h-4 w-4 text-[#477bea]" />}
        </DropdownMenuItem>}
        {!hasOrphansDomain && muses.length > 0 && <DropdownMenuSeparator className="my-1 bg-[#ececef]" />}
        {muses.map((muse) => {
          const selected = current ? current.toLowerCase() === muse.title.toLowerCase() : isOrphans(muse.title);
          return <DropdownMenuItem key={muse.title} disabled={saving} onSelect={() => { if (!selected) onChange(muse.title); }} className={itemClassName}>
            <span className="min-w-0 truncate">{muse.title}</span>{selected && <Check className="h-4 w-4 shrink-0 text-[#477bea]" />}
          </DropdownMenuItem>;
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Shows a passage of the note in place: the words a card quoted when the note
 * was opened from one, scrolled into view, or else the passage the retrieval used.
 */
function RetrievalMatchedBody({ text, matchedText, label }: { text: string; matchedText: string; label: string }) {
  const markRef = useRef<HTMLElement>(null);
  const span = matchedText ? findAnchor(text, matchedText) : null;
  useEffect(() => { markRef.current?.scrollIntoView({ block: 'center' }); }, [matchedText]);
  return <FormattedNoteBody text={text} mark={span ? { ...span, label, markRef } : undefined} />;
}

function RelatedNotePanel({ note, relevance, focusText = '', onClose, onOpenFull }: {
  note: Note;
  relevance?: RelevanceResult;
  /** Words a card quoted from this note; shown in place of the retrieval passage. */
  focusText?: string;
  onClose: () => void;
  onOpenFull: () => void;
}) {
  const content = splitNote(note);
  const reason = relevance?.explanation.trim() ?? '';
  // A quote can come from the title, which the body below does not show.
  const focusInBody = focusText && content.body && findAnchor(content.body, focusText) ? focusText : '';
  const matchedText = focusInBody || (relevance?.matched_text?.trim() ?? '');
  const relation = relationBadgeFor(relevance);

  return <div className="flex min-h-0 flex-1 flex-col bg-[#f7f7f9]">
    <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-[#e2e2e2] bg-[#f7f7f9]/95 px-4 py-2 backdrop-blur">
      <div className="min-w-0 text-xs text-[#999]">
        <span>{fullNoteDate(note.created_at)}</span>
        <span className="mx-2 text-[#ccc]" aria-hidden="true">·</span>
        <span className="truncate">{note.shared_by ? `Shared by ${note.shared_by}` : cleanCategory(note.category) || ORPHANS_MUSE}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button type="button" onClick={onOpenFull} className="rounded-md border border-[#dedede] bg-white px-3 py-1.5 text-xs text-[#477bea] shadow-sm hover:border-[#adc3ff] hover:bg-[#edf3ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]">Open full note</button>
        <button type="button" onClick={onClose} aria-label="Close related note" title="Back to suggestions" className="flex h-8 w-8 items-center justify-center rounded-md text-[#666] hover:bg-white hover:text-[#222] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]"><X className="h-5 w-5" /></button>
      </div>
    </header>
    <div className="min-h-0 flex-1 cursor-default overflow-y-auto px-7 py-10 sm:px-10" onDoubleClick={onOpenFull} title="Double-click to open this note">
      <article className="mx-auto max-w-2xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="min-w-0 flex-1 break-words text-2xl font-semibold text-[#171717]">{content.title || 'Untitled note'}</h2>
          {relation && <span className={`shrink-0 rounded px-2 py-1 text-[10px] font-medium ${relation.className}`}>{relation.label}</span>}
        </div>
        {content.body && <div className="mt-8 text-base leading-[1.7] text-[#2d2d2d]"><RetrievalMatchedBody text={content.body} matchedText={matchedText} label={focusInBody ? 'Quoted in your card' : 'Used for retrieval'} /></div>}
      </article>
    </div>
    {reason && <div className="shrink-0 border-t border-[#e4e4e4] bg-white px-5 py-4">
      <p className="text-xs leading-relaxed text-[#777]"><span className="font-medium italic text-[#477bea]">Why it’s relevant:</span> <span className="italic">{reason}</span></p>
    </div>}
  </div>;
}

function NoteReadingWorkspace({ note, previousNote, allNotes, sharedNotes = [], hasSearchableShared = false, muses, projects, saving, userId, initialRetrievalMode, autoSearch, onClose, onReturnToPrevious, onAddNote, onOpenNote, onOpenPage, onUpdate, onChangeDomain, onCreateDomain, onDelete, onShare, onSetDomainGoal, onImport }: {
  note: Note; previousNote: Note | null; allNotes: Note[]; muses: MuseMeta[]; projects: CortexProject[]; saving: boolean; userId: string; initialRetrievalMode: 'similar' | 'relevant'; autoSearch: boolean;
  /** Leaves the note and opens the importer, offered when a search finds nothing. */
  onImport?: () => void;
  /** Notes others shared with you. Searches may cite them, so cards and links look them up here too. */
  sharedNotes?: Note[];
  /** Whether a search reads any shared notes, so a note can be searched with none of your own beside it. */
  hasSearchableShared?: boolean;
  onClose: () => void; onReturnToPrevious: () => void; onAddNote: () => void; onOpenNote: (note: Note, autoSearch?: boolean) => void; onOpenPage: (project: CortexProject, page: ProjectPage) => void;
  onUpdate: (noteId: string, rawText: string) => Promise<void>; onChangeDomain: (category: string | null) => void; onCreateDomain: () => void; onDelete: (note: Note) => Promise<void>;
  onSetDomainGoal: (domainTitle: string, goal: string) => void;
  /** Copies the note into the person's public notes, to share by link. */
  onShare: (note: Note) => Promise<void>;
}) {
  const initial = splitNote(note);
  const [title, setTitle] = useState(() => editableNote(note).title);
  const [body, setBody] = useState(() => editableNote(note).body);
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [usedInMenuOpen, setUsedInMenuOpen] = useState(false);
  // Mobile starts with the note itself; desktop has room to show suggestions
  // alongside it immediately.
  const [summaryOpen, setSummaryOpen] = useState(false);
  // Below the width where the note and the panel fit side by side, the design's
  // phone layout applies: the panel is a sheet that rises over the note.
  const narrowScreen = useNarrowScreen();
  // The design's view keeps the panel closed until a passage is clicked, and
  // shows one card at a time; the classic view lists them all.
  const [suggestionsView, setSuggestionsView] = useState<NoteSuggestionsView>(() => readNoteSuggestionsView());
  const designView = suggestionsView === 'design';
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  // A chosen card whose result is open under its passage.
  const [dropCardId, setDropCardId] = useState<string | null>(null);
  const [panelNoteId, setPanelNoteId] = useState<string | null>(null);
  const [panelRelevance, setPanelRelevance] = useState<RelevanceResult | null>(null);
  // Words a card quoted from the note open in the side panel, to show them in place.
  const [panelFocus, setPanelFocus] = useState('');
  const [decisions, setDecisions] = useState<CardDecisions>({});
  // Choices made on other notes that mark this one, such as a later note's answer to a problem here.
  const [incomingDecisions, setIncomingDecisions] = useState<IncomingCardDecision[]>([]);
  const [retrieval, setRetrieval] = useState<RelevanceSearch | null>(null);
  // The sample vault's Start here note explains the app; searching it would
  // only spend AI credit on a guide.
  const isGuide = isSampleGuide(note);
  const requiresDomain = cleanCategory(note.category)?.toLowerCase() === ORPHANS_MUSE.toLowerCase();
  const assignableMuses = muses.filter((muse) => muse.title.toLowerCase() !== ORPHANS_MUSE.toLowerCase());
  // Avoid briefly showing "Not searched yet" before an automatic search starts.
  const [retrievalLoading, setRetrievalLoading] = useState(autoSearch && !isGuide && !requiresDomain);
  const [retrievalProgress, setRetrievalProgress] = useState<RelevanceProgress | null>(null);
  // Counts searches that finished while the note was open (not saved ones shown on opening).
  const [searchesFinished, setSearchesFinished] = useState(0);
  const [retrievalError, setRetrievalError] = useState('');
  const [retrievalAttempt, setRetrievalAttempt] = useState(0);
  const [retrievalMode, setRetrievalMode] = useState(initialRetrievalMode);
  // Starts false for a note opened just to read it. Retrieval only begins
  // after an explicit request (or when the caller intentionally auto-searches).
  const [searchRequested, setSearchRequested] = useState(autoSearch && !isGuide && !requiresDomain);
  const [searchRequest, setSearchRequest] = useState<KnowledgeSearchRequest | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [selectedInsightIndex, setSelectedInsightIndex] = useState(0);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const aiMode = useAiMode();
  const bodyRef = useRef<NoteBodyEditorHandle>(null);
  const [activeFormats, setActiveFormats] = useState<NoteFormat[]>([]);
  const latestSaveRef = useRef(onUpdate);
  latestSaveRef.current = onUpdate;
  const muse = cleanCategory(note.category) || ORPHANS_MUSE;
  const rawText = composeNoteText(title, body);
  // An older note without a title reads back as a made-up title over its text;
  // opening it is not an edit, so only a real change saves.
  const unchangedText = useMemo(() => { const start = editableNote(note); return composeNoteText(start.title, start.body); }, [note]);
  const noteChanged = Boolean(rawText) && rawText !== note.raw_text.trim() && rawText !== unchangedText;

  useEffect(() => {
    if (readNoteSuggestionsView() === 'classic' && window.matchMedia('(min-width: 1280px)').matches) setSummaryOpen(true);
  }, []);

  useEffect(() => {
    if (!editing || !noteChanged) return;
    setSaveState('saving');
    const timeout = window.setTimeout(() => {
      latestSaveRef.current(note.id, rawText).then(() => setSaveState('saved')).catch(() => setSaveState('error'));
    }, 850);
    return () => window.clearTimeout(timeout);
  }, [body, editing, note.id, note.raw_text, rawText, title]);

  // A hardware/browser Back action can unmount this reader immediately. Start
  // the same save used by the visible close control before the dashboard is
  // restored, so a quick mobile exit does not discard the latest edit.
  useEffect(() => {
    const saveBeforeHistoryExit = () => {
      if (noteChanged) void latestSaveRef.current(note.id, rawText);
    };
    window.addEventListener('popstate', saveBeforeHistoryExit);
    return () => window.removeEventListener('popstate', saveBeforeHistoryExit);
  }, [note.id, note.raw_text, rawText]);

  const orderedNotes = useMemo(() => [...allNotes].sort((a, b) => b.created_at.localeCompare(a.created_at)), [allNotes]);
  const noteIndex = orderedNotes.findIndex((item) => item.id === note.id);
  const newerNote = noteIndex > 0 ? orderedNotes[noteIndex - 1] : null;
  const olderNote = noteIndex < orderedNotes.length - 1 ? orderedNotes[noteIndex + 1] : null;
  const noteTooShortForRetrieval = note.raw_text.trim().length < MIN_RELEVANCE_DRAFT_CHARS;
  const hasOtherNotes = hasSearchableShared || allNotes.some((item) => item.id !== note.id);
  const domainGoal = domainGoalFor(note.category, muses);
  // Primitives, so a new muses array with the same content does not rerun the search.
  const domainName = domainGoal?.name ?? '';
  const goalText = domainGoal?.goal ?? '';
  // Your notes and the shared ones together, for finding any note a search names.
  const lookupNotes = useMemo(() => (sharedNotes.length ? [...allNotes, ...sharedNotes] : allNotes), [allNotes, sharedNotes]);
  const retrievalInputsRef = useRef({ note, allNotes, lookupNotes, hasSearchableShared, domainName, goalText, aiMode, rawText });
  retrievalInputsRef.current = { note, allNotes, lookupNotes, hasSearchableShared, domainName, goalText, aiMode, rawText };

  useEffect(() => {
    let active = true;
    if (requiresDomain) {
      setRetrieval(null);
      setRetrievalLoading(false);
      setRetrievalProgress(null);
      return;
    }
    const inputs = retrievalInputsRef.current;
    const requestNote = { ...inputs.note, raw_text: inputs.rawText || inputs.note.raw_text };
    const requestSignature = retrievalInputSignature(requestNote.raw_text, inputs.goalText, inputs.aiMode);
    // The title travels with the body so the search sees the note's whole
    // point; the sections that come back are moved onto the body, which is
    // what the reader shows.
    const searchedText = requestNote.raw_text.trim();
    const requestBody = splitNote(requestNote).body || searchedText;
    const availableNoteIds = new Set(inputs.lookupNotes.filter((item) => item.id !== requestNote.id).map((item) => item.id));
    // A saved search costs nothing to show, so it shows even for a note opened
    // only to read it, as long as it still names notes that exist and suits the mode.
    const canShow = (saved: SavedRetrieval | null): saved is SavedRetrieval => Boolean(saved
      && saved.search.results.some((result) => availableNoteIds.has(result.note_id))
      && (retrievalMode === 'similar' || saved.mode === 'relevant'));
    const savedTime = (saved: SavedRetrieval) => Date.parse(saved.savedAt) || 0;
    const showSaved = (saved: SavedRetrieval) => {
      cacheSavedRetrieval(userId, requestNote.id, saved);
      setRetrieval(saved.search);
      setRetrievalLoading(false);
    };
    // Whether every agent has reported back, which decides what leaving does.
    let agentsFinished = false;
    // Leaving the note (or searching again) before the agents finish hangs up,
    // and the server stops before its next model call. After they finish, the
    // costly part is paid for and only the insight call is left, so the search
    // finishes in the background and is saved for the next time the note opens.
    const cancel = new AbortController();
    const cleanup = () => {
      active = false;
      if (!agentsFinished) cancel.abort();
    };

    // A new search runs only when one was asked for.
    const runSearch = () => {
      if (!searchRequested || isSampleGuide(requestNote)) return;
      setRetrievalError(''); setRetrievalProgress(null);
      // Empty retrievals and caches whose notes no longer exist are not useful
      // completed searches. Retry instead of leaving the panel blank forever.
      setRetrieval(null);
      const requestTooShort = requestNote.raw_text.trim().length < MIN_RELEVANCE_DRAFT_CHARS;
      const requestHasOtherNotes = inputs.hasSearchableShared || inputs.allNotes.some((item) => item.id !== requestNote.id);
      if (requestTooShort || !requestHasOtherNotes) { setRetrievalLoading(false); return; }
      setRetrievalLoading(true);
      const onProgress = (progress: RelevanceProgress) => {
        agentsFinished = progress.agents_total > 0 && progress.agents_done >= progress.agents_total;
        if (active) setRetrievalProgress(progress);
      };
      // One search for the whole note. In relevant mode the server splits it
      // into its ideas and keeps up to three notes for each, reading every note
      // once however many ideas there are.
      const search = retrievalMode === 'relevant'
        ? findRelevantNotes(searchedText, requestNote.id, onProgress, inputs.domainName ? { name: inputs.domainName, goal: inputs.goalText } : null, cancel.signal)
        : findSimilarNotes(searchedText, requestNote.id, onProgress, inputs.allNotes);
      search
        .then((found) => {
          const response: RelevanceSearch = { ...found, sections: sectionsInBody(found.sections, searchedText, requestBody) };
          // Saved even when the person has already left, so the note shows it
          // next time without searching again. A failed insight step is not
          // saved, so opening the note again retries it.
          if (!response.insight_failed) persistSavedRetrieval(userId, requestNote, inputs.goalText, retrievalMode, response, requestSignature);
          if (active) { setRetrieval(response); setSearchesFinished((count) => count + 1); }
        })
        .catch((err) => {
          // Cancelling is expected when the reader leaves or searches again; it is not an error.
          if (cancel.signal.aborted || (err instanceof Error && err.name === 'AbortError')) return;
          if (active) setRetrievalError(safeErrorMessage(err, 'Could not retrieve related notes.'));
        })
        .finally(() => { if (active) setRetrievalLoading(false); });
    };

    if (retrievalAttempt > 0) { runSearch(); return cleanup; }
    const local = readSavedRetrieval(userId, requestNote);
    if (canShow(local)) {
      setRetrieval(local.search);
      setRetrievalLoading(false);
      // Another device may have searched this note since: its newer result replaces this one.
      void loadSharedRetrieval(requestNote.id, SAVED_RETRIEVAL_VERSION).then((shared) => {
        const remote = fromShared(shared);
        if (active && canShow(remote) && savedTime(remote) > savedTime(local)) showSaved(remote);
      });
      return cleanup;
    }
    // Nothing saved in this browser. Another device may have searched this
    // note already; only when none has does it run the AI calls again.
    if (searchRequested) setRetrievalLoading(true);
    void loadSharedRetrieval(requestNote.id, SAVED_RETRIEVAL_VERSION).then((shared) => {
      if (!active) return;
      const remote = fromShared(shared);
      if (canShow(remote)) showSaved(remote);
      else runSearch();
    });
    return cleanup;
  }, [note.id, requiresDomain, retrievalAttempt, retrievalMode, searchRequested, userId]);

  const wasDomainRequiredRef = useRef(requiresDomain);
  useEffect(() => {
    const wasRequired = wasDomainRequiredRef.current;
    wasDomainRequiredRef.current = requiresDomain;
    if (wasRequired && !requiresDomain && autoSearch && !isGuide) {
      setSearchRequested(true);
      setRetrievalAttempt((attempt) => attempt + 1);
    }
  }, [autoSearch, isGuide, requiresDomain]);

  const requestReretrieval = (mode: 'similar' | 'relevant' = retrievalMode) => {
    if (isGuide || requiresDomain) return;
    setRetrievalMode(mode);
    setSearchRequested(true);
    setRetrievalAttempt((attempt) => attempt + 1);
  };

  const surfacedNotes = useMemo(() => {
    const notesById = new Map(lookupNotes.map((item) => [item.id, item]));
    return (retrieval?.results ?? []).map((result) => notesById.get(result.note_id)).filter((item): item is Note => item !== undefined && item.id !== note.id).slice(0, 10);
  }, [lookupNotes, note.id, retrieval]);

  const noteById = useMemo(() => new Map(lookupNotes.map((item) => [item.id, item])), [lookupNotes]);
  const relevanceByNoteId = useMemo(
    () => new Map((retrieval?.results ?? []).map((result) => [result.note_id, result])),
    [retrieval]
  );
  // Retrievals saved on other devices aren't in this browser until those
  // notes are opened here, so the database names the rest.
  const [usedInElsewhere, setUsedInElsewhere] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    setUsedInElsewhere([]);
    void loadNotesUsing(note.id, SAVED_RETRIEVAL_VERSION).then((ids) => { if (active) setUsedInElsewhere(ids); });
    return () => { active = false; };
  }, [note.id, retrieval]);
  const usedInNotes = useMemo(() => allNotes.filter((item) => {
    if (item.id === note.id) return false;
    if (usedInElsewhere.includes(item.id)) return true;
    const saved = readSavedRetrieval(userId, item);
    return Boolean(saved?.search.results.some((result) => result.note_id === note.id)
      || saved?.search.insights?.some((itemInsight) => itemInsight.note_ids.includes(note.id)));
  }), [allNotes, note.id, retrieval, usedInElsewhere, userId]);
  const panelNote = panelNoteId ? lookupNotes.find((item) => item.id === panelNoteId) ?? null : null;
  const displayedBody = body || note.raw_text;
  const noteSections = useMemo(() => noteSectionsFor(displayedBody, retrieval?.sections), [displayedBody, retrieval]);
  /** The relation of an insight's strongest cited note, for cards from servers that predate card kinds. */
  const relationOf = useCallback((item: NoteInsight) =>
    item.note_ids.map((id) => relevanceByNoteId.get(id)?.relation_type).find(Boolean) ?? null, [relevanceByNoteId]);
  /**
   * The cards to show: this search's, and any the person acted on in an
   * earlier search, so what they chose stays on the note after a new one.
   */
  const cards = useMemo(() => {
    // A solution this note already handed to an earlier note lives on that
    // note now, so its card leaves this one; only that note can undo it.
    const handed = incomingDecisions.filter((decision) => isHandedFrom(decision, note.id));
    const wasHanded = (item: NoteInsight) => item.direction === 'outbound' && Boolean(item.problem)
      && handed.some((decision) => decision.fromNoteId === item.problem!.note_id && decision.insight.anchor === item.problem!.text);
    const current = (retrieval?.insights ?? []).filter((item) => !wasHanded(item)).map((item) => ({ id: insightActionId(item, relationOf(item)), item }));
    const currentIds = new Set(current.map((card) => card.id));
    const earlier = Object.entries(decisions)
      .filter(([id, decision]) => !currentIds.has(id) && decision.choice !== 'rejected' && !wasHanded(decision.insight))
      .map(([id, decision]) => ({ id, item: decision.insight }));
    return [...current, ...earlier];
  }, [decisions, incomingDecisions, note.id, relationOf, retrieval]);
  const insights = useMemo(() => cards.map((card) => card.item), [cards]);
  const insight = insights[Math.min(selectedInsightIndex, insights.length - 1)] ?? null;
  /**
   * Where each insight sits: its passage, looked for first inside the idea the
   * server put it in so a phrase repeated elsewhere is not picked, and the
   * section that passage is in. Without a passage, the section it was given.
   */
  const insightPlacements = useMemo(() => insights.map((item) => {
    const tagged = noteSections.find((section) => section.id === item.section_id) ?? null;
    const local = item.anchor && tagged ? findAnchor(tagged.text, item.anchor) : null;
    const span = local && tagged ? { start: tagged.start + local.start, end: tagged.start + local.end } : item.anchor ? findAnchor(displayedBody, item.anchor) : null;
    const section = (span && noteSections.find((candidate) => span.start >= candidate.start && span.start < candidate.end)) || tagged || noteSections[0] || null;
    return { span, section };
  }), [displayedBody, insights, noteSections]);
  /** The insight rests only on notes this one helps, so its card points at where the lesson applies. */
  const isOutbound = (item: NoteInsight) => item.note_ids.every((id) => relevanceByNoteId.get(id)?.direction === 'outbound');
  const formattedBody = hasNoteFormatting(displayedBody);

  /**
   * Each card with what the person chose, the kind it now shows as, and how it
   * marks the note. A card waiting on them is a highlight on its passage; once
   * they act, the highlight goes and their choice shows over the note instead:
   * a box under the line for a solution, an idea, or merged words, and a chip
   * at the end of the sentence for an extension, a contradiction, or a pattern.
   * A waiting card on a passage they already acted on is a repeat from a newer
   * search, so it is left out.
   */
  const cardLayout = useMemo(() => {
    const sectionAtOffset = (offset: number) => noteSections.find((section) => offset >= section.start && offset < section.end) ?? null;
    const views: CardView[] = cards.map((card, index) => {
      const decision = decisions[card.id] as CardDecision | undefined;
      const kind = decision?.kind ?? baseKindOf(card.item, relationOf(card.item));
      const placement = insightPlacements[index];
      return { ...card, index, decision, kind, span: placement?.span ?? null, section: placement?.section ?? noteSections[0] ?? null, fromNoteId: null };
    });
    // A later note that solved a problem here: its Solution box goes beside the problem.
    const incoming = incomingDecisions.flatMap((decision) => {
      const problem = decision.choice === 'solved' ? decision.insight.problem : null;
      const span = problem ? findAnchor(displayedBody, problem.text) : null;
      if (!span) return [];
      const view: CardView = { id: `from:${decision.fromNoteId}:${decision.cardId}`, item: decision.insight, index: -1, decision, kind: 'solution', span, section: sectionAtOffset(span.start), fromNoteId: decision.fromNoteId };
      return [view];
    });
    const actedSpans = [...views.filter((view) => isActedCard(view.decision) && view.span), ...incoming].map((view) => view.span!);
    const overlapsActed = (span: { start: number; end: number }) => actedSpans.some((taken) => span.start < taken.end && taken.start < span.end);
    const shown = views.filter((view) => view.decision?.choice !== 'rejected' && !(isPendingCard(view.decision) && view.span && overlapsActed(view.span)));

    const highlights: { start: number; end: number; index: number }[] = [];
    const overlays: { type: 'chip' | 'block'; at: number; view: (typeof views)[number] }[] = [];
    if (!editing) {
      for (const view of [...shown, ...incoming]) {
        const span = view.span;
        if (!span) continue;
        if (!view.fromNoteId && isPendingCard(view.decision)) {
          if (!highlights.some((taken) => span.start < taken.end && taken.start < span.end)) highlights.push({ ...span, index: view.index });
          continue;
        }
        const limit = view.section?.end ?? displayedBody.length;
        const sentenceEnd = Math.min(sentenceEndAfter(displayedBody, span.end), limit);
        const lineEnd = Math.min(lineEndAfter(displayedBody, span.end), limit);
        const choice = view.decision?.choice;
        // When this note answered an earlier one, or helped it, the answer is
        // shown on that note. This note already holds the answer in its own
        // words, so it is left unmarked (decided Nov 24): a mark here only confused.
        if (marksOtherNote(view, view.item.note_ids.every((id) => relevanceByNoteId.get(id)?.direction === 'outbound'))) continue;
        if (choice === 'solved' || choice === 'helped') overlays.push({ type: 'block', at: lineEnd, view });
        else if (choice === 'merged') overlays.push({ type: 'chip', at: sentenceEnd, view }, { type: 'block', at: lineEnd, view });
        else overlays.push({ type: 'chip', at: sentenceEnd, view });
      }
    }
    highlights.sort((x, y) => x.start - y.start);
    overlays.sort((x, y) => x.at - y.at || (x.type === 'chip' ? -1 : 1));
    return { views, shown, highlights, overlays };
  }, [cards, decisions, displayedBody, editing, incomingDecisions, insightPlacements, noteSections, relationOf, relevanceByNoteId]);
  const { highlights, overlays } = cardLayout;

  useEffect(() => {
    let active = true;
    loadCardDecisions(note.id)
      .then(async (loaded) => {
        const own = { ...loaded.own };
        let incoming = [...loaded.incoming];
        // A Solve saved the earlier way sits on the answering note, aimed at
        // the earlier note. Whichever of the two opens first moves it onto the
        // earlier note as that note's own solved card; it is shown either way.
        for (const [cardId, decision] of Object.entries(loaded.own)) {
          const handed = isOldHandedSolution(decision) ? handedSolutionCard(decision.insight, note.id) : null;
          if (!handed) continue;
          try {
            await saveCardDecision(handed.problemNoteId, handed.id, handed.decision);
            await saveCardDecision(note.id, cardId, null);
            delete own[cardId];
            incoming.push({ ...handed.decision, cardId: handed.id, fromNoteId: handed.problemNoteId });
          } catch { /* Kept as it was; it moves the next time. */ }
        }
        for (const decision of loaded.incoming) {
          const handed = isOldHandedSolution(decision) && decision.insight.problem?.note_id === note.id ? handedSolutionCard(decision.insight, decision.fromNoteId) : null;
          if (!handed) continue;
          try {
            await saveCardDecision(note.id, handed.id, handed.decision);
            await saveCardDecision(decision.fromNoteId, decision.cardId, null);
            own[handed.id] = handed.decision;
            incoming = incoming.filter((item) => item !== decision);
          } catch { /* Kept as it was; it moves the next time. */ }
        }
        if (!active) return;
        setDecisions(own);
        setIncomingDecisions(incoming);
      })
      .catch(() => { if (active) setSaveState('error'); });
    return () => { active = false; };
  }, [note.id]);

  /**
   * Records a choice, or clears it. The screen changes at once; if saving
   * fails, it goes back to how it was and says so.
   */
  const decide = (view: (typeof cardLayout.views)[number], choice: CardChoice | null, text?: string) => {
    const previous = decisions[view.id];
    // Solving an earlier note's problem hands the solution to that note: it is
    // saved there as its own solved card, and the card leaves this note.
    const handed = choice === 'solved' && view.item.direction === 'outbound' && !view.fromNoteId ? handedSolutionCard(view.item, note.id) : null;
    if (handed) {
      const marker: IncomingCardDecision = { ...handed.decision, cardId: handed.id, fromNoteId: handed.problemNoteId };
      setIncomingDecisions((current) => [...current, marker]);
      saveCardDecision(handed.problemNoteId, handed.id, handed.decision).catch(() => {
        setIncomingDecisions((current) => current.filter((item) => item !== marker));
        setSaveState('error');
      });
      return;
    }
    const next: CardDecision | null = choice
      ? {
        choice,
        // A dismissed solution carries on as a Helps card; anything else keeps its kind.
        kind: choice === 'downgraded' ? 'helps' : view.kind,
        insight: view.item,
        ...(text !== undefined ? { text } : {}),
      }
      : null;
    const apply = (decision: CardDecision | null | undefined) => setDecisions((current) => {
      const updated = { ...current };
      if (decision) updated[view.id] = decision;
      else delete updated[view.id];
      return updated;
    });
    apply(next);
    saveCardDecision(note.id, view.id, next).catch(() => {
      apply(previous);
      setSaveState('error');
    });
  };

  // A new note or search starts on the first section with something to show.
  // Afterwards clicking a section controls this, so a choice on a card, or
  // typing in the note, never moves the reader somewhere else.
  useEffect(() => {
    const firstWithCard = noteSections.find((section) => cardLayout.shown.some((view) => view.section?.id === section.id))?.id;
    setSelectedSectionId(firstWithCard ?? noteSections[0]?.id ?? null);
    setSelectedInsightIndex(cardLayout.shown[0]?.index ?? 0);
    // Only a new note or a new search should reset the selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id, retrieval]);

  const allVisibleInsightEntries = cardLayout.shown;
  const visibleInsightEntries = allVisibleInsightEntries.filter((entry) => entry.section?.id === selectedSectionId);

  /**
   * Notes the search matched that no card cites. The insight step writes a
   * card only when a note would change what the person does next, so without
   * this list a search that found related notes could look empty. Matches for
   * one part show with that part; matches for the note as a whole, or for a
   * part that no longer lines up with the text, always show.
   */
  const relatedNotes = useMemo(() => {
    const cited = new Set(cardLayout.shown.flatMap((view) => view.item.note_ids));
    const sectionIds = new Set(noteSections.map((section) => section.id));
    const uncited = (retrieval?.results ?? []).filter((result) => result.note_id !== note.id && !cited.has(result.note_id) && noteById.has(result.note_id));
    return {
      forSection: (sectionId: string | null) => uncited.filter((result) => result.section_id && result.section_id === sectionId),
      forWholeNote: uncited.filter((result) => !result.section_id || !sectionIds.has(result.section_id)),
    };
  }, [cardLayout.shown, note.id, noteById, noteSections, retrieval]);
  const relatedHere = relatedNotes.forSection(selectedSectionId);

  const selectSection = (sectionId: string) => {
    setSelectedSectionId(sectionId);
    const first = allVisibleInsightEntries.find((entry) => entry.section?.id === sectionId);
    if (first) setSelectedInsightIndex(first.index);
  };

  const selectInsight = (index: number) => {
    const sectionId = insightPlacements[index]?.section?.id;
    if (sectionId) selectSection(sectionId);
    setSelectedInsightIndex(index);
    setSummaryOpen(true);
    requestAnimationFrame(() => document.getElementById(`suggestion-card-${index}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  };

  /** Opens a past note in the side panel, scrolled to the words a card quoted from it. */
  const showCitedNote = (noteId: string, focus = '') => {
    setPanelRelevance(relevanceByNoteId.get(noteId) ?? null);
    setPanelFocus(focus);
    setPanelNoteId(noteId);
    setSummaryOpen(true);
  };

  /** The sentence of this note a card is about, with its key part picked out. */
  const triggerFor = (span: { start: number; end: number } | null) => span ? triggerSentence(displayedBody, span) : null;

  /** Every card the design's panel steps through, in reading order; dismissed ones stay so they can be undone. */
  const designCards = useMemo(() => {
    const shown = new Set(cardLayout.shown);
    return cardLayout.views
      .filter((view) => shown.has(view) || view.decision?.choice === 'rejected')
      .sort((a, b) => (a.section?.index ?? 0) - (b.section?.index ?? 0) || (a.span?.start ?? 0) - (b.span?.start ?? 0));
  }, [cardLayout]);
  const activeCard = designCards.find((view) => view.id === activeCardId) ?? null;
  const relatedCount = relatedNotes.forWholeNote.length + noteSections.reduce((count, section) => count + relatedNotes.forSection(section.id).length, 0);
  const insightFailed = Boolean(retrieval?.insight_failed);
  // When a note has cards, the notes the search matched without one, and word
  // that the suggestions did not finish, come after them as a last page.
  const hasRelatedPage = designCards.length > 0 && (relatedCount > 0 || insightFailed);
  const designPages = hasRelatedPage ? [...designCards.map((view) => view.id), RELATED_PAGE] : designCards.map((view) => view.id);
  const onRelatedPage = hasRelatedPage && activeCardId === RELATED_PAGE;
  const activePosition = designPages.indexOf(activeCardId ?? '');
  const designPendingCount = designCards.filter((view) => isPendingCard(view.decision)).length;
  const citedNotesOf = (view: CardView) => view.item.note_ids.map((id) => noteById.get(id)).filter((item): item is Note => item !== undefined);
  // While a card is open, or a result under a passage, the rest of the note fades back.
  // A card this note answered elsewhere has nothing here to focus on, so nothing fades.
  // The phone layout: a bottom bar opens the panel as a sheet over the note.
  const sheetMode = designView && narrowScreen;
  // On a phone the note stays as it is under the sheet, as in the design.
  const designFocus = sheetMode ? false : summaryOpen ? activeCard !== null && !marksOtherNote(activeCard, isOutbound(activeCard.item)) : dropCardId !== null;

  const closeDesignReading = () => { setPanelNoteId(null); setPanelRelevance(null); setPanelFocus(''); };
  const closeDesignPanel = () => { setSummaryOpen(false); setActiveCardId(null); closeDesignReading(); };
  const openDesignCard = (cardId: string | null) => { setDropCardId(null); closeDesignReading(); setActiveCardId(cardId); setSummaryOpen(true); };
  /** The panel button: the first card still waiting, or the first at all, or the empty state. */
  const openDesignPanel = () => {
    const live = designCards.filter((view) => view.decision?.choice !== 'rejected');
    openDesignCard((live.find((view) => isPendingCard(view.decision)) ?? live[0])?.id ?? (hasRelatedPage ? RELATED_PAGE : null));
  };
  const stepDesignCard = (delta: number) => {
    if (!designPages.length) return;
    const next = designPages[(Math.max(activePosition, 0) + delta + designPages.length) % designPages.length];
    closeDesignReading();
    setActiveCardId(next);
  };
  /** A choice closes the panel and opens its result under the passage, as in the design. */
  const chooseDesign = (view: CardView, choice: CardChoice | null, text?: string) => {
    decide(view, choice, text);
    if (!choice || choice === 'downgraded') return;
    const outbound = isOutbound(view.item) || view.item.direction === 'outbound';
    // A solution handed to an earlier note leaves this note entirely.
    if (choice === 'solved' && outbound) { closeDesignPanel(); return; }
    // On a phone the sheet stays on the card and shows what was chosen, as in the design.
    if (sheetMode) return;
    // Marking this note as helping an earlier one leaves nothing on it, so the
    // panel stays on the card to say where it went, with Undo.
    if (choice === 'helped' && outbound) return;
    closeDesignPanel();
    if (choice !== 'rejected') setDropCardId(view.id);
  };

  // A search that finishes while the panel shows nothing opens its first card.
  // So does one that replaced the open card: a card's id comes from its
  // wording, and a new search rewords it, so the old id finds nothing and the
  // panel said "Nothing to act on" over cards it had (fixed Nov 26).
  useEffect(() => {
    if (!designView || !summaryOpen || panelNoteId) return;
    if (activeCardId && designPages.includes(activeCardId)) return;
    const first = designCards.find((view) => isPendingCard(view.decision));
    if (first) setActiveCardId(first.id);
    else if (activeCardId) setActiveCardId(designCards.find((view) => view.decision?.choice !== 'rejected')?.id ?? (hasRelatedPage ? RELATED_PAGE : null));
    // Only a new search should move the panel on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retrieval]);

  // On a computer, a search that just finished with something to show opens
  // the side panel, so it is not missed (decided Nov 25). Phones keep the
  // sheet down; their footer says what was found.
  useEffect(() => {
    if (!searchesFinished || sheetMode || summaryOpen || !window.matchMedia('(min-width: 1280px)').matches) return;
    if (designView ? designCards.length > 0 || relatedCount > 0 : Boolean(retrieval?.results.length)) {
      if (designView) openDesignPanel(); else setSummaryOpen(true);
    }
    // Only a newly finished search should open the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchesFinished]);

  /** What a running search says, with how far the readers have got. */
  const searchingLabel = `Searching your notes${retrievalProgress?.agents_total ? ` · ${retrievalProgress.agents_done}/${retrievalProgress.agents_total}` : '…'}`;

  /** Notes the search matched that no card used, by the part of the note they match, then the whole note. */
  const relatedListsHeaded = (lead: 'Related' | 'Also related') => <>
    {noteSections.map((section) => { const results = relatedNotes.forSection(section.id); return results.length ? <RelatedNotesList key={`part-${section.id}`} heading={noteSections.length > 1 ? `${lead} to part ${section.index + 1}` : lead} results={results} notesById={noteById} onOpen={showCitedNote} /> : null; })}
    {relatedNotes.forWholeNote.length > 0 && <RelatedNotesList heading={`${lead} to the whole note`} results={relatedNotes.forWholeNote} notesById={noteById} onOpen={showCitedNote} />}
  </>;
  const relatedLists = relatedListsHeaded('Related');
  /** Shown when the search found notes but stopped before writing suggestions from them. */
  const failedNotice = insightFailed ? <div role="alert" className="rounded-xl border border-[#f0d9a8] bg-[#fff8e8] p-5">
    <h3 className="text-sm font-semibold text-[#6f5100]">Suggestions did not finish</h3>
    <p className="mt-1.5 text-[13px] leading-relaxed text-[#806b35]">{relatedCount
      ? 'The search found related notes, listed below, but stopped before it could turn them into suggestions. Searching again usually finishes.'
      : 'The search stopped before it could write suggestions, so this is not a sign your notes had nothing to offer. Searching again usually finishes.'}</p>
    <button type="button" onClick={() => requestReretrieval('relevant')} disabled={retrievalLoading || requiresDomain} className="mt-3 flex min-h-[36px] items-center gap-1.5 rounded-lg border border-[#e3c98a] bg-white px-3 text-[13px] font-medium text-[#6f5100] hover:border-[#d4ad55] disabled:opacity-50"><RefreshCw className="h-3.5 w-3.5" /> Search again</button>
  </div> : null;

  /**
   * What the phone's footer bar says: what the search found, by kind ("1
   * insight · 2 related notes"), or plainly that there is nothing (decided Nov 25).
   */
  const footerSummary = (() => {
    const insightCount = designCards.filter((view) => view.decision?.choice !== 'rejected').length;
    const counted = [
      insightCount ? `${insightCount} ${insightCount === 1 ? 'insight' : 'insights'}` : '',
      relatedCount ? `${relatedCount} related ${relatedCount === 1 ? 'note' : 'notes'}` : '',
    ].filter(Boolean).join(' · ');
    if (counted) return counted;
    if (insightFailed) return 'Suggestions did not finish';
    if (retrievalError) return 'Could not search your notes';
    return retrieval ? 'Nothing from your notes' : 'Not searched yet';
  })();

  /**
   * On a phone, tapping the title or the note's text starts editing; there is
   * no Edit button (decided Nov 25). A marked passage, a pill, a link or the
   * Domain and date still do their own thing, and while the sheet is open a
   * tap on the note only lowers it.
   */
  const tapToEdit = (event: React.MouseEvent) => {
    if (!narrowScreen || editing) return;
    if ((event.target as Element).closest('button, a, input, mark, [role="button"]')) return;
    if (sheetMode && summaryOpen) { closeDesignPanel(); return; }
    setEditing(true);
    requestAnimationFrame(() => bodyRef.current?.focus());
  };

  const switchSuggestionsView = () => {
    const next: NoteSuggestionsView = designView ? 'classic' : 'design';
    writeNoteSuggestionsView(next);
    setSuggestionsView(next);
    setMenuOpen(false);
    setActiveCardId(null);
    setDropCardId(null);
    closeDesignReading();
    setSummaryOpen(next === 'classic' && window.matchMedia('(min-width: 1280px)').matches);
  };

  /**
   * A section of the note as the design draws it. A section with a card gets a
   * line in the card's colour; its chosen cards end it with a pill that opens
   * what was chosen. Merged words and answers from later notes sit below it.
   */
  const renderDesignSection = (section: NoteSection) => {
    const text = formattedBody ? <FormattedNoteBody text={section.text} /> : <span className="whitespace-pre-wrap break-words">{section.text}</span>;
    // A card this note answered elsewhere leaves no mark here; it stays in the panel for Undo.
    const here = designCards.filter((view) => view.section?.id === section.id && view.decision?.choice !== 'rejected' && !marksOtherNote(view, isOutbound(view.item)));
    const selected = summaryOpen ? here.find((view) => view.id === activeCardId) : undefined;
    const dropView = summaryOpen ? undefined : here.find((view) => view.id === dropCardId && isActedCard(view.decision));
    const color = designFocus && !selected && !dropView ? '#C4C4CA' : '#2B2B2E';
    const incomingHere = overlays.filter((overlay) => overlay.view.fromNoteId && overlay.type === 'block' && overlay.view.section?.id === section.id);
    const below = <>
      {here.filter((view) => view.decision?.choice === 'merged').map((view) => {
        const tone = DESIGN_TONES.extension;
        const source = designSourceOf(view.item, noteById);
        return <div key={`added-${view.id}`} className="mt-3.5 flex flex-col gap-1.5 rounded-[10px] border px-[18px] py-3.5" style={{ background: tone.tint, borderColor: tone.soft }}>
          <span className="text-[18px] leading-relaxed text-[#2B2B2E]">{plainNoteText(view.decision?.text ?? view.item.answer?.text ?? view.item.action)}</span>
          {source.note && <button type="button" onClick={(event) => { event.stopPropagation(); showCitedNote(source.note!.id, view.item.answer?.text ?? ''); }} className="self-start text-[13px] text-[#6B6B70] hover:underline">From {source.sharedBy ? `${source.sharedBy}’s ` : ''}“{source.title}”{source.date ? ` · ${source.date}` : ''} ↗</button>}
        </div>;
      })}
      {incomingHere.map(({ view }) => {
        const tone = DESIGN_TONES.solution;
        const from = view.fromNoteId ? noteById.get(view.fromNoteId) : undefined;
        return <div key={`incoming-${view.id}`} className="mt-3.5 flex flex-col gap-1.5 rounded-[10px] border px-[18px] py-3.5" style={{ background: tone.tint, borderColor: tone.soft }}>
          <span className="text-[18px] leading-relaxed text-[#2B2B2E]"><span className="mr-1.5 text-[13px] font-semibold" style={{ color: tone.ink }}>Solution</span>{plainNoteText(view.item.answer?.text ?? view.item.action)}</span>
          {from && <button type="button" onClick={(event) => { event.stopPropagation(); showCitedNote(from.id, view.item.answer?.text ?? ''); }} className="self-start text-[13px] text-[#6B6B70] hover:underline">From “{noteLabel(from)}” · {formatDate(from.created_at)} ↗</button>}
        </div>;
      })}
    </>;

    if (!here.length) return <section key={section.id} id={`note-${section.id}`} aria-label={`Section ${section.index + 1}`} onClick={() => { if (summaryOpen) closeDesignPanel(); setDropCardId(null); }} className="cursor-text scroll-mt-20 pr-5 transition-colors" style={{ color }}>{text}{below}</section>;

    const lead = selected ?? here.find((view) => isPendingCard(view.decision)) ?? here[0];
    // The line and fill take the colour of the card that is open, if any.
    const tone = DESIGN_TONES[(selected ?? dropView ?? lead).kind];
    const allActed = here.every((view) => isActedCard(view.decision));
    const lineWidth = selected || (allActed && !summaryOpen) ? 3 : 2;
    const lineColor = selected ? tone.ink : summaryOpen ? tone.soft : allActed ? tone.ink : tone.soft;
    const pick = () => {
      // On a phone a chosen passage opens its card in the sheet, as in the design.
      if (!summaryOpen && allActed && !sheetMode) { setDropCardId((id) => (id === lead.id ? null : lead.id)); return; }
      if (selected) { closeDesignPanel(); return; }
      openDesignCard(lead.id);
    };
    const blockStyle: React.CSSProperties = selected
      ? sheetMode
        // On a phone the open passage is a tinted box; there is no panel beside it to reach.
        ? { background: tone.tint, borderRadius: 10, padding: '10px 12px 10px 0', margin: '-10px 0' }
        : { background: tone.tint, borderRadius: '10px 0 0 10px', padding: '16px 0', margin: '-16px 0', boxShadow: `0 0 0 100vw ${tone.tint}`, clipPath: 'inset(0 -100vw 0 0)' }
      : dropView ? { background: tone.tint, borderRadius: 10, padding: '14px 18px 14px 0', margin: '-14px 0 0' } : {};
    return <section key={section.id} id={`note-${section.id}`} aria-label={`Section ${section.index + 1}`} className="-ml-5 scroll-mt-20">
      <div role="button" tabIndex={0} aria-pressed={Boolean(selected)} title={selected ? 'Close what your notes say' : 'Show what your notes say'} onClick={pick} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(); } }} className="flex cursor-pointer outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#477bea]/30" style={blockStyle}>
        <span className="flex w-5 shrink-0 self-stretch" aria-hidden="true"><span className="rounded-sm transition-all" style={{ width: lineWidth, background: lineColor }} /></span>
        <div className="min-w-0 flex-1 transition-colors" style={{ color }}>
          {text}
          {here.some((view) => isActedCard(view.decision)) && <span className="mt-1 inline-flex flex-wrap gap-1.5 align-[2px]">
            {here.filter((view) => isActedCard(view.decision)).map((view) => {
              const viewTone = DESIGN_TONES[view.kind];
              const open = !summaryOpen && dropCardId === view.id;
              return <button key={`pill-${view.id}`} type="button" onClick={(event) => { event.stopPropagation(); if (summaryOpen || sheetMode) openDesignCard(view.id); else setDropCardId((id) => (id === view.id ? null : view.id)); }} className="inline-flex max-w-full items-center gap-1 truncate whitespace-nowrap rounded-full px-[9px] text-xs font-semibold leading-5 hover:brightness-95 sm:max-w-[22rem]" style={{ background: viewTone.tint, color: viewTone.ink }}>
                ✓ {designChoiceLabel(view.decision?.choice, designSourceOf(view.item, noteById))}{!summaryOpen && !sheetMode && <span aria-hidden="true">{open ? ' ▴' : ' ▾'}</span>}
              </button>;
            })}
          </span>}
        </div>
      </div>
      {dropView && <div className="ml-5"><DesignDrop view={dropView} notesById={noteById} outbound={isOutbound(dropView.item)} onUndo={() => { decide(dropView, designUndoChoice(dropView)); setDropCardId(null); }} onOpenSource={showCitedNote} /></div>}
      <div className="ml-5">{below}</div>
    </section>;
  };

  const [dismissedGoalDomains, setDismissedGoalDomains] = useState(() => readGoalPromptDismissed(userId));
  const goalSuggestions = retrieval?.goal_suggestions ?? [];
  const goalPrompt = domainName && !goalText && !dismissedGoalDomains.includes(domainName.toLowerCase()) && goalSuggestions.length
    ? <GoalPrompt
      domainTitle={domainName}
      suggestions={goalSuggestions}
      // Saving the goal marks the existing retrieval as stale. The user can
      // explicitly re-retrieve without losing the results already on screen.
      onPick={(goal) => onSetDomainGoal(domainName, goal)}
      onDismiss={() => { dismissGoalPrompt(userId, domainName); setDismissedGoalDomains(readGoalPromptDismissed(userId).concat(domainName.toLowerCase())); }}
    />
    : null;

  /** Saves any edit, then opens `next` (without a search unless asked) or closes the note. */
  const leaveWorkspace = async (next?: Note | null, autoSearch = false) => {
    if (noteChanged) {
      setSaveState('saving');
      try { await latestSaveRef.current(note.id, rawText); setSaveState('saved'); }
      catch { setSaveState('error'); return; }
    }
    if (next) onOpenNote(next, autoSearch); else onClose();
  };

  const returnToPrevious = async () => {
    if (noteChanged) {
      setSaveState('saving');
      try { await latestSaveRef.current(note.id, rawText); setSaveState('saved'); }
      catch { setSaveState('error'); return; }
    }
    onReturnToPrevious();
  };

  const finishEditing = () => {
    setEditing(false);
    if (!noteChanged) return;
    setSaveState('saving');
    latestSaveRef.current(note.id, rawText)
      .then(() => setSaveState('saved'))
      .catch(() => setSaveState('error'));
  };

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !searchRequest) void leaveWorkspace(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  });

  const applyReadingFormat = (kind: NoteFormat) => bodyRef.current?.format(kind);

  const openDate = () => setSearchRequest({ query: '', filter: { kind: 'date', value: localDateKey(note.created_at), label: fullNoteDate(note.created_at) } });

  /**
   * What an acted-on card leaves over the note. Clicking one opens the past
   * note it came from at the quoted spot, or, for a choice that has no single
   * spot (both are true, a pattern), reopens the card.
   */
  const renderOverlay = (overlay: (typeof overlays)[number], key: string) => {
    const { view } = overlay;
    const style = SUGGESTION_STYLES[view.kind];
    const choice = view.decision?.choice;
    const item = view.item;
    // Where the mark leads: for a box from a later note, that note's answer; for
    // this note's answer to an earlier problem, that problem; otherwise the
    // past words the card quoted. An answer with an empty note id is this note's own.
    const outboundAnswer = item.direction === 'outbound' && choice === 'solved' && !view.fromNoteId;
    const outboundHelp = item.direction === 'outbound' && choice === 'helped' && !view.fromNoteId;
    const sourceId = view.fromNoteId
      ?? (outboundAnswer ? item.problem?.note_id : undefined)
      ?? (item.answer?.note_id || item.quotes?.[0]?.note_id || item.note_ids[0]);
    const source = sourceId ? noteById.get(sourceId) : undefined;
    const sourceTitle = source ? noteLabel(source) : 'earlier note';
    // Someone else's note is named as theirs, never as one of yours.
    const sharedBy = source?.shared_by ?? null;
    const focus = view.fromNoteId ? item.answer?.text ?? ''
      : outboundAnswer ? item.problem?.text ?? ''
        : (item.answer?.note_id ? item.answer.text : '') || item.quotes?.[0]?.text || '';
    const reopenCard = choice === 'both' || choice === 'confirmed';
    const open = () => { if (reopenCard) selectInsight(view.index); else if (sourceId) showCitedNote(sourceId, focus); };
    const handlers = {
      role: 'button' as const,
      tabIndex: 0,
      onClick: (event: React.MouseEvent) => { event.stopPropagation(); open(); },
      onKeyDown: (event: React.KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); open(); } },
      title: reopenCard ? 'Open the card' : `Open “${sourceTitle}”`,
    };
    if (overlay.type === 'chip') {
      const label = choice === 'merged' ? 'Extended'
        : outboundAnswer ? `Solves ${sourceTitle}`
          : outboundHelp ? `Helps ${sourceTitle}`
        : choice === 'today' ? (sharedBy ? `Differs from ${sharedBy}` : `Updates ${sourceTitle}`)
          : choice === 'earlier' ? (sharedBy ? `${sharedBy}’s view holds` : `${sourceTitle} holds`)
            : choice === 'confirmed' ? `Pattern · ${sourceTitle}`
              : sourceTitle;
      return <span key={key} {...handlers} className={`ml-1.5 inline-block max-w-[16rem] cursor-pointer truncate rounded-full border px-2 align-[2px] text-[11px] font-medium leading-5 hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea] ${style.chip}`}>{label}</span>;
    }
    const words = choice === 'merged'
      ? plainNoteText(view.decision?.text ?? item.answer?.text ?? item.action)
      : choice === 'solved' ? plainNoteText(item.solution || (item.answer?.text ?? item.action))
        : item.kind === 'helps' ? `Might help to ${plainNoteText(item.action)}` : `Might help: “${plainNoteText(item.answer?.text ?? item.action)}”`;
    return <span key={key} {...handlers} className={`my-2 block cursor-pointer rounded-lg border px-3 py-2 text-[15px] leading-relaxed hover:brightness-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea] ${choice === 'merged' ? 'border-y-0 border-r-0 border-l-[3px] border-[#c8acea] bg-[#fbf8ff] text-[#3d2a57]' : `border-dashed ${style.outline} text-[#2d2d2d]`}`}>
      {choice === 'solved' && <span className={`mr-1.5 text-[12px] font-semibold ${style.actionText}`}>Solution:</span>}
      {words}
      <span className="mt-0.5 block text-[11px] text-[#999]">From {sharedBy ? `${sharedBy}’s ` : ''}“{sourceTitle}”{source ? ` · ${formatDate(source.created_at)}` : ''} ↗</span>
    </span>;
  };

  /**
   * A section's text with its marks: a highlight on each passage waiting on the
   * person, and their choices drawn over it. The text itself is never changed.
   */
  const renderSectionContent = (section: NoteSection) => {
    const marks = highlights.filter((span) => span.start >= section.start && span.end <= section.end);
    const inserts = overlays.filter((overlay) => overlay.at >= section.start && overlay.at <= section.end && overlay.view.section?.id === section.id);
    if (!marks.length && !inserts.length) return formattedBody ? <FormattedNoteBody text={section.text} /> : <span className="whitespace-pre-wrap break-words">{section.text}</span>;

    type DecoratedEvent =
      | { kind: 'mark'; at: number; end: number; mark: (typeof marks)[number] }
      | { kind: 'overlay'; at: number; overlay: (typeof inserts)[number] };

    /** Draw retrieval marks and accepted suggestions without changing source offsets. */
    const renderDecoratedRange = (start: number, end: number, keyPrefix: string): React.ReactNode[] => {
      const events: DecoratedEvent[] = [
        ...marks
          .filter((mark) => mark.end > start && mark.start < end)
          .map((mark) => ({ kind: 'mark' as const, at: Math.max(mark.start, start), end: Math.min(mark.end, end), mark })),
        ...inserts
          .filter((overlay) => overlay.at >= start && overlay.at <= end)
          .map((overlay) => ({ kind: 'overlay' as const, at: overlay.at, overlay })),
      ].sort((left, right) => left.at - right.at || (left.kind === 'mark' ? -1 : 1));
      const nodes: React.ReactNode[] = [];
      let cursor = start;
      events.forEach((event, position) => {
        // Anything placed inside a passage already drawn goes just after it.
        const at = Math.max(event.at, cursor);
        if (at > cursor) nodes.push(displayedBody.slice(cursor, at));
        cursor = at;
        if (event.kind === 'overlay') {
          nodes.push(renderOverlay(event.overlay, `${keyPrefix}-o${position}`));
          // A box already ends the line, so its line break would leave a gap.
          if (event.overlay.type === 'block' && cursor < end && displayedBody[cursor] === '\n') cursor++;
          return;
        }
        if (event.at < cursor) return;
        const { mark } = event;
        const view = cardLayout.views[mark.index];
        const style = SUGGESTION_STYLES[view.kind];
        const highlightStyle = HIGHLIGHT_STYLES[view.kind];
        const active = view.item === insight;
        const openInsight = () => selectInsight(mark.index);
        nodes.push(<mark
          key={`${keyPrefix}-m${mark.index}-${event.at}`}
          role="button"
          tabIndex={0}
          onClick={(clickEvent) => { clickEvent.stopPropagation(); openInsight(); }}
          onKeyDown={(keyEvent) => { if (keyEvent.key === 'Enter' || keyEvent.key === ' ') { keyEvent.preventDefault(); keyEvent.stopPropagation(); openInsight(); } }}
          aria-pressed={active}
          title="See what your notes say about this"
          className={`cursor-pointer rounded-sm px-0.5 text-inherit underline decoration-2 underline-offset-4 [box-decoration-break:clone] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea] ${active ? highlightStyle.active : `${highlightStyle.idle} hover:brightness-[0.98]`}`}
        ><InlineNoteFormatting text={displayedBody.slice(event.at, event.end)} />{event.end === mark.end && <span className={`ml-1 inline-block rounded px-1 align-[1px] text-[10px] font-medium leading-4 ${style.badge}`}>{style.label}</span>}</mark>);
        cursor = event.end;
      });
      if (cursor < end) nodes.push(displayedBody.slice(cursor, end));
      return nodes;
    };

    /** Hide lightweight Markdown markers while retaining retrieval decorations. */
    const renderInlineRange = (start: number, end: number, keyPrefix: string): React.ReactNode[] => {
      const runs = inlineRuns(displayedBody.slice(start, end), start);
      const nodes: React.ReactNode[] = [];
      // The markers themselves are not drawn, so a chip or box placed on one
      // (a fully bold sentence puts it right after the closing **) is drawn
      // next to the words instead of being dropped with the marker. Each run
      // draws what sits on it, ends included; a gap draws what is strictly
      // between runs, and at the line's own start and end.
      const overlaysOnMarkers = (after: number, before: number, keyPart: string) => inserts
        .filter((overlay) => overlay.at > after && overlay.at < before)
        .map((overlay, position) => renderOverlay(overlay, `${keyPrefix}-${keyPart}${position}`));
      let previousEnd = start - 1;
      runs.forEach((run, index) => {
        nodes.push(...overlaysOnMarkers(previousEnd, run.start, `gap${index}-`));
        nodes.push(styledRun(run, renderDecoratedRange(run.start, run.end, `${keyPrefix}-r${index}`), `${keyPrefix}-s${index}`));
        previousEnd = run.end;
      });
      nodes.push(...overlaysOnMarkers(previousEnd, end + 1, 'tail-'));
      return nodes;
    };

    if (formattedBody) {
      let lineStart = section.start;
      return <div className="space-y-3 break-words">{displayedBody.slice(section.start, section.end).split('\n').map((rawLine, index) => {
        const currentStart = lineStart;
        const lineEnd = currentStart + rawLine.length;
        lineStart = lineEnd + 1;
        const heading = rawLine.match(/^(#{1,3})\s+(.*)$/);
        if (heading) {
          const level = heading[1].length;
          const contentStart = lineEnd - heading[2].length;
          const className = level === 1 ? 'pt-2 text-2xl font-semibold leading-snug' : level === 2 ? 'pt-2 text-xl font-semibold leading-snug' : 'pt-1 text-lg font-semibold leading-snug';
          return <div key={index} role="heading" aria-level={Math.min(level + 1, 6)} className={className}>{renderInlineRange(contentStart, lineEnd, `${section.id}-l${index}`)}</div>;
        }
        const bullet = rawLine.match(/^[-+*•]\s+(.*)$/);
        if (bullet) {
          const contentStart = lineEnd - bullet[1].length;
          return <div key={index} className="flex gap-3 pl-2"><span aria-hidden="true" className="mt-[0.72em] h-1.5 w-1.5 shrink-0 rounded-full bg-current" /><span>{renderInlineRange(contentStart, lineEnd, `${section.id}-l${index}`)}</span></div>;
        }
        const numbered = rawLine.match(/^(\d+)\.\s+(.*)$/);
        if (numbered) {
          const contentStart = lineEnd - numbered[2].length;
          return <div key={index} className="flex gap-3 pl-1"><span className="min-w-5 shrink-0 text-right text-[#777]">{numbered[1]}.</span><span>{renderInlineRange(contentStart, lineEnd, `${section.id}-l${index}`)}</span></div>;
        }
        if (!rawLine.trim()) return <div key={index} className="min-h-2" aria-hidden={!inserts.some((overlay) => overlay.at === currentStart)}>{renderDecoratedRange(currentStart, lineEnd, `${section.id}-blank${index}`)}</div>;
        return <div key={index} className="whitespace-pre-wrap">{renderInlineRange(currentStart, lineEnd, `${section.id}-l${index}`)}</div>;
      })}</div>;
    }

    return <span className="whitespace-pre-wrap break-words">{renderDecoratedRange(section.start, section.end, section.id)}</span>;
  };

  return (
    <div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) void leaveWorkspace(); }} className="fixed inset-0 z-50 flex items-center justify-center bg-white p-0 sm:bg-black/35 sm:p-6 sm:backdrop-blur-[1px]">
    <div role="dialog" aria-modal="true" aria-label={title || 'Note'} className="flex h-[100dvh] min-h-0 w-full max-w-[1760px] flex-col overflow-hidden bg-white shadow-2xl sm:h-[min(94dvh,980px)] sm:rounded-xl sm:p-5">
      <header className="relative flex min-h-14 shrink-0 items-center border-b border-[#ececef] px-2 sm:h-14 sm:border-0 sm:px-2">
        <div className="flex items-center gap-1 text-[#777] sm:gap-2">
          {previousNote ? <><button type="button" onClick={() => void returnToPrevious()} aria-label={`Back to ${noteLabel(previousNote)}`} title={`Back to ${noteLabel(previousNote)}`} className="flex h-11 w-11 items-center justify-center rounded-md hover:bg-[#f4f4f4] sm:h-9 sm:w-9"><ArrowLeft className="h-5 w-5" /></button><span className="mx-1 hidden h-7 w-px bg-[#e5e5e5] sm:block" /></> : <button type="button" onClick={() => void leaveWorkspace()} aria-label="Back to dashboard" title="Back to dashboard" className="flex h-11 w-11 items-center justify-center rounded-md hover:bg-[#f4f4f4] xl:hidden"><ArrowLeft className="h-5 w-5" /></button>}
          {/* A note open on a phone keeps only the way back and the three dots (decided Nov 25). */}
          <button type="button" onClick={onAddNote} aria-label="Add a note" title="Add a note" className={`${sheetMode ? 'hidden' : 'flex'} h-10 w-10 items-center justify-center rounded-md bg-[#477bea] text-white hover:bg-[#3d6ed7] sm:h-8 sm:w-8`}><Plus className="h-5 w-5" /></button>
          <button type="button" onClick={() => setSearchRequest({ query: '' })} aria-label="Search notes, pages, and Domains" title="Search notes, pages, and Domains" className={`${sheetMode ? 'hidden' : 'flex'} h-10 w-10 items-center justify-center rounded-md hover:bg-[#f4f4f4] sm:h-9 sm:w-9`}><Search className="h-5 w-5" /></button>
        </div>
        <div className="absolute left-1/2 hidden -translate-x-1/2 text-sm xl:block"><NoteDomainPicker category={note.category} muses={muses} saving={saving} onChange={onChangeDomain} /></div>
        <div className="relative ml-auto flex items-center gap-1 text-[#777]">
          {usedInNotes.length > 0 && <div className="relative mr-2 hidden sm:block">
            <button type="button" onClick={() => setUsedInMenuOpen((open) => !open)} aria-haspopup="menu" aria-expanded={usedInMenuOpen} className="rounded-md border border-[#dedede] bg-white px-3 py-1.5 text-xs text-[#666] shadow-sm hover:border-[#adc3ff] hover:text-[#477bea]">Used in other notes</button>
            {usedInMenuOpen && <div role="menu" className="absolute right-0 top-10 z-40 w-72 overflow-hidden rounded-lg border border-[#ddd] bg-white py-1 shadow-xl">
              {usedInNotes.map((item) => <button key={item.id} role="menuitem" type="button" onClick={() => { setUsedInMenuOpen(false); void leaveWorkspace(item, false); }} className="block w-full truncate px-4 py-2.5 text-left text-sm text-[#333] hover:bg-[#edf3ff] hover:text-[#315fc5]">{noteLabel(item)}</button>)}
            </div>}
          </div>}
          <button type="button" disabled={!newerNote} onClick={() => newerNote && void leaveWorkspace(newerNote, false)} aria-label="Newer note" title="Newer note" className="hidden h-9 w-9 items-center justify-center rounded-md hover:bg-[#f4f4f4] disabled:opacity-25 sm:flex"><ChevronLeft className="h-4 w-4" /></button>
          <button type="button" disabled={!olderNote} onClick={() => olderNote && void leaveWorkspace(olderNote, false)} aria-label="Older note" title="Older note" className="hidden h-9 w-9 items-center justify-center rounded-md hover:bg-[#f4f4f4] disabled:opacity-25 sm:flex"><ChevronRight className="h-4 w-4" /></button>
          <button type="button" onClick={() => setMenuOpen((open) => !open)} aria-label="Note options" aria-expanded={menuOpen} className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-[#f4f4f4] sm:h-9 sm:w-9"><MoreHorizontal className="h-5 w-5" /></button>
          {menuOpen && <div className="absolute right-0 top-11 z-30 w-56 overflow-hidden rounded-lg border border-[#ddd] bg-white py-1 text-sm shadow-xl"><button type="button" onClick={switchSuggestionsView} className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-[#f5f5f5]"><Layers3 className="h-4 w-4" /> {designView ? 'Classic suggestions view' : 'New suggestions view'}</button>{!note.is_sample && <button type="button" disabled={saving} onClick={() => { setMenuOpen(false); void onShare(note); }} className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-[#f5f5f5]"><Share2 className="h-4 w-4" /> Copy to public notes</button>}<button type="button" disabled={saving} onClick={() => { setMenuOpen(false); void onDelete(note); }} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-red-600 hover:bg-red-50"><Trash2 className="h-4 w-4" /> Delete note</button></div>}
        </div>
      </header>

      <div className={`relative grid min-h-0 flex-1 overflow-hidden bg-[#f7f7f9] sm:rounded-xl sm:border sm:border-[#d8d8d8] sm:shadow-[0_2px_9px_rgba(0,0,0,0.13)] ${summaryOpen && !sheetMode ? 'xl:grid-cols-[minmax(0,1.08fr)_minmax(360px,.92fr)]' : 'grid-cols-1'}`}>
        {/* On a phone the note stays in view under the sheet. */}
        <section className={`relative min-h-0 min-w-0 flex-col overflow-hidden bg-white xl:flex ${summaryOpen && !sheetMode ? 'hidden' : 'flex'}`}>
          <div className="absolute right-3 top-3 z-10 flex gap-2 sm:right-4">
            {/* While a search runs and the panel is closed, say so loudly: a coloured, moving button (decided Nov 25). */}
            {retrievalLoading && !summaryOpen && !sheetMode ? <button type="button" onClick={() => (designView ? openDesignPanel() : setSummaryOpen(true))} aria-controls="note-suggestions-panel" className="ocreda-searching flex h-10 items-center gap-2 rounded-full bg-[#477bea] pl-3.5 pr-4 text-[13px] font-medium text-white shadow-[0_6px_18px_rgba(71,123,234,0.4)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea] focus-visible:ring-offset-2">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /><span role="status">{searchingLabel}</span>
            </button>
            : designView ? !summaryOpen && !sheetMode && <button type="button" onClick={openDesignPanel} aria-label="Show suggestions panel" title="Show suggestions panel" aria-controls="note-suggestions-panel" className="flex h-10 items-center gap-1.5 rounded-[10px] px-2.5 text-[#55555B] hover:bg-[#f4f4f4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]">
              {retrievalLoading ? <Loader2 className="h-5 w-5 animate-spin text-[#477bea]" /> : <PanelRightOpen className="h-5 w-5 rotate-180" aria-hidden="true" />}
              {!retrievalLoading && designPendingCount > 0 && <span className="text-xs font-medium">{designPendingCount}</span>}
            </button> : <>
            <button type="button" onClick={() => setSummaryOpen((open) => !open)} aria-label={summaryOpen ? 'Hide suggestions' : 'Show suggestions'} title={summaryOpen ? 'Hide suggestions' : 'Show suggestions'} aria-controls="note-suggestions-panel" aria-expanded={summaryOpen} className="flex h-10 w-10 items-center justify-center rounded-md border border-[#dedede] bg-white text-[#555] shadow-sm hover:border-[#adc3ff] hover:text-[#477bea] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea] sm:h-8 sm:w-8"><PanelRightOpen className={`h-4 w-4 ${summaryOpen ? '' : 'rotate-180'}`} aria-hidden="true" /></button>
            {!summaryOpen && <button type="button" onClick={() => setSummaryOpen(true)} aria-controls="note-suggestions-panel" className="rounded-md border border-[#dedede] bg-white px-3 py-1.5 text-xs text-[#555] shadow-sm hover:border-[#adc3ff] hover:text-[#477bea] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]">Show suggestions</button>}
            </>}
          </div>
          {/* Room at the bottom so the end of the note can scroll above the bar or the open sheet. */}
          <div className={`min-h-0 flex-1 overflow-y-auto px-4 pt-14 sm:px-12 sm:pt-12 xl:px-[8%] ${sheetMode && summaryOpen ? 'pb-[66vh]' : 'pb-24'}`}>
            {editing ? <div className="mx-auto max-w-3xl"><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Note title" placeholder={defaultNoteTitle(body) || 'Title (optional)'} className="w-full bg-transparent text-2xl font-semibold outline-none placeholder:font-normal placeholder:text-[#c4c4c6]" /><NoteBodyEditor ref={bodyRef} value={body} onChange={setBody} autoFocus ariaLabel="Note text" onActiveFormatsChange={setActiveFormats} wrapperClassName="mt-10" className="min-h-[520px] w-full bg-transparent text-base leading-[1.7]" /></div> : <article className="relative mx-auto max-w-3xl" onDoubleClick={() => { setEditing(true); requestAnimationFrame(() => bodyRef.current?.focus()); }} onClick={tapToEdit} title={narrowScreen ? undefined : 'Double-click to edit'}>{(title.trim() || body.trim()) && <h1 className="break-words px-2 py-1 text-2xl font-semibold">{plainNoteText(title) || defaultNoteTitle(body)}</h1>}<div className="mt-2 flex flex-wrap gap-x-3 px-2 text-xs text-[#999]" onDoubleClick={(event) => event.stopPropagation()}><NoteDomainPicker category={note.category} muses={muses} saving={saving} onChange={onChangeDomain} showPrefix /><button type="button" onClick={openDate} className="hover:text-[#477bea]">{fullNoteDate(note.created_at)}</button></div>
              {designView ? <div className="mt-9 flex w-full flex-col gap-[18px] px-2 py-2 text-left text-[17px] leading-[1.6] xl:gap-[22px] xl:text-[19px] xl:leading-[1.65]">
                {noteSections.length ? noteSections.map(renderDesignSection) : <span className="text-left text-base text-[#999]">{narrowScreen ? 'Tap to start writing.' : 'Double-click to start writing.'}</span>}
              </div> : <div className="mt-9 w-full rounded-md px-2 py-2 text-left text-base leading-[1.7]">
                <div className="min-w-0 flex-1 space-y-7">
                  {noteSections.length ? noteSections.map((section) => <section key={section.id} id={`note-${section.id}`} tabIndex={0} aria-label={`Section ${section.index + 1}`} aria-current={selectedSectionId === section.id ? 'true' : undefined} onClick={() => selectSection(section.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectSection(section.id); } }} className={`cursor-text scroll-mt-20 border-l-[3px] pl-4 outline-none transition hover:border-[#888] focus-visible:ring-2 focus-visible:ring-[#477bea]/30 ${selectedSectionId === section.id ? 'border-[#666]' : 'border-[#d2d2d5]'}`}>{renderSectionContent(section)}</section>) : <span className="text-left text-[#999]">{narrowScreen ? 'Tap to start writing.' : 'Double-click to start writing.'}</span>}
                </div>
              </div>}
            </article>}
          </div>
          <ReadingFormatBar onFormat={applyReadingFormat} onDone={finishEditing} editing={editing} active={activeFormats} />
          <span className="absolute bottom-3 right-5 text-[11px] text-[#999]">{saving || saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Save failed' : ''}</span>
          {/* The phone's way in: a bar along the bottom saying how many cards wait, as in the design. */}
          {/* A tap or a swipe on it opens the sheet (decided Nov 25). */}
          {/* While a search runs the bar turns blue with a moving sheen, so it is noticed (decided Nov 25). */}
          {sheetMode && !summaryOpen && !editing && <button type="button" {...tapOrSwipe(openDesignPanel)} aria-label="Open what your notes say" aria-controls="note-suggestions-panel" className={`absolute inset-x-0 bottom-0 z-20 flex h-16 select-none flex-col items-center justify-start gap-2 rounded-t-[20px] pt-2.5 transition-colors duration-300 ${retrievalLoading ? 'ocreda-searching bg-[#477bea] shadow-[0_-6px_22px_rgba(71,123,234,0.45)]' : 'bg-[#F7F7F8] shadow-[0_-6px_20px_rgba(10,10,20,0.12)]'}`}>
            <span className={`h-[5px] w-10 rounded-full ${retrievalLoading ? 'bg-white/60' : 'bg-[#C9C9CF]'}`} aria-hidden="true" />
            <span role="status" className={`flex items-center gap-1.5 text-[13px] ${retrievalLoading ? 'font-medium text-white' : 'text-[#55555B]'}`}>{retrievalLoading ? <><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> {searchingLabel}</> : footerSummary}</span>
          </button>}
        </section>

        {summaryOpen && designView && <aside id="note-suggestions-panel" aria-label="What works for you" className={sheetMode
          // On a phone the panel is a sheet over the lower part of the note.
          ? 'absolute inset-x-0 bottom-0 z-20 flex h-[62%] min-h-0 flex-col overflow-hidden rounded-t-[20px] bg-[#F7F7F8] shadow-[0_-10px_30px_rgba(10,10,20,0.18)]'
          : 'relative flex min-h-0 flex-col overflow-hidden border-l border-[#EEEEF0] bg-[#F7F7F8]'}>
          {/* The sheet's one control (decided Nov 25): its grey bar lowers it back into the footer on a tap or a swipe. */}
          {sheetMode && <button type="button" {...tapOrSwipe(closeDesignPanel)} aria-label="Collapse suggestions" title="Collapse" className="flex h-10 shrink-0 select-none items-center justify-center"><span className="h-[5px] w-10 rounded-full bg-[#C9C9CF]" aria-hidden="true" /></button>}
          {panelNote ? (() => {
            // Arrows step through the notes the open card rests on, each at the words it quoted.
            const cited = activeCard ? citedNotesOf(activeCard) : [];
            const list = cited.some((item) => item.id === panelNote.id) ? cited : [panelNote];
            return <DesignReadingView
              notes={list}
              index={list.findIndex((item) => item.id === panelNote.id)}
              focus={panelFocus}
              relevanceFor={(noteId) => relevanceByNoteId.get(noteId)}
              onIndex={(index) => { const next = list[index]; if (!next) return; setPanelNoteId(next.id); setPanelFocus(activeCard?.item.quotes?.find((quote) => quote.note_id === next.id)?.text ?? ''); }}
              onClose={closeDesignReading}
              onOpenFull={(item) => void leaveWorkspace(item, false)}
            />;
          })() : activeCard ? <DesignSuggestionPanel
            key={activeCard.id}
            view={activeCard}
            position={activePosition}
            total={designPages.length}
            notesById={noteById}
            outbound={isOutbound(activeCard.item)}
            refreshing={retrievalLoading}
            onPrev={() => stepDesignCard(-1)}
            onNext={() => stepDesignCard(1)}
            onRefresh={() => requestReretrieval()}
            onHide={closeDesignPanel}
            onChoose={(choice, text) => chooseDesign(activeCard, choice, text)}
            onFindOther={() => requestReretrieval('relevant')}
            onOpenSource={showCitedNote}
            sheet={sheetMode}
          /> : onRelatedPage ? <div className="flex min-h-0 flex-1 flex-col">
            <DesignPanelBar position={activePosition} total={designPages.length} refreshing={retrievalLoading} onPrev={() => stepDesignCard(-1)} onNext={() => stepDesignCard(1)} onRefresh={() => requestReretrieval()} onHide={closeDesignPanel} sheet={sheetMode} />
            <div className={`min-h-0 flex-1 overflow-y-auto ${sheetMode ? 'px-5 pb-6 pt-2' : 'px-6 pb-10 pt-4 sm:px-12'}`}>
              <div className="max-w-[644px] space-y-4">
                {failedNotice}
                {relatedListsHeaded('Also related')}
                {goalPrompt}
              </div>
            </div>
          </div> : <div className="flex min-h-0 flex-1 flex-col">
            {sheetMode ? <DesignPanelBar position={0} total={0} refreshing={retrievalLoading || isGuide || requiresDomain} onPrev={() => undefined} onNext={() => undefined} onRefresh={() => requestReretrieval()} onHide={closeDesignPanel} sheet /> : <div className="flex shrink-0 items-center justify-end gap-0.5 px-6 pt-4 sm:px-8">
              {aiMode === 'basic' && <Link href="/profile" title="Searching with the cheaper Basic model. Change it in your profile." className="mr-auto rounded-md border border-[#f0d9a8] bg-[#fff8e8] px-2.5 py-1.5 text-xs text-[#8a6100] hover:border-[#e3b341]">Basic AI</Link>}
              <button type="button" onClick={() => requestReretrieval()} disabled={retrievalLoading || isGuide || requiresDomain} aria-label="Refresh suggestions" title="Refresh suggestions" className="flex h-11 w-11 items-center justify-center rounded-xl text-[#55555B] hover:bg-white disabled:opacity-50"><RefreshCw className={`h-[18px] w-[18px] ${retrievalLoading ? 'animate-spin' : ''}`} /></button>
              <button type="button" onClick={closeDesignPanel} aria-label="Hide suggestions panel" title="Hide suggestions panel" className="flex h-11 w-11 items-center justify-center rounded-xl text-[#55555B] hover:bg-white"><PanelRightOpen className="h-[18px] w-[18px]" /></button>
            </div>}
            <div className={`min-h-0 flex-1 overflow-y-auto ${sheetMode ? 'px-5 pb-6' : 'px-6 pb-10 sm:px-12'}`}>
              <div className="max-w-[644px] space-y-4">
                {retrievalLoading ? <div className="flex min-h-[360px] items-center justify-center gap-3 text-sm text-[#6B6B70]" role="status"><Loader2 className="h-5 w-5 animate-spin text-[#477bea]" /> Finding related notes{retrievalProgress?.agents_total ? ` · ${retrievalProgress.agents_done}/${retrievalProgress.agents_total}` : '…'}</div>
                  : retrievalError ? <div className="flex min-h-[360px] flex-col items-center justify-center gap-3.5 text-center" role="alert"><span className="text-[15px] text-[#6B6B70]">{retrievalError}</span><button type="button" onClick={() => requestReretrieval('relevant')} className="flex min-h-[40px] items-center gap-2 rounded-[10px] border border-[#D6D6DB] bg-white px-3.5 text-sm font-medium text-[#2B2B2E]"><RefreshCw className="h-4 w-4" /> Try again</button></div>
                  : isGuide && !retrieval ? <p className="py-16 text-center text-[15px] leading-relaxed text-[#6B6B70]">This note is a guide, so it isn&apos;t searched. Write a note about something you&apos;re stuck on, and the sample notes that help will show up here.</p>
                  : !retrieval && (noteTooShortForRetrieval || !hasOtherNotes) ? <p className="py-16 text-center text-[15px] leading-relaxed text-[#6B6B70]">{noteTooShortForRetrieval ? `Write at least ${MIN_RELEVANCE_DRAFT_CHARS} characters, then find notes.` : 'Once you have another note, Ocreda can look for connections.'}</p>
                  : <>
                    {/* A run that stopped partway says so, rather than looking like one that found nothing. */}
                    {insightFailed ? <div className="pt-6">{failedNotice}</div> : <div className="flex min-h-[320px] flex-col items-center justify-center gap-3.5 py-10 text-center">
                      <span className="text-[15px] text-[#6B6B70]">{relatedCount ? 'Nothing to act on here, but these notes relate to it.' : 'Nothing from your notes here.'}</span>
                      <button type="button" onClick={() => requestReretrieval('relevant')} disabled={requiresDomain} className="flex min-h-[40px] items-center gap-2 rounded-[10px] border border-[#D6D6DB] bg-white px-3.5 text-sm font-medium text-[#2B2B2E] hover:border-[#b9b9c0] disabled:opacity-50"><RefreshCw className="h-4 w-4" /> {retrieval ? 'Search again' : 'Find notes'}</button>
                      {onImport && <span className="text-[13px] text-[#8A8A90]">or <button type="button" onClick={onImport} className="text-[#55555B] underline underline-offset-[3px]">import notes</button></span>}
                    </div>}
                    {!insights.length && retrieval?.summary && <section className="rounded-xl border border-[#EBD58A] bg-[#FDF7DE] p-5"><span className="text-[13px] font-semibold text-[#9A7400]">Insight</span><p className="mt-2 text-[15px] leading-relaxed text-[#3d3828]">{retrieval.summary}</p></section>}
                    {relatedLists}
                    {goalPrompt}
                  </>}
              </div>
            </div>
          </div>}
        </aside>}

        {summaryOpen && !designView && <aside id="note-suggestions-panel" className="relative flex min-h-0 flex-col overflow-hidden bg-[#f7f7f9] xl:border-l xl:border-[#dedede]">
          {panelNote ? <RelatedNotePanel
            note={panelNote}
            relevance={panelRelevance ?? relevanceByNoteId.get(panelNote.id)}
            focusText={panelFocus}
            onClose={() => { setPanelNoteId(null); setPanelRelevance(null); setPanelFocus(''); }}
            onOpenFull={() => void leaveWorkspace(panelNote, false)}
          /> : <>
          <header className="sticky top-0 z-10 flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-[#e2e2e2] bg-[#f7f7f9]/95 px-3 py-2 backdrop-blur sm:px-4">
            <div className="flex items-center gap-2"><button type="button" onClick={() => setSummaryOpen(false)} className="flex h-10 items-center gap-1 rounded-md px-2 text-sm font-medium text-[#555] hover:bg-white xl:hidden"><ArrowLeft className="h-4 w-4" /> Note</button>{aiMode === 'basic' && <Link href="/profile" title="Searching with the cheaper Basic model. Change it in your profile." className="rounded-md border border-[#f0d9a8] bg-[#fff8e8] px-2.5 py-1.5 text-xs text-[#8a6100] hover:border-[#e3b341]">Basic AI</Link>}</div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setSummaryOpen(false)} aria-label="Hide suggestions panel" title="Hide suggestions panel" className="flex h-8 w-8 items-center justify-center rounded-md border border-[#dedede] bg-white text-[#555] shadow-sm hover:border-[#adc3ff] hover:text-[#477bea]"><PanelRightOpen className="h-4 w-4" /></button>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
            {retrievalLoading ? <div className="flex min-h-[360px] items-center justify-center gap-3 text-sm text-[#777]" role="status"><Loader2 className="h-5 w-5 animate-spin text-[#477bea]" /> Finding related notes{retrievalProgress?.agents_total ? ` · ${retrievalProgress.agents_done}/${retrievalProgress.agents_total}` : '…'}</div>
              : retrievalError ? <div className="flex min-h-[360px] items-center justify-center text-center" role="alert"><div><h2 className="text-lg font-semibold">Could not retrieve notes</h2><p className="mt-3 max-w-sm text-sm leading-relaxed text-[#777]">{retrievalError}</p><button type="button" onClick={() => requestReretrieval('relevant')} className="mt-5 rounded-md bg-[#477bea] px-4 py-2 text-sm text-white hover:bg-[#3d6ed7]">Try again</button></div></div>
              : <div className="mx-auto max-w-2xl">
                <section aria-labelledby="suggestions-heading">
                  <div className="mb-4 flex items-center justify-between gap-3"><h2 id="suggestions-heading" className="text-sm font-medium text-[#555]">Suggestions</h2><span className="text-[11px] text-[#999]">Up to 3 notes per section</span></div>
                  <div className="space-y-4">
                    {visibleInsightEntries.map((view, visibleIndex) => { const { item, index, id, section } = view; return <Fragment key={id}>
                      {visibleIndex === 0 && section && noteSections.length > 1 && <button type="button" onClick={() => document.getElementById(`note-${section.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })} className="sticky top-0 z-[1] flex w-full items-center gap-2 bg-[#f7f7f9]/95 py-1 text-left text-[11px] font-medium uppercase tracking-[0.08em] text-[#999] backdrop-blur"><span className="h-px flex-1 bg-[#d8d8dc]" />Section {section.index + 1}<span className="h-px flex-1 bg-[#d8d8dc]" /></button>}
                      <div id={`suggestion-card-${index}`} onClick={() => setSelectedInsightIndex(index)} className={selectedInsightIndex === index ? 'rounded-xl ring-2 ring-[#477bea]/20' : ''}>
                        <SuggestionCard insight={item} kind={view.kind} decision={view.decision} notesById={noteById} trigger={triggerFor(view.span)} outbound={isOutbound(item)} onChoose={(choice, text) => decide(view, choice, text)} onOpenSource={showCitedNote} />
                      </div>
                    </Fragment>; })}
                    {!visibleInsightEntries.length && allVisibleInsightEntries.length > 0 && <div className="rounded-xl border border-[#e2e2e2] bg-white p-5 text-sm leading-relaxed text-[#777]">No suggestions for this part of your note. Click a highlight in your note, or a gray bar beside it, to see the others.</div>}
                    {!insights.length && retrieval?.summary && <section className="rounded-xl border border-[#eadb99] bg-[#fffdf4] p-5 shadow-sm"><span className="rounded-md bg-[#fff2b8] px-2 py-1 text-xs font-medium text-[#8a6a00]">Insight</span><p className="mt-4 text-sm leading-relaxed text-[#3d3828]">{retrieval.summary}</p></section>}
                    {isGuide && !retrieval && <div className="rounded-xl border border-dashed border-[#d5d9e3] bg-white p-7 text-center"><h3 className="font-medium">This note is a guide</h3><p className="mt-2 text-sm leading-relaxed text-[#777]">It isn&apos;t searched. Write a new note about something you&apos;re stuck on, and the sample notes that help will show up here.</p><button type="button" onClick={onAddNote} className="mt-4 rounded-md bg-[#477bea] px-4 py-2 text-sm text-white hover:bg-[#3d6ed7]">Write a note</button></div>}
                    {!retrieval && !searchRequested && !noteTooShortForRetrieval && hasOtherNotes && !isGuide && <div className="rounded-xl border border-dashed border-[#d5d9e3] bg-white p-7 text-center"><h3 className="font-medium">See what your notes suggest</h3><p className="mt-2 text-sm leading-relaxed text-[#777]">Search your other notes for contradictions, solutions, help, extensions, and insights.</p><button type="button" onClick={() => { setSearchRequested(true); setRetrievalAttempt((attempt) => attempt + 1); }} className="mt-4 rounded-md bg-[#477bea] px-4 py-2 text-sm text-white hover:bg-[#3d6ed7]">Find related notes</button></div>}
                    {retrieval?.insight_failed && !insights.length && surfacedNotes.length > 0 && <div className="rounded-xl border border-[#f0d9a8] bg-[#fff8e8] p-5"><h3 className="text-sm font-medium text-[#6f5100]">Suggestions did not finish</h3><p className="mt-2 text-xs leading-relaxed text-[#806b35]">The related notes are still available below.</p></div>}
                    {retrieval && !retrieval.insight_failed && !insights.length && !retrieval.summary && <div className="rounded-xl border border-[#e2e2e2] bg-white p-5 text-sm leading-relaxed text-[#777]">{relatedHere.length || relatedNotes.forWholeNote.length ? 'No suggestions to act on yet, but these notes relate to it.' : 'No suggestion changes your next step yet.'}</div>}
                    {!retrieval && (noteTooShortForRetrieval || !hasOtherNotes) && <div className="rounded-xl border border-[#e2e2e2] bg-white p-5 text-sm leading-relaxed text-[#777]">{noteTooShortForRetrieval ? `Write at least ${MIN_RELEVANCE_DRAFT_CHARS} characters, then choose Find related notes.` : 'Once you have another note, Ocreda can look for connections.'}</div>}
                    {relatedHere.length > 0 && <RelatedNotesList key={`part-${selectedSectionId}`} heading={noteSections.length > 1 ? 'Also related to this part' : 'Also related'} results={relatedHere} notesById={noteById} onOpen={showCitedNote} />}
                    {relatedNotes.forWholeNote.length > 0 && <RelatedNotesList heading={noteSections.length > 1 ? 'Also related to the whole note' : 'Also related'} results={relatedNotes.forWholeNote} notesById={noteById} onOpen={showCitedNote} />}
                    {goalPrompt}
                  </div>
                </section>

              </div>}
          </div>
          </>}
        </aside>}
      </div>

      {searchRequest && <KnowledgeSearchOverlay request={searchRequest} notes={allNotes} muses={muses} projects={projects} onClose={() => setSearchRequest(null)} onOpenPage={(project, page) => { setSearchRequest(null); onOpenPage(project, page); }} onOpenNote={(item) => { setSearchRequest(null); onOpenNote(item); }} />}
      {requiresDomain && <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-labelledby="orphan-domain-title">
        <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl sm:p-8">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#edf3ff] text-[#477bea]"><FolderPlus className="h-5 w-5" /></div>
          <h2 id="orphan-domain-title" className="mt-5 text-xl font-semibold text-[#202020]">Choose a Domain before retrieval</h2>
          <p className="mt-2 text-sm leading-relaxed text-[#666]">This note is in Orphans. Place it in a real Domain so Ocreda has the right context before finding related notes.</p>
          {assignableMuses.length > 0 ? <div className="mt-6 max-h-64 space-y-2 overflow-y-auto">
            {assignableMuses.map((domain) => <button key={domain.title} type="button" disabled={saving} onClick={() => onChangeDomain(domain.title)} className="flex w-full items-start justify-between gap-4 rounded-lg border border-[#dedede] px-4 py-3 text-left hover:border-[#8fb1ff] hover:bg-[#f7f9ff] disabled:opacity-50"><span><span className="block text-sm font-medium text-[#222]">{domain.title}</span>{domain.description && <span className="mt-1 line-clamp-2 block text-xs leading-relaxed text-[#777]">{domain.description}</span>}</span><ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-[#999]" /></button>)}
          </div> : <p className="mt-6 rounded-lg bg-[#f7f7f9] px-4 py-3 text-sm text-[#666]">Create your first Domain, then this note will be placed there.</p>}
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <button type="button" disabled={saving} onClick={() => void leaveWorkspace()} className="rounded-md px-4 py-2 text-sm text-[#666] hover:bg-[#f4f4f4] disabled:opacity-50">Back to notes</button>
            <button type="button" disabled={saving} onClick={onCreateDomain} className="flex items-center justify-center gap-2 rounded-md bg-[#477bea] px-4 py-2 text-sm font-medium text-white hover:bg-[#3d6ed7] disabled:opacity-50"><Plus className="h-4 w-4" /> Create a Domain</button>
          </div>
        </div>
      </div>}
    </div>
    </div>
  );
}

function RetrievedNoteOverlay({ note, muses, saving, onClose, onAddNote, onImport, onSearch, onUpdate, onDelete }: {
  note: Note; muses: MuseMeta[]; saving: boolean;
  onClose: () => void; onAddNote: () => void; onImport: () => void;
  onSearch: (request: KnowledgeSearchRequest) => void;
  onUpdate: (noteId: string, rawText: string) => Promise<void>; onDelete: (note: Note) => Promise<void>;
}) {
  const initial = splitNote(note);
  const [title, setTitle] = useState(() => editableNote(note).title);
  const [body, setBody] = useState(() => editableNote(note).body);
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const bodyRef = useRef<NoteBodyEditorHandle>(null);
  const [activeFormats, setActiveFormats] = useState<NoteFormat[]>([]);
  const rawText = composeNoteText(title, body);
  // An older note without a title reads back as a made-up title over its text;
  // opening it is not an edit, so only a real change saves.
  const unchangedText = useMemo(() => { const start = editableNote(note); return composeNoteText(start.title, start.body); }, [note]);
  const noteChanged = Boolean(rawText) && rawText !== note.raw_text.trim() && rawText !== unchangedText;
  const muse = cleanCategory(note.category) || ORPHANS_MUSE;
  const usedMuses = useMemo(() => {
    const direct = muses.filter((item) => item.title.toLowerCase() === muse.toLowerCase());
    return (direct.length ? direct : muses).slice(0, 4);
  }, [muses, muse]);

  useEffect(() => {
    if (!editing || !noteChanged) return;
    setSaveState('saving');
    const timeout = window.setTimeout(() => {
      onUpdate(note.id, rawText).then(() => setSaveState('saved')).catch(() => setSaveState('error'));
    }, 850);
    return () => window.clearTimeout(timeout);
  }, [body, editing, note.id, note.raw_text, onUpdate, rawText, title]);

  const applyFormat = (kind: NoteFormat) => {
    setEditing(true);
    bodyRef.current?.format(kind);
  };

  const openDate = () => onSearch({ query: '', filter: { kind: 'date', value: localDateKey(note.created_at), label: fullNoteDate(note.created_at) } });
  const openMuse = () => onSearch({ query: muse, filter: { kind: 'muse', value: muse, label: muse } });

  return (
    <div className="fixed inset-0 z-[70] bg-black/25 p-3 backdrop-blur-[5px] sm:p-6" role="dialog" aria-modal="true" aria-label={`Retrieved note: ${initial.title}`} onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <div className="relative mx-auto flex h-full max-w-[1760px] flex-col">
        <div className="flex h-14 shrink-0 items-center justify-between px-2 text-white">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => { onClose(); onAddNote(); }} aria-label="Add a note" className="flex h-8 w-24 items-center justify-center rounded-md bg-[#477bea] hover:bg-[#3d6ed7]"><Plus className="h-5 w-5" /></button>
            <button type="button" onClick={onImport} aria-label="Import notes" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-white/10"><Upload className="h-6 w-6" /></button>
            <button type="button" onClick={() => onSearch({ query: '' })} aria-label="Search notes, pages, and Domains" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-white/10"><Search className="h-6 w-6" /></button>
          </div>
          <button type="button" onClick={onClose} aria-label="Close retrieved note" className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-white/10"><X className="h-7 w-7" /></button>
        </div>
        <div className="grid min-h-0 flex-1 overflow-hidden rounded-2xl border-[9px] border-white/80 bg-[#f7f7f9] shadow-2xl lg:grid-cols-[minmax(0,1fr)_330px]">
          <section className="relative flex min-h-0 flex-col overflow-hidden bg-white shadow-[4px_0_14px_rgba(0,0,0,0.14)]">
            <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-28 pt-12 sm:px-16 lg:px-[11%] lg:pt-20">
              <input value={title} readOnly={!editing} onClick={() => setEditing(true)} onChange={(event) => setTitle(event.target.value)} aria-label="Retrieved note title" placeholder={defaultNoteTitle(body) || (editing ? 'Title (optional)' : '')} className={`w-full bg-transparent text-2xl font-semibold outline-none placeholder:font-normal placeholder:text-[#c4c4c6] ${editing ? 'cursor-text' : 'cursor-pointer'}`} />
              <NoteBodyEditor ref={bodyRef} value={body} editable={editing} onClick={() => setEditing(true)} onChange={setBody} ariaLabel="Retrieved note text" onActiveFormatsChange={setActiveFormats} className={`mt-8 min-h-[540px] w-full bg-transparent text-base leading-[1.7] ${editing ? 'cursor-text' : 'cursor-pointer'}`} />
            </div>
            <ReadingFormatBar onFormat={applyFormat} onDone={() => setEditing(false)} editing={editing} active={activeFormats} />
            <span className="absolute bottom-3 right-5 text-[11px] text-[#999]">{saving || saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Save failed' : ''}</span>
          </section>
          <aside className="relative min-h-0 overflow-y-auto bg-[#f7f7f9] px-6 pb-8 pt-16">
            <div className="absolute right-4 top-3">
              <button type="button" onClick={() => setMenuOpen((open) => !open)} aria-label="Retrieved note options" aria-expanded={menuOpen} className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-white"><MoreHorizontal className="h-5 w-5" /></button>
              {menuOpen && <div className="absolute right-0 top-10 z-10 w-40 overflow-hidden rounded-lg border border-[#ddd] bg-white py-1 text-sm shadow-xl"><button type="button" onClick={() => { setMenuOpen(false); setEditing(true); bodyRef.current?.focus(); }} className="block w-full px-4 py-2.5 text-left hover:bg-[#f5f5f5]">Edit note</button><button type="button" disabled={saving} onClick={() => { setMenuOpen(false); void onDelete(note); }} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-red-600 hover:bg-red-50"><Trash2 className="h-4 w-4" /> Delete note</button></div>}
            </div>
            <button type="button" onClick={openDate} className="block rounded px-1 py-1 text-left text-sm text-[#777] hover:bg-white hover:text-[#477bea]">{fullNoteDate(note.created_at)}</button>
            <button type="button" onClick={openMuse} className="mt-5 block rounded px-1 py-1 text-left text-sm hover:bg-white"><span className="font-medium">Domain:</span> <span className="text-[#777]">{muse}</span></button>
            <div className="my-6 h-px bg-[#d8d8d8]" />
            <button type="button" onClick={openMuse} className="text-sm text-[#477bea] hover:underline">Used in Domain</button>
            <div className="mt-5 space-y-5">{usedMuses.map((muse) => <button key={muse.title} type="button" onClick={() => onSearch({ query: muse.title, filter: { kind: 'muse', value: muse.title, label: muse.title } })} className="block w-full rounded-lg border border-[#e0e0e0] bg-white p-5 text-left shadow-[0_2px_8px_rgba(0,0,0,0.13)] transition hover:-translate-y-0.5 hover:border-[#8fb1ff]"><strong className="block text-base">{muse.title}</strong><p className="mt-4 line-clamp-6 text-sm leading-relaxed text-[#777]">{muse.description || `Notes and ideas organized in ${muse.title}.`}</p><div className="mt-8 flex justify-between text-xs text-[#aaa]"><span>{muse.title}</span><span>{formatDate(muse.createdAt)}</span></div></button>)}</div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function ReadingFormatBar({ onFormat, onDone, editing, active = [] }: { onFormat: (kind: NoteFormat) => void; onDone: () => void; editing: boolean; active?: NoteFormat[] }) {
  if (!editing) return null;
  // Buttons keep the editor focused, so the selection, or a format turned on
  // for what is typed next, survives the click.
  const keepFocus = (event: React.MouseEvent) => event.preventDefault();
  const on = (kind: NoteFormat) => (active.includes(kind) ? 'bg-white text-[#477bea] shadow-sm' : '');
  return <div className="absolute bottom-5 left-1/2 z-20 flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-1 rounded-xl bg-[#f7f7f9] px-3 py-2 text-sm text-[#555] shadow-sm"><button type="button" aria-label="Voice input" className="flex h-8 w-8 items-center justify-center rounded hover:bg-white"><Mic className="h-4 w-4" /></button><span className="mx-1 h-7 w-px bg-[#ddd]" /><button type="button" onMouseDown={keepFocus} onClick={() => onFormat('bold')} aria-label="Bold" aria-pressed={active.includes('bold')} className={`h-8 w-8 rounded font-bold hover:bg-white ${on('bold')}`}>B</button><button type="button" onMouseDown={keepFocus} onClick={() => onFormat('italic')} aria-label="Italic" aria-pressed={active.includes('italic')} className={`h-8 w-8 rounded italic hover:bg-white ${on('italic')}`}>I</button><span className="mx-1 h-7 w-px bg-[#ddd]" />{(['h1', 'h2', 'h3'] as const).map((kind) => <button key={kind} type="button" onMouseDown={keepFocus} onClick={() => onFormat(kind)} aria-pressed={active.includes(kind)} className={`hidden h-8 rounded px-2 font-semibold hover:bg-white sm:block ${on(kind)}`}>{kind.toUpperCase()}</button>)}<button type="button" onMouseDown={keepFocus} onClick={() => onFormat('body')} className="hidden h-8 rounded px-2 hover:bg-white md:block">Body</button><span className="mx-1 hidden h-7 w-px bg-[#ddd] md:block" /><button type="button" onMouseDown={keepFocus} onClick={() => onFormat('bullet')} aria-pressed={active.includes('bullet')} className={`hidden h-8 items-center gap-1 rounded px-2 hover:bg-white lg:flex ${on('bullet')}`}><List className="h-4 w-4" /> Bullet list</button><button type="button" onMouseDown={keepFocus} onClick={() => onFormat('number')} aria-pressed={active.includes('number')} className={`hidden h-8 items-center gap-1 rounded px-2 hover:bg-white xl:flex ${on('number')}`}><ListOrdered className="h-4 w-4" /> Numbered list</button><button type="button" onClick={onDone} className="ml-2 h-8 rounded-md bg-[#477bea] px-3 text-white hover:bg-[#3d6ed7]">Done</button></div>;
}

function KnowledgeSearchOverlay({ request, notes, sharedNotes = [], muses, projects, hideProjectColumn = false, onClose, onOpenPage, onOpenNote }: {
  request: KnowledgeSearchRequest; notes: Note[]; muses: MuseMeta[]; projects: CortexProject[]; hideProjectColumn?: boolean; onClose: () => void; onOpenPage: (project: CortexProject, page: ProjectPage) => void; onOpenNote: (note: Note) => void;
  /** Notes others shared with you, shown as their own group under a text search. */
  sharedNotes?: Note[];
}) {
  const [query, setQuery] = useState(request.query);
  const [filter, setFilter] = useState<KnowledgeFilter | undefined>(request.filter);
  const normalized = query.trim().toLowerCase();
  const sortedNotes = useMemo(() => [...notes].sort((a, b) => b.created_at.localeCompare(a.created_at)), [notes]);
  const filteredNotes = useMemo(() => sortedNotes.filter((note) => {
    if (filter?.kind === 'date' && localDateKey(note.created_at) !== filter.value) return false;
    if (filter?.kind === 'muse' && (cleanCategory(note.category) || ORPHANS_MUSE).toLowerCase() !== filter.value.toLowerCase()) return false;
    if (filter) return true;
    return !normalized || `${note.raw_text} ${note.category ?? ''}`.toLowerCase().includes(normalized);
  }), [filter, normalized, sortedNotes]);
  // Only a text search reaches shared notes: the date and Domain filters are about your own.
  const matchingShared = useMemo(() => (filter || !normalized ? [] : sharedNotes
    .filter((note) => `${note.raw_text} ${note.shared_by ?? ''}`.toLowerCase().includes(normalized))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))), [filter, normalized, sharedNotes]);
  const matchingPages = useMemo(() => projects.flatMap((project) => project.pages.map((page) => ({ project, page }))).filter(({ page }) => {
    if (!normalized) return true;
    return `${page.title} ${page.content}`.toLowerCase().includes(normalized);
  }), [normalized, projects]);
  const recentTerms = useMemo(() => {
    const values = [...muses.map((muse) => muse.title), ...sortedNotes.slice(0, 5).map((note) => noteLabel(note))];
    return Array.from(new Set(values.filter(Boolean))).slice(0, 6);
  }, [muses, sortedNotes]);
  const heading = filter?.kind === 'date' ? `Notes written on ${filter.label}` : filter?.kind === 'muse' ? `Notes in ${filter.label}` : `Notes containing “${query.trim()}”`;
  const showProjectColumn = !hideProjectColumn && filter?.kind !== 'muse';

  const changeQuery = (value: string) => { setQuery(value); setFilter(undefined); };

  return (
    <div className="fixed inset-0 z-[80] bg-black/25 p-3 backdrop-blur-[5px] sm:p-6" role="dialog" aria-modal="true" aria-label="Search notes, pages, and Domains" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <button type="button" onClick={onClose} aria-label="Close search" className="absolute right-5 top-5 z-10 flex h-10 w-10 items-center justify-center rounded-md text-white hover:bg-white/10"><X className="h-7 w-7" /></button>
      <div className="mx-auto mt-12 flex h-[calc(100%-3rem)] max-w-[1640px] flex-col overflow-hidden rounded-[20px] bg-white shadow-2xl sm:mt-16 sm:h-[calc(100%-4rem)]">
        <div className="flex h-20 shrink-0 items-center border-b border-[#ddd] px-7 sm:px-10"><Search className="mr-4 h-6 w-6 shrink-0 text-[#aaa]" /><input autoFocus value={query} onChange={(event) => changeQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }} placeholder="Search notes, pages, and Domains" className="h-full min-w-0 flex-1 bg-transparent text-xl outline-none placeholder:text-[#b3b3b3] sm:text-2xl" />{filter && <button type="button" onClick={() => { setFilter(undefined); setQuery(''); }} className="rounded-full bg-[#edf3ff] px-3 py-1.5 text-xs text-[#477bea]">Clear {filter.kind === 'muse' ? 'domain' : filter.kind}</button>}</div>
        {!query.trim() && !filter ? <div className="min-h-0 flex-1 overflow-y-auto px-10 py-12 sm:px-16"><p className="text-sm text-[#aaa]">Recent</p><div className="mt-5 max-w-2xl space-y-1">{recentTerms.map((term) => <button key={term} type="button" onClick={() => setQuery(term)} className="block w-full rounded-lg px-1 py-3 text-left text-base text-[#555] hover:bg-[#f6f6f6] hover:px-3">{term}</button>)}</div></div> : <div className={`grid min-h-0 flex-1 overflow-y-auto lg:overflow-hidden ${showProjectColumn ? 'lg:grid-cols-[450px_minmax(0,1fr)]' : 'lg:grid-cols-1'}`}>
          {showProjectColumn && <aside className="border-b border-[#ddd] px-7 py-10 lg:overflow-y-auto lg:border-b-0 lg:border-r sm:px-10"><p className="mb-7 text-sm text-[#aaa]">Found in project pages</p><div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-1">{matchingPages.map(({ project, page }) => <button key={`${project.id}-${page.id}`} type="button" onClick={() => onOpenPage(project, page)} title={page.title || undefined} className="flex h-[300px] flex-col overflow-hidden rounded-lg border border-[#e3e3e5] bg-white p-7 text-left shadow-[0_2px_8px_rgba(0,0,0,0.1)] transition hover:-translate-y-0.5 hover:border-[#8fb1ff]"><strong className="line-clamp-2 shrink-0 text-base leading-snug"><HighlightedText text={page.title} query={query} /></strong><span className="mt-4 block min-h-0 flex-1 overflow-hidden"><span className="line-clamp-6 whitespace-pre-wrap text-sm leading-relaxed text-[#777]"><HighlightedText text={page.content || 'Empty page'} query={query} /></span></span><span className="mt-4 flex shrink-0 items-center justify-between gap-3 text-xs text-[#aaa]"><span className="min-w-0 truncate">{project.title}</span><span className="shrink-0">{formatDate(page.updatedAt)}</span></span></button>)}{!matchingPages.length && <p className="text-sm text-[#999] sm:col-span-2 lg:col-span-1">No project page contains this search.</p>}</div></aside>}
          <section className="min-h-0 px-7 py-10 lg:overflow-y-auto sm:px-12"><p className="mb-7 text-sm text-[#aaa]">{heading}</p><div className={`grid gap-7 ${showProjectColumn ? 'xl:grid-cols-2' : 'lg:grid-cols-2 xl:grid-cols-3'}`}>{filteredNotes.map((item) => { const content = splitNote(item); const preview = content.body ? previewNoteText(content.body) : notePreview(item); return <button key={item.id} type="button" onClick={() => onOpenNote(item)} title={content.title || undefined} className="flex h-[280px] flex-col overflow-hidden rounded-lg border border-[#e3e3e5] bg-white p-6 text-left shadow-[0_2px_8px_rgba(0,0,0,0.1)] transition hover:-translate-y-0.5 hover:border-[#8fb1ff]">{content.hasTitle && <strong className="line-clamp-2 shrink-0 text-base leading-snug"><HighlightedText text={defaultNoteTitle(content.title)} query={filter ? '' : query} /></strong>}<span className="mt-4 block min-h-0 flex-1 overflow-hidden"><span className="line-clamp-5 text-sm leading-relaxed text-[#777]"><HighlightedText text={preview} query={filter ? '' : query} /></span></span><span className="mt-4 flex shrink-0 items-center justify-between gap-3 text-xs text-[#aaa]"><span className="min-w-0 truncate">{cleanCategory(item.category) || ORPHANS_MUSE}</span><span className="shrink-0">{formatDate(item.created_at)}</span></span></button>; })}{!filteredNotes.length && <p className="text-sm text-[#999] xl:col-span-2">No notes match this search.</p>}</div>{matchingShared.length > 0 && <><p className="mb-7 mt-12 text-sm text-[#aaa]">Shared with me</p><div className={`grid gap-7 ${showProjectColumn ? 'xl:grid-cols-2' : 'lg:grid-cols-2 xl:grid-cols-3'}`}>{matchingShared.map((item) => <LibraryNoteCard key={item.id} note={item} query={query} layout="search" onClick={() => onOpenNote(item)} />)}</div></>}</section>
        </div>}
      </div>
    </div>
  );
}

function retrievalKeywords(value: string): string[] {
  const ignored = new Set(['about', 'after', 'also', 'been', 'between', 'could', 'difference', 'find', 'from', 'have', 'looking', 'note', 'something', 'stated', 'that', 'their', 'there', 'these', 'they', 'this', 'what', 'when', 'where', 'which', 'will', 'with', 'would']);
  return (value.toLowerCase().match(/[a-z0-9']{3,}/g) ?? []).filter((word) => !ignored.has(word));
}

type NoteSection = { id: string; index: number; label: string; text: string; start: number; end: number };
type RelevanceSearch = {
  results: RelevanceResult[];
  coverage: RelevanceCoverage;
  summary?: string;
  insights?: NoteInsight[];
  goal_suggestions?: string[];
  note_intent?: InsightIntent | null;
  insight_failed?: boolean;
  /** The ideas the search split the note into, with offsets into the note's body. */
  sections?: RelevanceSection[];
};

/**
 * The server splits the text it searched, title included, but the reader
 * shows the body alone. Moves each section onto the body, dropping any part
 * that was in the title.
 */
function sectionsInBody(sections: RelevanceSection[] | undefined, searched: string, body: string): RelevanceSection[] | undefined {
  const offset = sections?.length ? searched.indexOf(body) : -1;
  if (!sections || offset < 0) return undefined;
  const moved: RelevanceSection[] = [];
  for (const section of sections) {
    let start = Math.max(section.start, offset) - offset;
    let end = Math.min(section.end, offset + body.length) - offset;
    while (start < end && /\s/.test(body[start])) start++;
    while (end > start && /\s/.test(body[end - 1])) end--;
    if (end > start) moved.push({ ...section, start, end, text: body.slice(start, end) });
  }
  return moved.length ? moved : undefined;
}

/**
 * The note's sections: the ideas the last search split it into while they
 * still line up with the text, and its paragraphs otherwise. Sections only
 * count as lining up when nothing but whitespace falls between them, since
 * text outside every section would not be shown.
 */
function noteSectionsFor(body: string, searched: RelevanceSection[] | undefined): NoteSection[] {
  let located: RelevanceSection[] | null = searched?.length ? [] : null;
  let cursor = 0;
  for (const section of searched ?? []) {
    const at = body.indexOf(section.text, cursor);
    if (at < 0 || body.slice(cursor, at).trim()) { located = null; break; }
    located?.push({ ...section, start: at, end: at + section.text.length });
    cursor = at + section.text.length;
  }
  if (located && body.slice(cursor).trim()) located = null;
  return (located ?? splitIntoParagraphs(body))
    .map((section, index) => ({ id: section.id, index, label: section.label, text: section.text, start: section.start, end: section.end }));
}

// Keep each visible section focused: never show more than three notes at once.
const RELEVANCE_PAGE_SIZE = 3;

/**
 * Only relationships worth interrupting the reader for get a badge. A relevant
 * note that supports or extends the draft is the default expectation, so saying
 * so adds noise — whereas a note that contradicts the draft, or raises a
 * question it leaves open, is exactly what someone would miss on their own. The
 * full taxonomy still comes back from the API for filtering later.
 */
const RELATION_BADGES: Partial<Record<NoteRelationType, { label: string; className: string }>> = {
  contradicts: { label: 'Contradicts', className: 'bg-[#fdecea] text-[#c0392b]' },
  question: { label: 'Open question', className: 'bg-[#f1eafc] text-[#6b3fc0]' },
  parallel: { label: 'Parallel', className: 'bg-[#e3f4f1] text-[#1b7a6e]' },
  solves: { label: 'Solves', className: 'bg-[#e6f4ea] text-[#1e7b3c]' },
};

/**
 * The badge for a related note. "Solves" alone hides which way it goes, so it
 * says which note holds the answer: this related note, or the one being read.
 */
function relationBadgeFor(result: RelevanceResult | undefined): { label: string; className: string } | null {
  const badge = result?.relation_type ? RELATION_BADGES[result.relation_type] : null;
  if (!badge || result?.relation_type !== 'solves') return badge ?? null;
  return { ...badge, label: result.direction === 'outbound' ? 'Your new note answers it' : 'Answers your new note' };
}

type CardDecisions = Record<string, CardDecision>;

/** A card as the note view lays it out, or a mark another note's choice left here. */
type CardView = {
  id: string;
  item: NoteInsight;
  /** Position in the note's card list; -1 for a mark from another note. */
  index: number;
  decision?: CardDecision;
  kind: SuggestionKind;
  span: { start: number; end: number } | null;
  section: NoteSection | null;
  /** Set for a mark left by a choice on another note's card: that note's id. */
  fromNoteId: string | null;
};

/** Waiting on the person: no choice yet, or a solution turned into a Helps card. */
function isPendingCard(decision?: CardDecision): boolean {
  return !decision || decision.choice === 'downgraded';
}

/** Acted on, so its mark shows over the note in place of the highlight. */
function isActedCard(decision?: CardDecision): boolean {
  return Boolean(decision && decision.choice !== 'downgraded' && decision.choice !== 'rejected');
}

/**
 * Solve on a note that answers an earlier note's problem hands the solution to
 * that earlier note (decided Nov 24). The earlier note gets a solved Solution
 * card of its own, as if its own search had found the answer: this note's
 * words as the answer, its own sentence as the problem. It is saved on the
 * earlier note, and only that note can undo it; the card leaves this note.
 * `targetNoteId` names the answering note, so that note can tell its card was handed on.
 */
function handedSolutionCard(item: NoteInsight, answerNoteId: string): { problemNoteId: string; id: string; decision: CardDecision } | null {
  const problem = item.problem;
  const answerText = (item.answer?.text || item.action || '').trim();
  if (!problem?.note_id || !problem.text.trim() || !answerText) return null;
  const answer = { note_id: answerNoteId, text: answerText };
  const insight: NoteInsight = { anchor: problem.text, intent: item.intent, kind: 'solution', text: 'Another note of yours answers this: {1}', quotes: [answer], answer, ...(item.solution ? { solution: item.solution } : {}), action: answerText, note_ids: [answerNoteId] };
  return { problemNoteId: problem.note_id, id: insightActionId(insight, 'solves'), decision: { choice: 'solved', kind: 'solution', insight, targetNoteId: answerNoteId } };
}

/** A Solve saved the earlier way: on the answering note, aimed at the earlier note's problem. */
function isOldHandedSolution(decision: CardDecision): boolean {
  return decision.choice === 'solved' && decision.insight.direction === 'outbound' && Boolean(decision.insight.problem?.note_id) && Boolean(decision.targetNoteId);
}

/** A solution this note handed to an earlier note, seen from this note: the card it came from leaves. */
function isHandedFrom(decision: IncomingCardDecision, noteId: string): boolean {
  return decision.choice === 'solved' && decision.kind === 'solution' && decision.insight.answer?.note_id === noteId && !decision.insight.problem;
}

function insightActionId(insight: NoteInsight, relation: NoteRelationType | null): string {
  const kind = baseKindOf(insight, relation);
  const source = `${kind}|${insight.anchor}|${insight.text}|${insight.action}|${insight.note_ids.join(',')}`;
  return `${kind}:${Math.abs(stableHash(source))}`;
}

const SUGGESTION_STYLES: Record<SuggestionKind, { label: string; border: string; badge: string; action: string; actionText: string; quote: string; outline: string; chip: string }> = {
  contradiction: { label: 'Contradiction', border: 'border-[#f3c2c2]', badge: 'bg-[#ffe1e1] text-[#c64747]', action: 'bg-[#fff0f0]', actionText: 'text-[#8f3c3c]', quote: 'decoration-[#df7777]', outline: 'border-[#e8a3a3] bg-[#fff8f8]', chip: 'border-[#f0b7b7] bg-[#fff0f0] text-[#b23b3b]' },
  solution: { label: 'Solution', border: 'border-[#bfd2ff]', badge: 'bg-[#dfe9ff] text-[#3f6ed3]', action: 'bg-[#edf3ff]', actionText: 'text-[#315fc5]', quote: 'decoration-[#7ca2ff]', outline: 'border-[#9db8f5] bg-[#f6f9ff]', chip: 'border-[#b6cbf8] bg-[#edf3ff] text-[#315fc5]' },
  helps: { label: 'Helps', border: 'border-[#bfe3ca]', badge: 'bg-[#e0f4e6] text-[#2c7b45]', action: 'bg-[#eef8f1]', actionText: 'text-[#28623b]', quote: 'decoration-[#72b987]', outline: 'border-[#95cfa6] bg-[#f5fbf7]', chip: 'border-[#a9d8b7] bg-[#eef8f1] text-[#28623b]' },
  extension: { label: 'Extension', border: 'border-[#d8c4ef]', badge: 'bg-[#eee2fb] text-[#7348a7]', action: 'bg-[#f6f0fc]', actionText: 'text-[#62408a]', quote: 'decoration-[#ad83d1]', outline: 'border-[#c8acea] bg-[#fbf8ff]', chip: 'border-[#d8c4ef] bg-[#f6f0fc] text-[#62408a]' },
  insight: { label: 'Insight', border: 'border-[#eadb99]', badge: 'bg-[#fff2b8] text-[#8a6a00]', action: 'bg-[#fff9df]', actionText: 'text-[#735d12]', quote: 'decoration-[#dfbf4f]', outline: 'border-[#e6d27c] bg-[#fffcef]', chip: 'border-[#eadb99] bg-[#fff9df] text-[#735d12]' },
};

const HIGHLIGHT_STYLES: Record<SuggestionKind, { idle: string; active: string }> = {
  contradiction: { idle: 'bg-[#ffe6e6] decoration-[#df7777]', active: 'bg-[#ffcfcf] decoration-[#c64747]' },
  solution: { idle: 'bg-[#e5edff] decoration-[#7ca2ff]', active: 'bg-[#cfdcff] decoration-[#477bea]' },
  helps: { idle: 'bg-[#e3f4e8] decoration-[#72b987]', active: 'bg-[#cdebd6] decoration-[#2c7b45]' },
  extension: { idle: 'bg-[#f0e5fb] decoration-[#ad83d1]', active: 'bg-[#e2cff5] decoration-[#8254b5]' },
  insight: { idle: 'bg-[#fff5ce] decoration-[#dfbf4f]', active: 'bg-[#ffe699] decoration-[#b88a08]' },
};

function suggestionKindFor(relation: NoteRelationType | null): SuggestionKind {
  if (relation === 'contradicts') return 'contradiction';
  if (relation === 'solves') return 'solution';
  if (relation === 'helps') return 'helps';
  if (relation === 'extends') return 'extension';
  return 'insight';
}

const KIND_FOR_CARD: Record<CardKind, SuggestionKind> = {
  solution: 'solution',
  helps: 'helps',
  extension: 'extension',
  contradiction: 'contradiction',
  pattern: 'insight',
};

/** The kind the server gave the card; older servers only sent the notes' relation. */
function baseKindOf(insight: NoteInsight, relation: NoteRelationType | null): SuggestionKind {
  return insight.kind ? KIND_FOR_CARD[insight.kind] : suggestionKindFor(relation);
}

/** Where the sentence holding `from` ends: after its full stop, or at the end of its line. */
function sentenceEndAfter(text: string, from: number): number {
  if (from > 0 && '.!?'.includes(text[from - 1])) return from;
  for (let index = from; index < text.length; index++) {
    if (text[index] === '\n') return index;
    if ('.!?'.includes(text[index]) && (index + 1 === text.length || /\s/.test(text[index + 1]))) return index + 1;
  }
  return text.length;
}

function sentenceStartBefore(text: string, from: number): number {
  for (let index = from - 1; index >= 0; index--) {
    if (text[index] === '\n') return index + 1;
    if ('.!?'.includes(text[index]) && /\s/.test(text[index + 1] ?? '')) {
      let start = index + 1;
      while (start < from && /\s/.test(text[start])) start++;
      return start;
    }
  }
  return 0;
}

function lineEndAfter(text: string, from: number): number {
  const index = text.indexOf('\n', from);
  return index === -1 ? text.length : index;
}

/** The whole sentence a card is about, with the part that needs the card picked out. */
type TriggerSentence = { before: string; key: string; after: string };

function triggerSentence(text: string, span: { start: number; end: number }): TriggerSentence {
  const start = sentenceStartBefore(text, span.start);
  const end = sentenceEndAfter(text, span.end);
  // The offsets point into the note's markdown, so each piece is cleaned on its
  // own: a line marker can only open the sentence, and bold markers can sit on
  // either side of the highlighted words.
  const rawBefore = text.slice(start, span.start);
  const opensLine = start === 0 || text[start - 1] === '\n';
  const before = stripInlineMarkdown(opensLine ? rawBefore.replace(LINE_MARKER, '') : rawBefore).trimStart();
  const rawKey = text.slice(span.start, span.end);
  const key = stripInlineMarkdown(opensLine && !rawBefore.trim() ? rawKey.replace(LINE_MARKER, '') : rawKey);
  return { before, key, after: stripInlineMarkdown(text.slice(span.end, end)).trimEnd() };
}

function sentenceCase(text: string): string {
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

/**
 * The card's sentence: the model's connecting words, with the person's own
 * words quoted inside it exactly as they wrote them. Each quote opens its note.
 */
function InsightSentence({ insight, kind, onOpenSource }: { insight: NoteInsight; kind: SuggestionKind; onOpenSource: (noteId: string, focus?: string) => void }) {
  const quotes = insight.quotes ?? [];
  if (!quotes.length) return <>{stripInlineMarkdown(insight.text)}</>;
  const parts = insight.text.split(/(\{\d+\})/);
  const quoteAt = (part: string) => /^\{\d+\}$/.test(part) ? quotes[Number(part.slice(1, -1)) - 1] : undefined;
  return <>{parts.map((part, index) => {
    const quote = quoteAt(part);
    // A quote that ends a sentence already has its stop, so the sentence's own
    // stop or comma right after it would double up ("okay.'.").
    if (!quote) return <Fragment key={index}>{stripInlineMarkdown(index > 0 && /[.!?]$/.test(plainNoteText(quoteAt(parts[index - 1])?.text ?? '').trim()) ? part.replace(/^[.,;:]/, '') : part)}</Fragment>;
    const open = () => onOpenSource(quote.note_id, quote.text);
    // A span, not a button: browsers lay a button out as one block, so a long
    // quote filled the line and pushed the punctuation after it onto its own.
    return <span
      key={index}
      role="button"
      tabIndex={0}
      onClick={(event) => { event.stopPropagation(); open(); }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        open();
      }}
      title="Open the note this came from"
      className={`cursor-pointer rounded-sm font-semibold underline decoration-2 underline-offset-4 [box-decoration-break:clone] hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea] ${SUGGESTION_STYLES[kind].quote}`}
    >‘{plainNoteText(quote.text)}’</span>;
  })}</>;
}

function UndoButton({ onUndo }: { onUndo: () => void }) {
  return <button type="button" onClick={(event) => { event.stopPropagation(); onUndo(); }} className="text-xs font-medium text-[#777] underline-offset-2 hover:text-[#333] hover:underline">Undo</button>;
}

function IconChoice({ kind, accept, label, onClick }: { kind: SuggestionKind; accept: boolean; label: string; onClick: () => void }) {
  const style = SUGGESTION_STYLES[kind];
  return <button
    type="button"
    onClick={(event) => { event.stopPropagation(); onClick(); }}
    aria-label={label}
    title={label}
    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea] ${accept ? `${style.badge} hover:brightness-95` : 'border border-[#e2e2e2] bg-white text-[#777] hover:text-[#333]'}`}
  >{accept ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}</button>;
}

/**
 * The action under a card. Nothing here edits the note: every choice is kept
 * beside it and drawn over it, and every choice can be undone.
 */
function CardAction({ insight, kind, decision, sourceTitle, sourceDate, sharedBy = null, outbound, onChoose, onOpenSource }: {
  insight: NoteInsight;
  kind: SuggestionKind;
  /** True when this note is the help and the earlier note is the one helped. */
  outbound: boolean;
  decision?: CardDecision;
  sourceTitle: string;
  /** Who shared the note the card rests on, when it is someone else's. */
  sharedBy?: string | null;
  sourceDate: string;
  onChoose: (choice: CardChoice | null, text?: string) => void;
  onOpenSource: (noteId: string, focus?: string) => void;
}) {
  const style = SUGGESTION_STYLES[kind];
  const choice = decision?.choice;
  const [draft, setDraft] = useState(decision?.text ?? '');
  const [editing, setEditing] = useState(false);
  useEffect(() => { setDraft(decision?.text ?? ''); setEditing(false); }, [decision?.choice, decision?.text]);
  const answer = insight.answer;
  const openAnswer = () => { if (answer) onOpenSource(answer.note_id, answer.text); };
  const box = `mt-4 rounded-lg px-4 py-3 ${style.action}`;
  const heading = `text-[11px] font-medium ${style.actionText}`;

  if (kind === 'solution' && insight.direction === 'outbound' && insight.problem) {
    // This note is the answer; the problem is in the earlier note, so that is
    // where Solved marks it. The answer is already quoted at the top of the
    // card, as the sentence of this note the card is about, so it is not repeated here.
    const problem = insight.problem;
    const openProblem = () => onOpenSource(problem.note_id, problem.text);
    if (choice === 'solved') return <div className={box}>
      <p className={`flex items-center gap-1.5 ${heading}`}><Check className="h-3.5 w-3.5" /> Your earlier note now shows this as its answer</p>
      <div className="mt-2 flex gap-3">
        <button type="button" onClick={(event) => { event.stopPropagation(); openProblem(); }} className="text-xs font-medium text-[#315fc5] hover:underline">See it ↗</button>
        <UndoButton onUndo={() => onChoose(null)} />
      </div>
    </div>;
    return <div className={box}>
      <p className="text-[13px] leading-relaxed text-[#315078]">Your new note answers “{sourceTitle}”. Click “Solved” and that note will show this as its answer.</p>
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={(event) => { event.stopPropagation(); onChoose('solved'); }} className="rounded-md bg-[#477bea] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#3d6ed7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea] focus-visible:ring-offset-2">Solved</button>
        {/* As a Helps card it would only quote this note's own words back, so Dismiss removes it. */}
        <button type="button" onClick={(event) => { event.stopPropagation(); onChoose('rejected'); }} className="rounded-md bg-white px-3 py-1.5 text-xs font-medium text-[#666] shadow-sm hover:bg-[#f5f5f5]">Dismiss</button>
      </div>
    </div>;
  }

  if (kind === 'solution') {
    const answerText = plainNoteText(answer?.text ?? insight.action);
    // What to do, in plain words, when the search wrote it; the exact words go under it.
    const solution = plainNoteText(insight.solution ?? '').trim();
    if (choice === 'solved') return <div className={box}>
      <p className={`flex items-center gap-1.5 ${heading}`}><Check className="h-3.5 w-3.5" /> Solved · shown beside your sentence</p>
      <p className="mt-1 text-[14px] leading-relaxed text-[#26467a]">{solution || answerText}</p>
      <div className="mt-2"><UndoButton onUndo={() => onChoose(null)} /></div>
    </div>;
    return <div className={box}>
      <p className={heading}>Solution</p>
      <p className="mt-1 text-[15px] leading-relaxed text-[#26467a]">{solution || answerText}</p>
      {solution && <p className="mt-1 text-[12px] italic leading-relaxed text-[#5b7fc9]">‘{answerText}’</p>}
      {answer && <button type="button" onClick={(event) => { event.stopPropagation(); openAnswer(); }} className="mt-1 text-[11px] text-[#5b7fc9] hover:underline">From {sharedBy ? `${sharedBy}’s ` : ''}“{sourceTitle}” · {sourceDate} ↗</button>}
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={(event) => { event.stopPropagation(); onChoose('solved'); }} className="rounded-md bg-[#477bea] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#3d6ed7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea] focus-visible:ring-offset-2">Solved</button>
        <button type="button" onClick={(event) => { event.stopPropagation(); onChoose('downgraded'); }} className="rounded-md bg-white px-3 py-1.5 text-xs font-medium text-[#666] shadow-sm hover:bg-[#f5f5f5]">Dismiss</button>
      </div>
    </div>;
  }

  if (kind === 'helps' && outbound) {
    // This note is the help and the earlier note is where it applies, so the
    // wording says so rather than reading as advice for this note.
    const idea = sentenceCase(plainNoteText(insight.action));
    if (choice === 'helped') return <div className={box}>
      <p className={`flex items-center gap-1.5 ${heading}`}><Check className="h-3.5 w-3.5" /> Marked as helping “{sourceTitle}”</p>
      <p className="mt-1 text-[14px] font-medium leading-relaxed text-[#1f4d2e]">{idea}</p>
      <div className="mt-2"><UndoButton onUndo={() => onChoose(null)} /></div>
    </div>;
    return <div className={`${box} flex items-center gap-3`}>
      <div className="min-w-0 flex-1">
        <p className={heading}>Your new note could help “{sourceTitle}”</p>
        <p className="mt-1 text-[15px] font-semibold leading-relaxed text-[#1f4d2e]">{idea}</p>
      </div>
      <IconChoice kind={kind} accept={false} label="Doesn’t apply there" onClick={() => onChoose('rejected')} />
      <IconChoice kind={kind} accept label="Yes, it helps there" onClick={() => onChoose('helped')} />
    </div>;
  }

  if (kind === 'helps') {
    // A dismissed solution has no idea of its own, so its answer stands in.
    const idea = insight.kind === 'helps' ? sentenceCase(plainNoteText(insight.action)) : `“${plainNoteText(answer?.text ?? insight.action)}”`;
    if (choice === 'helped') return <div className={box}>
      <p className={`flex items-center gap-1.5 ${heading}`}><Check className="h-3.5 w-3.5" /> Shown beside your sentence</p>
      <p className="mt-1 text-[14px] font-medium leading-relaxed text-[#1f4d2e]">{idea}</p>
      <div className="mt-2"><UndoButton onUndo={() => onChoose(choice === 'helped' && insight.kind === 'solution' ? 'downgraded' : null)} /></div>
    </div>;
    return <div className={`${box} flex items-center gap-3`}>
      <div className="min-w-0 flex-1">
        <p className={heading}>This might help your new note</p>
        <p className="mt-1 text-[15px] font-semibold leading-relaxed text-[#1f4d2e]">{idea}</p>
      </div>
      <IconChoice kind={kind} accept={false} label="Not helpful" onClick={() => onChoose('rejected')} />
      <IconChoice kind={kind} accept label="This helps" onClick={() => onChoose('helped')} />
    </div>;
  }

  if (kind === 'extension') {
    // Merged words are kept as plain text, so neither the card, the note, nor Edit shows markdown symbols.
    const words = plainNoteText(answer?.text ?? insight.action);
    if (choice === 'merged') return <div className={box}>
      <p className={`flex items-center gap-1.5 ${heading}`}><Check className="h-3.5 w-3.5" /> Added below your sentence</p>
      {editing
        ? <>
          <textarea autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onClick={(event) => event.stopPropagation()} rows={3} aria-label="Edit the added text" className="mt-2 w-full resize-y rounded-md border border-[#d8c4ef] bg-white px-3 py-2 text-[13px] leading-relaxed text-[#4d3569] outline-none focus:border-[#9a72c5] focus:ring-2 focus:ring-[#d8c4ef]" />
          <div className="mt-2 flex gap-3">
            <button type="button" disabled={!draft.trim()} onClick={(event) => { event.stopPropagation(); onChoose('merged', draft.trim()); }} className="rounded-md bg-[#8254b5] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#70449f] disabled:opacity-40">Save</button>
            <button type="button" onClick={(event) => { event.stopPropagation(); setEditing(false); setDraft(decision?.text ?? ''); }} className="text-xs text-[#777] hover:underline">Cancel</button>
          </div>
        </>
        : <p className="mt-1 whitespace-pre-wrap text-[14px] leading-relaxed text-[#4d3569]">“{plainNoteText(decision?.text ?? words)}”</p>}
      {!editing && <div className="mt-2 flex gap-3"><button type="button" onClick={(event) => { event.stopPropagation(); setDraft(plainNoteText(decision?.text ?? words)); setEditing(true); }} className="text-xs font-medium text-[#7348a7] hover:underline">Edit</button><UndoButton onUndo={() => onChoose(null)} /></div>}
    </div>;
    return <div className={`${box} flex items-center gap-3`}>
      <div className="min-w-0 flex-1">
        <p className={heading}>Merge adds to your note</p>
        <p className="mt-1 text-[14px] leading-relaxed text-[#4d3569]">“{words}”</p>
        <p className="mt-1 text-[11px] text-[#9a7fbf]">Word for word{sharedBy ? ` from ${sharedBy}` : ''}, linked to {sourceDate}</p>
      </div>
      <IconChoice kind={kind} accept={false} label="Dismiss" onClick={() => onChoose('rejected')} />
      <button type="button" onClick={(event) => { event.stopPropagation(); onChoose('merged', words); }} className="shrink-0 rounded-md bg-[#8254b5] px-4 py-2 text-xs font-medium text-white hover:bg-[#70449f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8254b5] focus-visible:ring-offset-2">Merge</button>
    </div>;
  }

  if (kind === 'contradiction') {
    const options: { choice: CardChoice; label: string }[] = [
      { choice: 'today', label: 'Today stands' },
      { choice: 'earlier', label: sharedBy ? `${sharedBy}’s view holds` : `${sourceTitle} holds` },
      { choice: 'both', label: 'Both are true' },
    ];
    return <div className={box}>
      <p className={heading}>Which is true?</p>
      <div className="mt-2 space-y-2">
        {options.map((option) => <button
          key={option.choice}
          type="button"
          aria-pressed={choice === option.choice}
          onClick={(event) => { event.stopPropagation(); onChoose(option.choice, option.choice === 'both' ? decision?.text : undefined); }}
          className={`block w-full truncate rounded-md border px-3 py-2 text-left text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c64747] ${choice === option.choice ? 'border-[#a82c2c] bg-[#a82c2c] text-white' : 'border-[#f0c6c6] bg-white text-[#5a2b2b] hover:bg-[#fff6f6]'}`}
        >{option.label}</button>)}
      </div>
      {choice === 'both' && <div className="mt-3">
        <label className={heading} htmlFor={`both-${Math.abs(stableHash(insight.text))}`}>Why both are true</label>
        <textarea id={`both-${Math.abs(stableHash(insight.text))}`} value={draft} onChange={(event) => setDraft(event.target.value)} onClick={(event) => event.stopPropagation()} rows={2} placeholder="Optional" className="mt-1 w-full resize-y rounded-md border border-[#f3c2c2] bg-white px-3 py-2 text-[13px] leading-relaxed text-[#6f3333] outline-none focus:border-[#d47a7a] focus:ring-2 focus:ring-[#f3c2c2]" />
        {draft.trim() !== (decision?.text ?? '') && <button type="button" onClick={(event) => { event.stopPropagation(); onChoose('both', draft.trim()); }} className="mt-1 rounded-md bg-[#d65d5d] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#c34f4f]">Save</button>}
      </div>}
      {choice && <div className="mt-2"><UndoButton onUndo={() => onChoose(null)} /></div>}
    </div>;
  }

  if (choice === 'confirmed') return <div className={box}>
    <p className={`flex items-center gap-1.5 ${heading}`}><Check className="h-3.5 w-3.5" /> Marked as a pattern</p>
    <p className="mt-1 text-[14px] font-medium leading-relaxed text-[#4f3f0c]">{plainNoteText(insight.action)}</p>
    <div className="mt-2"><UndoButton onUndo={() => onChoose(null)} /></div>
  </div>;
  return <div className={`${box} flex items-center gap-3`}>
    <div className="min-w-0 flex-1">
      <p className={heading}>A pattern in your notes</p>
      <p className="mt-1 text-[15px] font-semibold leading-relaxed text-[#4f3f0c]">{plainNoteText(insight.action)}</p>
    </div>
    <IconChoice kind={kind} accept={false} label="Not a pattern" onClick={() => onChoose('rejected')} />
    <IconChoice kind={kind} accept label="Yes, a pattern" onClick={() => onChoose('confirmed')} />
  </div>;
}

/**
 * Notes the search matched without a card: each with its name, date, the
 * one-line summary of what it says, and why it was picked. Opening one shows
 * it beside the note at the passage the match rested on.
 */
function RelatedNotesList({ heading, results, notesById, onOpen }: {
  heading: string;
  results: RelevanceResult[];
  notesById: Map<string, Note>;
  onOpen: (noteId: string, focus?: string) => void;
}) {
  // Every match that cleared its bar arrives; the strongest few show first.
  const [shown, setShown] = useState(RELATED_NOTES_PAGE_SIZE);
  const remaining = results.length - shown;
  return <section aria-label={heading} className="pt-2">
    <h3 className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-[#999]">{heading}</h3>
    <ul className="space-y-2">
      {results.slice(0, shown).map((result) => {
        const relatedNote = notesById.get(result.note_id);
        if (!relatedNote) return null;
        const badge = relationBadgeFor(result);
        const summary = result.gist.trim() || notePreview(relatedNote);
        const reason = result.explanation.trim();
        return <li key={result.note_id}>
          <button
            type="button"
            // No card quoted this note, so the panel marks the passage the search matched instead.
            onClick={() => onOpen(result.note_id)}
            className="block w-full rounded-lg border border-[#e4e4e8] bg-white px-4 py-3 text-left shadow-sm transition hover:border-[#8fb1ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-[13px] font-medium text-[#222]">{noteLabel(relatedNote)}</span>
              <span className="flex shrink-0 items-center gap-2 text-[11px] text-[#aaa]">
                {badge && <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}>{badge.label}</span>}
                {formatDate(relatedNote.created_at)}
              </span>
            </span>
            <span className="mt-1 line-clamp-2 block text-[13px] leading-relaxed text-[#666]">{summary}</span>
            {/* Shown up front so the reader sees why the note is here without opening it. */}
            {reason && <span className="mt-2 block rounded-md bg-[#e4f2e8] px-2.5 py-2">
              <span className="block text-[9px] font-semibold uppercase tracking-[0.09em] text-[#6aa37c]">Why it’s relevant</span>
              <span className="mt-1 block text-[12px] leading-relaxed text-[#4a6b55]">{reason}</span>
            </span>}
          </button>
        </li>;
      })}
    </ul>
    {remaining > 0 && <button type="button" onClick={() => setShown((count) => count + RELATED_NOTES_PAGE_SIZE)} className="mt-2 w-full rounded-lg border border-dashed border-[#d5d9e3] px-4 py-2 text-[13px] text-[#477bea] hover:border-[#8fb1ff] hover:bg-[#f8f9fc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]">Show {Math.min(RELATED_NOTES_PAGE_SIZE, remaining)} more <span className="text-[#999]">({remaining} left)</span></button>}
  </section>;
}

/**
 * One suggestion: the sentence of the note it is about, their own past words
 * connected by one line from the model, and what they can do with it.
 */
function SuggestionCard({ insight, kind, decision, notesById, trigger, outbound = false, compact = false, onChoose, onOpenSource }: {
  insight: NoteInsight;
  kind: SuggestionKind;
  decision?: CardDecision;
  notesById: Map<string, Note>;
  /** The sentence of the note it is about; without one the bare passage is shown. */
  trigger?: TriggerSentence | null;
  /** True when this note is the lesson and the cited notes are where it applies. */
  outbound?: boolean;
  compact?: boolean;
  /** Absent where the note cannot keep choices yet, such as an unsaved draft. */
  onChoose?: (choice: CardChoice | null, text?: string) => void;
  onOpenSource: (noteId: string, focus?: string) => void;
}) {
  const style = SUGGESTION_STYLES[kind];
  // An answer with an empty note id is this note's own words, so the source is the problem's note.
  const sourceId = insight.problem?.note_id || insight.answer?.note_id || insight.quotes?.[0]?.note_id || insight.note_ids[0];
  const source = sourceId ? notesById.get(sourceId) : undefined;
  const sourceTitle = source ? noteLabel(source) : 'Earlier note';
  const sourceDate = source ? formatDate(source.created_at) : '';
  const cited = insight.note_ids.map((id) => notesById.get(id)).filter((note): note is Note => note !== undefined);
  // When this note is the help, the badge says the earlier note is the one helped.
  const badgeLabel = outbound && kind === 'solution' ? 'Answers an earlier note'
    : outbound && kind === 'helps' ? 'Helps an earlier note'
      : style.label;
  return (
    <section aria-label={`${style.label} suggestion`} className={`rounded-xl border bg-white shadow-sm ${style.border} ${compact ? 'p-4' : 'p-6'}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-2"><span className={`shrink-0 rounded-md px-2 py-1 text-xs font-medium ${style.badge}`}>{badgeLabel}</span></p>
        {kind === 'contradiction' && onChoose && !decision && <button type="button" onClick={(event) => { event.stopPropagation(); onChoose('rejected'); }} aria-label="Dismiss" title="Dismiss" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#999] hover:bg-[#f5f5f5] hover:text-[#555]"><X className="h-4 w-4" /></button>}
      </div>
      {(trigger || insight.anchor) && <blockquote className="mt-3 border-l-2 border-[#ddd] pl-3 text-[13px] italic leading-relaxed text-[#777]">“{trigger
        ? <>{trigger.before}<span className={`rounded-sm px-0.5 not-italic text-[#444] ${HIGHLIGHT_STYLES[kind].idle}`}>{trigger.key}</span>{trigger.after}</>
        : plainNoteText(insight.anchor)}”</blockquote>}
      <p className={`mt-4 leading-relaxed text-[#222] ${compact ? 'text-[14px]' : 'text-[16px]'}`}><InsightSentence insight={insight} kind={kind} onOpenSource={onOpenSource} /></p>
      {source && <p className="mt-2 text-[11px] text-[#999]">{outbound ? 'The earlier note this helps' : source.shared_by ? `From ${source.shared_by}’s notes` : 'From your notes'}: “{sourceTitle}” · {sourceDate}</p>}
      {onChoose
        ? <CardAction insight={insight} kind={kind} decision={decision} sourceTitle={sourceTitle} sourceDate={sourceDate} sharedBy={source?.shared_by ?? null} outbound={outbound} onChoose={onChoose} onOpenSource={onOpenSource} />
        : <p className="mt-3 text-[11px] text-[#999]">Save the note to act on this.</p>}
      {cited.length > 0 && <div className="mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-t border-[#ececef] pt-3 text-[11px] text-[#999]">
        <span>{outbound ? 'Where this applies' : 'Notes used'}</span>
        {cited.map((note) => <button key={note.id} type="button" onClick={(event) => { event.stopPropagation(); onOpenSource(note.id); }} className="truncate hover:text-[#477bea] hover:underline">{formatDate(note.created_at)} · {noteLabel(note)} ↗</button>)}
      </div>}
    </section>
  );
}

/*
 * The suggestions view from the Ocreda design (Nov 24, built for testing).
 * Each passage with a card gets a coloured line beside it; clicking one opens
 * the panel on that card alone, with arrows to the others. A choice closes the
 * panel and leaves a pill on the passage that opens what was chosen. The
 * classic view stays one click away in the note's menu, to compare.
 */
const NOTE_VIEW_KEY = 'ocreda-note-suggestions-view';
/** The id of the panel's last page, after the cards: related notes without a card. */
const RELATED_PAGE = 'related';
type NoteSuggestionsView = 'design' | 'classic';

/**
 * The phone sheet's grey bar: a tap and a swipe do the same thing (decided
 * Nov 25), since people try to drag a sheet's bar. The press is captured so a
 * swipe that leaves the bar still counts, and the page does not scroll under
 * it. A click with no pointer behind it (Enter or Space) still works.
 */
function tapOrSwipe(action: () => void) {
  return {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      // Capturing only helps a swipe that leaves the bar; the bar works without it.
      try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* No active pointer to capture. */ }
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
      event.preventDefault();
      // The bar usually disappears with the action, so the click that follows
      // this tap would land on whatever was under it (a Domain card, the note's
      // text) and open it. Swallow that one click.
      const swallow = (click: MouseEvent) => { click.preventDefault(); click.stopPropagation(); };
      window.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 400);
      action();
    },
    onClick: (event: React.MouseEvent) => { if (event.detail === 0) action(); },
    style: { touchAction: 'none' } as React.CSSProperties,
  };
}

/** Whether the screen is narrower than the note-and-panel layout (Tailwind's xl, 1280px). */
function useNarrowScreen(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1279.98px)');
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return narrow;
}

function readNoteSuggestionsView(): NoteSuggestionsView {
  try { return localStorage.getItem(NOTE_VIEW_KEY) === 'classic' ? 'classic' : 'design'; } catch { return 'design'; }
}

function writeNoteSuggestionsView(view: NoteSuggestionsView): void {
  try { localStorage.setItem(NOTE_VIEW_KEY, view); } catch { /* Kept for this visit only. */ }
}

/** The design's colours for each kind: the line and text, the soft border, and the tinted fill. */
const DESIGN_TONES: Record<SuggestionKind, { ink: string; soft: string; tint: string }> = {
  solution: { ink: '#3B66D6', soft: '#B9CBF5', tint: '#E9EFFD' },
  contradiction: { ink: '#B42318', soft: '#F2B8B5', tint: '#FCE9E8' },
  helps: { ink: '#2E7D4F', soft: '#A8D5BA', tint: '#E5F2EA' },
  extension: { ink: '#7B4FC9', soft: '#D8CBF4', tint: '#F4EFFC' },
  insight: { ink: '#9A7400', soft: '#EBD58A', tint: '#FDF7DE' },
};

/** The past note a card rests on, as the design names it. */
type DesignSource = { note?: Note; title: string; date: string; sharedBy: string | null };

function designSourceOf(item: NoteInsight, notesById: Map<string, Note>): DesignSource {
  const sourceId = item.problem?.note_id || item.answer?.note_id || item.quotes?.[0]?.note_id || item.note_ids[0];
  const note = sourceId ? notesById.get(sourceId) : undefined;
  return { note, title: note ? noteLabel(note) : 'an earlier note', date: note ? formatDate(note.created_at) : '', sharedBy: note?.shared_by ?? null };
}

/** What a choice is called, on the panel and on the pill at the end of the passage. */
function designChoiceLabel(choice: CardChoice | undefined, source: DesignSource): string {
  switch (choice) {
    case 'solved': return 'Solved';
    case 'helped': return 'Helped';
    case 'merged': return 'Merged';
    case 'confirmed': return 'Noted';
    case 'today': return 'What I wrote today is true';
    case 'earlier': return source.sharedBy ? `What ${source.sharedBy} wrote${source.date ? ` on ${source.date}` : ''} is true` : `What I wrote${source.date ? ` on ${source.date}` : ' before'} is true`;
    case 'both': return 'Both are true';
    default: return 'Dismissed';
  }
}

/**
 * Whether a card's choice marks another note rather than this one: this note
 * answered an earlier note's problem, or was marked as helping it. The answer
 * shows on that earlier note; this note already holds it in its own words.
 */
function marksOtherNote(view: CardView, outbound: boolean): boolean {
  const choice = view.decision?.choice;
  return !view.fromNoteId && (choice === 'solved' || choice === 'helped') && (outbound || view.item.direction === 'outbound');
}

/** Undoing a Helps card that began as a solution puts it back as a Helps card, as the classic view does. */
function designUndoChoice(view: CardView): CardChoice | null {
  return view.decision?.choice === 'helped' && view.item.kind === 'solution' ? 'downgraded' : null;
}

/** The box at the top of an act-on card: what it offers, and what the buttons do. */
type DesignSynthesis = { label: string; works: string; from: string; accept: CardChoice; acceptLabel: string; acceptText?: string; dismiss: CardChoice; quiet?: boolean };

function designSynthesis(view: CardView, source: DesignSource, citedCount: number, outbound: boolean): DesignSynthesis | null {
  const item = view.item;
  const whose = source.sharedBy ? `${source.sharedBy}’s` : 'your';
  const from = `Synthesis of ${citedCount || 1} of ${whose} notes`;
  const where = `“${source.title}”${source.date ? ` · ${source.date}` : ''}`;
  if (view.kind === 'solution') {
    // The headline is what to do, in plain words; the exact words it rests on go beneath it.
    const solution = plainNoteText(item.solution ?? '').trim();
    if (outbound && item.problem) return solution
      ? { label: `Your new note answers ${where}`, works: solution, from: `The problem there, in your words: ‘${plainNoteText(item.problem.text)}’`, accept: 'solved', acceptLabel: 'Solve', dismiss: 'rejected' }
      : { label: `Your new note answers ${where}`, works: `“${plainNoteText(item.problem.text)}”`, from: `The problem, word for word from ${where}`, accept: 'solved', acceptLabel: 'Solve', dismiss: 'rejected' };
    const answer = plainNoteText(item.answer?.text ?? item.action);
    // A dismissed solution carries on as a Helps card, as in the classic view.
    // With each note's words shown below, the headline is labelled as what it is: a synthesis.
    return { label: 'Solution', works: solution || answer, from: solution && !item.evidence?.length ? `${source.sharedBy ? `${source.sharedBy}’s` : 'Your'} words in ${where}: ‘${answer}’` : from, accept: 'solved', acceptLabel: 'Solve', dismiss: 'downgraded' };
  }
  if (view.kind === 'helps') {
    if (outbound) return { label: `Your new note could help ${where}`, works: sentenceCase(plainNoteText(item.action)), from, accept: 'helped', acceptLabel: 'Use this', dismiss: 'rejected' };
    // A dismissed solution has no idea of its own, so its answer stands in.
    const idea = item.kind === 'helps' ? sentenceCase(plainNoteText(item.action)) : `“${plainNoteText(item.answer?.text ?? item.action)}”`;
    return { label: 'Helps', works: idea, from, accept: 'helped', acceptLabel: 'Use this', dismiss: 'rejected' };
  }
  if (view.kind === 'extension') {
    const words = plainNoteText(item.answer?.text ?? item.action);
    return { label: 'Will be added below your sentence', works: words, from: `${source.sharedBy ? `${source.sharedBy}’s` : 'Your'} exact words from ${where}`, accept: 'merged', acceptLabel: 'Merge', acceptText: words, dismiss: 'rejected', quiet: true };
  }
  if (view.kind === 'insight') return { label: 'Insight', works: plainNoteText(item.action), from, accept: 'confirmed', acceptLabel: 'Note', dismiss: 'rejected' };
  return null;
}

/** "Your words and why it relates": the card's sentence with their quotes, and the notes it rests on. */
function DesignEvidence({ view, cited, onOpenSource }: { view: CardView; cited: Note[]; onOpenSource: (noteId: string, focus?: string) => void }) {
  const noteLink = (note: Note) => <button key={note.id} type="button" onClick={(event) => { event.stopPropagation(); onOpenSource(note.id); }} className="text-left text-[13px] text-[#55555B] hover:text-[#1B1B1F] hover:underline">
    {note.shared_by ? `${note.shared_by}’s ` : ''}{noteLabel(note)} · {formatDate(note.created_at)} ↗
  </button>;
  // Each note on its own: what part it plays, its words and why it came back,
  // then the note itself (decided Nov 26, from the cofounder's card design).
  const evidence = (view.item.evidence ?? []).flatMap((entry) => {
    const note = cited.find((item) => item.id === entry.note_id);
    return note ? [{ entry, note }] : [];
  });
  if (evidence.length) {
    const rest = cited.filter((note) => !evidence.some(({ note: shown }) => shown.id === note.id));
    return <section className="flex flex-col gap-3">
      <h2 className="text-[13px] font-normal text-[#6B6B70]">Your words and why it relates</h2>
      <div className="flex flex-col gap-7">
        {evidence.map(({ entry, note }) => <div key={note.id} className="flex flex-col gap-2">
          <h3 className="text-[16px] font-normal italic text-[#2B2B2E]">{entry.heading}</h3>
          <p className="text-[16px] leading-[1.75] text-[#6E6E74] [&_[role=button]]:text-[#1B1B1F]"><InsightSentence insight={{ ...view.item, text: entry.text }} kind={view.kind} onOpenSource={onOpenSource} /></p>
          <div className="flex flex-col items-start">{noteLink(note)}</div>
        </div>)}
      </div>
      {rest.length > 0 && <div className="flex flex-col items-start gap-1.5">{rest.map(noteLink)}</div>}
    </section>;
  }
  return <section className="flex flex-col gap-3">
    <h2 className="text-[13px] font-normal text-[#6B6B70]">Your words and why it relates</h2>
    <p className="text-[16px] leading-[1.75] text-[#6E6E74] [&_[role=button]]:text-[#1B1B1F]"><InsightSentence insight={view.item} kind={view.kind} onOpenSource={onOpenSource} /></p>
    <div className="flex flex-col items-start gap-1.5">
      {cited.map((note) => <button key={note.id} type="button" onClick={(event) => { event.stopPropagation(); onOpenSource(note.id); }} className="text-left text-[13px] text-[#55555B] hover:text-[#1B1B1F] hover:underline">
        {note.shared_by ? `${note.shared_by}’s ` : ''}{noteLabel(note)} · {formatDate(note.created_at)} ↗
      </button>)}
    </div>
  </section>;
}

/** The panel's top row: arrows through the note's pages when there is more than one, refresh, and hide. */
function DesignPanelBar({ position, total, refreshing, onPrev, onNext, onRefresh, onHide, sheet = false }: {
  position: number;
  total: number;
  refreshing: boolean;
  onPrev: () => void;
  onNext: () => void;
  onRefresh: () => void;
  onHide: () => void;
  /** On a phone's sheet the row sits under the handle, and closing it lowers the sheet. */
  sheet?: boolean;
}) {
  // On a phone the row holds the arrows between cards and searching again,
  // which the note's header no longer has; the grey bar above collapses the
  // sheet (decided Nov 25).
  if (sheet) return <div className="flex shrink-0 items-center justify-end pb-1 pl-5 pr-3">
    {total > 1 && <div className="mr-auto flex items-center">
      <button type="button" onClick={onPrev} aria-label="Previous suggestion" className="flex h-10 w-9 items-center justify-center text-[#55555B]"><ChevronLeft className="h-4 w-4" /></button>
      <span className="text-[13px] text-[#55555B]">{position + 1} of {total}</span>
      <button type="button" onClick={onNext} aria-label="Next suggestion" className="flex h-10 w-9 items-center justify-center text-[#55555B]"><ChevronRight className="h-4 w-4" /></button>
    </div>}
    <button type="button" onClick={onRefresh} disabled={refreshing} aria-label="Search again" title="Search again" className="flex h-10 w-10 items-center justify-center rounded-xl text-[#55555B] disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /></button>
  </div>;
  return <div className="flex shrink-0 items-center justify-end gap-3 px-6 pt-4 sm:px-8">
    {total > 1 && <div className="mr-auto flex items-center gap-0.5">
      <button type="button" onClick={onPrev} aria-label="Previous suggestion in this note" className="flex h-9 w-9 items-center justify-center rounded-[10px] text-[#55555B] hover:bg-white"><ChevronLeft className="h-4 w-4" /></button>
      <span className="min-w-[48px] text-center text-[13px] text-[#55555B]">{position + 1} of {total}</span>
      <button type="button" onClick={onNext} aria-label="Next suggestion in this note" className="flex h-9 w-9 items-center justify-center rounded-[10px] text-[#55555B] hover:bg-white"><ChevronRight className="h-4 w-4" /></button>
    </div>}
    <div className="flex items-center gap-0.5">
      <button type="button" onClick={onRefresh} disabled={refreshing} aria-label="Refresh suggestions" title="Refresh suggestions" className="flex h-11 w-11 items-center justify-center rounded-xl text-[#55555B] hover:bg-white disabled:opacity-50"><RefreshCw className={`h-[18px] w-[18px] ${refreshing ? 'animate-spin' : ''}`} /></button>
      <button type="button" onClick={onHide} aria-label="Hide suggestions panel" title="Hide suggestions panel" className="flex h-11 w-11 items-center justify-center rounded-xl text-[#55555B] hover:bg-white"><PanelRightOpen className="h-[18px] w-[18px]" /></button>
    </div>
  </div>;
}

/** The panel's view of one card, from the design: its result, what it offers, its evidence, and its buttons. */
function DesignSuggestionPanel({ view, position, total, notesById, outbound, refreshing, onPrev, onNext, onRefresh, onHide, onChoose, onFindOther, onOpenSource, sheet = false }: {
  /** On a phone the panel is a sheet: smaller type, and the buttons fixed along its bottom. */
  sheet?: boolean;
  view: CardView;
  position: number;
  total: number;
  notesById: Map<string, Note>;
  outbound: boolean;
  refreshing: boolean;
  onPrev: () => void;
  onNext: () => void;
  onRefresh: () => void;
  onHide: () => void;
  onChoose: (choice: CardChoice | null, text?: string) => void;
  onFindOther: () => void;
  onOpenSource: (noteId: string, focus?: string) => void;
}) {
  const tone = DESIGN_TONES[view.kind];
  const source = designSourceOf(view.item, notesById);
  const cited = view.item.note_ids.map((id) => notesById.get(id)).filter((note): note is Note => note !== undefined);
  const choice = view.decision?.choice;
  const rejected = choice === 'rejected';
  const acted = isActedCard(view.decision);
  const pending = isPendingCard(view.decision);
  const synthesis = designSynthesis(view, source, cited.length, outbound);
  const [bothOpen, setBothOpen] = useState(false);
  const [bothText, setBothText] = useState(view.decision?.text ?? '');

  const sides: { choice: CardChoice; kick: string; label: string }[] = [
    { choice: 'today', kick: sheet ? 'Highlighted above' : 'Highlighted on the left', label: designChoiceLabel('today', source) },
    { choice: 'earlier', kick: `“${source.title}”${source.date ? ` · ${source.date}` : ''}`, label: designChoiceLabel('earlier', source) },
  ];

  const buttons = synthesis && !rejected && pending ? <>
    <button type="button" onClick={() => onChoose(synthesis.accept, synthesis.acceptText)} className={`flex items-center justify-center gap-2 font-semibold text-white hover:brightness-95 ${sheet ? 'min-h-[48px] flex-[2] rounded-xl text-base' : 'min-h-[44px] min-w-[190px] rounded-[10px] px-[22px] text-[15px]'}`} style={{ background: tone.ink }}><Check className="h-4 w-4" strokeWidth={2.6} />{synthesis.acceptLabel}</button>
    <button type="button" onClick={() => onChoose(synthesis.dismiss)} className={`flex items-center justify-center border border-[#D6D6DB] bg-white font-medium text-[#2B2B2E] hover:border-[#b9b9c0] ${sheet ? 'min-h-[48px] flex-1 rounded-xl text-base' : 'min-h-[44px] min-w-[130px] rounded-[10px] px-[18px] text-[15px]'}`}>Dismiss</button>
  </> : null;

  return <div className="flex min-h-0 flex-1 flex-col">
    <DesignPanelBar position={position} total={total} refreshing={refreshing} onPrev={onPrev} onNext={onNext} onRefresh={onRefresh} onHide={onHide} sheet={sheet} />

    <div className={`min-h-0 flex-1 overflow-y-auto ${sheet ? 'px-5 pb-6 pt-2' : 'px-6 pb-10 pt-4 sm:px-12'}`}>
      <div className={`flex max-w-[644px] flex-col ${sheet ? 'gap-5' : 'gap-8'}`}>
        {acted && <div role="status" className="flex min-h-[60px] items-center gap-3.5 rounded-[14px] py-2 pl-[18px] pr-3 text-white shadow-[0_8px_22px_rgba(20,20,30,0.16)]" style={{ background: tone.ink }}>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white" style={{ color: tone.ink }}><Check className="h-4 w-4" strokeWidth={3} /></span>
          <span className="flex flex-1 flex-col">
            <span className="text-[19px] font-semibold leading-snug">{designChoiceLabel(choice, source)}</span>
            {/* Nothing marks this note: the answer went to the earlier one, so say where. */}
            {marksOtherNote(view, outbound) && <span className="text-[13px] leading-snug text-white/85">Shown on {source.sharedBy ? `${source.sharedBy}’s ` : ''}“{source.title}”{source.note && <> · <button type="button" onClick={() => onOpenSource(source.note!.id, view.item.problem?.text ?? '')} className="underline">open it</button></>}</span>}
          </span>
          <button type="button" onClick={() => onChoose(designUndoChoice(view))} className="min-h-[40px] px-2.5 text-sm text-white underline">Undo</button>
        </div>}
        {rejected && <div role="status" className="-mb-3 flex flex-wrap items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#8A8A90] text-white"><X className="h-4 w-4" strokeWidth={3} /></span>
          <span className="flex-1 text-[18px] font-semibold text-[#55555B]">Dismissed</span>
          <button type="button" onClick={onFindOther} className="flex min-h-[36px] items-center gap-1.5 rounded-lg border border-[#D6D6DB] bg-white px-3 text-[13px] font-medium text-[#2B2B2E] hover:border-[#b9b9c0]"><RefreshCw className="h-3.5 w-3.5" /> Find other notes</button>
          <button type="button" onClick={() => onChoose(null)} className="min-h-[36px] px-2 text-[13px] text-[#6B6B70] underline">Undo</button>
        </div>}

        {view.kind === 'contradiction' && !rejected && <>
          {choice === 'both' && view.decision?.text && <div className="flex flex-col gap-1.5 rounded-xl border bg-white px-5 py-[18px]" style={{ borderColor: tone.soft }}>
            <span className="text-[13px] text-[#6B6B70]">Why both are true</span>
            <p className="whitespace-pre-line text-[17px] leading-relaxed text-[#1B1B1F]">{view.decision.text}</p>
          </div>}
          <div style={{ opacity: choice === 'today' ? 0.4 : 1 }} className="transition-opacity"><DesignEvidence view={view} cited={cited} onOpenSource={onOpenSource} /></div>
          {pending && <section aria-label="Which is true" className="flex flex-col gap-2.5 rounded-[14px] border p-5" style={{ borderColor: tone.soft, background: tone.tint }}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold" style={{ color: tone.ink }}>Which is true?</span>
              <button type="button" onClick={() => onChoose('rejected')} aria-label="Dismiss this contradiction" title="Dismiss" className="-my-1.5 -mr-1.5 flex h-8 w-8 items-center justify-center rounded-lg hover:bg-white/60" style={{ color: tone.ink }}><X className="h-4 w-4" /></button>
            </div>
            {/* Side by side on a phone too, as in the design, with smaller type to fit. */}
            <div className={`grid gap-2.5 ${sheet ? 'grid-cols-2 gap-2' : 'grid-cols-1 sm:grid-cols-2'}`}>
              {sides.map((side) => <button key={side.choice} type="button" onClick={() => onChoose(side.choice)} className={`flex flex-col justify-between rounded-xl border-[1.5px] bg-white text-left text-[#2B2B2E] hover:brightness-[0.98] ${sheet ? 'min-h-[96px] gap-2 p-3' : 'min-h-[88px] gap-2.5 p-4'}`} style={{ borderColor: tone.soft }}>
                <span className={`truncate font-semibold ${sheet ? 'text-[11px]' : 'text-xs'}`} style={{ color: tone.ink }}>{side.kick}</span>
                <span className={`font-semibold leading-snug ${sheet ? 'text-sm' : 'text-base'}`}>{side.label}</span>
              </button>)}
            </div>
            <button type="button" aria-pressed={bothOpen} onClick={() => setBothOpen(true)} className="min-h-[40px] self-center rounded-lg px-3.5 text-sm font-medium" style={bothOpen ? { background: '#FFFFFF', color: tone.ink } : { color: '#55555B' }}>Both are true</button>
            {bothOpen && <div className="mt-1 flex flex-col gap-2">
              <label htmlFor={`both-why-${view.id}`} className="text-[13px] text-[#55555B]">Why are both true?</label>
              <textarea id={`both-why-${view.id}`} autoFocus value={bothText} onChange={(event) => setBothText(event.target.value)} placeholder="Write how both can be true at the same time…" className="min-h-[90px] resize-y rounded-[10px] border border-[#D6D6DB] bg-white px-3.5 py-3 text-[15px] leading-normal text-[#2B2B2E] outline-none focus:border-[#b9b9c0]" />
              <button type="button" onClick={() => onChoose('both', bothText.trim())} className="min-h-[40px] min-w-[140px] self-start rounded-[10px] px-[18px] text-sm font-semibold text-white" style={{ background: tone.ink }}>Save</button>
            </div>}
          </section>}
        </>}

        {synthesis && !rejected && <>
          <section aria-label="Synthesis" className="flex flex-col gap-3 rounded-[14px] border px-6 pb-5 pt-6" style={{ borderColor: tone.soft, background: tone.tint }}>
            <span className="text-[13px] font-semibold" style={{ color: tone.ink }}>{synthesis.label}</span>
            <p className={`${sheet ? 'text-[19px]' : 'text-[23px] tracking-[-0.01em]'} leading-[1.4] text-[#111114] ${synthesis.quiet ? 'font-medium' : 'font-semibold'}`}>{choice === 'merged' && view.decision?.text ? plainNoteText(view.decision.text) : synthesis.works}</p>
            <span className={`${sheet ? 'text-[11px]' : 'text-xs'} text-[#55555B]`}>{synthesis.from}</span>
          </section>
          <DesignEvidence view={view} cited={cited} onOpenSource={onOpenSource} />
          {buttons && !sheet && <div className="flex flex-wrap gap-2 border-t border-[#E2E2E6] pt-6">{buttons}</div>}
        </>}
      </div>
    </div>
    {/* On a phone the buttons stay along the bottom of the sheet while its content scrolls. */}
    {buttons && sheet && <div className="flex shrink-0 gap-2 border-t border-[#E2E2E6] bg-[#F7F7F8] px-5 pb-7 pt-3">{buttons}</div>}
  </div>;
}

/** What a chosen card shows under its passage when its pill is clicked: the result, and why. */
function DesignDrop({ view, notesById, outbound, onUndo, onOpenSource }: {
  view: CardView;
  notesById: Map<string, Note>;
  outbound: boolean;
  onUndo: () => void;
  onOpenSource: (noteId: string, focus?: string) => void;
}) {
  const tone = DESIGN_TONES[view.kind];
  const source = designSourceOf(view.item, notesById);
  const cited = view.item.note_ids.map((id) => notesById.get(id)).filter((note): note is Note => note !== undefined);
  const synthesis = designSynthesis(view, source, cited.length, outbound);
  const choice = view.decision?.choice;
  const works = choice === 'merged' && view.decision?.text ? plainNoteText(view.decision.text) : synthesis?.works ?? '';
  return <div className="mb-1.5 mt-[18px] flex flex-col gap-[22px] border-y border-[#EEEEF0] bg-[#F7F7F8] py-8 pr-2 [clip-path:inset(0_-100vw)]" style={{ boxShadow: '0 0 0 100vw #F7F7F8' }}>
    <section aria-label="Synthesis" className="flex flex-col gap-2.5 rounded-xl border bg-white px-[22px] py-5" style={{ borderColor: tone.soft }}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-semibold" style={{ color: tone.ink }}>{synthesis?.label ?? 'Contradiction'}</span>
        <button type="button" onClick={onUndo} className="min-h-[32px] px-1 text-[13px] text-[#6B6B70] underline">Undo</button>
      </div>
      {works && <p className="text-[20px] font-semibold leading-[1.4] text-[#1B1B1F]">{works}</p>}
      {view.kind === 'contradiction' && <p className="text-[15px] leading-normal text-[#3A3A40]">You chose: <b className="font-semibold" style={{ color: tone.ink }}>{designChoiceLabel(choice, source)}</b></p>}
      {choice === 'both' && view.decision?.text && <p className="whitespace-pre-line text-[15px] leading-normal text-[#3A3A40]">Why both are true: {view.decision.text}</p>}
    </section>
    <DesignEvidence view={view} cited={cited} onOpenSource={onOpenSource} />
  </div>;
}

/** A past note opened from a card, inside the panel: the quoted words marked, and why it came back. */
function DesignReadingView({ notes, index, focus, relevanceFor, onIndex, onClose, onOpenFull }: {
  notes: Note[];
  index: number;
  focus: string;
  relevanceFor: (noteId: string) => RelevanceResult | undefined;
  onIndex: (index: number) => void;
  onClose: () => void;
  onOpenFull: (note: Note) => void;
}) {
  const note = notes[Math.max(0, Math.min(index, notes.length - 1))];
  if (!note) return null;
  const content = splitNote(note);
  const relevance = relevanceFor(note.id);
  const focusInBody = focus && content.body && findAnchor(content.body, focus) ? focus : '';
  const matched = focusInBody || (relevance?.matched_text?.trim() ?? '');
  const why = relevance?.explanation.trim() ?? '';
  return <div className="relative flex min-h-0 flex-1 flex-col px-6 pb-8 pt-4 sm:px-12">
    <div className="flex shrink-0 items-center justify-end gap-0.5">
      <button type="button" onClick={() => onOpenFull(note)} aria-label="Open full note" title="Open full note" className="flex h-11 w-11 items-center justify-center rounded-xl text-[#55555B] hover:bg-white"><ExternalLink className="h-[18px] w-[18px]" /></button>
      <button type="button" onClick={onClose} aria-label="Close note" title="Close" className="flex h-11 w-11 items-center justify-center rounded-xl text-[#55555B] hover:bg-white"><X className="h-5 w-5" /></button>
    </div>
    <div className="flex min-h-0 max-w-[644px] flex-1 flex-col gap-[26px] overflow-y-auto pr-3">
      <div className="flex flex-col gap-1.5">
        <span className="flex min-h-[32px] items-center text-sm text-[#6B6B70]">{fullNoteDate(note.created_at)} · {note.shared_by ? `Shared by ${note.shared_by}` : cleanCategory(note.category) || ORPHANS_MUSE}</span>
        <h2 className="text-[30px] font-semibold leading-tight text-[#2B2B2E]">{content.title || 'Untitled note'}</h2>
      </div>
      {content.body && <div className="text-[19px] leading-[1.65] text-[#3A3A40]"><RetrievalMatchedBody text={content.body} matchedText={matched} label={focusInBody ? 'Quoted in your card' : 'Used for retrieval'} /></div>}
      {why && <section aria-label="Why it came back" className="flex flex-col gap-2 rounded-xl border border-[#E2B93B] bg-white px-5 py-[18px]">
        <span className="text-[13px] font-medium text-[#8F6D05]">Why it came back</span>
        <p className="text-base leading-relaxed text-[#2B2B2E]">{why}</p>
      </section>}
      {notes.length > 1 && <div className="flex items-center justify-center gap-2 pb-2">
        <button type="button" onClick={() => onIndex(index - 1)} disabled={index <= 0} aria-label="Previous retrieved note" className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-[#DADADF] bg-white text-[#2B2B2E] disabled:text-[#C4C4C9]"><ChevronLeft className="h-4 w-4" /></button>
        <span className="min-w-[64px] text-center text-sm text-[#55555B]">{index + 1} of {notes.length}</span>
        <button type="button" onClick={() => onIndex(index + 1)} disabled={index >= notes.length - 1} aria-label="Next retrieved note" className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-[#DADADF] bg-white text-[#2B2B2E] disabled:text-[#C4C4C9]"><ChevronRight className="h-4 w-4" /></button>
      </div>}
    </div>
  </div>;
}

// Domains where the person answered "Just logging", so the goal question is not asked again.
function goalPromptDismissedKey(userId: string): string {
  return `ocreda-goal-prompt-dismissed:${userId}`;
}

function readGoalPromptDismissed(userId: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(goalPromptDismissedKey(userId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function dismissGoalPrompt(userId: string, domainTitle: string): void {
  try {
    const next = [...new Set([...readGoalPromptDismissed(userId), domainTitle.toLowerCase()])];
    localStorage.setItem(goalPromptDismissedKey(userId), JSON.stringify(next));
  } catch {
    // Without storage the question just comes back next time.
  }
}

/**
 * For a Domain with no stated goal: the model's guesses at one, answerable in
 * a single tap. The pick becomes the Domain's description, which every later
 * search uses as its goal.
 */
function GoalPrompt({ domainTitle, suggestions, onPick, onDismiss }: {
  domainTitle: string; suggestions: string[]; onPick: (goal: string) => void; onDismiss: () => void;
}) {
  return (
    <section aria-label={`Goal for ${domainTitle}`} className="rounded-xl border border-dashed border-[#d5d9e3] bg-white/60 p-5 text-left">
      <p className="text-sm font-medium text-[#333]">What’s {domainTitle} for?</p>
      <p className="mt-1 text-xs leading-relaxed text-[#888]">Pick one and Ocreda will look for notes that move you toward it.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {suggestions.map((goal) => <button key={goal} type="button" onClick={() => onPick(goal)} className="rounded-full border border-[#c9d8fb] bg-[#f4f7ff] px-3 py-1.5 text-xs text-[#315fc5] hover:border-[#477bea] hover:bg-[#e8efff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]">{goal}</button>)}
        <button type="button" onClick={onDismiss} className="rounded-full border border-[#e0e0e0] px-3 py-1.5 text-xs text-[#777] hover:bg-[#f4f4f4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]">Just logging</button>
      </div>
    </section>
  );
}

/**
 * The tinted annotation under a relevant note, with why-it's-relevant on its
 * front and the note summary on its back. Both faces share one grid cell, so the
 * panel is as tall as the longer of the two and nothing below it jumps when it
 * turns over.
 */
function AnnotationFlip({ summary, relevance, flipped, onFlip }: {
  summary: string; relevance: string; flipped: boolean; onFlip: () => void;
}) {
  // Each face carries its own tint: green explains how the note bears on the
  // draft first; blue restates the note after the reader deliberately flips it.
  const faces = [
    { key: 'relevance', label: 'Why it’s relevant', text: relevance, action: 'Summary', hidden: flipped, back: false, panel: 'bg-[#e4f2e8]', labelColor: 'text-[#6aa37c]', textColor: 'text-[#4a6b55]' },
    { key: 'summary', label: 'Summary', text: summary, action: 'Why it’s relevant', hidden: !flipped, back: true, panel: 'bg-[#f4f7ff]', labelColor: 'text-[#8ba0d8]', textColor: 'text-[#5d6b85]' },
  ];
  return (
    <div className="mt-2.5 [perspective:900px]">
      <div className={`grid transition-transform duration-500 ease-out [transform-style:preserve-3d] motion-reduce:transition-none ${flipped ? '[transform:rotateY(180deg)]' : ''}`}>
        {faces.map((face) => (
          <div
            key={face.key}
            aria-hidden={face.hidden}
            className={`flex flex-col rounded-md px-2.5 py-2 [backface-visibility:hidden] [grid-area:1/1] ${face.panel} ${face.back ? '[transform:rotateY(180deg)]' : ''}`}
          >
            <p className={`text-[9px] font-semibold uppercase tracking-[0.09em] ${face.labelColor}`}>{face.label}</p>
            <p className={`mt-1 flex-1 text-[11px] leading-relaxed ${face.textColor}`}>{face.text}</p>
            <button
              type="button"
              tabIndex={face.hidden ? -1 : 0}
              onClick={(event) => { event.stopPropagation(); onFlip(); }}
              className="mt-1.5 flex items-center gap-1 self-end rounded text-[10px] font-medium text-[#477bea] hover:text-[#2f5fcc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8fb1ff]"
            >
              {face.action} <RefreshCw className="h-2.5 w-2.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * What the relevance panel shows while the readers run. The bar and counts come
 * from real progress events, one per reader as it finishes. The title ticker
 * underneath is a glimpse of the notes being searched, not a claim about which
 * one is being read at this instant — the readers work through them in parallel.
 */
function SearchProgress({ notes, progress }: { notes: Note[]; progress: RelevanceProgress | null }) {
  const titles = useMemo(() => notes.map((note) => splitNote(note).title.trim()).filter(Boolean), [notes]);
  const [tick, setTick] = useState(() => Math.floor(Math.random() * 1000));

  useEffect(() => {
    if (titles.length < 2) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1100);
    return () => window.clearInterval(timer);
  }, [titles.length]);

  const done = progress?.agents_done ?? 0;
  const total = progress?.agents_total ?? 0;
  const matches = progress?.matches ?? 0;
  // A sliver of bar before the first reader finishes, so it reads as started.
  const percent = total ? Math.max(4, Math.round((done / total) * 100)) : 2;
  const title = titles.length ? titles[tick % titles.length] : '';

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-2 text-[#555]">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[#477bea]" />
          {total ? `${done} of ${total} readers done` : 'Searching notes…'}
        </span>
        <span className={matches ? 'font-medium text-[#477bea]' : 'text-[#aaa]'}>
          {matches ? `${matches} ${matches === 1 ? 'match' : 'matches'} so far` : 'No matches yet'}
        </span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-[#eceef3]" role="progressbar" aria-label="Search progress" aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={done}>
        <div className="h-full rounded-full bg-[#477bea] transition-[width] duration-500 ease-out motion-reduce:transition-none" style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-2 truncate text-[11px] text-[#999]" aria-hidden="true">
        Reading {notes.length} {notes.length === 1 ? 'note' : 'notes'}
        {title && <> · <span className="text-[#666]">“{title}”</span></>}
      </p>
    </div>
  );
}

function RelevantNotesPanel({ notes, relevance, loading, progress, error, stale, page, onPageChange, onRetry, onClose }: {
  notes: Note[]; relevance: RelevanceSearch | null; loading: boolean; progress: RelevanceProgress | null; error: string; stale: boolean;
  page: number; onPageChange: (page: number) => void; onRetry: () => void; onClose: () => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Cards whose annotation has been flipped from the summary to "why it's relevant".
  const [flippedById, setFlippedById] = useState<Record<string, boolean>>({});
  const noteById = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes]);

  const results = relevance?.results ?? [];
  const pageCount = Math.max(1, Math.ceil(results.length / RELEVANCE_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = results.slice(currentPage * RELEVANCE_PAGE_SIZE, (currentPage + 1) * RELEVANCE_PAGE_SIZE);
  const coverage = relevance?.coverage;

  // On a narrow screen this is a bottom sheet rather than a full overlay, so the
  // draft stays visible and editable while the search runs — a wait you can keep
  // writing through is not really a wait. From lg up it becomes the side column.
  return (
    <aside className="absolute inset-x-0 bottom-0 z-20 flex max-h-[58%] flex-col rounded-t-xl border-t border-[#e4e4e4] bg-white shadow-[0_-8px_24px_rgba(0,0,0,0.10)] lg:static lg:z-auto lg:max-h-none lg:w-[370px] lg:shrink-0 lg:rounded-none lg:border-l lg:border-t-0 lg:border-[#eee] lg:shadow-none" aria-label="Relevant notes">
      <header className="flex shrink-0 items-center justify-between border-b border-[#eee] px-5 py-3">
        <h2 className="text-sm font-medium text-[#333]">Relevant notes</h2>
        <button type="button" onClick={onClose} aria-label="Close relevant notes" className="rounded p-1 text-[#888] hover:bg-[#f4f4f4]"><X className="h-4 w-4" /></button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          /* Skeletons shaped like the real cards, so the layout is already
             built when results land and nothing jumps. */
          <div>
            <SearchProgress notes={notes} progress={progress} />
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <div key={index} className="animate-pulse rounded-lg border border-[#e4e4e4] bg-[#fafafb] p-3" style={{ animationDelay: `${index * 140}ms` }}>
                  <div className="space-y-1.5">
                    <div className="h-2.5 w-full rounded bg-[#e6e6e9]" />
                    <div className="h-2.5 w-[94%] rounded bg-[#e6e6e9]" />
                    <div className="h-2.5 w-[58%] rounded bg-[#e6e6e9]" />
                  </div>
                  <div className="mt-2.5 rounded-md bg-[#f4f7ff] px-2.5 py-2">
                    <div className="h-1.5 w-20 rounded bg-[#d9e3f8]" />
                    <div className="mt-2 h-2 w-full rounded bg-[#e7edfc]" />
                    <div className="mt-1.5 h-2 w-[72%] rounded bg-[#e7edfc]" />
                  </div>
                  <div className="mt-2.5 flex items-center justify-between">
                    <div className="h-2 w-14 rounded bg-[#ebebed]" />
                    <div className="h-2 w-10 rounded bg-[#ebebed]" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-sm text-red-600">{error}</p>
            <button type="button" onClick={onRetry} className="rounded-md border border-[#ddd] px-3 py-1.5 text-sm hover:bg-[#f6f6f6]">Try again</button>
          </div>
        ) : !relevance ? (
          <p className="px-2 py-12 text-center text-sm leading-relaxed text-[#999]">Click “Find relevant notes” to see what in your library connects to this draft.</p>
        ) : results.length === 0 ? (
          <p className="px-2 py-12 text-center text-sm leading-relaxed text-[#999]">Nothing in your notes connects to this draft yet.</p>
        ) : (
          <div className="space-y-3">
            {currentPage === 0 && relevance.insights?.map((item, index) => <SuggestionCard
              key={index}
              compact
              insight={item}
              kind={baseKindOf(item, item.note_ids.map((id) => results.find((result) => result.note_id === id)?.relation_type).find(Boolean) ?? null)}
              outbound={item.note_ids.every((id) => results.find((result) => result.note_id === id)?.direction === 'outbound')}
              notesById={noteById}
              onOpenSource={(noteId) => {
                const index = results.findIndex((result) => result.note_id === noteId);
                if (index === -1) return;
                onPageChange(Math.floor(index / RELEVANCE_PAGE_SIZE));
                setExpandedId(noteId);
              }}
            />)}
            {visible.map((result) => {
              const note = noteById.get(result.note_id);
              if (!note) return null;
              const content = splitNote(note);
              const badge = relationBadgeFor(result);
              const expanded = expandedId === result.note_id;
              const flipped = Boolean(flippedById[result.note_id]);
              const hasHeading = content.hasTitle;
              return (
                // A div rather than a <button>, because the flip link inside
                // it is itself a button.
                <div key={result.note_id} role="button" tabIndex={0} onClick={() => setExpandedId(expanded ? null : result.note_id)} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setExpandedId(expanded ? null : result.note_id); } }} aria-expanded={expanded} className="block w-full cursor-pointer rounded-lg border border-[#e4e4e4] bg-[#fafafb] p-3 text-left transition hover:border-[#8fb1ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8fb1ff]">
                  {(hasHeading || badge) && <div className="mb-2 flex items-start justify-between gap-2">
                    {hasHeading && <strong className="min-w-0 flex-1 truncate text-sm text-[#222]">{content.title}</strong>}
                    {badge && <span className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}>{badge.label}</span>}
                  </div>}
                  {/* The note's own words lead, and are the largest, darkest
                      text on the card. line-clamp trails them with an ellipsis
                      until it is clicked open. */}
                  <p className={`text-[13px] leading-relaxed text-[#333] ${expanded ? 'max-h-64 overflow-y-auto whitespace-pre-wrap' : 'line-clamp-3'}`}>
                    {expanded ? (content.body || note.raw_text) : notePreview(note)}
                  </p>
                  {/* Set on its own tinted panel, smaller and cooler in tone, so
                      it reads as annotation about the note rather than more of
                      the note. */}
                  {result.gist ? (
                    <AnnotationFlip
                      summary={result.gist}
                      relevance={result.explanation}
                      flipped={flipped}
                      onFlip={() => setFlippedById((current) => ({ ...current, [result.note_id]: !flipped }))}
                    />
                  ) : result.explanation ? (
                    <div className="mt-2.5 rounded-md bg-[#f4f7ff] px-2.5 py-2">
                      <p className="text-[9px] font-semibold uppercase tracking-[0.09em] text-[#8ba0d8]">Why it’s relevant</p>
                      <p className="mt-1 text-[11px] leading-relaxed text-[#5d6b85]">{result.explanation}</p>
                    </div>
                  ) : null}
                  <div className="mt-2.5 flex items-center justify-between text-[11px] text-[#aaa]">
                    <span>{result.level ? `Level ${result.level} of 5` : `${Math.round(result.relevance_score * 100)}% ${result.explanation ? 'match' : 'similarity'}`}</span>
                    <span>{formatDate(note.created_at)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Only render the footer when it has something to say, otherwise it
          shows as an empty bordered strip under the results. */}
      {!loading && !error && relevance && (stale || coverage?.complete === false || results.length > RELEVANCE_PAGE_SIZE) && <footer className="shrink-0 space-y-2 border-t border-[#eee] px-4 py-3">
        {stale && <p className="text-[11px] leading-relaxed text-[#a06a00]">Your new note changed since this search. Run it again to refresh.</p>}
        {coverage && !coverage.complete && <p className="text-[11px] leading-relaxed text-[#a06a00]">Searched {coverage.notes_searched} of {coverage.notes_total} notes — the rest couldn’t be read. <button type="button" onClick={onRetry} className="underline">Search again</button></p>}
        {results.length > RELEVANCE_PAGE_SIZE && <div className="flex items-center justify-between">
          <button type="button" onClick={() => onPageChange(currentPage - 1)} disabled={currentPage === 0} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[#555] hover:bg-[#f4f4f4] disabled:opacity-35"><ChevronLeft className="h-3.5 w-3.5" /> Previous</button>
          <span className="text-[11px] text-[#999]">{currentPage + 1} / {pageCount}</span>
          <button type="button" onClick={() => onPageChange(currentPage + 1)} disabled={currentPage >= pageCount - 1} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[#555] hover:bg-[#f4f4f4] disabled:opacity-35">Next <ChevronRight className="h-3.5 w-3.5" /></button>
        </div>}
      </footer>}
    </aside>
  );
}

function NoteEditor({ state, muses, notes, saving, error, onChange, onCreateMuse, onClose, onSave, onFindRelevantNotes, onImport, onDelete }: {
  state: NoteEditorState; muses: MuseMeta[]; notes: Note[]; saving: boolean; error: string;
  onChange: (state: NoteEditorState) => void; onCreateMuse: (title: string) => void;
  onClose: () => void; onSave: () => void; onFindRelevantNotes: () => void; onImport: () => void; onDelete?: () => void;
}) {
  const bodyRef = useRef<NoteBodyEditorHandle>(null);
  const [activeFormats, setActiveFormats] = useState<NoteFormat[]>([]);
  const speechRef = useRef<SpeechRecognitionLike | null>(null);
  const museMenuRef = useRef<HTMLDivElement>(null);
  const [dictating, setDictating] = useState(false);
  const [museOpen, setMuseOpen] = useState(false);
  const [newMuse, setNewMuse] = useState('');
  const [editingStarted, setEditingStarted] = useState(Boolean(state.note || state.title || state.body));
  const [panelOpen, setPanelOpen] = useState(false);
  const [relevance, setRelevance] = useState<RelevanceSearch | null>(null);
  const [relevanceLoading, setRelevanceLoading] = useState(false);
  const [relevanceProgress, setRelevanceProgress] = useState<RelevanceProgress | null>(null);
  const [relevanceError, setRelevanceError] = useState('');
  const [relevancePage, setRelevancePage] = useState(0);
  const [searchedDraft, setSearchedDraft] = useState('');
  // Repeat clicks on an unchanged draft are served from here rather than
  // costing another ten model calls.
  const relevanceCache = useRef(new Map<string, RelevanceSearch>());
  // Closing the editor hangs up on a search still running, so its remaining model calls are never made.
  const searchCancelRef = useRef<AbortController | null>(null);
  useEffect(() => () => searchCancelRef.current?.abort(), []);

  // Matches how saveNote assembles raw_text, so the draft is scored as the
  // note it will actually become.
  const draftText = useMemo(() => {
    const title = state.title.trim(); const body = state.body.trim();
    return title && body ? `${title}\n\n${body}` : title || body;
  }, [state.body, state.title]);

  const draftTooShort = draftText.length < MIN_RELEVANCE_DRAFT_CHARS;
  const domainRequired = cleanCategory(state.muse)?.toLowerCase() === ORPHANS_MUSE.toLowerCase();
  const draftChangedSinceSearch = Boolean(relevance) && searchedDraft !== draftText;
  const domainCapture = state.context === 'domain';

  useEffect(() => {
    if (!museOpen || !domainCapture) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMuseOpen(false); };
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!museMenuRef.current?.contains(event.target as Node)) setMuseOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('mousedown', closeOnOutsideClick);
    };
  }, [domainCapture, museOpen]);

  const runRelevanceSearch = async () => {
    if (domainRequired) {
      setPanelOpen(true);
      setRelevanceError('Choose a Domain before finding related notes.');
      return;
    }
    if (draftTooShort || relevanceLoading) return;
    setPanelOpen(true); setRelevanceError(''); setRelevancePage(0);

    const domain = domainGoalFor(state.muse, muses);
    const cacheKey = `${getAiMode()}\n${domain?.name ?? ''}\n${domain?.goal ?? ''}\n${draftText}`;
    const cached = relevanceCache.current.get(cacheKey);
    if (cached) { setRelevance(cached); setSearchedDraft(draftText); return; }

    setRelevanceProgress(null); setRelevanceLoading(true);
    const cancel = new AbortController();
    searchCancelRef.current = cancel;
    try {
      const response = await findRelevantNotes(draftText, state.note?.id ?? null, setRelevanceProgress, domain, cancel.signal);
      relevanceCache.current.set(cacheKey, response);
      setRelevance(response); setSearchedDraft(draftText);
    } catch (err) {
      if (cancel.signal.aborted) return;
      setRelevance(null);
      setRelevanceError(safeErrorMessage(err, 'Could not search your notes right now.'));
    } finally {
      if (!cancel.signal.aborted) setRelevanceLoading(false);
    }
  };

  const applyFormat = (kind: NoteFormat) => bodyRef.current?.format(kind);

  const toggleDictation = () => {
    if (speechRef.current && dictating) { speechRef.current.stop(); return; }
    const speechWindow = window as typeof window & { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
    const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Recognition) return;
    const recognition = new Recognition();
    recognition.lang = 'en-US'; recognition.continuous = true; recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results).map((result) => result[0].transcript).join(' ').trim();
      if (transcript) onChange({ ...state, body: `${state.body}${state.body ? ' ' : ''}${transcript}` });
    };
    recognition.onerror = () => setDictating(false); recognition.onend = () => setDictating(false);
    speechRef.current = recognition; setDictating(true); recognition.start();
  };

  const museLabel = cleanCategory(state.muse) ?? ORPHANS_MUSE;
  const relevanceTitle = domainRequired
    ? 'Choose a Domain before finding related notes'
    : draftTooShort
      ? `Write at least ${MIN_RELEVANCE_DRAFT_CHARS} characters to search your notes`
      : 'Find relevant notes';
  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center ${domainCapture ? 'bg-[#e5e5e5] p-3 sm:p-6' : 'bg-black/25 p-4 backdrop-blur-[5px]'}`} role="dialog" aria-modal="true" aria-label={state.note ? 'Edit note' : 'Create note'} onMouseDown={(event) => { if (!domainCapture && event.target === event.currentTarget && !saving) onClose(); }}>
      {!domainCapture && <button type="button" onClick={onClose} aria-label="Close note editor" className="absolute right-5 top-5 z-10 text-white drop-shadow sm:right-8 sm:top-7"><X className="h-7 w-7" /></button>}
      <div className={`flex min-h-[530px] flex-col bg-white ${domainCapture ? 'h-full w-full overflow-hidden shadow-[0_8px_24px_rgba(0,0,0,0.12)]' : 'h-[min(78vh,780px)] w-[min(88vw,1340px)] overflow-visible rounded-[20px] border-[9px] border-[#f5f5f7] shadow-2xl'}`}>
        {domainCapture && <header className="relative z-30 grid shrink-0 grid-cols-[1fr_auto] grid-rows-[64px_44px] items-center border-b border-[#eeeeef] bg-white px-2 text-[#aaa] sm:flex sm:h-16 sm:px-6">
          <div className="flex min-w-0 items-center gap-1 sm:gap-2">
            <button type="button" onClick={onClose} aria-label="Close note editor" title="Close note editor" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-[#f5f5f6] hover:text-[#555]"><ArrowLeft className="h-5 w-5" /></button>
            <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-md bg-[#477bea] text-white"><Plus className="h-4 w-4" /></span>
            <button type="button" onClick={onImport} aria-label="Import notes" title="Import notes" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-[#f5f5f6] hover:text-[#555]"><Upload className="h-5 w-5" /></button>
            <button type="button" onClick={onFindRelevantNotes} disabled={domainRequired || draftTooShort || saving} aria-label="Find relevant notes" title={relevanceTitle} className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-[#f5f5f6] hover:text-[#477bea] disabled:opacity-35">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-5 w-5" />}</button>
          </div>
          <div ref={museMenuRef} className="relative col-span-2 row-start-2 z-40 max-w-full justify-self-center sm:absolute sm:left-1/2 sm:-translate-x-1/2">
            <button type="button" onClick={() => setMuseOpen((value) => !value)} aria-expanded={museOpen} className="flex max-w-[calc(100vw-3rem)] items-center rounded px-2 py-1 text-xs text-[#555] hover:bg-[#f5f5f6] sm:max-w-[40vw]"><span className="shrink-0">Domain:&nbsp;</span><span className="truncate border-b border-[#999]">{museLabel}</span><ChevronDown className="ml-1 h-3.5 w-3.5 shrink-0" /></button>
            {museOpen && <div className="absolute left-1/2 top-8 z-50 w-[285px] -translate-x-1/2 overflow-hidden rounded-lg border border-[#ddd] bg-white py-2 text-left text-[#555] shadow-xl">
              {muses.map((muse) => <button key={muse.title} type="button" onClick={() => { onChange({ ...state, muse: muse.title }); setMuseOpen(false); }} className="flex w-full items-center justify-between px-5 py-3 text-left text-sm hover:bg-[#f6f6f6] focus:bg-[#f6f6f6] focus:outline-none">{muse.title} {state.muse === muse.title && <Check className="h-4 w-4 text-[#477bea]" />}</button>)}
            </div>}
          </div>
          <div className="flex items-center gap-1 justify-self-end text-xs sm:ml-auto">
            <ChevronLeft className="h-4 w-4 opacity-40" /><span className="min-w-[54px] text-center">{formatDate(new Date().toISOString())}</span><ChevronRight className="h-4 w-4 opacity-40" />
            <MoreHorizontal className="ml-3 h-5 w-5 text-[#555]" />
          </div>
        </header>}
        <div className="relative flex min-h-0 flex-1">
          <div className={`flex min-h-0 min-w-0 flex-1 flex-col ${domainCapture ? 'items-center px-8 pb-8 pt-[10vh]' : 'px-8 pb-5 pt-10 sm:px-16 sm:pt-12'}`}>
            <input value={state.title} onFocus={() => setEditingStarted(true)} onChange={(event) => onChange({ ...state, title: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); setEditingStarted(true); bodyRef.current?.focus(); } }} placeholder={domainCapture ? 'Title' : 'What’s on your mind?'} aria-label="Note title" className={`w-full shrink-0 bg-transparent outline-none placeholder:text-[#555] ${domainCapture ? 'max-w-2xl text-xl font-semibold sm:text-2xl' : 'text-xl font-medium italic sm:text-2xl'}`} />
            <NoteBodyEditor ref={bodyRef} value={state.body} onFocus={() => setEditingStarted(true)} onChange={(body) => onChange({ ...state, body })} placeholder={editingStarted ? '' : domainCapture ? 'Knowledge is what makes people special, and special people do special things, so make this one count.' : "For example: Someone made the point that we mostly don't choose our beliefs, we absorb them and backfill reasons after. Uncomfortable but I can't argue with it. Makes me wonder how much of what I think is actually mine."} ariaLabel="Note body" onActiveFormatsChange={setActiveFormats} wrapperClassName={`mt-5 min-h-0 w-full flex-1 overflow-y-auto ${domainCapture ? 'max-w-2xl' : ''}`} className={`min-h-full w-full bg-transparent text-base leading-relaxed ${domainCapture ? 'sm:text-lg sm:leading-[1.65]' : ''}`} />
          </div>
          {panelOpen && <RelevantNotesPanel notes={notes} relevance={relevance} loading={relevanceLoading} progress={relevanceProgress} error={relevanceError} stale={draftChangedSinceSearch} page={relevancePage} onPageChange={setRelevancePage} onRetry={() => void runRelevanceSearch()} onClose={() => setPanelOpen(false)} />}
        </div>
        <div className={`relative border-t border-[#eee] bg-[#f8f8fa] px-3 py-2 text-sm text-[#555] sm:px-5 ${domainCapture ? 'flex min-h-[62px] flex-col items-stretch gap-2 lg:flex-row lg:items-center lg:gap-1' : 'flex min-h-[58px] flex-wrap items-center gap-1'}`}>
          <div className={`${domainCapture ? 'flex w-full min-w-0 items-center gap-1 overflow-x-auto pb-1 lg:flex-1 lg:overflow-visible lg:pb-0' : 'contents'}`}>
            <button type="button" onClick={toggleDictation} aria-label={dictating ? 'Stop dictation' : 'Start dictation'} className={`mr-3 rounded p-2 hover:bg-white ${dictating ? 'text-red-600' : ''}`}><Mic className="h-4 w-4" /></button><span className="mr-3 h-7 w-px bg-[#ddd]" />
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('bold')} aria-pressed={activeFormats.includes('bold')} aria-label="Bold" className={`rounded p-2 font-bold hover:bg-white ${activeFormats.includes('bold') ? 'bg-white text-[#477bea] shadow-sm' : ''}`}><Bold className="h-4 w-4" /></button>
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('italic')} aria-pressed={activeFormats.includes('italic')} aria-label="Italic" className={`rounded p-2 italic hover:bg-white ${activeFormats.includes('italic') ? 'bg-white text-[#477bea] shadow-sm' : ''}`}><Italic className="h-4 w-4" /></button><span className="mx-2 h-7 w-px bg-[#ddd]" />
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('h1')} className="rounded px-2 py-1.5 font-semibold hover:bg-white">H1</button><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('h2')} className="rounded px-2 py-1.5 font-semibold hover:bg-white">H2</button><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('h3')} className="rounded px-2 py-1.5 font-semibold hover:bg-white">H3</button><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('body')} className="rounded px-2 py-1.5 hover:bg-white">Body</button><span className="mx-2 hidden h-7 w-px bg-[#ddd] lg:block" />
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('bullet')} className="hidden items-center gap-1 rounded px-2 py-1.5 hover:bg-white sm:flex"><List className="h-4 w-4" /> Bullet list</button><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('number')} className="hidden items-center gap-1 rounded px-2 py-1.5 hover:bg-white md:flex"><ListOrdered className="h-4 w-4" /> Numbered list</button>
            <span className="mx-2 h-7 w-px bg-[#ddd]" />
          </div>
          <div className={`${domainCapture ? 'flex w-full items-center gap-2 lg:w-auto lg:gap-1' : 'contents'}`}>
            <button type="button" onClick={onFindRelevantNotes} disabled={domainRequired || draftTooShort || saving} title={relevanceTitle} className="flex items-center gap-1.5 rounded px-2 py-1.5 font-medium text-[#477bea] hover:bg-white disabled:opacity-40">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}
              <span className="hidden lg:inline">Find relevant notes</span>
            </button>
          {!domainCapture && <div className="relative ml-auto shrink-0">
            <button type="button" onClick={() => setMuseOpen((value) => !value)} className="flex items-center text-sm"><span className="text-[#477bea]">Domain:</span>&nbsp;<span className="border-b border-[#999]">{museLabel}</span><ChevronDown className="ml-1 h-3.5 w-3.5" /></button>
            {museOpen && <div className="absolute bottom-9 right-0 z-[60] w-[285px] overflow-hidden rounded-lg border border-[#ddd] bg-white py-2 shadow-xl">
              {muses.map((muse) => <button key={muse.title} type="button" onClick={() => { onChange({ ...state, muse: muse.title }); setMuseOpen(false); }} className="flex w-full items-center justify-between px-5 py-3 text-left text-sm hover:bg-[#f6f6f6]">{muse.title} {state.muse === muse.title && <Check className="h-4 w-4 text-[#477bea]" />}</button>)}
              <div className="flex items-center gap-2 border-t border-[#eee] px-4 py-2">
                <Plus className="h-4 w-4 shrink-0 text-[#777]" />
                <input value={newMuse} onChange={(event) => setNewMuse(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && newMuse.trim()) { event.preventDefault(); onCreateMuse(newMuse); setNewMuse(''); setMuseOpen(false); } }} placeholder="New Domain" className="min-w-0 flex-1 py-1 text-sm outline-none" />
                <button type="button" disabled={!newMuse.trim()} onClick={() => { onCreateMuse(newMuse); setNewMuse(''); setMuseOpen(false); }} aria-label="Create Domain" className="rounded bg-[#477bea] p-1 text-white disabled:opacity-35"><Check className="h-3.5 w-3.5" /></button>
              </div>
            </div>}
          </div>}
          {onDelete && <button type="button" onClick={onDelete} disabled={saving} aria-label="Delete note" className="ml-3 rounded p-2 text-red-600 hover:bg-red-50"><Trash2 className="h-4 w-4" /></button>}
          <button type="button" onClick={onSave} disabled={saving || (!state.title.trim() && !state.body.trim())} className={`ml-3 flex shrink-0 items-center justify-center rounded-md bg-[#477bea] text-white hover:bg-[#3d6ed7] disabled:opacity-45 ${domainCapture ? 'h-10 flex-1 lg:w-44 lg:flex-none' : 'h-8 w-32 sm:w-40'}`}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}</button>
          </div>
          {error && <p role="alert" className="absolute bottom-full right-0 mb-2 max-w-[420px] rounded-md bg-red-600 px-3 py-2 text-xs text-white">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function MuseEditor({ state, saving, error, onChange, onClose, onSave }: {
  state: MuseEditorState; saving: boolean; error: string; onChange: (state: MuseEditorState) => void; onClose: () => void; onSave: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[6px]" role="dialog" aria-modal="true" aria-label={state.originalTitle ? 'Edit Domain' : 'Create Domain'} onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <div className="relative w-[min(92vw,570px)]">
        <button type="button" onClick={onClose} aria-label="Close Domain editor" className="absolute right-2 top-2 z-10 text-[#777] sm:-right-10 sm:-top-8 sm:text-white"><X className="h-7 w-7" /></button>
        <div className="rounded-xl border-[9px] border-[#f4f4f6] bg-white px-6 py-7 shadow-2xl sm:px-8">
          <h2 className="text-xl font-semibold text-[#222]">{state.originalTitle ? 'Edit Domain' : 'Create a Domain'}</h2>
          <p className="mt-1 text-sm leading-relaxed text-[#777]">Give it one clear goal. Ocreda uses that goal to decide which notes can help.</p>
          <label htmlFor="muse-title" className="mt-7 block text-sm font-medium text-[#333]">Domain name</label>
          <input autoFocus id="muse-title" maxLength={80} required value={state.title} onChange={(event) => onChange({ ...state, title: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); document.getElementById('muse-description')?.focus(); } }} placeholder="e.g. Launch Ocreda" aria-label="Domain title" className="mt-2 w-full rounded-lg border border-[#d9dce3] bg-[#fafafb] px-4 py-3 text-base font-medium text-[#333] outline-none placeholder:font-normal placeholder:text-[#aaa] focus:border-[#477bea] focus:ring-2 focus:ring-[#477bea]/15" />
          <label htmlFor="muse-description" className="mt-6 block text-sm font-medium text-[#333]">What is the clear goal of this Domain?</label>
          <textarea id="muse-description" maxLength={600} required value={state.description} onChange={(event) => onChange({ ...state, description: event.target.value })} placeholder="e.g. Get the first 10 paying users and learn why they stay." aria-label="Domain goal" className="mt-2 h-[190px] w-full resize-none rounded-lg border border-[#d9dce3] bg-[#fafafb] p-4 text-base leading-relaxed text-[#555] outline-none placeholder:text-[#aaa] focus:border-[#477bea] focus:ring-2 focus:ring-[#477bea]/15" />
        </div>
        <button type="button" onClick={onSave} disabled={saving || !state.title.trim() || !state.description.trim()} className="mx-auto mt-6 flex h-10 w-[190px] max-w-[80vw] items-center justify-center rounded-md bg-[#477bea] text-white hover:bg-[#3d6ed7] disabled:cursor-not-allowed disabled:opacity-45">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save Domain'}</button>
        {error && <p role="alert" className="mt-3 text-center text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}

function ProjectEditor({ state, error, onChange, onClose, onSave }: {
  state: ProjectEditorState; error: string; onChange: (state: ProjectEditorState) => void; onClose: () => void; onSave: () => void;
}) {
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[6px]" role="dialog" aria-modal="true" aria-label={state.project ? 'Edit project' : 'Create project'} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="relative w-[min(92vw,570px)] rounded-xl border-[8px] border-[#f4f4f6] bg-white p-6 shadow-2xl">
        <button type="button" onClick={onClose} aria-label="Close project editor" className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-md text-[#777] hover:bg-[#f4f4f4]"><X className="h-5 w-5" /></button>
        <h2 className="mb-7 text-sm font-normal text-[#999]">{state.project ? 'Edit project' : 'New project'}</h2>
        <input autoFocus maxLength={80} value={state.title} onChange={(event) => onChange({ ...state, title: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); descriptionRef.current?.focus(); } }} placeholder="Project title" aria-label="Project title" className="w-full border-b border-[#ddd] bg-transparent px-1 pb-3 text-2xl font-semibold text-[#333] outline-none focus:border-[#477bea]" />
        <textarea ref={descriptionRef} maxLength={500} value={state.description} onChange={(event) => onChange({ ...state, description: event.target.value })} placeholder="What will you explore or write about in this project?" aria-label="Project description" className="mt-7 h-44 w-full resize-none rounded-md bg-[#f7f7f9] p-5 text-sm leading-relaxed text-[#555] outline-none placeholder:text-[#aaa] focus:ring-2 focus:ring-[#477bea]/20" />
        {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
        <button type="button" onClick={onSave} disabled={!state.title.trim()} className="ml-auto mt-6 flex h-9 w-32 items-center justify-center rounded-md bg-[#477bea] text-sm text-white hover:bg-[#3d6ed7] disabled:opacity-40">Save</button>
      </div>
    </div>
  );
}

function SavedConfirmation() {
  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/25 backdrop-blur-[5px]" role="status" aria-live="polite"><div className="flex h-[260px] w-[min(88vw,680px)] items-center justify-center rounded-lg bg-[#477bea] text-xl text-white shadow-2xl sm:text-2xl">Saved to you for you</div></div>;
}
