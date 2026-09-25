'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Bold, Check, ChevronDown, ChevronLeft, ChevronRight, Filter, FolderPlus, Grid2X2, Italic, Layers3, List, ListOrdered, Loader as Loader2, Mic, MoreHorizontal, PanelRightOpen, Pin, Plus, RefreshCw, Rows3, ScanSearch, Search, Trash2, Upload, X } from 'lucide-react';
import type { RelevanceProgress } from '@/lib/types';
import NoteImporter, { ImportDomainDraft, ImportNoteDraft } from '@/components/NoteImporter';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useAuth } from '@/lib/auth-context';
import { createNote, deleteNote, findRelevantNotes, findSimilarNotes, getNotes, importNotes, MIN_RELEVANCE_DRAFT_CHARS, moveNotesToCategory, processNote, updateNote } from '@/lib/notes-api';
import { supabase } from '@/lib/supabase';
import { prepareImportedNoteText } from '@/lib/import-note-content';
import { IS_LOCAL_MODE } from '@/dev/local-mode';  // DEV-LOCAL-MODE
import { Note, NoteRelationType, RelevanceCoverage, RelevanceResult } from '@/lib/types';

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

const AUTOMATIC_MUSE = '__automatic__';
const ORPHANS_MUSE = 'Orphans';
const ORPHANS_DESCRIPTION = 'Imported notes that did not match another Domain.';
const ORPHANS_MIGRATION_VERSION = 'v1';

function cleanCategory(value: string | null | undefined): string | null {
  const clean = value?.trim().replace(/\s+/g, ' ') ?? '';
  return clean || null;
}

/**
 * Existing notes keep the app's original storage convention: line one is the
 * title and all later lines are the body. Title generation for titleless files
 * happens only in the import path, before a new note is inserted.
 */
function splitNote(note: Note): { title: string; body: string; hasTitle: boolean } {
  const text = note.raw_text.trim();
  if (!text) return { title: '', body: '', hasTitle: false };
  const [first, ...rest] = text.split('\n');
  const heading = first.trim();
  const body = rest.join('\n').trim();
  return { title: heading, body, hasTitle: Boolean(heading) };
}

/** A one-line label for a note in lists and menus, where something must show. */
function noteLabel(note: Note): string {
  const { title, hasTitle } = splitNote(note);
  if (hasTitle) return title;
  const preview = notePreview(note);
  return preview.length > 60 ? `${preview.slice(0, 60).trimEnd()}...` : preview || 'Untitled note';
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
const SAVED_RETRIEVAL_VERSION = 'v2';

function savedRetrievalKey(userId: string, noteId: string): string {
  return `ocreda-saved-retrieval:${SAVED_RETRIEVAL_VERSION}:${userId}:${noteId}`;
}

function noteSignature(note: Note): string {
  return `${note.raw_text.length}:${stableHash(note.raw_text)}`;
}

function readSavedRetrieval(userId: string, note: Note): { mode: 'similar' | 'relevant'; search: RelevanceSearch } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(savedRetrievalKey(userId, note.id)) ?? 'null') as {
      signature?: string; mode?: string; search?: RelevanceSearch;
    } | null;
    if (saved?.signature !== noteSignature(note) || !Array.isArray(saved.search?.results) || !saved.search?.coverage) return null;
    if (!saved.search.results.every((result) => result && typeof result.note_id === 'string' && typeof result.gist === 'string')) return null;
    if (saved.search.summary !== undefined && typeof saved.search.summary !== 'string') return null;
    if (saved.mode !== 'similar' && saved.mode !== 'relevant') return null;
    // Older similarity-only responses have empty explanations. Do not reuse
    // them in the annotated reading view, where every card needs a reason.
    if (saved.mode === 'relevant' && !saved.search.results.every((result) => typeof result.explanation === 'string' && result.explanation.trim())) return null;
    return { mode: saved.mode, search: saved.search };
  } catch {
    return null;
  }
}

function persistSavedRetrieval(userId: string, note: Note, mode: 'similar' | 'relevant', search: RelevanceSearch): void {
  try {
    localStorage.setItem(savedRetrievalKey(userId, note.id), JSON.stringify({ signature: noteSignature(note), mode, search }));
  } catch {
    // A full or disabled browser store should not prevent the note itself from being saved.
  }
}

function safeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return fallback;
}

function readMuseAssignments(userId: string): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(`ocreda-note-muses:${userId}`) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

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

function inferMuse(text: string, muses: MuseMeta[]): string | null {
  if (!muses.length) return null;
  const ignored = new Set(['this', 'that', 'with', 'from', 'have', 'will', 'your', 'about', 'into', 'were', 'when']);
  const words = new Set((text.toLowerCase().match(/[a-z0-9']{3,}/g) ?? []).filter((word) => !ignored.has(word)));
  const ranked = muses.map((muse) => {
    const titleWords = muse.title.toLowerCase().match(/[a-z0-9']{3,}/g) ?? [];
    const descriptionWords = muse.description.toLowerCase().match(/[a-z0-9']{3,}/g) ?? [];
    const score = titleWords.reduce((sum, word) => sum + (words.has(word) ? 3 : 0), 0) + descriptionWords.reduce((sum, word) => sum + (words.has(word) ? 1 : 0), 0);
    return { title: muse.title, score };
  });
  const best = ranked.sort((a, b) => b.score - a.score)[0];
  return best && best.score > 0 ? best.title : null;
}

function OcredaMark({ className = '' }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/ocreda-logo.png" alt="" aria-hidden="true" className={`object-contain ${className}`} />;
}

export default function OcredaHome() {
  const { user } = useAuth();
  const [notes, setNotes] = useState<Note[]>([]);
  const [museMeta, setMuseMeta] = useState<MuseMeta[]>([]);
  const [pinnedMuseTitles, setPinnedMuseTitles] = useState<string[]>([]);
  const [projects, setProjects] = useState<CortexProject[]>([]);
  const [view, setView] = useState<'cortex' | 'muses'>('cortex');
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState('');
  const [noteEditor, setNoteEditor] = useState<NoteEditorState | null>(null);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [activeNoteRetrievalMode, setActiveNoteRetrievalMode] = useState<'similar' | 'relevant'>('relevant');
  const [museEditor, setMuseEditor] = useState<MuseEditorState | null>(null);
  const [projectEditor, setProjectEditor] = useState<ProjectEditorState | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [activeMuse, setActiveMuse] = useState<string | null>(null);
  const [showUnsorted, setShowUnsorted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [error, setError] = useState('');
  const [importError, setImportError] = useState('');
  const [importProgress, setImportProgress] = useState<{ completed: number; total: number } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const orphanMigrationStartedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const loaded = await getNotes();
      const localMuses = user ? readMuseAssignments(user.id) : {};
      setNotes(loaded.map((note) => localMuses[note.id] ? { ...note, category: localMuses[note.id] } : note));
    }
    catch (err) { setError(safeErrorMessage(err, 'Unable to load your notes.')); }
    finally { setLoading(false); }
  }, [user]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!user) return;
    const museKey = `ocreda-muses:${user.id}`;
    const projectKey = `ocreda-projects:${user.id}`;
    const legacy = readStoredList<MuseMeta>(`ocreda-cortexes:${user.id}`).filter((item) => item && typeof item.title === 'string');
    const storedMuses = readStoredList<MuseMeta>(museKey).filter((item) => item && typeof item.title === 'string');
    const nextMuses = storedMuses.length ? storedMuses : legacy;
    setMuseMeta(nextMuses);
    setPinnedMuseTitles([...new Set(readStoredList<string>(`ocreda-pinned-muses:${user.id}`).filter((title): title is string => typeof title === 'string'))].slice(0, 3));
    if (!storedMuses.length && legacy.length) localStorage.setItem(museKey, JSON.stringify(legacy));

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
    }
    if (IS_LOCAL_MODE) {  // DEV-LOCAL-MODE
      setDisplayName('you');
    } else {
      supabase.from('user_settings').select('full_name').eq('user_id', user.id).maybeSingle().then(({ data }) => {
        const authName = String(user.user_metadata?.full_name ?? user.user_metadata?.name ?? '').trim();
        setDisplayName(data?.full_name?.trim() || authName || user.email?.split('@')[0] || 'you');
      });
    }
  }, [user]);

  const persistMuseMeta = useCallback((next: MuseMeta[]) => {
    setMuseMeta(next);
    if (user) localStorage.setItem(`ocreda-muses:${user.id}`, JSON.stringify(next));
  }, [user]);

  const persistPinnedMuses = useCallback((next: string[]) => {
    setPinnedMuseTitles(next);
    if (user) localStorage.setItem(`ocreda-pinned-muses:${user.id}`, JSON.stringify(next));
  }, [user]);

  const togglePinnedMuse = (title: string) => {
    const validPinned = pinnedMuseTitles.filter((pinned) => muses.some((muse) => muse.title.toLowerCase() === pinned.toLowerCase()));
    const exists = validPinned.some((pinned) => pinned.toLowerCase() === title.toLowerCase());
    if (!exists && validPinned.length >= 3) {
      setError('You can pin up to 3 Domains. Unpin one before adding another.');
      return;
    }
    persistPinnedMuses(exists ? validPinned.filter((pinned) => pinned.toLowerCase() !== title.toLowerCase()) : [...validPinned, title]);
    setError('');
  };

  const persistProjects = useCallback((next: CortexProject[]) => {
    setProjects(next);
    if (user) localStorage.setItem(`ocreda-projects:${user.id}`, JSON.stringify(next));
  }, [user]);

  const persistMuseAssignments = useCallback((noteIds: string[], category: string | null) => {
    if (!user || !noteIds.length) return;
    const assignments = readMuseAssignments(user.id);
    noteIds.forEach((noteId) => {
      if (category) assignments[noteId] = category;
      else delete assignments[noteId];
    });
    localStorage.setItem(`ocreda-note-muses:${user.id}`, JSON.stringify(assignments));
    setNotes((current) => current.map((note) => noteIds.includes(note.id) ? { ...note, category, category_updated_at: new Date().toISOString() } : note));
  }, [user]);

  useEffect(() => {
    if (!user || loading || orphanMigrationStartedRef.current) return;
    const migrationKey = `ocreda-orphans-migration:${ORPHANS_MIGRATION_VERSION}:${user.id}`;
    if (localStorage.getItem(migrationKey) === 'complete') return;

    orphanMigrationStartedRef.current = true;
    const uncategorizedIds = notes.filter((note) => !cleanCategory(note.category)).map((note) => note.id);
    const existingOrphans = museMeta.find((muse) => muse.title.toLowerCase() === ORPHANS_MUSE.toLowerCase());
    if (!existingOrphans) {
      persistMuseMeta([
        ...museMeta,
        { title: ORPHANS_MUSE, description: ORPHANS_DESCRIPTION, createdAt: new Date().toISOString() },
      ]);
    }

    const migrate = async () => {
      try {
        if (uncategorizedIds.length) {
          await moveNotesToCategory(uncategorizedIds, ORPHANS_MUSE);
          persistMuseAssignments(uncategorizedIds, ORPHANS_MUSE);
        }
        localStorage.setItem(migrationKey, 'complete');
      } catch (err) {
        orphanMigrationStartedRef.current = false;
        setError(safeErrorMessage(err, 'Unable to move existing uncategorized notes to Orphans.'));
      }
    };
    void migrate();
  }, [loading, museMeta, notes, persistMuseAssignments, persistMuseMeta, user]);

  const muses = useMemo(() => {
    const map = new Map<string, MuseMeta>();
    museMeta.forEach((item) => { const title = cleanCategory(item.title); if (title) map.set(title.toLowerCase(), { ...item, title }); });
    notes.forEach((note) => {
      const title = cleanCategory(note.category);
      if (title && !map.has(title.toLowerCase())) map.set(title.toLowerCase(), { title, description: '', createdAt: note.created_at });
    });
    return Array.from(map.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [museMeta, notes]);

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

  const unsortedNotes = useMemo(() => notes.filter((note) => !cleanCategory(note.category)), [notes]);
  const isEmpty = !loading && notes.length === 0 && muses.length === 0;
  const flashSaved = () => { setSavedOpen(true); window.setTimeout(() => setSavedOpen(false), 1350); };
  const closeLibrary = useCallback(() => { setActiveMuse(null); setShowUnsorted(false); setView('cortex'); }, []);
  const openMuse = useCallback((title: string) => {
    setActiveMuse(title);
    setShowUnsorted(false);
    setView('muses');
  }, []);
  const openNewNote = (muse = AUTOMATIC_MUSE) => { setError(''); setNoteEditor({ note: null, title: '', body: '', muse, context: 'domain' }); };
  const openExistingNote = (note: Note) => { setError(''); setActiveNoteRetrievalMode('relevant'); setActiveNoteId(note.id); };
  const createMuseFromEditor = (value: string) => {
    const requested = cleanCategory(value);
    if (!requested) return;
    const existing = muses.find((item) => item.title.toLowerCase() === requested.toLowerCase());
    const title = existing?.title ?? requested;
    if (!existing) persistMuseMeta([...museMeta, { title, description: '', createdAt: new Date().toISOString() }]);
    setNoteEditor((current) => current ? { ...current, muse: title } : current);
  };

  const saveNote = async (findRelevant = false) => {
    if (!noteEditor) return;
    const title = noteEditor.title.trim(); const body = noteEditor.body.trim();
    if (!title && !body) { setError('Write something before saving.'); return; }
    const rawText = title && body ? `${title}\n\n${body}` : title || body;
    const category = noteEditor.muse === AUTOMATIC_MUSE ? inferMuse(rawText, muses) : cleanCategory(noteEditor.muse);
    setSaving(true); setError('');
    try {
      let savedNoteId: string;
      if (noteEditor.note) {
        const updated = await updateNote(noteEditor.note.id, rawText, category);
        setNotes((current) => current.map((note) => note.id === updated.id ? { ...updated, category } : note));
        persistMuseAssignments([updated.id], category);
        savedNoteId = updated.id;
      } else {
        const created = await createNote(rawText, category);
        setNotes((current) => [{ ...created, category }, ...current]);
        persistMuseAssignments([created.id], category);
        processNote(created.id).catch(() => {});
        savedNoteId = created.id;
      }
      setNoteEditor(null); setActiveNoteRetrievalMode('relevant'); setActiveNoteId(savedNoteId);
      if (!findRelevant) flashSaved();
    } catch (err) { setError(safeErrorMessage(err, 'Unable to save this note.')); }
    finally { setSaving(false); }
  };

  const removeNote = async () => {
    if (!noteEditor?.note || !confirm('Delete this note? This cannot be undone.')) return;
    setSaving(true);
    try { const noteId = noteEditor.note.id; await deleteNote(noteId); persistMuseAssignments([noteId], null); setNotes((current) => current.filter((note) => note.id !== noteId)); setNoteEditor(null); }
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
      const [updated] = await moveNotesToCategory([noteId], nextCategory);
      if (!updated) throw new Error('Note not found.');
      setNotes((items) => items.map((note) => note.id === noteId ? { ...note, category: nextCategory, category_updated_at: updated.category_updated_at } : note));
      persistMuseAssignments([noteId], nextCategory);
    } catch (err) { setError(safeErrorMessage(err, 'Unable to change this note’s Domain.')); }
    finally { setSaving(false); }
  };

  const removeReadingNote = async (note: Note) => {
    if (!confirm('Delete this page? This cannot be undone.')) return;
    setSaving(true); setError('');
    try {
      await deleteNote(note.id);
      persistMuseAssignments([note.id], null);
      setNotes((items) => items.filter((item) => item.id !== note.id));
      if (activeNoteId === note.id) setActiveNoteId(null);
    } catch (err) { setError(safeErrorMessage(err, 'Unable to delete this page.')); }
    finally { setSaving(false); }
  };

  const saveInstantRetrieval = async (queryText: string, resultNotes: Note[], projectId: string, newProjectTitle?: string) => {
    setSaving(true); setError('');
    try {
      const now = new Date().toISOString();
      let target = projects.find((project) => project.id === projectId);
      let nextProjects = projects;
      if (!target) {
        const title = cleanCategory(newProjectTitle);
        if (!title) throw new Error('Choose a project or create a new one first.');
        target = { id: createProjectId(), title, description: `Pages saved from Instant Retrieval.`, content: '', pages: [], createdAt: now, updatedAt: now };
        nextProjects = [...projects, target];
      }
      const closest = resultNotes[0];
      const closestContent = closest ? splitNote(closest) : null;
      const page: ProjectPage = {
        id: createPageId(),
        title: queryText.trim().replace(/[.!?]+$/, '').slice(0, 100) || 'Instant retrieval',
        content: closestContent
          ? `${closestContent.title}\n\n${closestContent.body || notePreview(closest)}`
          : `Instant retrieval\n\n${queryText.trim()}`,
        sourceNoteIds: resultNotes.slice(0, 6).map((note) => note.id),
        createdAt: now,
        updatedAt: now,
      };
      nextProjects = nextProjects.map((project) => project.id === target!.id ? { ...project, pages: [...project.pages, page], updatedAt: now } : project);
      persistProjects(nextProjects);
      setActiveProjectId(target.id);
      setActivePageId(page.id);
      flashSaved();
    } catch (err) { setError(safeErrorMessage(err, 'Unable to save this retrieval.')); throw err; }
    finally { setSaving(false); }
  };

  const saveMuse = async () => {
    if (!museEditor) return;
    const title = cleanCategory(museEditor.title);
    if (!title) { setError('Add a title for this Domain.'); return; }
    if (muses.some((item) => item.title.toLowerCase() === title.toLowerCase() && item.title !== museEditor.originalTitle)) { setError('A Domain with this title already exists.'); return; }
    setSaving(true); setError('');
    try {
      if (museEditor.originalTitle && museEditor.originalTitle !== title) {
        const affected = notesByMuse.get(museEditor.originalTitle) ?? [];
        const updated = await moveNotesToCategory(affected.map((note) => note.id), title);
        const updates = new Map(updated.map((note) => [note.id, note]));
        setNotes((current) => current.map((note) => updates.get(note.id) ?? note));
        persistMuseAssignments(affected.map((note) => note.id), title);
      }
      const originalKey = museEditor.originalTitle?.toLowerCase();
      const next = museMeta.filter((item) => item.title.toLowerCase() !== originalKey && item.title.toLowerCase() !== title.toLowerCase());
      next.push({ title, description: museEditor.description.trim(), createdAt: museMeta.find((item) => item.title.toLowerCase() === originalKey)?.createdAt ?? new Date().toISOString() });
      persistMuseMeta(next);
      if (museEditor.originalTitle && museEditor.originalTitle !== title) {
        persistPinnedMuses(pinnedMuseTitles.map((pinned) => pinned.toLowerCase() === museEditor.originalTitle?.toLowerCase() ? title : pinned));
      }
      if (activeMuse === museEditor.originalTitle) setActiveMuse(title);
      setMuseEditor(null); flashSaved();
    } catch (err) { setError(safeErrorMessage(err, 'Unable to save this Domain.')); }
    finally { setSaving(false); }
  };

  const removeMuse = async (title: string) => {
    if (!confirm(`Delete “${title}”? Its notes will return to Instant retrieval.`)) return;
    setSaving(true);
    try {
      const updated = await moveNotesToCategory((notesByMuse.get(title) ?? []).map((note) => note.id), null);
      const updates = new Map(updated.map((note) => [note.id, note]));
      setNotes((current) => current.map((note) => updates.get(note.id) ?? note));
      persistMuseAssignments((notesByMuse.get(title) ?? []).map((note) => note.id), null);
      persistMuseMeta(museMeta.filter((item) => item.title.toLowerCase() !== title.toLowerCase()));
      persistPinnedMuses(pinnedMuseTitles.filter((pinned) => pinned.toLowerCase() !== title.toLowerCase()));
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
      const matchingDomains = importDomains.filter((domain) => domain.title.toLowerCase() !== ORPHANS_MUSE.toLowerCase());
      const orphanTitle = importDomainMap.get(ORPHANS_MUSE.toLowerCase())?.title ?? ORPHANS_MUSE;
      const inputs = drafts.map((draft) => {
        const rawText = prepareImportedNoteText(draft.rawText);
        return { rawText, category: inferMuse(rawText, matchingDomains) ?? orphanTitle };
      });
      const imported = await importNotes(
        inputs,
        (completed, total) => setImportProgress({ completed, total })
      );

      const nextMeta = new Map(museMeta.map((muse) => [muse.title.toLowerCase(), muse]));
      importDomains.forEach((domain) => {
        if (!nextMeta.has(domain.title.toLowerCase())) nextMeta.set(domain.title.toLowerCase(), domain);
      });
      persistMuseMeta(Array.from(nextMeta.values()));

      const categorized = imported.map((note, index) => ({ ...note, category: inputs[index].category }));
      setNotes((current) => [...categorized, ...current]);
      const idsByDomain = new Map<string, string[]>();
      categorized.forEach((note) => idsByDomain.set(note.category!, [...(idsByDomain.get(note.category!) ?? []), note.id]));
      idsByDomain.forEach((noteIds, category) => persistMuseAssignments(noteIds, category));
      categorized.forEach((note) => processNote(note.id).catch(() => {}));
      setImportProgress(null); setImportOpen(false); flashSaved();
    } catch (err) { setImportProgress(null); setImportError(safeErrorMessage(err, 'Your notes could not be imported.')); throw err; }
  };

  if (loading) return <div className="flex h-[100dvh] items-center justify-center overflow-hidden bg-white"><Loader2 className="h-7 w-7 animate-spin text-[#477bea]" /></div>;

  const activeProject = activeProjectId ? projects.find((project) => project.id === activeProjectId) ?? null : null;
  const activePage = activeProject && activePageId ? activeProject.pages.find((page) => page.id === activePageId) ?? null : null;

  return (
    <main className="light h-[100dvh] w-full overflow-hidden bg-white text-[#141414]">
      <section className="relative flex h-full w-full flex-col overflow-hidden bg-white">
        {activeNoteId && notes.find((note) => note.id === activeNoteId) ? <NoteReadingWorkspace key={activeNoteId} note={notes.find((note) => note.id === activeNoteId)!} allNotes={notes} muses={muses} projects={projects} saving={saving} userId={user?.id ?? 'local'} initialRetrievalMode={activeNoteRetrievalMode} onBack={() => setActiveNoteId(null)} onAddNote={() => openNewNote(cleanCategory(notes.find((note) => note.id === activeNoteId)?.category) ?? AUTOMATIC_MUSE)} onOpenNote={(note) => openExistingNote(note)} onOpenPage={(project, page) => { setActiveNoteId(null); setActiveProjectId(project.id); setActivePageId(page.id); }} onUpdate={updateReadingNote} onChangeDomain={(category) => void changeReadingNoteDomain(activeNoteId, category)} onDelete={removeReadingNote} onSaveRetrieval={saveInstantRetrieval} />
          : activeProject && activePage ? <ProjectPageWorkspace key={activePage.id} project={activeProject} page={activePage} notes={notes} muses={muses} projects={projects} saving={saving} onBack={() => setActivePageId(null)} onChange={(page) => updateProjectPage(activeProject.id, page)} onAddNote={() => openNewNote()} onOpenNote={openExistingNote} onOpenPage={(project, page) => { setActiveProjectId(project.id); setActivePageId(page.id); }} onDelete={() => removeProjectPage(activeProject.id, activePage.id)} onSaveRetrieval={saveInstantRetrieval} />
          : activeProject ? <ProjectPagesGrid project={activeProject} onBack={() => { setActiveProjectId(null); setActivePageId(null); }} onAddPage={() => createProjectPage(activeProject.id)} onOpenPage={(page) => setActivePageId(page.id)} onEdit={() => setProjectEditor({ project: activeProject, title: activeProject.title, description: activeProject.description })} onDelete={() => removeProject(activeProject.id)} />
          : isEmpty ? <EmptyWorkspace displayName={displayName} userEmail={user?.email ?? ''} existingDomains={muses} onAddNote={() => openNewNote()} onImport={handleImport} onOpenImport={() => setImportOpen(true)} importError={importError} progress={importProgress} />
          : activeMuse || showUnsorted ? <MuseDetail title={showUnsorted ? 'Instant retrieval' : activeMuse ?? ''} notes={showUnsorted ? unsortedNotes : notesByMuse.get(activeMuse ?? '') ?? []} isUnsorted={showUnsorted} busy={saving} onClose={closeLibrary} onAddNote={() => openNewNote(showUnsorted ? AUTOMATIC_MUSE : activeMuse ?? AUTOMATIC_MUSE)} onOpenNote={openExistingNote} onEdit={() => { const meta = muses.find((item) => item.title === activeMuse); if (meta) setMuseEditor({ originalTitle: meta.title, title: meta.title, description: meta.description }); }} onDelete={() => { if (activeMuse) void removeMuse(activeMuse); }} />
          : view === 'muses' ? <MuseGrid muses={muses} projects={projects} notes={notes} notesByMuse={notesByMuse} busy={saving} onClose={closeLibrary} onAddNote={(muse) => openNewNote(muse ?? AUTOMATIC_MUSE)} onAddMuse={() => setMuseEditor({ originalTitle: null, title: '', description: '' })} onEditMuse={(muse) => setMuseEditor({ originalTitle: muse.title, title: muse.title, description: muse.description })} onDeleteMuse={(title) => void removeMuse(title)} onOpenNote={openExistingNote} onSaveRetrieval={saveInstantRetrieval} />
          : <CortexHome projects={projects} muses={muses} pinnedMuseTitles={pinnedMuseTitles} notes={notes} notesByMuse={notesByMuse} userEmail={user?.email ?? ''} busy={saving} onOpenMuses={() => setView('muses')} onOpenMuse={openMuse} onTogglePin={togglePinnedMuse} onAddMuse={() => setMuseEditor({ originalTitle: null, title: '', description: '' })} onAddNote={() => openNewNote()} onOpenImport={() => setImportOpen(true)} onOpenPage={(project, page) => { setActiveProjectId(project.id); setActivePageId(page.id); }} onOpenNote={openExistingNote} onSaveRetrieval={saveInstantRetrieval} />}
        {error && !noteEditor && !museEditor && !projectEditor && <div role="alert" className="fixed bottom-5 left-1/2 z-40 max-w-[90vw] -translate-x-1/2 rounded-lg bg-[#202020] px-4 py-3 text-sm text-white shadow-xl">{error}<button type="button" onClick={() => setError('')} aria-label="Dismiss error" className="ml-4"><X className="inline h-4 w-4" /></button></div>}
      </section>
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
          <a href="/terms">Terms of use</a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className={menuItemClassName}>
          <a href="/privacy">Privacy policy</a>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1 bg-[#ececef]" />
        <DropdownMenuItem onSelect={onOpenImport} className={menuItemClassName}>Import notes</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BetaAndAvatar({ email, feedback = false, onOpenImport }: { email: string; feedback?: boolean; onOpenImport: () => void }) {
  return (
    <div className="flex items-center gap-4">
      <div className="inline-flex overflow-hidden rounded-md border border-[#a8c4ff] text-sm">
        <span className="bg-[#edf3ff] px-4 py-1.5 text-[#477bea]">Beta</span>
        {feedback && <a href="mailto:feedback@ocreda.com" className="hidden border-l border-[#a8c4ff] px-3 py-1.5 text-[#252525] hover:bg-[#f5f7fb] sm:block">Send feedback</a>}
      </div>
      <Avatar email={email} onOpenImport={onOpenImport} />
    </div>
  );
}

function EmptyWorkspace({ displayName, userEmail, existingDomains, onAddNote, onImport, onOpenImport, importError, progress }: {
  displayName: string; userEmail: string; onAddNote: () => void;
  existingDomains: ImportDomainDraft[];
  onImport: (drafts: ImportNoteDraft[], domains: ImportDomainDraft[]) => Promise<void>; onOpenImport: () => void; importError: string;
  progress: { completed: number; total: number } | null;
}) {
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-y-auto bg-white px-5 md:overflow-hidden sm:px-10">
      <div className="flex h-[72px] shrink-0 items-start justify-end pt-5 sm:h-[82px] sm:pt-7"><BetaAndAvatar email={userEmail} onOpenImport={onOpenImport} /></div>
      <div className="flex flex-none flex-col items-center justify-start py-5 sm:py-7 md:min-h-0 md:flex-1 md:justify-center">
      <div className="mx-auto w-full max-w-[920px]">
        <div className="text-center">
          <h1 className="flex items-center justify-center gap-3 text-[28px] font-medium tracking-[-0.02em] sm:text-[36px]"><OcredaMark className="h-9 w-9 sm:h-10 sm:w-10" /> Welcome to Ocreda, {displayName || 'you'}</h1>
          <p className="mt-2 text-base text-[#777] sm:text-lg">Let your knowledge proactively come to you without asking</p>
        </div>
        <div className="mt-[clamp(32px,5vh,64px)] grid items-start gap-4 md:grid-cols-2">
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
      <p className="flex h-[58px] shrink-0 items-center justify-center text-center text-xs text-[#777] sm:h-[68px] sm:text-sm">Your notes are private and secured. Nobody can touch them.</p>
    </div>
  );
}

function CortexHome({ projects, muses, pinnedMuseTitles, notes, notesByMuse, userEmail, busy, onOpenMuses, onOpenMuse, onTogglePin, onAddMuse, onAddNote, onOpenImport, onOpenPage, onOpenNote, onSaveRetrieval }: {
  projects: CortexProject[]; muses: MuseMeta[]; pinnedMuseTitles: string[]; notes: Note[]; notesByMuse: Map<string, Note[]>; userEmail: string; busy: boolean;
  onOpenMuses: () => void; onOpenMuse: (title: string) => void; onTogglePin: (title: string) => void; onAddMuse: () => void; onAddNote: () => void; onOpenImport: () => void;
  onOpenPage: (project: CortexProject, page: ProjectPage) => void; onOpenNote: (note: Note) => void;
  onSaveRetrieval: (queryText: string, resultNotes: Note[], projectId: string, newProjectTitle?: string) => Promise<void>;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [instantRetrievalOpen, setInstantRetrievalOpen] = useState(false);
  const pinnedMuses = pinnedMuseTitles.map((title) => muses.find((muse) => muse.title.toLowerCase() === title.toLowerCase())).filter((muse): muse is MuseMeta => Boolean(muse));
  const unpinnedMuses = muses.filter((muse) => !pinnedMuseTitles.some((title) => title.toLowerCase() === muse.title.toLowerCase()));

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-white">
      <header className="relative z-20 flex h-[88px] shrink-0 items-center border-b border-[#eeeeef] px-5 sm:px-8">
        <div className="flex items-center gap-2 text-[#222]">
          <button type="button" onClick={onAddNote} className="flex h-10 items-center gap-2 rounded-md px-2 text-sm hover:bg-[#f5f5f6]" title="Add a note"><span className="flex h-7 w-16 items-center justify-center rounded-md bg-[#477bea] text-white"><Plus className="h-4 w-4" /></span><span className="hidden sm:inline">Add a note</span></button>
          <button type="button" onClick={() => setSearchOpen(true)} aria-label="Search notes, pages, and Domains" title="Search notes, pages, and Domains" className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-[#f5f5f6]"><Search className="h-5 w-5" /></button>
          <button type="button" onClick={() => setInstantRetrievalOpen(true)} aria-label="Open Instant Retrieval" title="Instant Retrieval" className="flex h-10 w-10 items-center justify-center rounded-md text-[#477bea] hover:bg-[#edf3ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]"><ScanSearch className="h-5 w-5" /></button>
          <button type="button" onClick={onOpenImport} aria-label="Import notes" title="Import notes" className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-[#f5f5f6]"><Upload className="h-5 w-5" /></button>
        </div>
        <h1 className="pointer-events-none absolute left-1/2 hidden -translate-x-1/2 text-sm font-normal text-[#b2b2b2] lg:block lg:text-base">Your knowledge</h1>
        <div className="ml-auto"><BetaAndAvatar email={userEmail} feedback onOpenImport={onOpenImport} /></div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-5 pb-28 pt-10 sm:px-10 lg:px-16">
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
            <button type="button" onClick={onAddMuse} aria-label="Add a Domain" title="Add a Domain" className="flex h-[286px] items-center justify-center rounded-md border border-dashed border-[#dfe3ec] text-[#477bea] transition hover:border-[#8fb1ff] hover:bg-[#f8f9fc]"><FolderPlus className="h-9 w-9 stroke-[1.6]" /></button>
          </div>
        </section>
      </main>

      <button type="button" onClick={onOpenMuses} aria-label="Open Domains and notes" className="absolute bottom-0 left-1/2 z-20 flex h-16 w-[min(88vw,420px)] -translate-x-1/2 items-center justify-center gap-10 rounded-t-[52px] border border-b-0 border-[#e0e0e0] bg-white px-8 text-xs text-[#777] shadow-[0_-4px_16px_rgba(0,0,0,0.10)] transition hover:h-[70px] hover:text-[#222] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]">
        <span className="flex items-center gap-2"><Layers3 className="h-4 w-4 text-[#477bea]" /> {muses.length} {muses.length === 1 ? 'Domain' : 'Domains'}</span>
        <span>{notes.length} {notes.length === 1 ? 'Note' : 'Notes'}</span>
      </button>

      {searchOpen && <KnowledgeSearchOverlay request={{ query: '' }} notes={notes} muses={muses} projects={projects} hideProjectColumn onClose={() => setSearchOpen(false)} onOpenPage={(project, page) => { setSearchOpen(false); onOpenPage(project, page); }} onOpenNote={(note) => { setSearchOpen(false); onOpenNote(note); }} onInstantRetrieval={() => { setSearchOpen(false); setInstantRetrievalOpen(true); }} />}
      {instantRetrievalOpen && <InstantRetrievalOverlay notes={notes} muses={muses} projects={projects} saving={busy} onClose={() => setInstantRetrievalOpen(false)} onOpenNote={(note) => { setInstantRetrievalOpen(false); onOpenNote(note); }} onSave={onSaveRetrieval} />}
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
        {project.pages.map((page) => <button key={page.id} type="button" onClick={() => onOpenPage(page)} className="relative h-[300px] overflow-hidden rounded-lg border border-[#e1e1e1] bg-[#f7f7f9] p-2 text-left shadow-[0_2px_9px_rgba(0,0,0,0.14)] transition hover:-translate-y-0.5 hover:border-[#7ca2ff]"><span className="block h-[244px] overflow-hidden rounded bg-white p-5"><strong className="block text-base">{page.title}</strong><span className="mt-4 block line-clamp-[9] whitespace-pre-wrap text-sm leading-relaxed text-[#777]">{page.content || 'Start writing on this page.'}</span></span><span className="absolute inset-x-4 bottom-3 flex justify-between text-xs text-[#aaa]"><span>Page</span><span>{formatDate(page.updatedAt)}</span></span></button>)}
        <button type="button" onClick={onAddPage} className="flex h-[300px] items-center justify-center rounded-lg border border-dashed border-[#c9d7fa] text-[#477bea] hover:bg-[#f8faff]"><FolderPlus className="h-9 w-9 stroke-[1.6]" /></button>
      </div>
      {!project.pages.length && <p className="mt-8 text-center text-sm text-[#999]">This project is ready for its first page.</p>}
    </main>
  </div>;
}

function ProjectPageWorkspace({ project, page, notes, muses, projects, saving, onBack, onChange, onAddNote, onOpenNote, onOpenPage, onDelete, onSaveRetrieval }: {
  project: CortexProject; page: ProjectPage; notes: Note[]; muses: MuseMeta[]; projects: CortexProject[]; saving: boolean;
  onBack: () => void; onChange: (page: ProjectPage) => void;
  onAddNote: () => void; onOpenNote: (note: Note) => void; onOpenPage: (project: CortexProject, page: ProjectPage) => void; onDelete: () => void;
  onSaveRetrieval: (queryText: string, resultNotes: Note[], projectId: string, newProjectTitle?: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(page.title);
  const [content, setContent] = useState(page.content);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [contextOpen, setContextOpen] = useState(true);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [searchRequest, setSearchRequest] = useState<KnowledgeSearchRequest | null>(null);
  const [instantRetrievalOpen, setInstantRetrievalOpen] = useState(false);
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
        <button type="button" onClick={() => setInstantRetrievalOpen(true)} aria-label="Open Instant Retrieval" title="Open Instant Retrieval" className="ml-1 flex h-9 w-9 items-center justify-center rounded-md text-[#477bea] hover:bg-[#edf3ff]"><ScanSearch className="h-5 w-5" /></button>
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
          {selectedContent && selectedNote ? <article className="mx-auto max-w-xl">{selectedContent.hasTitle && <h2 className="text-lg font-semibold">{selectedContent.title}</h2>}<p className="mt-6 whitespace-pre-wrap text-sm leading-[1.6] text-[#333]">{selectedContent.body || selectedNote.raw_text}</p><div className="mt-8 border-t border-[#ddd] pt-4 text-xs text-[#999]">Domain: {cleanCategory(selectedNote.category) || 'Instant retrieval'} · {fullNoteDate(selectedNote.created_at)}</div></article> : <div className="flex h-full items-center justify-center text-center"><div><h2 className="text-lg font-semibold">Write to retrieve your knowledge.</h2><p className="mt-3 max-w-sm text-sm leading-relaxed text-[#777]">Related text will appear here as your page develops.</p></div></div>}
        </section>}
        {contextOpen && <aside className="min-h-[420px] overflow-y-auto border-l border-[#dedede] bg-white p-4 lg:min-h-0">
          <h2 className="mb-4 text-center text-sm font-normal text-[#999]">Retrieved for this page</h2>
          <div className="space-y-4">
            {surfacedNotes.map((note) => { const noteContent = splitNote(note); return <button key={note.id} type="button" onMouseEnter={() => setSelectedNoteId(note.id)} onFocus={() => setSelectedNoteId(note.id)} onClick={() => onOpenNote(note)} className={`block h-[190px] w-full overflow-hidden rounded-md border bg-[#f7f7f9] p-2 text-left shadow-sm transition hover:border-[#8fb1ff] ${selectedNoteId === note.id ? 'border-[#7ca2ff] ring-1 ring-[#7ca2ff]/30' : 'border-[#e0e0e0]'}`}><span className="block h-[142px] overflow-hidden rounded bg-white p-4"><span className="float-right text-[11px] text-[#477bea]">note</span>{noteContent.hasTitle && <strong className="block max-w-[80%] truncate text-sm">{noteContent.title}</strong>}<span className="mt-3 block line-clamp-4 text-xs leading-relaxed text-[#777]">{noteContent.body || notePreview(note)}</span></span><span className="mt-2 flex items-center justify-between px-2 text-[11px] text-[#aaa]"><span className="truncate">Domain: {cleanCategory(note.category) || 'Instant retrieval'}</span><span>{formatDate(note.created_at)}</span></span></button>; })}
            {!surfacedNotes.length && <p className="px-4 py-12 text-center text-sm leading-relaxed text-[#999]">Related notes will appear here as your knowledge base grows.</p>}
          </div>
        </aside>}
      </div>
      {searchRequest && <KnowledgeSearchOverlay request={searchRequest} notes={notes} muses={muses} projects={projects} onClose={() => setSearchRequest(null)} onOpenPage={(nextProject, nextPage) => { setSearchRequest(null); onOpenPage(nextProject, nextPage); }} onOpenNote={(note) => { setSearchRequest(null); onOpenNote(note); }} onInstantRetrieval={() => { setSearchRequest(null); setInstantRetrievalOpen(true); }} />}
      {instantRetrievalOpen && <InstantRetrievalOverlay notes={notes} muses={muses} projects={projects} saving={saving} onClose={() => setInstantRetrievalOpen(false)} onOpenNote={(note) => { setInstantRetrievalOpen(false); onOpenNote(note); }} onSave={onSaveRetrieval} />}
    </div>
  );
}

type LibrarySort = 'newest' | 'oldest' | 'random' | 'date';
type LibraryLayout = 'grid' | 'large';

function MuseGrid({ muses, projects, notes, notesByMuse, busy, onClose, onAddNote, onAddMuse, onEditMuse, onDeleteMuse, onOpenNote, onSaveRetrieval }: {
  muses: MuseMeta[]; projects: CortexProject[]; notes: Note[]; notesByMuse: Map<string, Note[]>; busy: boolean;
  onClose: () => void;
  onAddNote: (muse?: string) => void; onAddMuse: () => void; onEditMuse: (muse: MuseMeta) => void;
  onDeleteMuse: (title: string) => void; onOpenNote: (note: Note) => void;
  onSaveRetrieval: (queryText: string, resultNotes: Note[], projectId: string, newProjectTitle?: string) => Promise<void>;
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
  const [instantRetrievalOpen, setInstantRetrievalOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || searchOpen || sortOpen || musesOpen || instantRetrievalOpen) return;
      if (document.querySelector('[aria-modal="true"], [role="status"]')) return;
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [instantRetrievalOpen, musesOpen, onClose, searchOpen, sortOpen]);

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
          <button type="button" onClick={() => setInstantRetrievalOpen(true)} aria-label="Open Instant Retrieval" title="Open Instant Retrieval" className="mt-3 flex h-10 w-10 items-center justify-center rounded-md text-[#477bea] hover:bg-[#edf3ff]"><ScanSearch className="h-5 w-5" /></button>
        </aside>

        <section className="min-w-0 flex-1 overflow-y-auto px-5 pt-10 sm:px-8 lg:px-12 lg:pt-14">
          {searchOpen && <label className="mb-10 flex h-12 w-full max-w-[330px] items-center rounded-xl bg-[#f7f7f9] px-4 shadow"><Search className="mr-3 h-5 w-5 text-[#aaa]" /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setSearchOpen(false); setQuery(''); } }} placeholder="Search your notes" className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label>}
          <div data-testid="note-library-cards" data-layout={query.trim() ? 'search' : layout} className={`mx-auto grid max-w-[1520px] gap-7 pb-20 lg:gap-x-12 lg:gap-y-10 ${query.trim() ? 'grid-cols-1 xl:grid-cols-2' : layout === 'grid' ? 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1 lg:grid-cols-2'}`}>
            {visibleNotes.map((note) => <LibraryNoteCard key={note.id} note={note} query={query} layout={query.trim() ? 'search' : layout} onClick={() => onOpenNote(note)} />)}
            {query.trim() && <InstantRetrievalCard onClick={() => setInstantRetrievalOpen(true)} tall />}
            {!query.trim() && <AddLibraryCard layout={layout} onClick={() => onAddNote(selectedMuses.size === 1 ? firstSelectedMuse : undefined)} />}
          </div>
          {!visibleNotes.length && query.trim() && <p className="pb-20 text-sm text-[#999]">No notes contain “{query.trim()}”.</p>}
        </section>
      </div>

      {musesOpen && <MuseSelector muses={muses} notesByMuse={notesByMuse} selected={selectedMuses} busy={busy} onClose={() => setMusesOpen(false)} onSave={(next) => { setSelectedMuses(next); setMusesOpen(false); }} onCreate={() => { setMusesOpen(false); onAddMuse(); }} onEdit={(muse) => { setMusesOpen(false); onEditMuse(muse); }} onDelete={onDeleteMuse} />}
      {instantRetrievalOpen && <InstantRetrievalOverlay notes={notes} muses={muses} projects={projects} initialQuery={query} saving={busy} onClose={() => setInstantRetrievalOpen(false)} onOpenNote={(note) => { setInstantRetrievalOpen(false); onOpenNote(note); }} onSave={onSaveRetrieval} />}
    </div>
  );
}

function AddLibraryCard({ layout, onClick }: { layout: LibraryLayout; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={`relative overflow-hidden rounded-lg border border-[#e1e1e3] bg-white text-left text-[#477bea] shadow-[0_3px_12px_rgba(0,0,0,0.15)] transition hover:-translate-y-0.5 hover:border-[#a9c0f5] hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea] ${layout === 'grid' ? 'h-[360px] p-8' : 'h-[440px] p-8'}`}><span className="flex items-center gap-2 text-base"><Plus className="h-5 w-5" /> Add</span><span className="absolute inset-x-5 bottom-6 text-center text-sm italic text-[#b4b4b8]">You can always add more</span><span className="sr-only">{layout === 'grid' ? 'grid' : 'large card'} layout</span></button>;
}

function LibraryNoteCard({ note, query, layout, onClick }: { note: Note; query: string; layout: LibraryLayout | 'search'; onClick: () => void }) {
  const content = splitNote(note);
  const isGrid = layout === 'grid';
  const isLarge = layout === 'large';
  return <button type="button" onClick={onClick} className={`relative overflow-hidden rounded-lg border border-[#e1e1e3] bg-[#f7f7f9] p-2 text-left shadow-[0_3px_12px_rgba(0,0,0,0.15)] transition hover:-translate-y-0.5 hover:border-[#7ca2ff] hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea] ${isGrid ? 'h-[360px]' : isLarge ? 'h-[440px]' : 'h-[360px]'}`}><span className={`block overflow-hidden rounded-md bg-white ${isGrid ? 'h-[280px] px-7 py-7' : isLarge ? 'h-[360px] px-8 py-8' : 'h-[280px] px-7 py-7'}`}>{content.hasTitle && <strong className={`block text-base leading-snug text-[#151515] ${isLarge ? 'line-clamp-4 text-lg' : 'line-clamp-3'}`}><HighlightedText text={content.title} query={query} /></strong>}<span className={`mt-4 block whitespace-pre-wrap text-[15px] leading-[1.55] text-[#777] ${isGrid ? 'line-clamp-[8]' : isLarge ? 'line-clamp-[12]' : 'line-clamp-[8]'}`}><HighlightedText text={content.body || notePreview(note)} query={query} /></span></span><span className="absolute inset-x-5 bottom-4 flex items-center justify-between gap-3 text-xs text-[#aaa]"><span className="min-w-0 truncate">{cleanCategory(note.category) || 'Instant retrieval'}</span><span className="shrink-0">{formatDate(note.created_at)}</span></span><span className="sr-only">{isLarge ? 'large card' : layout} layout</span></button>;
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

function MuseDetail({ title, notes, isUnsorted, busy, onClose, onAddNote, onOpenNote, onEdit, onDelete }: {
  title: string; notes: Note[]; isUnsorted: boolean; busy: boolean; onClose: () => void; onAddNote: () => void;
  onOpenNote: (note: Note) => void; onEdit: () => void; onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [newestFirst, setNewestFirst] = useState(true);
  const [compact, setCompact] = useState(false);
  const visibleNotes = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = normalized ? notes.filter((note) => note.raw_text.toLowerCase().includes(normalized)) : notes;
    return [...filtered].sort((left, right) => newestFirst
      ? right.created_at.localeCompare(left.created_at)
      : left.created_at.localeCompare(right.created_at));
  }, [newestFirst, notes, query]);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[#bdbdbd] p-3 sm:p-5">
      <header className="relative flex h-16 shrink-0 items-center px-1 text-white sm:px-2">
        <div className="flex items-center gap-1">
          <button type="button" onClick={onAddNote} aria-label={`Add a note to ${title}`} title="Add a note" className="mr-2 flex h-8 w-24 items-center justify-center rounded-md bg-[#477bea] shadow-sm hover:bg-[#3d6ed7]"><Plus className="h-5 w-5" /></button>
          <button type="button" onClick={() => { setSearchOpen((open) => !open); if (searchOpen) setQuery(''); }} aria-label="Search this Domain" title="Search this Domain" className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-white/10"><Search className="h-5 w-5" /></button>
          <button type="button" onClick={() => setNewestFirst((value) => !value)} aria-label={newestFirst ? 'Show oldest notes first' : 'Show newest notes first'} title={newestFirst ? 'Newest first' : 'Oldest first'} aria-pressed={!newestFirst} className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-white/10"><Filter className="h-5 w-5" /></button>
          <button type="button" onClick={() => setCompact((value) => !value)} aria-label={compact ? 'Use spacious card view' : 'Use compact card view'} title={compact ? 'Spacious cards' : 'Compact cards'} aria-pressed={compact} className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-white/10"><Grid2X2 className="h-5 w-5" /></button>
        </div>
        <h1 className="pointer-events-none absolute left-1/2 hidden max-w-[40vw] -translate-x-1/2 truncate text-sm font-normal text-white/90 sm:block">{title}</h1>
        <button type="button" onClick={onClose} aria-label="Close Domain and return home" title="Close Domain and return home" className="ml-auto flex h-10 w-10 items-center justify-center rounded-md text-white drop-shadow hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"><X className="h-6 w-6" /></button>
      </header>

      <section className="relative min-h-0 flex-1 overflow-y-auto rounded-[28px] bg-white px-5 pb-16 pt-9 shadow-[0_14px_40px_rgba(0,0,0,0.12)] sm:px-10 lg:px-16">
      <p className="text-center text-sm font-normal text-[#b2b2b7]">{visibleNotes.length} {visibleNotes.length === 1 ? 'entry' : 'entries'}</p>
      {searchOpen && <label className="mx-auto mt-6 flex h-11 w-full max-w-md items-center rounded-xl bg-[#f7f7f9] px-4 shadow-sm"><Search className="mr-3 h-4 w-4 text-[#aaa]" /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${title}`} className="min-w-0 flex-1 bg-transparent text-sm text-[#222] outline-none placeholder:text-[#aaa]" /></label>}
      {!isUnsorted && <div className="absolute right-5 top-4 sm:right-8"><button type="button" onClick={() => setMenuOpen((value) => !value)} aria-label="Domain options" aria-expanded={menuOpen} className="flex h-10 w-10 items-center justify-center rounded-md text-[#222] hover:bg-[#f4f4f4]"><MoreHorizontal className="h-5 w-5" /></button>{menuOpen && <div className="absolute right-0 top-11 z-10 w-40 overflow-hidden rounded-lg border border-[#ddd] bg-white py-1 text-sm shadow-xl"><button type="button" onClick={() => { setMenuOpen(false); onEdit(); }} className="block w-full px-4 py-2.5 text-left hover:bg-[#f5f5f5]">Edit Domain</button><button type="button" disabled={busy} onClick={() => { setMenuOpen(false); onDelete(); }} className="block w-full px-4 py-2.5 text-left text-red-600 hover:bg-red-50">Delete Domain</button></div>}</div>}
      <div className={`mx-auto mt-14 grid max-w-[1510px] grid-cols-1 gap-8 sm:grid-cols-2 lg:gap-x-12 lg:gap-y-10 ${compact ? 'xl:grid-cols-4' : 'xl:grid-cols-3'}`}>
        {visibleNotes.map((note) => { const content = splitNote(note); return <button key={note.id} type="button" onClick={() => onOpenNote(note)} className="relative h-[360px] min-w-0 overflow-hidden rounded-lg border border-[#e1e1e3] bg-[#f7f7f9] p-2 text-left shadow-[0_3px_12px_rgba(0,0,0,0.15)] transition hover:-translate-y-0.5 hover:border-[#7ca2ff] hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]"><span className="block h-[280px] overflow-hidden rounded-md bg-white px-7 py-7">{content.hasTitle && <strong className="block line-clamp-3 text-base leading-snug text-[#151515]">{content.title}</strong>}<span className="mt-4 block whitespace-pre-wrap text-[15px] leading-[1.55] text-[#777] line-clamp-[8]">{content.body || notePreview(note)}</span></span><span className="absolute bottom-4 right-5 text-xs text-[#aaa]">{formatDate(note.created_at)}</span></button>; })}
        <button type="button" onClick={onAddNote} aria-label={`Add a note to ${title}`} className="relative flex h-[360px] items-start rounded-lg border border-[#e1e1e3] bg-white p-8 text-[#477bea] shadow-[0_3px_12px_rgba(0,0,0,0.15)] transition hover:-translate-y-0.5 hover:border-[#a9c0f5] hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]"><span className="flex items-center gap-2"><Plus className="h-5 w-5" /> Add</span><span className="absolute inset-x-5 bottom-6 text-center text-sm italic text-[#b4b4b8]">You can always add more</span></button>
      </div>
      {!visibleNotes.length && query.trim() && <p className="mt-8 text-center text-sm text-[#999]">No notes contain “{query.trim()}”.</p>}
      {!notes.length && <p className="mt-8 text-center text-sm text-[#999]">This Domain is ready for its first note.</p>}
      </section>
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

function NoteDomainPicker({ category, muses, saving, onChange, showPrefix = false }: {
  category: string | null; muses: MuseMeta[]; saving: boolean;
  onChange: (category: string | null) => void; showPrefix?: boolean;
}) {
  const current = cleanCategory(category);
  const label = current || 'Instant retrieval';
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
        <DropdownMenuItem disabled={saving} onSelect={() => { if (current) onChange(null); }} className={itemClassName}>
          Instant retrieval {!current && <Check className="h-4 w-4 text-[#477bea]" />}
        </DropdownMenuItem>
        {muses.length > 0 && <DropdownMenuSeparator className="my-1 bg-[#ececef]" />}
        {muses.map((muse) => {
          const selected = current?.toLowerCase() === muse.title.toLowerCase();
          return <DropdownMenuItem key={muse.title} disabled={saving} onSelect={() => { if (!selected) onChange(muse.title); }} className={itemClassName}>
            <span className="min-w-0 truncate">{muse.title}</span>{selected && <Check className="h-4 w-4 shrink-0 text-[#477bea]" />}
          </DropdownMenuItem>;
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NoteReadingWorkspace({ note, allNotes, muses, projects, saving, userId, initialRetrievalMode, onBack, onAddNote, onOpenNote, onOpenPage, onUpdate, onChangeDomain, onDelete, onSaveRetrieval }: {
  note: Note; allNotes: Note[]; muses: MuseMeta[]; projects: CortexProject[]; saving: boolean; userId: string; initialRetrievalMode: 'similar' | 'relevant';
  onBack: () => void; onAddNote: () => void; onOpenNote: (note: Note) => void; onOpenPage: (project: CortexProject, page: ProjectPage) => void;
  onUpdate: (noteId: string, rawText: string) => Promise<void>; onChangeDomain: (category: string | null) => void; onDelete: (note: Note) => Promise<void>;
  onSaveRetrieval: (queryText: string, resultNotes: Note[], projectId: string, newProjectTitle?: string) => Promise<void>;
}) {
  const initial = splitNote(note);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [notesOpen, setNotesOpen] = useState(true);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [flippedReasonById, setFlippedReasonById] = useState<Record<string, boolean>>({});
  const [retrieval, setRetrieval] = useState<RelevanceSearch | null>(null);
  const [retrievalLoading, setRetrievalLoading] = useState(false);
  const [retrievalProgress, setRetrievalProgress] = useState<RelevanceProgress | null>(null);
  const [retrievalError, setRetrievalError] = useState('');
  const [retrievalAttempt, setRetrievalAttempt] = useState(0);
  const [retrievalMode, setRetrievalMode] = useState(initialRetrievalMode);
  const [searchRequest, setSearchRequest] = useState<KnowledgeSearchRequest | null>(null);
  const [instantRetrievalOpen, setInstantRetrievalOpen] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const latestSaveRef = useRef(onUpdate);
  latestSaveRef.current = onUpdate;
  const muse = cleanCategory(note.category) || 'Instant retrieval';
  const rawText = title.trim() && body.trim() ? `${title.trim()}\n\n${body.trim()}` : title.trim() || body.trim();

  useEffect(() => {
    if (!editing || !rawText || rawText === note.raw_text.trim()) return;
    setSaveState('saving');
    const timeout = window.setTimeout(() => {
      latestSaveRef.current(note.id, rawText).then(() => setSaveState('saved')).catch(() => setSaveState('error'));
    }, 850);
    return () => window.clearTimeout(timeout);
  }, [body, editing, note.id, note.raw_text, rawText, title]);

  const orderedNotes = useMemo(() => [...allNotes].sort((a, b) => b.created_at.localeCompare(a.created_at)), [allNotes]);
  const noteIndex = orderedNotes.findIndex((item) => item.id === note.id);
  const previousNote = noteIndex < orderedNotes.length - 1 ? orderedNotes[noteIndex + 1] : null;
  const nextNote = noteIndex > 0 ? orderedNotes[noteIndex - 1] : null;
  const noteTooShortForRetrieval = note.raw_text.trim().length < MIN_RELEVANCE_DRAFT_CHARS;
  const hasOtherNotes = allNotes.some((item) => item.id !== note.id);

  useEffect(() => {
    // The editor autosaves while typing. Wait until editing finishes before
    // running the more expensive related-note search again.
    if (editing) return;
    let active = true;
    setRetrieval(null); setRetrievalError(''); setRetrievalProgress(null); setSelectedNoteId(null);
    const saved = retrievalAttempt === 0 ? readSavedRetrieval(userId, note) : null;
    if (saved && (retrievalMode === 'similar' || saved.mode === 'relevant')) {
      setRetrieval(saved.search);
      setRetrievalLoading(false);
      return;
    }
    if (noteTooShortForRetrieval || !hasOtherNotes) { setRetrievalLoading(false); return; }
    setRetrievalLoading(true);
    const search = retrievalMode === 'relevant' ? findRelevantNotes : findSimilarNotes;
    search(note.raw_text, note.id, (progress) => { if (active) setRetrievalProgress(progress); }, allNotes)
      .then((response) => { if (active) { setRetrieval(response); persistSavedRetrieval(userId, note, retrievalMode, response); } })
      .catch((err) => { if (active) setRetrievalError(safeErrorMessage(err, 'Could not retrieve related notes.')); })
      .finally(() => { if (active) setRetrievalLoading(false); });
    return () => { active = false; };
  }, [allNotes, editing, hasOtherNotes, note, noteTooShortForRetrieval, retrievalAttempt, retrievalMode, userId]);

  const surfacedNotes = useMemo(() => {
    const notesById = new Map(allNotes.map((item) => [item.id, item]));
    return (retrieval?.results ?? []).map((result) => notesById.get(result.note_id)).filter((item): item is Note => item !== undefined && item.id !== note.id).slice(0, 8);
  }, [allNotes, note.id, retrieval]);

  useEffect(() => {
    setSelectedNoteId((current) => surfacedNotes.some((item) => item.id === current) ? current : surfacedNotes[0]?.id ?? null);
  }, [surfacedNotes]);

  const selectedNote = surfacedNotes.find((item) => item.id === selectedNoteId) ?? surfacedNotes[0] ?? null;
  const noteById = useMemo(() => new Map(allNotes.map((item) => [item.id, item])), [allNotes]);
  const relevanceByNoteId = useMemo(
    () => new Map((retrieval?.results ?? []).map((result) => [result.note_id, result])),
    [retrieval]
  );
  const surfacedNoteIds = new Set(surfacedNotes.map((item) => item.id));
  const summaries = (retrieval?.results ?? [])
    .filter((result) => surfacedNoteIds.has(result.note_id))
    .map((result) => result.gist.trim() || noteById.get(result.note_id)?.summary?.trim() || '')
    .filter(Boolean);

  const leaveWorkspace = async (next?: Note | null) => {
    if (rawText && rawText !== note.raw_text.trim()) {
      setSaveState('saving');
      try { await latestSaveRef.current(note.id, rawText); setSaveState('saved'); }
      catch { setSaveState('error'); return; }
    }
    if (next) onOpenNote(next); else onBack();
  };

  const finishEditing = () => {
    setEditing(false);
    if (!rawText || rawText === note.raw_text.trim()) return;
    setSaveState('saving');
    latestSaveRef.current(note.id, rawText)
      .then(() => setSaveState('saved'))
      .catch(() => setSaveState('error'));
  };

  const applyReadingFormat = (kind: 'bold' | 'italic' | 'h1' | 'h2' | 'h3' | 'body' | 'bullet' | 'number') => {
    const field = bodyRef.current; if (!field) return;
    const start = field.selectionStart; const end = field.selectionEnd; const selection = body.slice(start, end);
    let replacement = selection;
    if (kind === 'bold') replacement = `**${selection || 'bold text'}**`;
    if (kind === 'italic') replacement = `*${selection || 'italic text'}*`;
    if (kind === 'h1') replacement = `# ${selection || 'Heading'}`;
    if (kind === 'h2') replacement = `## ${selection || 'Heading'}`;
    if (kind === 'h3') replacement = `### ${selection || 'Heading'}`;
    if (kind === 'body') replacement = selection.replace(/^#{1,3}\s+/gm, '');
    if (kind === 'bullet') replacement = (selection || 'List item').split('\n').map((line) => `• ${line.replace(/^[-•]\s*/, '')}`).join('\n');
    if (kind === 'number') replacement = (selection || 'List item').split('\n').map((line, index) => `${index + 1}. ${line.replace(/^\d+\.\s*/, '')}`).join('\n');
    setBody(`${body.slice(0, start)}${replacement}${body.slice(end)}`);
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(start, start + replacement.length); });
  };

  const openDate = () => setSearchRequest({ query: '', filter: { kind: 'date', value: localDateKey(note.created_at), label: fullNoteDate(note.created_at) } });

  return (
    <div className="flex h-full min-h-0 flex-col bg-white p-3 sm:p-5">
      <header className="relative flex h-14 shrink-0 items-center px-1 sm:px-2">
        <div className="flex items-center gap-1 text-[#777] sm:gap-2">
          <button type="button" onClick={() => void leaveWorkspace()} aria-label="Back to notes" title="Back to notes" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-[#f4f4f4]"><ArrowLeft className="h-5 w-5" /></button>
          <span className="mx-1 h-7 w-px bg-[#e5e5e5]" />
          <button type="button" onClick={onAddNote} aria-label="Add a note" title="Add a note" className="flex h-8 w-8 items-center justify-center rounded-md bg-[#477bea] text-white hover:bg-[#3d6ed7]"><Plus className="h-5 w-5" /></button>
          <button type="button" onClick={() => setInstantRetrievalOpen(true)} aria-label="Open Instant Retrieval" title="Open Instant Retrieval" className="flex h-9 w-9 items-center justify-center rounded-md text-[#477bea] hover:bg-[#edf3ff]"><ScanSearch className="h-5 w-5" /></button>
          <button type="button" onClick={() => setSearchRequest({ query: '' })} aria-label="Search notes, pages, and Domains" title="Search notes, pages, and Domains" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-[#f4f4f4]"><Search className="h-5 w-5" /></button>
        </div>
        <div className="absolute left-1/2 hidden -translate-x-1/2 text-sm xl:block"><NoteDomainPicker category={note.category} muses={muses} saving={saving} onChange={onChangeDomain} /></div>
        <div className="relative ml-auto flex items-center gap-1 text-[#777]">
          <button type="button" disabled={!previousNote} onClick={() => previousNote && void leaveWorkspace(previousNote)} aria-label="Previous note" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-[#f4f4f4] disabled:opacity-25"><ChevronLeft className="h-4 w-4" /></button>
          <button type="button" disabled={!nextNote} onClick={() => nextNote && void leaveWorkspace(nextNote)} aria-label="Next note" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-[#f4f4f4] disabled:opacity-25"><ChevronRight className="h-4 w-4" /></button>
          <button type="button" onClick={() => setMenuOpen((open) => !open)} aria-label="Note options" aria-expanded={menuOpen} className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-[#f4f4f4]"><MoreHorizontal className="h-5 w-5" /></button>
          {menuOpen && <div className="absolute right-0 top-11 z-30 w-40 overflow-hidden rounded-lg border border-[#ddd] bg-white py-1 text-sm shadow-xl"><button type="button" onClick={() => { setMenuOpen(false); setEditing(true); requestAnimationFrame(() => bodyRef.current?.focus()); }} className="block w-full px-4 py-2.5 text-left hover:bg-[#f5f5f5]">Edit note</button><button type="button" disabled={saving} onClick={() => { setMenuOpen(false); void onDelete(note); }} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-red-600 hover:bg-red-50"><Trash2 className="h-4 w-4" /> Delete note</button></div>}
        </div>
      </header>

      <div className={`grid min-h-0 flex-1 overflow-y-auto rounded-xl border border-[#d8d8d8] bg-[#f7f7f9] shadow-[0_2px_9px_rgba(0,0,0,0.13)] xl:overflow-hidden ${summaryOpen && notesOpen ? 'xl:grid-cols-[minmax(0,1.05fr)_minmax(300px,.9fr)_300px]' : summaryOpen ? 'xl:grid-cols-[minmax(0,1.05fr)_minmax(300px,.9fr)]' : notesOpen ? 'xl:grid-cols-[minmax(0,1fr)_300px]' : 'grid-cols-1'}`}>
        <section className="relative flex min-h-[520px] min-w-0 flex-col overflow-hidden bg-white xl:min-h-0">
          <div className="absolute right-4 top-3 z-10 flex gap-2">
            <button type="button" onClick={() => setSummaryOpen((open) => !open)} aria-label={summaryOpen ? 'Hide summary' : 'Show summary'} title={summaryOpen ? 'Hide summary' : 'Show summary'} aria-controls="note-summary-panel" aria-expanded={summaryOpen} className="flex h-8 w-8 items-center justify-center rounded-md border border-[#dedede] bg-white text-[#555] shadow-sm hover:border-[#adc3ff] hover:text-[#477bea] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]"><PanelRightOpen className={`h-4 w-4 ${summaryOpen ? '' : 'rotate-180'}`} aria-hidden="true" /></button>
            {!summaryOpen && <button type="button" onClick={() => setNotesOpen((open) => !open)} aria-controls="related-notes-panel" aria-expanded={notesOpen} className="rounded-md border border-[#dedede] bg-white px-3 py-1.5 text-xs text-[#555] shadow-sm hover:border-[#adc3ff] hover:text-[#477bea] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]">{notesOpen ? 'Hide notes' : 'See notes'}</button>}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-24 pt-12 sm:px-12 xl:px-[8%]">
            {editing ? <div className="mx-auto max-w-3xl"><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Note title" placeholder="Title (optional)" className="w-full bg-transparent text-2xl font-semibold outline-none placeholder:font-normal placeholder:text-[#c4c4c6]" /><textarea ref={bodyRef} value={body} onChange={(event) => setBody(event.target.value)} aria-label="Note text" className="mt-10 min-h-[520px] w-full resize-none bg-transparent text-base leading-[1.7] outline-none" /></div> : <article className="mx-auto max-w-3xl">{title.trim() && <button type="button" onClick={() => setEditing(true)} className="block w-full rounded-md px-2 py-1 text-left outline-none hover:bg-[#f8f8f8] focus-visible:ring-2 focus-visible:ring-[#477bea]/20"><h1 className="break-words text-2xl font-semibold">{title}</h1></button>}<div className="mt-2 flex flex-wrap gap-x-3 px-2 text-xs text-[#999]"><NoteDomainPicker category={note.category} muses={muses} saving={saving} onChange={onChangeDomain} showPrefix /><button type="button" onClick={openDate} className="hover:text-[#477bea]">{fullNoteDate(note.created_at)}</button></div><button type="button" onClick={() => { setEditing(true); requestAnimationFrame(() => bodyRef.current?.focus()); }} className="mt-9 block w-full rounded-md px-2 py-2 text-left text-base leading-[1.7] outline-none hover:bg-[#f8f8f8] focus-visible:ring-2 focus-visible:ring-[#477bea]/20"><span className="whitespace-pre-wrap break-words">{body || note.raw_text || 'Tap to start writing.'}</span></button></article>}
          </div>
          <ReadingFormatBar onFormat={applyReadingFormat} onDone={finishEditing} editing={editing} />
          <span className="absolute bottom-3 right-5 text-[11px] text-[#999]">{saving || saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Save failed' : ''}</span>
        </section>

        {summaryOpen && <section id="note-summary-panel" className="relative min-h-[420px] overflow-y-auto border-t border-[#dedede] bg-[#f7f7f9] px-7 pb-12 pt-12 sm:px-12 xl:min-h-0 xl:border-l xl:border-t-0">
          <button type="button" onClick={() => setNotesOpen((open) => !open)} aria-controls="related-notes-panel" aria-expanded={notesOpen} className="absolute right-4 top-3 rounded-md border border-[#dedede] bg-white px-3 py-1.5 text-xs text-[#477bea] shadow-sm hover:border-[#adc3ff] hover:bg-[#edf3ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]">{notesOpen ? 'Hide notes' : 'See notes'}</button>
          {retrievalLoading ? <div className="flex h-full items-center justify-center gap-3 text-sm text-[#777]" role="status"><Loader2 className="h-5 w-5 animate-spin text-[#477bea]" /> Finding related notes{retrievalProgress?.agents_total ? ` · ${retrievalProgress.agents_done}/${retrievalProgress.agents_total}` : '…'}</div>
            : retrievalError ? <div className="flex h-full items-center justify-center text-center" role="alert"><div><h2 className="text-lg font-semibold">Could not retrieve notes</h2><p className="mt-3 max-w-sm text-sm leading-relaxed text-[#777]">{retrievalError}</p><button type="button" onClick={() => setRetrievalAttempt((attempt) => attempt + 1)} className="mt-5 rounded-md bg-[#477bea] px-4 py-2 text-sm text-white hover:bg-[#3d6ed7]">Try again</button></div></div>
            : retrieval?.summary || summaries.length ? <article className="mx-auto max-w-xl"><h2 className="text-lg font-semibold leading-snug">Summary of related notes</h2><div className="mt-7 space-y-4 text-sm leading-[1.7] text-[#333]">{retrieval?.summary ? <p>{retrieval.summary}</p> : summaries.map((summary, index) => <p key={index}>{summary}</p>)}</div></article>
            : surfacedNotes.length ? <div className="flex h-full items-center justify-center text-center"><div><h2 className="text-lg font-semibold">Summarize related notes</h2><p className="mt-3 max-w-sm text-sm leading-relaxed text-[#777]">{retrievalMode === 'relevant' ? 'A summary was not returned for these notes.' : 'Find relevant notes to create a summary of the notes shown here.'}</p><button type="button" onClick={() => { setRetrievalMode('relevant'); setRetrievalAttempt((attempt) => attempt + 1); }} className="mt-5 rounded-md bg-[#477bea] px-4 py-2 text-sm text-white hover:bg-[#3d6ed7]">{retrievalMode === 'relevant' ? 'Try again' : 'Find relevant notes'}</button></div></div>
            : <div className="flex h-full items-center justify-center text-center"><div><h2 className="text-lg font-semibold">{noteTooShortForRetrieval ? 'Keep writing to retrieve notes' : !hasOtherNotes ? 'Your next note could connect here' : 'No related notes yet'}</h2><p className="mt-3 max-w-sm text-sm leading-relaxed text-[#777]">{noteTooShortForRetrieval ? `Write at least ${MIN_RELEVANCE_DRAFT_CHARS} characters, then save to find related notes.` : !hasOtherNotes ? 'Once you have another note, Ocreda can look for connections.' : 'No notes matched this one yet.'}</p></div></div>}
        </section>}

        {notesOpen && <aside id="related-notes-panel" className="min-h-[420px] overflow-y-auto border-t border-[#dedede] bg-white p-4 xl:min-h-0 xl:border-l xl:border-t-0">
          <div className="mb-4 flex items-center justify-between gap-2"><h2 className="text-sm font-normal text-[#999]">Retrieved for this note</h2><button type="button" onClick={() => setNotesOpen(false)} className="rounded-md px-2 py-1 text-xs text-[#477bea] hover:bg-[#edf3ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]">Hide notes</button></div>
          <div className="space-y-4">
            {surfacedNotes.map((item) => {
              const content = splitNote(item);
              const retrievalResult = relevanceByNoteId.get(item.id);
              const retrievalReason = retrievalResult?.explanation.trim() ?? '';
              const retrievalSummary = retrievalResult?.gist.trim() || item.summary?.trim() || notePreview(item);
              const badge = retrievalResult?.relation_type ? RELATION_BADGES[retrievalResult.relation_type] : null;
              const flipped = Boolean(flippedReasonById[item.id]);
              return <div
                key={item.id}
                role="button"
                tabIndex={0}
                onMouseEnter={() => setSelectedNoteId(item.id)}
                onFocus={() => setSelectedNoteId(item.id)}
                onClick={() => setSelectedNoteId(item.id)}
                onDoubleClick={() => void leaveWorkspace(item)}
                onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === 'Enter') { event.preventDefault(); void leaveWorkspace(item); } }}
                aria-label={`${noteLabel(item)}${retrievalReason ? `. Retrieval reason: ${retrievalReason}` : ''}. Double-click or press Enter to open`}
                title="Double-click to open note"
                aria-pressed={selectedNote?.id === item.id}
                className={`block w-full cursor-pointer rounded-lg border bg-[#fafafb] p-3 text-left shadow-sm transition hover:border-[#8fb1ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea] ${selectedNote?.id === item.id ? 'border-[#7ca2ff] ring-1 ring-[#7ca2ff]/30' : 'border-[#e0e0e0]'}`}
              >
                <div className="flex items-start justify-between gap-2">
                  {content.hasTitle ? <strong className="min-w-0 flex-1 truncate text-sm text-[#222]">{content.title}</strong> : <span className="min-w-0 flex-1" />}
                  {badge ? <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}>{badge.label}</span> : <span className="shrink-0 text-[11px] text-[#477bea]">note</span>}
                </div>
                <p className="mt-2 line-clamp-3 text-[13px] leading-relaxed text-[#333]">{content.body || notePreview(item)}</p>
                {retrievalReason && (retrievalSummary ? <AnnotationFlip
                  summary={retrievalSummary}
                  relevance={retrievalReason}
                  flipped={flipped}
                  onFlip={() => setFlippedReasonById((current) => ({ ...current, [item.id]: !flipped }))}
                /> : <div className="mt-2.5 rounded-md bg-[#f4f7ff] px-2.5 py-2">
                  <p className="text-[9px] font-semibold uppercase tracking-[0.09em] text-[#8ba0d8]">Why it’s relevant</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-[#5d6b85]">{retrievalReason}</p>
                </div>)}
                <div className="mt-2.5 flex items-center justify-between text-[11px] text-[#aaa]"><span className="truncate">Domain: {cleanCategory(item.category) || 'Instant retrieval'}</span><span className="shrink-0">{formatDate(item.created_at)}</span></div>
              </div>;
            })}
            {!surfacedNotes.length && !retrievalLoading && !retrievalError && !noteTooShortForRetrieval && hasOtherNotes && <p className="px-4 py-12 text-center text-sm leading-relaxed text-[#999]">No related notes found yet.</p>}
          </div>
          {retrieval?.coverage.complete === false && <p className="mt-4 text-center text-xs text-[#999]">Only some notes could be searched. Results may be incomplete.</p>}
        </aside>}
      </div>

      {searchRequest && <KnowledgeSearchOverlay request={searchRequest} notes={allNotes} muses={muses} projects={projects} onClose={() => setSearchRequest(null)} onOpenPage={(project, page) => { setSearchRequest(null); onOpenPage(project, page); }} onOpenNote={(item) => { setSearchRequest(null); onOpenNote(item); }} onInstantRetrieval={() => { setSearchRequest(null); setInstantRetrievalOpen(true); }} />}
      {instantRetrievalOpen && <InstantRetrievalOverlay notes={allNotes} muses={muses} projects={projects} saving={saving} onClose={() => setInstantRetrievalOpen(false)} onOpenNote={(item) => { setInstantRetrievalOpen(false); onOpenNote(item); }} onSave={onSaveRetrieval} />}
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
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const rawText = title.trim() && body.trim() ? `${title.trim()}\n\n${body.trim()}` : title.trim() || body.trim();
  const muse = cleanCategory(note.category) || 'Instant retrieval';
  const usedMuses = useMemo(() => {
    const direct = muses.filter((item) => item.title.toLowerCase() === muse.toLowerCase());
    return (direct.length ? direct : muses).slice(0, 4);
  }, [muses, muse]);

  useEffect(() => {
    if (!editing || !rawText || rawText === note.raw_text.trim()) return;
    setSaveState('saving');
    const timeout = window.setTimeout(() => {
      onUpdate(note.id, rawText).then(() => setSaveState('saved')).catch(() => setSaveState('error'));
    }, 850);
    return () => window.clearTimeout(timeout);
  }, [body, editing, note.id, note.raw_text, onUpdate, rawText, title]);

  const applyFormat = (kind: 'bold' | 'italic' | 'h1' | 'h2' | 'h3' | 'body' | 'bullet' | 'number') => {
    setEditing(true);
    const field = bodyRef.current; if (!field) return;
    const start = field.selectionStart; const end = field.selectionEnd; const selection = body.slice(start, end);
    let replacement = selection;
    if (kind === 'bold') replacement = `**${selection || 'bold text'}**`;
    if (kind === 'italic') replacement = `*${selection || 'italic text'}*`;
    if (kind === 'h1') replacement = `# ${selection || 'Heading'}`;
    if (kind === 'h2') replacement = `## ${selection || 'Heading'}`;
    if (kind === 'h3') replacement = `### ${selection || 'Heading'}`;
    if (kind === 'body') replacement = selection.replace(/^#{1,3}\s+/gm, '');
    if (kind === 'bullet') replacement = (selection || 'List item').split('\n').map((line) => `• ${line.replace(/^[-•]\s*/, '')}`).join('\n');
    if (kind === 'number') replacement = (selection || 'List item').split('\n').map((line, index) => `${index + 1}. ${line.replace(/^\d+\.\s*/, '')}`).join('\n');
    setBody(`${body.slice(0, start)}${replacement}${body.slice(end)}`);
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(start, start + replacement.length); });
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
              <input value={title} readOnly={!editing} onClick={() => setEditing(true)} onChange={(event) => setTitle(event.target.value)} aria-label="Retrieved note title" placeholder={editing ? 'Title (optional)' : ''} className={`w-full bg-transparent text-2xl font-semibold outline-none placeholder:font-normal placeholder:text-[#c4c4c6] ${editing ? 'cursor-text' : 'cursor-pointer'}`} />
              <textarea ref={bodyRef} value={body} readOnly={!editing} onClick={() => setEditing(true)} onChange={(event) => setBody(event.target.value)} aria-label="Retrieved note text" className={`mt-8 min-h-[540px] w-full resize-none bg-transparent text-base leading-[1.7] outline-none ${editing ? 'cursor-text' : 'cursor-pointer'}`} />
            </div>
            <ReadingFormatBar onFormat={applyFormat} onDone={() => setEditing(false)} editing={editing} />
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

function ReadingFormatBar({ onFormat, onDone, editing }: { onFormat: (kind: 'bold' | 'italic' | 'h1' | 'h2' | 'h3' | 'body' | 'bullet' | 'number') => void; onDone: () => void; editing: boolean }) {
  if (!editing) return null;
  return <div className="absolute bottom-5 left-1/2 z-20 flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-1 rounded-xl bg-[#f7f7f9] px-3 py-2 text-sm text-[#555] shadow-sm"><button type="button" aria-label="Voice input" className="flex h-8 w-8 items-center justify-center rounded hover:bg-white"><Mic className="h-4 w-4" /></button><span className="mx-1 h-7 w-px bg-[#ddd]" /><button type="button" onClick={() => onFormat('bold')} className="h-8 w-8 rounded font-bold hover:bg-white">B</button><button type="button" onClick={() => onFormat('italic')} className="h-8 w-8 rounded italic hover:bg-white">I</button><span className="mx-1 h-7 w-px bg-[#ddd]" />{(['h1', 'h2', 'h3'] as const).map((kind) => <button key={kind} type="button" onClick={() => onFormat(kind)} className="hidden h-8 rounded px-2 font-semibold hover:bg-white sm:block">{kind.toUpperCase()}</button>)}<button type="button" onClick={() => onFormat('body')} className="hidden h-8 rounded px-2 hover:bg-white md:block">Body</button><span className="mx-1 hidden h-7 w-px bg-[#ddd] md:block" /><button type="button" onClick={() => onFormat('bullet')} className="hidden h-8 items-center gap-1 rounded px-2 hover:bg-white lg:flex"><List className="h-4 w-4" /> Bullet list</button><button type="button" onClick={() => onFormat('number')} className="hidden h-8 items-center gap-1 rounded px-2 hover:bg-white xl:flex"><ListOrdered className="h-4 w-4" /> Numbered list</button><button type="button" onClick={onDone} className="ml-2 h-8 rounded-md bg-[#477bea] px-3 text-white hover:bg-[#3d6ed7]">Done</button></div>;
}

function InstantRetrievalCard({ onClick, tall = false }: { onClick: () => void; tall?: boolean }) {
  return <button type="button" onClick={onClick} className={`flex w-full flex-col items-center justify-center rounded-lg border border-[#e6e6e6] bg-[#f7f7f9] text-center shadow-[0_2px_8px_rgba(0,0,0,0.1)] transition hover:-translate-y-0.5 hover:border-[#8fb1ff] hover:shadow-lg ${tall ? 'min-h-[340px]' : 'min-h-[270px]'}`}><span className="flex h-20 w-20 items-center justify-center rounded-md bg-[#477bea] text-[#8fb1ff] shadow-md"><ArrowUp className="h-16 w-16 stroke-[1.8]" /></span><span className="mt-7 text-sm font-medium text-[#222]">Instant retrieval instead</span></button>;
}

function KnowledgeSearchOverlay({ request, notes, muses, projects, hideProjectColumn = false, onClose, onOpenPage, onOpenNote, onInstantRetrieval }: {
  request: KnowledgeSearchRequest; notes: Note[]; muses: MuseMeta[]; projects: CortexProject[]; hideProjectColumn?: boolean; onClose: () => void; onOpenPage: (project: CortexProject, page: ProjectPage) => void; onOpenNote: (note: Note) => void; onInstantRetrieval: () => void;
}) {
  const [query, setQuery] = useState(request.query);
  const [filter, setFilter] = useState<KnowledgeFilter | undefined>(request.filter);
  const normalized = query.trim().toLowerCase();
  const sortedNotes = useMemo(() => [...notes].sort((a, b) => b.created_at.localeCompare(a.created_at)), [notes]);
  const filteredNotes = useMemo(() => sortedNotes.filter((note) => {
    if (filter?.kind === 'date' && localDateKey(note.created_at) !== filter.value) return false;
    if (filter?.kind === 'muse' && (cleanCategory(note.category) || 'Instant retrieval').toLowerCase() !== filter.value.toLowerCase()) return false;
    if (filter) return true;
    return !normalized || `${note.raw_text} ${note.category ?? ''}`.toLowerCase().includes(normalized);
  }), [filter, normalized, sortedNotes]);
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
          {showProjectColumn && <aside className="border-b border-[#ddd] px-7 py-10 lg:overflow-y-auto lg:border-b-0 lg:border-r sm:px-10"><p className="mb-7 text-sm text-[#aaa]">Found in project pages</p><div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-1">{matchingPages.map(({ project, page }) => <button key={`${project.id}-${page.id}`} type="button" onClick={() => onOpenPage(project, page)} className="relative min-h-[300px] rounded-lg border border-[#e3e3e3] bg-white p-7 text-left shadow-[0_2px_8px_rgba(0,0,0,0.14)] transition hover:-translate-y-0.5 hover:border-[#8fb1ff]"><strong className="block text-base"><HighlightedText text={page.title} query={query} /></strong><p className="mt-5 line-clamp-[10] whitespace-pre-wrap text-sm leading-relaxed text-[#777]"><HighlightedText text={page.content || 'Empty page'} query={query} /></p><div className="absolute inset-x-4 bottom-4 flex justify-between text-xs text-[#aaa]"><span>{project.title}</span><span>{formatDate(page.updatedAt)}</span></div></button>)}{!matchingPages.length && <p className="text-sm text-[#999] sm:col-span-2 lg:col-span-1">No project page contains this search.</p>}<InstantRetrievalCard onClick={onInstantRetrieval} tall /></div></aside>}
          <section className="min-h-0 px-7 py-10 lg:overflow-y-auto sm:px-12"><p className="mb-7 text-sm text-[#aaa]">{heading}</p><div className={`grid gap-7 ${showProjectColumn ? 'xl:grid-cols-2' : 'lg:grid-cols-2 xl:grid-cols-3'}`}>{filteredNotes.map((item) => { const content = splitNote(item); const preview = content.body || notePreview(item); return <button key={item.id} type="button" onClick={() => onOpenNote(item)} className="relative min-h-[250px] rounded-lg border border-[#e3e3e3] bg-[#f7f7f9] p-2 text-left shadow-[0_2px_8px_rgba(0,0,0,0.14)] transition hover:-translate-y-0.5 hover:border-[#8fb1ff]"><div className="h-[190px] rounded-md bg-white p-6">{content.hasTitle && <strong className="block text-base"><HighlightedText text={content.title} query={filter ? '' : query} /></strong>}<p className="mt-4 line-clamp-6 text-sm leading-relaxed text-[#777]"><HighlightedText text={preview} query={filter ? '' : query} /></p></div><div className="flex items-center justify-between px-3 py-3 text-xs text-[#aaa]"><span>{cleanCategory(item.category) || 'Instant retrieval'}</span><span>{formatDate(item.created_at)}</span></div></button>; })}{!filteredNotes.length && <p className="text-sm text-[#999] xl:col-span-2">No notes match this search.</p>}<InstantRetrievalCard onClick={onInstantRetrieval} /></div></section>
        </div>}
      </div>
    </div>
  );
}

function retrievalKeywords(value: string): string[] {
  const ignored = new Set(['about', 'after', 'also', 'been', 'between', 'could', 'difference', 'find', 'from', 'have', 'looking', 'note', 'something', 'stated', 'that', 'their', 'there', 'these', 'they', 'this', 'what', 'when', 'where', 'which', 'will', 'with', 'would']);
  return (value.toLowerCase().match(/[a-z0-9']{3,}/g) ?? []).filter((word) => !ignored.has(word));
}

function InstantRetrievalOverlay({ notes, projects, initialQuery = '', saving, onClose, onOpenNote, onSave }: {
  notes: Note[]; muses: MuseMeta[]; projects: CortexProject[]; saving: boolean; onClose: () => void; onOpenNote: (note: Note) => void;
  initialQuery?: string;
  onSave: (queryText: string, resultNotes: Note[], projectId: string, newProjectTitle?: string) => Promise<void>;
}) {
  const [phase, setPhase] = useState<'intro' | 'clarify' | 'results'>('intro');
  const [query, setQuery] = useState(initialQuery);
  const [clarificationRound, setClarificationRound] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [newProject, setNewProject] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');

  const results = useMemo(() => {
    const keywords = retrievalKeywords(query);
    return [...notes].map((note) => {
      const haystack = `${note.raw_text} ${note.category ?? ''}`.toLowerCase();
      const keywordScore = keywords.reduce((score, word) => score + (haystack.includes(word) ? 2 : 0), 0);
      return { note, score: keywordScore + sharedWordScore(query, note.raw_text) };
    }).sort((left, right) => right.score - left.score || right.note.created_at.localeCompare(left.note.created_at)).filter((item, index) => item.score > 0 || index < 2).slice(0, 6).map((item) => item.note);
  }, [notes, query]);

  useEffect(() => { setSelectedId(results[0]?.id ?? null); }, [results]);

  const keywords = retrievalKeywords(query);
  const topic = keywords.slice(-3).join(' ');
  const clarification = clarificationRound === 0
    ? `Did it mention anything about ${topic || 'a specific detail'}?`
    : 'Should I search broadly across every Domain and include the closest related ideas?';

  const beginClarification = () => {
    if (!query.trim()) return;
    setClarificationRound(0); setPhase('clarify'); setSaveMessage(''); setSaveError('');
  };

  const answerClarification = (yes: boolean) => {
    if (yes || clarificationRound > 0) setPhase('results');
    else setClarificationRound(1);
  };

  const saveTo = async (projectId: string, newProjectTitle?: string) => {
    if (!query.trim() || (!projectId && !cleanCategory(newProjectTitle))) return;
    setSaveError('');
    try {
      await onSave(query, results, projectId, newProjectTitle);
      const label = projects.find((project) => project.id === projectId)?.title ?? cleanCategory(newProjectTitle) ?? 'project';
      setSaveMessage(`Saved as a page in ${label}`); setSaveMenuOpen(false); setNewProject('');
    } catch (error) { setSaveError(safeErrorMessage(error, 'Unable to save this retrieval.')); }
  };

  if (phase === 'intro') return (
    <div className="fixed inset-0 z-[90] bg-black/25 p-3 backdrop-blur-[5px] sm:p-6" role="dialog" aria-modal="true" aria-label="Instant retrieval introduction" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <button type="button" onClick={onClose} aria-label="Close instant retrieval" className="absolute right-5 top-5 z-10 flex h-10 w-10 items-center justify-center rounded-md text-white hover:bg-white/10"><X className="h-7 w-7" /></button>
      <button type="button" onClick={() => setPhase('clarify')} className="mx-auto flex h-full w-full max-w-[1760px] items-center justify-center rounded-2xl border-[9px] border-white/80 bg-[#f7f7f9] text-left shadow-2xl">
        <span className="w-[min(90%,720px)] space-y-8 text-base leading-relaxed text-[#222] sm:text-lg"><span className="block">This is a temporary retrieval space where you can instantly find anything from your Ocreda.</span><span className="block">You can ask for a specific thing you are looking for or go as broad as you want.</span><span className="block">This will not be saved unless you save it as a page in a Project.</span><span className="block font-medium">Tap on the screen.</span></span>
      </button>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[90] bg-black/25 p-3 backdrop-blur-[5px] sm:p-6" role="dialog" aria-modal="true" aria-label="Instant retrieval workspace" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <div className="relative mx-auto flex h-full max-w-[1760px] flex-col">
        <div className="relative flex h-14 shrink-0 items-center justify-between px-2 text-white">
          <div className="relative">
            <button type="button" disabled={!query.trim() || saving} onClick={() => setSaveMenuOpen((open) => !open)} className="rounded-md bg-white px-3 py-2 text-sm text-[#222] shadow disabled:opacity-45">{saving ? 'Saving...' : 'Save this as a page'}</button>
            {saveMenuOpen && <div className="absolute left-0 top-11 z-30 w-[300px] overflow-hidden rounded-lg border border-[#ddd] bg-white py-2 text-sm text-[#222] shadow-xl"><p className="px-4 pb-2 text-xs text-[#999]">Choose a Project</p>{projects.map((project) => <button key={project.id} type="button" onClick={() => void saveTo(project.id)} className="block w-full px-4 py-2.5 text-left hover:bg-[#f5f5f5]">{project.title}</button>)}{!projects.length && <p className="px-4 py-2 text-xs text-[#999]">No projects yet. Create one below.</p>}<div className="mt-1 flex items-center gap-2 border-t border-[#eee] px-3 pt-2"><input value={newProject} onChange={(event) => setNewProject(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void saveTo('', newProject); } }} placeholder="New Project" className="min-w-0 flex-1 rounded border border-[#ddd] px-2 py-2 outline-none focus:border-[#477bea]" /><button type="button" disabled={!newProject.trim()} onClick={() => void saveTo('', newProject)} aria-label="Create Project and save page" className="rounded bg-[#477bea] p-2 text-white disabled:opacity-35"><Check className="h-4 w-4" /></button></div>{saveError && <p className="px-4 pt-2 text-xs text-red-600">{saveError}</p>}</div>}
          </div>
          {saveMessage && <span className="absolute left-1/2 -translate-x-1/2 rounded-full bg-white/90 px-4 py-1.5 text-xs text-[#477bea] shadow">{saveMessage}</span>}
          <button type="button" onClick={onClose} aria-label="Close instant retrieval" className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-white/10"><X className="h-7 w-7" /></button>
        </div>
        <div className={`grid min-h-0 flex-1 overflow-y-auto rounded-xl border border-[#cfcfcf] bg-white shadow-[0_2px_9px_rgba(0,0,0,0.16)] lg:overflow-hidden ${phase === 'results' ? 'lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,.95fr)_360px]' : 'lg:grid-cols-2'}`}>
          <section className="relative min-h-[430px] overflow-hidden bg-[#f7f7f9] px-8 py-16 shadow-[4px_0_12px_rgba(0,0,0,0.14)] sm:px-14 lg:min-h-0">
            <textarea autoFocus value={query} onChange={(event) => { setQuery(event.target.value); if (phase === 'results') setPhase('clarify'); }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); beginClarification(); } }} placeholder="Ask for a specific note or explore a broad idea…" aria-label="Instant retrieval request" className="h-full min-h-[300px] w-full resize-none bg-transparent text-lg leading-relaxed outline-none placeholder:text-[#aaa]" />
            <span className="absolute bottom-5 left-1/2 -translate-x-1/2 text-xs text-[#aaa]">Press Enter to continue · Shift+Enter for a new line</span>
          </section>
          <section className="relative min-h-[430px] overflow-y-auto bg-white px-8 py-16 sm:px-14 lg:min-h-0">
            {!query.trim() ? <p className="text-base text-[#aaa]">Start typing what you want to find.</p> : phase === 'clarify' ? <div><p className="text-lg leading-relaxed">{clarification}</p><div className="mt-8 flex gap-6"><button type="button" onClick={() => answerClarification(true)} aria-label="Yes" className="flex h-10 w-10 items-center justify-center rounded-full bg-[#477bea] text-white hover:bg-[#3d6ed7]"><Check className="h-5 w-5" /></button><button type="button" onClick={() => answerClarification(false)} aria-label="No" className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-[#222] hover:bg-[#f5f5f5]"><X className="h-5 w-5" /></button></div></div> : <div><Check className="h-10 w-10 rounded-full bg-[#477bea] p-2 text-white" /><p className="mt-10 text-lg">I have found {results.length} {results.length === 1 ? 'note' : 'notes'} that are close to your request.</p>{results[0] && <div className="mt-12 border-t border-[#eee] pt-7"><strong className="text-base">Closest match: <HighlightedText text={splitNote(results[0]).title} query={query} /></strong><p className="mt-4 line-clamp-8 whitespace-pre-wrap text-sm leading-relaxed text-[#555]"><HighlightedText text={splitNote(results[0]).body || notePreview(results[0])} query={query} /></p></div>}</div>}
          </section>
          {phase === 'results' && <aside className="min-h-[430px] overflow-y-auto border-l border-[#d6d6d6] bg-white p-5 lg:min-h-0"><div className="mb-4 flex items-center justify-between"><h2 className="text-sm text-[#999]">Retrieved notes</h2><span className="rounded border border-[#bbb] px-3 py-1 text-xs text-[#477bea]">See notes</span></div><div className="space-y-5">{results.map((item) => { const content = splitNote(item); return <button key={item.id} type="button" onMouseEnter={() => setSelectedId(item.id)} onFocus={() => setSelectedId(item.id)} onClick={() => onOpenNote(item)} className={`block min-h-[200px] w-full rounded-lg border bg-white p-5 text-left shadow-[0_2px_8px_rgba(0,0,0,0.13)] transition hover:-translate-y-0.5 ${selectedId === item.id ? 'border-[#6f9cff] ring-1 ring-[#6f9cff]/40' : 'border-[#e2e2e2]'}`}><span className="float-right text-xs text-[#477bea]">note</span>{content.hasTitle && <strong className="block max-w-[82%] text-base"><HighlightedText text={content.title} query={query} /></strong>}<p className="mt-4 line-clamp-6 whitespace-pre-wrap text-sm leading-relaxed text-[#777]"><HighlightedText text={content.body || notePreview(item)} query={query} /></p><div className="mt-7 flex justify-between text-xs text-[#aaa]"><span>{cleanCategory(item.category) || 'Instant retrieval'}</span><span>{formatDate(item.created_at)}</span></div></button>; })}{!results.length && <p className="text-sm text-[#999]">No close notes yet. Try a broader request.</p>}</div></aside>}
        </div>
      </div>
    </div>
  );
}

type RelevanceSearch = { results: RelevanceResult[]; coverage: RelevanceCoverage; summary?: string };

// Five per page rather than ten, so each card has room to preview the note's
// own text under the explanation instead of only its title.
const RELEVANCE_PAGE_SIZE = 5;

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
};

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
            {visible.map((result) => {
              const note = noteById.get(result.note_id);
              if (!note) return null;
              const content = splitNote(note);
              const badge = result.relation_type ? RELATION_BADGES[result.relation_type] : null;
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
                    <span>{Math.round(result.relevance_score * 100)}% {result.explanation ? 'match' : 'similarity'}</span>
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
        {stale && <p className="text-[11px] leading-relaxed text-[#a06a00]">Your draft changed since this search. Run it again to refresh.</p>}
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
  const bodyRef = useRef<HTMLTextAreaElement>(null);
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

  // Matches how saveNote assembles raw_text, so the draft is scored as the
  // note it will actually become.
  const draftText = useMemo(() => {
    const title = state.title.trim(); const body = state.body.trim();
    return title && body ? `${title}\n\n${body}` : title || body;
  }, [state.body, state.title]);

  const draftTooShort = draftText.length < MIN_RELEVANCE_DRAFT_CHARS;
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
    if (draftTooShort || relevanceLoading) return;
    setPanelOpen(true); setRelevanceError(''); setRelevancePage(0);

    const cached = relevanceCache.current.get(draftText);
    if (cached) { setRelevance(cached); setSearchedDraft(draftText); return; }

    setRelevanceProgress(null); setRelevanceLoading(true);
    try {
      const response = await findRelevantNotes(draftText, state.note?.id ?? null, setRelevanceProgress);
      relevanceCache.current.set(draftText, response);
      setRelevance(response); setSearchedDraft(draftText);
    } catch (err) {
      setRelevance(null);
      setRelevanceError(safeErrorMessage(err, 'Could not search your notes right now.'));
    } finally {
      setRelevanceLoading(false);
    }
  };

  const applyFormat = (kind: 'bold' | 'italic' | 'h1' | 'h2' | 'h3' | 'body' | 'bullet' | 'number') => {
    const field = bodyRef.current;
    if (!field) return;
    const start = field.selectionStart; const end = field.selectionEnd;
    const selection = state.body.slice(start, end);
    let replacement = selection;
    if (kind === 'bold') replacement = `**${selection || 'bold text'}**`;
    if (kind === 'italic') replacement = `*${selection || 'italic text'}*`;
    if (kind === 'h1') replacement = `# ${selection || 'Heading'}`;
    if (kind === 'h2') replacement = `## ${selection || 'Heading'}`;
    if (kind === 'h3') replacement = `### ${selection || 'Heading'}`;
    if (kind === 'body') replacement = selection.replace(/^#{1,3}\s+/gm, '');
    if (kind === 'bullet') replacement = (selection || 'List item').split('\n').map((line) => `• ${line.replace(/^[-•]\s*/, '')}`).join('\n');
    if (kind === 'number') replacement = (selection || 'List item').split('\n').map((line, index) => `${index + 1}. ${line.replace(/^\d+\.\s*/, '')}`).join('\n');
    onChange({ ...state, body: `${state.body.slice(0, start)}${replacement}${state.body.slice(end)}` });
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(start, start + replacement.length); });
  };

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

  const museLabel = state.muse === AUTOMATIC_MUSE ? 'Automatically organize' : state.muse;
  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center ${domainCapture ? 'bg-[#e5e5e5] p-3 sm:p-6' : 'bg-black/25 p-4 backdrop-blur-[5px]'}`} role="dialog" aria-modal="true" aria-label={state.note ? 'Edit note' : 'Create note'} onMouseDown={(event) => { if (!domainCapture && event.target === event.currentTarget && !saving) onClose(); }}>
      {!domainCapture && <button type="button" onClick={onClose} aria-label="Close note editor" className="absolute right-5 top-5 z-10 text-white drop-shadow sm:right-8 sm:top-7"><X className="h-7 w-7" /></button>}
      <div className={`flex min-h-[530px] flex-col bg-white ${domainCapture ? 'h-full w-full overflow-hidden shadow-[0_8px_24px_rgba(0,0,0,0.12)]' : 'h-[min(78vh,780px)] w-[min(88vw,1340px)] overflow-visible rounded-[20px] border-[9px] border-[#f5f5f7] shadow-2xl'}`}>
        {domainCapture && <header className="relative z-30 grid shrink-0 grid-cols-[1fr_auto] grid-rows-[64px_44px] items-center border-b border-[#eeeeef] bg-white px-2 text-[#aaa] sm:flex sm:h-16 sm:px-6">
          <div className="flex min-w-0 items-center gap-1 sm:gap-2">
            <button type="button" onClick={onClose} aria-label="Close note editor" title="Close note editor" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-[#f5f5f6] hover:text-[#555]"><ArrowLeft className="h-5 w-5" /></button>
            <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-md bg-[#477bea] text-white"><Plus className="h-4 w-4" /></span>
            <button type="button" onClick={onImport} aria-label="Import notes" title="Import notes" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-[#f5f5f6] hover:text-[#555]"><Upload className="h-5 w-5" /></button>
            <button type="button" onClick={onFindRelevantNotes} disabled={draftTooShort || saving} aria-label="Find relevant notes" title={draftTooShort ? `Write at least ${MIN_RELEVANCE_DRAFT_CHARS} characters to search your notes` : 'Find relevant notes'} className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-[#f5f5f6] hover:text-[#477bea] disabled:opacity-35">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-5 w-5" />}</button>
          </div>
          <div ref={museMenuRef} className="relative col-span-2 row-start-2 z-40 max-w-full justify-self-center sm:absolute sm:left-1/2 sm:-translate-x-1/2">
            <button type="button" onClick={() => setMuseOpen((value) => !value)} aria-expanded={museOpen} className="flex max-w-[calc(100vw-3rem)] items-center rounded px-2 py-1 text-xs text-[#555] hover:bg-[#f5f5f6] sm:max-w-[40vw]"><span className="shrink-0">Domain:&nbsp;</span><span className="truncate border-b border-[#999]">{museLabel}</span><ChevronDown className="ml-1 h-3.5 w-3.5 shrink-0" /></button>
            {museOpen && <div className="absolute left-1/2 top-8 z-50 w-[285px] -translate-x-1/2 overflow-hidden rounded-lg border border-[#ddd] bg-white py-2 text-left text-[#555] shadow-xl">
              <button type="button" onClick={() => { onChange({ ...state, muse: AUTOMATIC_MUSE }); setMuseOpen(false); }} className="flex w-full items-center justify-between px-5 py-3 text-left text-sm hover:bg-[#f6f6f6] focus:bg-[#f6f6f6] focus:outline-none">Automatically organize {state.muse === AUTOMATIC_MUSE && <Check className="h-4 w-4 text-[#477bea]" />}</button>
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
            <textarea ref={bodyRef} value={state.body} onFocus={() => setEditingStarted(true)} onChange={(event) => onChange({ ...state, body: event.target.value })} placeholder={editingStarted ? '' : domainCapture ? 'Knowledge is what makes people special, and special people do special things, so make this one count.' : "For example: Someone made the point that we mostly don't choose our beliefs, we absorb them and backfill reasons after. Uncomfortable but I can't argue with it. Makes me wonder how much of what I think is actually mine."} aria-label="Note body" className={`mt-5 min-h-0 w-full flex-1 resize-none bg-transparent text-base leading-relaxed outline-none placeholder:text-[#aaa] ${domainCapture ? 'max-w-2xl sm:text-lg sm:leading-[1.65]' : ''}`} />
          </div>
          {panelOpen && <RelevantNotesPanel notes={notes} relevance={relevance} loading={relevanceLoading} progress={relevanceProgress} error={relevanceError} stale={draftChangedSinceSearch} page={relevancePage} onPageChange={setRelevancePage} onRetry={() => void runRelevanceSearch()} onClose={() => setPanelOpen(false)} />}
        </div>
        <div className={`relative border-t border-[#eee] bg-[#f8f8fa] px-3 py-2 text-sm text-[#555] sm:px-5 ${domainCapture ? 'flex min-h-[62px] flex-col items-stretch gap-2 lg:flex-row lg:items-center lg:gap-1' : 'flex min-h-[58px] flex-wrap items-center gap-1'}`}>
          <div className={`${domainCapture ? 'flex w-full min-w-0 items-center gap-1 overflow-x-auto pb-1 lg:flex-1 lg:overflow-visible lg:pb-0' : 'contents'}`}>
            <button type="button" onClick={toggleDictation} aria-label={dictating ? 'Stop dictation' : 'Start dictation'} className={`mr-3 rounded p-2 hover:bg-white ${dictating ? 'text-red-600' : ''}`}><Mic className="h-4 w-4" /></button><span className="mr-3 h-7 w-px bg-[#ddd]" />
            <button type="button" onClick={() => applyFormat('bold')} aria-label="Bold" className="rounded p-2 font-bold hover:bg-white"><Bold className="h-4 w-4" /></button>
            <button type="button" onClick={() => applyFormat('italic')} aria-label="Italic" className="rounded p-2 italic hover:bg-white"><Italic className="h-4 w-4" /></button><span className="mx-2 h-7 w-px bg-[#ddd]" />
            <button type="button" onClick={() => applyFormat('h1')} className="rounded px-2 py-1.5 font-semibold hover:bg-white">H1</button><button type="button" onClick={() => applyFormat('h2')} className="rounded px-2 py-1.5 font-semibold hover:bg-white">H2</button><button type="button" onClick={() => applyFormat('h3')} className="rounded px-2 py-1.5 font-semibold hover:bg-white">H3</button><button type="button" onClick={() => applyFormat('body')} className="rounded px-2 py-1.5 hover:bg-white">Body</button><span className="mx-2 hidden h-7 w-px bg-[#ddd] lg:block" />
            <button type="button" onClick={() => applyFormat('bullet')} className="hidden items-center gap-1 rounded px-2 py-1.5 hover:bg-white sm:flex"><List className="h-4 w-4" /> Bullet list</button><button type="button" onClick={() => applyFormat('number')} className="hidden items-center gap-1 rounded px-2 py-1.5 hover:bg-white md:flex"><ListOrdered className="h-4 w-4" /> Numbered list</button>
            <span className="mx-2 h-7 w-px bg-[#ddd]" />
          </div>
          <div className={`${domainCapture ? 'flex w-full items-center gap-2 lg:w-auto lg:gap-1' : 'contents'}`}>
            <button type="button" onClick={onFindRelevantNotes} disabled={draftTooShort || saving} title={draftTooShort ? `Write at least ${MIN_RELEVANCE_DRAFT_CHARS} characters to search your notes` : 'Find relevant notes'} className="flex items-center gap-1.5 rounded px-2 py-1.5 font-medium text-[#477bea] hover:bg-white disabled:opacity-40">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}
              <span className="hidden lg:inline">Find relevant notes</span>
            </button>
          {!domainCapture && <div className="relative ml-auto shrink-0">
            <button type="button" onClick={() => setMuseOpen((value) => !value)} className="flex items-center text-sm"><span className="text-[#477bea]">Domain:</span>&nbsp;<span className="border-b border-[#999]">{museLabel}</span><ChevronDown className="ml-1 h-3.5 w-3.5" /></button>
            {museOpen && <div className="absolute bottom-9 right-0 z-[60] w-[285px] overflow-hidden rounded-lg border border-[#ddd] bg-white py-2 shadow-xl">
              <button type="button" onClick={() => { onChange({ ...state, muse: AUTOMATIC_MUSE }); setMuseOpen(false); }} className="flex w-full items-center justify-between px-5 py-3 text-left text-sm hover:bg-[#f6f6f6]">Automatically organize {state.muse === AUTOMATIC_MUSE && <Check className="h-4 w-4 text-[#477bea]" />}</button>
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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[6px]" role="dialog" aria-modal="true" aria-label={state.originalTitle ? 'Edit Domain' : 'Create Domain'} onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <div className="relative w-[min(92vw,570px)]">
        <button type="button" onClick={onClose} aria-label="Close Domain editor" className="absolute right-2 top-2 z-10 text-[#777] sm:-right-10 sm:-top-8 sm:text-white"><X className="h-7 w-7" /></button>
        <div className="rounded-xl border-[9px] border-[#f4f4f6] bg-[#f7f7f9] p-2 shadow-2xl">
          <textarea autoFocus id="muse-description" maxLength={600} value={state.description} onChange={(event) => onChange({ ...state, description: event.target.value })} placeholder={'Describe how you want to use this Domain\n\nE.g: I will use this Domain to collect ideas about business, philosophy, or a project I am building.'} aria-label="Domain description" className="h-[300px] w-full resize-none rounded-lg bg-white p-6 text-base leading-relaxed text-[#555] outline-none placeholder:text-[#aaa]" />
          <input maxLength={80} value={state.title} onChange={(event) => onChange({ ...state, title: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) onSave(); }} placeholder="Title of the Domain" aria-label="Domain title" className="w-full bg-transparent px-4 py-5 text-2xl font-bold text-[#555] outline-none placeholder:text-[#777]" />
        </div>
        <button type="button" onClick={onSave} disabled={saving || !state.title.trim()} className="mx-auto mt-9 flex h-9 w-[180px] max-w-[80vw] items-center justify-center rounded-md bg-[#477bea] text-white hover:bg-[#3d6ed7] disabled:opacity-45">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}</button>
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
