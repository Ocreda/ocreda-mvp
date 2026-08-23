'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Bold, Check, ChevronDown, ChevronLeft, ChevronRight, Filter, FolderPlus, Grid2X2, Italic, List, ListOrdered, Loader as Loader2, Mic, MoreHorizontal, PanelRightOpen, Plus, Rows3, Search, Trash2, Upload, X } from 'lucide-react';
import NoteImporter, { ImportNoteDraft } from '@/components/NoteImporter';
import { useAuth } from '@/lib/auth-context';
import { createNote, deleteNote, getNoteRelations, getNotes, importNotes, moveNotesToCategory, processNote, updateNote } from '@/lib/notes-api';
import { supabase } from '@/lib/supabase';
import { Note } from '@/lib/types';

type CortexMeta = { title: string; description: string; createdAt: string };
type NoteEditorState = { note: Note | null; title: string; body: string; muse: string };
type CortexEditorState = { originalTitle: string | null; title: string; description: string };
type SpeechRecognitionLike = {
  lang: string; continuous: boolean; interimResults: boolean;
  start: () => void; stop: () => void;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
  onerror: (() => void) | null; onend: (() => void) | null;
};

const AUTOMATIC_MUSE = '__automatic__';

function cleanCategory(value: string | null | undefined): string | null {
  const clean = value?.trim().replace(/\s+/g, ' ') ?? '';
  return clean || null;
}

function splitNote(note: Note): { title: string; body: string } {
  const text = note.raw_text.trim();
  if (!text) return { title: 'Untitled note', body: '' };
  const [first, ...rest] = text.split('\n');
  return { title: (first.trim() || 'Untitled note').slice(0, 120), body: rest.join('\n').trim() };
}

function notePreview(note: Note): string {
  const { body } = splitNote(note);
  return (body || note.raw_text).replace(/[#*_>`~-]/g, '').replace(/\s+/g, ' ').trim();
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(value));
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return hash;
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

function inferMuse(text: string, cortexes: CortexMeta[]): string | null {
  if (!cortexes.length) return null;
  const ignored = new Set(['this', 'that', 'with', 'from', 'have', 'will', 'your', 'about', 'into', 'were', 'when']);
  const words = new Set((text.toLowerCase().match(/[a-z0-9']{3,}/g) ?? []).filter((word) => !ignored.has(word)));
  const ranked = cortexes.map((cortex) => {
    const titleWords = cortex.title.toLowerCase().match(/[a-z0-9']{3,}/g) ?? [];
    const descriptionWords = cortex.description.toLowerCase().match(/[a-z0-9']{3,}/g) ?? [];
    const score = titleWords.reduce((sum, word) => sum + (words.has(word) ? 3 : 0), 0) + descriptionWords.reduce((sum, word) => sum + (words.has(word) ? 1 : 0), 0);
    return { title: cortex.title, score };
  });
  const best = ranked.sort((a, b) => b.score - a.score)[0];
  return best && best.score > 0 ? best.title : null;
}

function OcredaMark({ className = '' }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/ocreda-logo.png" alt="" aria-hidden="true" className={`object-contain ${className}`} />;
}

export default function OcredaHome() {
  const router = useRouter();
  const { user } = useAuth();
  const [notes, setNotes] = useState<Note[]>([]);
  const [cortexMeta, setCortexMeta] = useState<CortexMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState('');
  const [noteEditor, setNoteEditor] = useState<NoteEditorState | null>(null);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [cortexEditor, setCortexEditor] = useState<CortexEditorState | null>(null);
  const [activeCortex, setActiveCortex] = useState<string | null>(null);
  const [showUnsorted, setShowUnsorted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [error, setError] = useState('');
  const [importError, setImportError] = useState('');
  const [importProgress, setImportProgress] = useState<{ completed: number; total: number } | null>(null);

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
    try {
      const stored = localStorage.getItem(`ocreda-cortexes:${user.id}`);
      if (stored) {
        const parsed = JSON.parse(stored) as CortexMeta[];
        if (Array.isArray(parsed)) setCortexMeta(parsed.filter((item) => item && typeof item.title === 'string'));
      }
    } catch { /* categories still derive from notes */ }
    supabase.from('user_settings').select('full_name').eq('user_id', user.id).maybeSingle().then(({ data }) => {
      const authName = String(user.user_metadata?.full_name ?? user.user_metadata?.name ?? '').trim();
      setDisplayName(data?.full_name?.trim() || authName || user.email?.split('@')[0] || 'you');
    });
  }, [user]);

  const persistCortexMeta = useCallback((next: CortexMeta[]) => {
    setCortexMeta(next);
    if (user) localStorage.setItem(`ocreda-cortexes:${user.id}`, JSON.stringify(next));
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

  const cortexes = useMemo(() => {
    const map = new Map<string, CortexMeta>();
    cortexMeta.forEach((item) => { const title = cleanCategory(item.title); if (title) map.set(title.toLowerCase(), { ...item, title }); });
    notes.forEach((note) => {
      const title = cleanCategory(note.category);
      if (title && !map.has(title.toLowerCase())) map.set(title.toLowerCase(), { title, description: '', createdAt: note.created_at });
    });
    return Array.from(map.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [cortexMeta, notes]);

  const notesByCortex = useMemo(() => {
    const grouped = new Map<string, Note[]>();
    cortexes.forEach((cortex) => grouped.set(cortex.title, []));
    notes.forEach((note) => {
      const category = cleanCategory(note.category);
      if (!category) return;
      const canonical = cortexes.find((cortex) => cortex.title.toLowerCase() === category.toLowerCase())?.title ?? category;
      grouped.set(canonical, [...(grouped.get(canonical) ?? []), note]);
    });
    return grouped;
  }, [cortexes, notes]);

  const unsortedNotes = useMemo(() => notes.filter((note) => !cleanCategory(note.category)), [notes]);
  const isEmpty = !loading && notes.length === 0 && cortexes.length === 0;
  const flashSaved = () => { setSavedOpen(true); window.setTimeout(() => setSavedOpen(false), 1350); };
  const closeLibrary = useCallback(() => { router.push('/profile'); }, [router]);
  const openNewNote = (muse = AUTOMATIC_MUSE) => { setError(''); setNoteEditor({ note: null, title: '', body: '', muse }); };
  const openExistingNote = (note: Note) => { setError(''); setActiveNoteId(note.id); };
  const createMuseFromEditor = (value: string) => {
    const requested = cleanCategory(value);
    if (!requested) return;
    const existing = cortexes.find((item) => item.title.toLowerCase() === requested.toLowerCase());
    const title = existing?.title ?? requested;
    if (!existing) persistCortexMeta([...cortexMeta, { title, description: '', createdAt: new Date().toISOString() }]);
    setNoteEditor((current) => current ? { ...current, muse: title } : current);
  };

  const saveNote = async () => {
    if (!noteEditor) return;
    const title = noteEditor.title.trim(); const body = noteEditor.body.trim();
    if (!title && !body) { setError('Write something before saving.'); return; }
    const rawText = title && body ? `${title}\n\n${body}` : title || body;
    const category = noteEditor.muse === AUTOMATIC_MUSE ? inferMuse(rawText, cortexes) : cleanCategory(noteEditor.muse);
    setSaving(true); setError('');
    try {
      if (noteEditor.note) {
        const updated = await updateNote(noteEditor.note.id, rawText, category);
        setNotes((current) => current.map((note) => note.id === updated.id ? { ...updated, category } : note));
        persistMuseAssignments([updated.id], category);
      } else {
        const created = await createNote(rawText, category);
        setNotes((current) => [{ ...created, category }, ...current]);
        persistMuseAssignments([created.id], category);
        processNote(created.id).catch(() => {});
      }
      setNoteEditor(null); flashSaved();
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
      const updated = await updateNote(noteId, rawText, cleanCategory(current.category));
      setNotes((items) => items.map((note) => note.id === noteId ? { ...updated, category: current.category } : note));
    } catch (err) { setError(safeErrorMessage(err, 'Unable to save this note.')); throw err; }
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

  const saveInstantRetrieval = async (queryText: string, resultNotes: Note[], category: string) => {
    const muse = cleanCategory(category);
    if (!muse) throw new Error('Choose or create a cortex first.');
    setSaving(true); setError('');
    try {
      const existing = cortexes.find((item) => item.title.toLowerCase() === muse.toLowerCase());
      const canonicalMuse = existing?.title ?? muse;
      if (!existing) persistCortexMeta([...cortexMeta, { title: canonicalMuse, description: `Saved instant retrievals about ${queryText.trim()}.`, createdAt: new Date().toISOString() }]);
      const sources = resultNotes.slice(0, 5).map((item) => `• ${splitNote(item).title}`).join('\n');
      const rawText = `Instant retrieval — ${queryText.trim()}\n\nI searched my Ocreda for: ${queryText.trim()}.${sources ? `\n\nSurfaced notes:\n${sources}` : ''}`;
      const created = await createNote(rawText, canonicalMuse);
      const saved = { ...created, category: canonicalMuse };
      setNotes((current) => [saved, ...current]);
      persistMuseAssignments([created.id], canonicalMuse);
      processNote(created.id).catch(() => {});
      flashSaved();
      return saved;
    } catch (err) { setError(safeErrorMessage(err, 'Unable to save this retrieval.')); throw err; }
    finally { setSaving(false); }
  };

  const saveCortex = async () => {
    if (!cortexEditor) return;
    const title = cleanCategory(cortexEditor.title);
    if (!title) { setError('Add a title for this cortex.'); return; }
    if (cortexes.some((item) => item.title.toLowerCase() === title.toLowerCase() && item.title !== cortexEditor.originalTitle)) { setError('A cortex with this title already exists.'); return; }
    setSaving(true); setError('');
    try {
      if (cortexEditor.originalTitle && cortexEditor.originalTitle !== title) {
        const affected = notesByCortex.get(cortexEditor.originalTitle) ?? [];
        const updated = await moveNotesToCategory(affected.map((note) => note.id), title);
        const updates = new Map(updated.map((note) => [note.id, note]));
        setNotes((current) => current.map((note) => updates.get(note.id) ?? note));
        persistMuseAssignments(affected.map((note) => note.id), title);
      }
      const originalKey = cortexEditor.originalTitle?.toLowerCase();
      const next = cortexMeta.filter((item) => item.title.toLowerCase() !== originalKey && item.title.toLowerCase() !== title.toLowerCase());
      next.push({ title, description: cortexEditor.description.trim(), createdAt: cortexMeta.find((item) => item.title.toLowerCase() === originalKey)?.createdAt ?? new Date().toISOString() });
      persistCortexMeta(next);
      if (activeCortex === cortexEditor.originalTitle) setActiveCortex(title);
      setCortexEditor(null); flashSaved();
    } catch (err) { setError(safeErrorMessage(err, 'Unable to save this cortex.')); }
    finally { setSaving(false); }
  };

  const removeCortex = async (title: string) => {
    if (!confirm(`Delete “${title}”? Its notes will return to Instant retrieval.`)) return;
    setSaving(true);
    try {
      const updated = await moveNotesToCategory((notesByCortex.get(title) ?? []).map((note) => note.id), null);
      const updates = new Map(updated.map((note) => [note.id, note]));
      setNotes((current) => current.map((note) => updates.get(note.id) ?? note));
      persistMuseAssignments((notesByCortex.get(title) ?? []).map((note) => note.id), null);
      persistCortexMeta(cortexMeta.filter((item) => item.title.toLowerCase() !== title.toLowerCase())); setActiveCortex(null);
    } catch (err) { setError(safeErrorMessage(err, 'Unable to delete this cortex.')); }
    finally { setSaving(false); }
  };

  const handleImport = async (drafts: ImportNoteDraft[]) => {
    setImportError('');
    try {
      const imported = await importNotes(drafts.map((draft) => draft.rawText), (completed, total) => setImportProgress({ completed, total }));
      setNotes((current) => [...imported, ...current]); imported.forEach((note) => processNote(note.id).catch(() => {}));
      setImportProgress(null); flashSaved();
    } catch (err) { setImportProgress(null); setImportError(safeErrorMessage(err, 'Your notes could not be imported.')); throw err; }
  };

  if (loading) return <div className="flex h-[100dvh] items-center justify-center overflow-hidden bg-white"><Loader2 className="h-7 w-7 animate-spin text-[#477bea]" /></div>;

  return (
    <main className="light h-[100dvh] w-full overflow-hidden bg-white text-[#141414]">
      <section className="relative flex h-full w-full flex-col overflow-hidden bg-white">
        {activeNoteId && notes.find((note) => note.id === activeNoteId) ? <NoteReadingWorkspace key={activeNoteId} note={notes.find((note) => note.id === activeNoteId)!} allNotes={notes} cortexes={cortexes} saving={saving} onBack={() => setActiveNoteId(null)} onAddNote={() => openNewNote(cleanCategory(notes.find((note) => note.id === activeNoteId)?.category) ?? AUTOMATIC_MUSE)} onImport={handleImport} onOpenNote={(note) => setActiveNoteId(note.id)} onUpdate={updateReadingNote} onDelete={removeReadingNote} onSaveRetrieval={saveInstantRetrieval} />
          : isEmpty ? <EmptyWorkspace displayName={displayName} userEmail={user?.email ?? ''} onAddNote={() => openNewNote()} onImport={handleImport} importError={importError} progress={importProgress} />
          : activeCortex || showUnsorted ? <CortexDetail title={showUnsorted ? 'Instant retrieval' : activeCortex ?? ''} notes={showUnsorted ? unsortedNotes : notesByCortex.get(activeCortex ?? '') ?? []} isUnsorted={showUnsorted} busy={saving} onBack={() => { setActiveCortex(null); setShowUnsorted(false); }} onAddNote={() => openNewNote(showUnsorted ? AUTOMATIC_MUSE : activeCortex ?? AUTOMATIC_MUSE)} onOpenNote={openExistingNote} onEdit={() => { const meta = cortexes.find((item) => item.title === activeCortex); if (meta) setCortexEditor({ originalTitle: meta.title, title: meta.title, description: meta.description }); }} onDelete={() => { if (activeCortex) void removeCortex(activeCortex); }} />
          : <CortexGrid cortexes={cortexes} notes={notes} notesByCortex={notesByCortex} busy={saving} onClose={closeLibrary} onAddNote={(muse) => openNewNote(muse ?? AUTOMATIC_MUSE)} onAddCortex={() => setCortexEditor({ originalTitle: null, title: '', description: '' })} onEditCortex={(cortex) => setCortexEditor({ originalTitle: cortex.title, title: cortex.title, description: cortex.description })} onDeleteCortex={(title) => void removeCortex(title)} onOpenNote={openExistingNote} onImport={handleImport} onSaveRetrieval={saveInstantRetrieval} />}
        {error && !noteEditor && !cortexEditor && <div role="alert" className="fixed bottom-5 left-1/2 z-40 max-w-[90vw] -translate-x-1/2 rounded-lg bg-[#202020] px-4 py-3 text-sm text-white shadow-xl">{error}<button type="button" onClick={() => setError('')} aria-label="Dismiss error" className="ml-4"><X className="inline h-4 w-4" /></button></div>}
      </section>
      {noteEditor && <NoteEditor state={noteEditor} cortexes={cortexes} saving={saving} error={error} onChange={setNoteEditor} onCreateMuse={createMuseFromEditor} onClose={() => { setNoteEditor(null); setError(''); }} onSave={() => void saveNote()} onDelete={noteEditor.note ? () => void removeNote() : undefined} />}
      {cortexEditor && <CortexEditor state={cortexEditor} saving={saving} error={error} onChange={setCortexEditor} onClose={() => { setCortexEditor(null); setError(''); }} onSave={() => void saveCortex()} />}
      {savedOpen && <SavedConfirmation />}
    </main>
  );
}

function Avatar({ email }: { email: string }) {
  return <Link href="/profile" aria-label="Open profile" className="flex h-9 w-9 items-center justify-center rounded-full bg-[#bd315c] text-sm font-medium text-white hover:opacity-90 sm:h-10 sm:w-10">{(email[0] || 'U').toUpperCase()}</Link>;
}

function BetaAndAvatar({ email, feedback = false }: { email: string; feedback?: boolean }) {
  return (
    <div className="flex items-center gap-4">
      <div className="inline-flex overflow-hidden rounded-md border border-[#a8c4ff] text-sm">
        <span className="bg-[#edf3ff] px-4 py-1.5 text-[#477bea]">Beta</span>
        {feedback && <a href="mailto:feedback@ocreda.com" className="border-l border-[#a8c4ff] px-3 py-1.5 text-[#252525] hover:bg-[#f5f7fb]">Send feedback</a>}
      </div>
      <Avatar email={email} />
    </div>
  );
}

function EmptyWorkspace({ displayName, userEmail, onAddNote, onImport, importError, progress }: {
  displayName: string; userEmail: string; onAddNote: () => void;
  onImport: (drafts: ImportNoteDraft[]) => Promise<void>; importError: string;
  progress: { completed: number; total: number } | null;
}) {
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-y-auto bg-white px-5 md:overflow-hidden sm:px-10">
      <div className="flex h-[72px] shrink-0 items-start justify-end pt-5 sm:h-[82px] sm:pt-7"><BetaAndAvatar email={userEmail} /></div>
      <div className="flex flex-none flex-col items-center justify-start py-5 sm:py-7 md:min-h-0 md:flex-1 md:justify-center">
      <div className="mx-auto w-full max-w-[920px]">
        <div className="text-center">
          <h1 className="flex items-center justify-center gap-3 text-[28px] font-medium tracking-[-0.02em] sm:text-[36px]"><OcredaMark className="h-9 w-9 sm:h-10 sm:w-10" /> Welcome to Ocreda, {displayName || 'you'}</h1>
          <p className="mt-2 text-base text-[#777] sm:text-lg">Let your knowledge proactively come to you without asking</p>
        </div>
        <div className="mt-[clamp(32px,5vh,64px)] grid items-start gap-4 md:grid-cols-2">
          <NoteImporter onImport={onImport} importError={importError} />
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

type LibrarySort = 'newest' | 'oldest' | 'random' | 'date';

function CortexGrid({ cortexes, notes, notesByCortex, busy, onClose, onAddNote, onAddCortex, onEditCortex, onDeleteCortex, onOpenNote, onImport, onSaveRetrieval }: {
  cortexes: CortexMeta[]; notes: Note[]; notesByCortex: Map<string, Note[]>; busy: boolean;
  onClose: () => void;
  onAddNote: (muse?: string) => void; onAddCortex: () => void; onEditCortex: (cortex: CortexMeta) => void;
  onDeleteCortex: (title: string) => void; onOpenNote: (note: Note) => void;
  onImport: (drafts: ImportNoteDraft[]) => Promise<void>;
  onSaveRetrieval: (queryText: string, resultNotes: Note[], category: string) => Promise<Note>;
}) {
  const [selectedMuses, setSelectedMuses] = useState<Set<string>>(new Set());
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [sort, setSort] = useState<LibrarySort>('newest');
  const [randomSeed, setRandomSeed] = useState(() => Date.now());
  const [sortOpen, setSortOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [date, setDate] = useState('');
  const [musesOpen, setMusesOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [instantRetrievalOpen, setInstantRetrievalOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || searchOpen || sortOpen || musesOpen || importOpen || instantRetrievalOpen) return;
      if (document.querySelector('[aria-modal="true"], [role="status"]')) return;
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [importOpen, instantRetrievalOpen, musesOpen, onClose, searchOpen, sortOpen]);

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
  const toggleMuse = (title: string) => setSelectedMuses((current) => {
    const next = new Set(current);
    if (next.has(title)) next.delete(title); else next.add(title);
    return next;
  });

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-white">
      <header className="relative z-20 flex h-[118px] shrink-0 items-end gap-3 overflow-x-auto bg-[#bdbdbd] px-5 pb-4 pt-10 lg:px-7">
        <button type="button" onClick={onAddCortex} className="h-10 shrink-0 rounded-md border border-white bg-transparent px-8 text-sm italic text-white shadow hover:bg-white/10">Create</button>
        <button type="button" onClick={resetLibrary} className={`h-10 shrink-0 rounded-md px-9 text-sm shadow ${selectedMuses.size === 0 ? 'bg-[#202020] text-white' : 'bg-white text-[#222]'}`}>All</button>
        {cortexes.slice(0, 5).map((cortex) => <button key={cortex.title} type="button" onClick={() => toggleMuse(cortex.title)} className={`h-10 min-w-[174px] shrink-0 rounded-md px-5 text-sm shadow ${selectedMuses.has(cortex.title) ? 'bg-[#202020] text-white' : 'bg-[#fbfbfd] text-[#b5b5b5]'}`}>{cortex.title}</button>)}
        <button type="button" onClick={() => setMusesOpen(true)} className="ml-auto h-10 min-w-[170px] shrink-0 rounded-md bg-white px-8 text-sm text-[#222] shadow hover:bg-[#f8f8f8]">See all</button>
        <button type="button" onClick={onClose} aria-label="Close note library" title="Close note library" className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-md text-white drop-shadow hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"><X className="h-6 w-6" /></button>
      </header>

      <div className="relative min-h-0 flex-1 overflow-y-auto bg-white">
        <aside className="absolute left-5 top-24 z-10 flex w-24 flex-col items-center text-[#aaa] lg:left-8">
          <button type="button" onClick={() => onAddNote(firstSelectedMuse)} aria-label="Add note" className="flex h-32 w-8 items-center justify-center rounded-md bg-[#477bea] text-white shadow hover:bg-[#3d6ed7]"><Plus className="h-5 w-5" /></button>
          <span className="mt-20 text-xs text-[#477bea]">{visibleNotes.length} {visibleNotes.length === 1 ? 'note' : 'notes'}</span>
          <div className="relative mt-6">
            <button type="button" onClick={() => setSortOpen((open) => !open)} aria-label="Sort notes" className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-[#f4f4f4]"><Filter className="h-5 w-5" /></button>
            {sortOpen && <div className="absolute left-10 top-0 z-30 w-28 rounded-lg border border-[#e5e5e5] bg-white p-2 text-left text-xs text-[#aaa] shadow-xl">{(['newest', 'oldest', 'random', 'date'] as LibrarySort[]).map((option) => <button key={option} type="button" onClick={() => { setSort(option); if (option === 'random') setRandomSeed(Date.now()); if (option !== 'date') setDate(''); setSortOpen(false); }} className={`block w-full rounded px-2 py-1.5 capitalize hover:bg-[#f5f5f5] ${sort === option ? 'text-[#222]' : ''}`}>{option}</button>)}</div>}
          </div>
          {sort === 'date' && <input type="date" value={date} onChange={(event) => setDate(event.target.value)} aria-label="Filter by date" className="mt-1 w-24 rounded border border-[#ddd] px-1 py-1 text-[10px] text-[#555]" />}
          <button type="button" onClick={() => setLayout((value) => value === 'grid' ? 'list' : 'grid')} aria-label={layout === 'grid' ? 'Use large card view' : 'Use grid view'} className="mt-1 flex h-10 w-10 items-center justify-center rounded-md hover:bg-[#f4f4f4]">{layout === 'grid' ? <Grid2X2 className="h-5 w-5" /> : <Rows3 className="h-5 w-5" />}</button>
          <button type="button" onClick={() => { setSearchOpen((open) => !open); if (searchOpen) setQuery(''); }} aria-label="Search notes" className="mt-1 flex h-10 w-10 items-center justify-center rounded-md hover:bg-[#f4f4f4]"><Search className="h-5 w-5" /></button>
          <button type="button" onClick={() => setImportOpen(true)} aria-label="Import notes" className="mt-1 flex h-10 w-10 items-center justify-center rounded-md hover:bg-[#f4f4f4]"><Upload className="h-5 w-5" /></button>
        </aside>

        <section className="min-h-full pl-[138px] pr-6 pt-16 lg:pl-[190px] lg:pr-14">
          {searchOpen && <label className="mb-10 flex h-12 w-full max-w-[330px] items-center rounded-xl bg-[#f7f7f9] px-4 shadow"><Search className="mr-3 h-5 w-5 text-[#aaa]" /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setSearchOpen(false); setQuery(''); } }} placeholder="Search your notes" className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label>}
          <div className={`grid gap-10 pb-20 ${query.trim() ? 'grid-cols-1' : layout === 'grid' ? 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1 xl:grid-cols-2'}`}>
            {selectedMuses.size === 0 && !query.trim() && <AddLibraryCard layout={layout} onClick={() => onAddNote()} />}
            {visibleNotes.map((note) => <LibraryNoteCard key={note.id} note={note} query={query} layout={query.trim() ? 'search' : layout} onClick={() => onOpenNote(note)} />)}
            {query.trim() && <InstantRetrievalCard onClick={() => setInstantRetrievalOpen(true)} tall />}
            {selectedMuses.size > 0 && !query.trim() && <AddLibraryCard layout={layout} onClick={() => onAddNote(firstSelectedMuse)} />}
          </div>
          {!visibleNotes.length && query.trim() && <p className="pb-20 text-sm text-[#999]">No notes contain “{query.trim()}”.</p>}
        </section>
      </div>

      {musesOpen && <MuseSelector cortexes={cortexes} notesByCortex={notesByCortex} selected={selectedMuses} busy={busy} onClose={() => setMusesOpen(false)} onSave={(next) => { setSelectedMuses(next); setMusesOpen(false); }} onCreate={() => { setMusesOpen(false); onAddCortex(); }} onEdit={(cortex) => { setMusesOpen(false); onEditCortex(cortex); }} onDelete={onDeleteCortex} />}
      {importOpen && <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/25 p-4 backdrop-blur-[5px]"><button type="button" onClick={() => setImportOpen(false)} aria-label="Close importer" className="absolute right-6 top-6 text-white"><X className="h-7 w-7" /></button><div className="w-[min(92vw,620px)] rounded-2xl bg-white p-7 shadow-2xl"><NoteImporter onImport={async (drafts) => { await onImport(drafts); setImportOpen(false); }} /></div></div>}
      {instantRetrievalOpen && <InstantRetrievalOverlay notes={notes} cortexes={cortexes} initialQuery={query} saving={busy} onClose={() => setInstantRetrievalOpen(false)} onOpenNote={(note) => { setInstantRetrievalOpen(false); onOpenNote(note); }} onSave={onSaveRetrieval} />}
    </div>
  );
}

function AddLibraryCard({ layout, onClick }: { layout: 'grid' | 'list'; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={`relative rounded-lg border border-[#e1e1e1] bg-white p-7 text-left text-[#477bea] shadow-[0_2px_9px_rgba(0,0,0,0.16)] transition hover:-translate-y-0.5 hover:shadow-lg ${layout === 'grid' ? 'min-h-[300px]' : 'min-h-[420px]'}`}><span className="flex items-center gap-2 text-base"><Plus className="h-5 w-5" /> Add</span><span className="absolute inset-x-5 bottom-5 text-center text-sm italic text-[#bbb]">You can always add more</span></button>;
}

function LibraryNoteCard({ note, query, layout, onClick }: { note: Note; query: string; layout: 'grid' | 'list' | 'search'; onClick: () => void }) {
  const content = splitNote(note);
  return <button type="button" onClick={onClick} className={`relative overflow-hidden rounded-lg border border-[#e1e1e1] bg-[#f7f7f9] text-left shadow-[0_2px_9px_rgba(0,0,0,0.16)] transition hover:-translate-y-0.5 hover:border-[#7ca2ff] hover:shadow-lg ${layout === 'grid' ? 'min-h-[300px]' : layout === 'list' ? 'min-h-[420px]' : 'min-h-[500px]'}`}><span className="m-2 block min-h-[230px] rounded-md bg-white px-6 py-7"><strong className="block text-base"><HighlightedText text={content.title} query={query} /></strong><span className={`mt-4 block whitespace-pre-wrap text-sm leading-relaxed text-[#777] ${layout === 'search' ? 'line-clamp-[18]' : layout === 'list' ? 'line-clamp-[15]' : 'line-clamp-[9]'}`}><HighlightedText text={content.body || notePreview(note)} query={query} /></span></span><span className="absolute inset-x-4 bottom-4 flex justify-between text-xs text-[#aaa]"><span>Muse: {cleanCategory(note.category) || 'Instant retrieval'}</span><span>{formatDate(note.created_at)}</span></span></button>;
}

function MuseSelector({ cortexes, notesByCortex, selected, busy, onClose, onSave, onCreate, onEdit, onDelete }: {
  cortexes: CortexMeta[]; notesByCortex: Map<string, Note[]>; selected: Set<string>; busy: boolean;
  onClose: () => void; onSave: (selected: Set<string>) => void; onCreate: () => void;
  onEdit: (cortex: CortexMeta) => void; onDelete: (title: string) => void;
}) {
  const [draft, setDraft] = useState(() => new Set(selected));
  const [menu, setMenu] = useState<string | null>(null);
  const toggle = (title: string) => setDraft((current) => { const next = new Set(current); if (next.has(title)) next.delete(title); else next.add(title); return next; });
  return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30 p-5 backdrop-blur-[6px]" role="dialog" aria-modal="true" aria-label="Choose Muses"><div className="relative flex h-[min(78vh,720px)] w-[min(92vw,1220px)] flex-col rounded-xl bg-white shadow-2xl"><button type="button" onClick={onClose} aria-label="Close Muse selector" className="absolute right-2 top-2 z-10 text-[#777] sm:-right-10 sm:-top-10 sm:text-white"><X className="h-7 w-7" /></button><button type="button" onClick={onCreate} aria-label="Create Muse" className="absolute left-3 top-3 flex h-7 w-7 items-center justify-center rounded-md bg-[#477bea] text-white"><Plus className="h-4 w-4" /></button><h2 className="pt-12 text-center text-sm text-[#aaa]">Muses</h2><div className="grid flex-1 grid-cols-1 gap-8 overflow-y-auto px-12 pb-10 pt-14 sm:grid-cols-2 lg:grid-cols-4">{cortexes.map((cortex) => <div key={cortex.title} className="relative"><button type="button" onClick={() => toggle(cortex.title)} className={`flex h-32 w-full flex-col justify-between rounded-lg p-5 text-left shadow-[0_2px_8px_rgba(0,0,0,0.16)] ${draft.has(cortex.title) ? 'bg-[#202020] text-white' : 'bg-[#f6f6f8] text-[#777]'}`}><span>{cortex.title}</span><span className="text-xs opacity-60">{notesByCortex.get(cortex.title)?.length ?? 0} notes</span></button><button type="button" onClick={() => setMenu(menu === cortex.title ? null : cortex.title)} aria-label={`${cortex.title} options`} className="absolute bottom-2 right-2 rounded p-1 hover:bg-black/10"><MoreHorizontal className="h-4 w-4" /></button>{menu === cortex.title && <div className="absolute right-0 top-full z-20 mt-1 w-28 rounded-md border border-[#ddd] bg-white py-1 text-xs text-[#222] shadow-xl"><button type="button" onClick={() => onEdit(cortex)} className="block w-full px-3 py-2 text-left hover:bg-[#f5f5f5]">Edit</button><button type="button" disabled={busy} onClick={() => { setMenu(null); setDraft((current) => { const next = new Set(current); next.delete(cortex.title); return next; }); onDelete(cortex.title); }} className="block w-full px-3 py-2 text-left text-red-600 hover:bg-red-50">Delete</button></div>}</div>)}<button type="button" onClick={onCreate} aria-label="Add another Muse" className="flex h-32 items-center justify-center rounded-lg text-[#477bea] hover:bg-[#fafafa]"><Plus className="h-7 w-7" /></button></div><button type="button" onClick={() => onSave(draft)} className="absolute bottom-2 right-2 h-8 w-28 rounded-md bg-[#202020] text-sm text-white hover:bg-black">Save</button></div></div>;
}

function CortexDetail({ title, notes, isUnsorted, busy, onBack, onAddNote, onOpenNote, onEdit, onDelete }: {
  title: string; notes: Note[]; isUnsorted: boolean; busy: boolean; onBack: () => void; onAddNote: () => void;
  onOpenNote: (note: Note) => void; onEdit: () => void; onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="relative h-full min-h-0 overflow-y-auto bg-white px-5 pb-16 pt-6 sm:px-12 lg:px-20">
      <button type="button" onClick={onBack} aria-label="Back to your cortex" className="absolute left-5 top-5 flex h-10 w-10 items-center justify-center rounded-md text-[#555] hover:bg-[#f4f4f4] sm:left-8"><ArrowLeft className="h-5 w-5" /></button>
      <h1 className="text-center text-sm font-normal text-[#aaa]">{title}</h1>
      {!isUnsorted && <div className="absolute right-6 top-5 sm:right-10"><button type="button" onClick={() => setMenuOpen((value) => !value)} aria-label="Cortex options" aria-expanded={menuOpen} className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-[#f4f4f4]"><MoreHorizontal className="h-5 w-5" /></button>{menuOpen && <div className="absolute right-0 top-11 z-10 w-40 overflow-hidden rounded-lg border border-[#ddd] bg-white py-1 text-sm shadow-xl"><button type="button" onClick={() => { setMenuOpen(false); onEdit(); }} className="block w-full px-4 py-2.5 text-left hover:bg-[#f5f5f5]">Edit cortex</button><button type="button" disabled={busy} onClick={() => { setMenuOpen(false); onDelete(); }} className="block w-full px-4 py-2.5 text-left text-red-600 hover:bg-red-50">Delete cortex</button></div>}</div>}
      <div className="mx-auto mt-16 grid max-w-[1300px] grid-cols-1 justify-items-center gap-x-14 gap-y-16 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {notes.map((note) => { const content = splitNote(note); return <button key={note.id} type="button" onClick={() => onOpenNote(note)} className="relative h-[355px] w-[278px] rounded-md border border-[#e2e2e2] bg-white p-6 text-left shadow-[0_2px_9px_rgba(0,0,0,0.15)] transition-all hover:-translate-y-0.5 hover:shadow-lg"><strong className="block text-base">{content.title}</strong><span className="mt-4 block whitespace-pre-wrap text-sm leading-relaxed text-[#727272] line-clamp-[12]">{content.body || notePreview(note)}</span><span className="absolute bottom-4 right-4 text-xs text-[#b8b8b8]">{formatDate(note.created_at)}</span></button>; })}
        <button type="button" onClick={onAddNote} aria-label={`Add a note to ${title}`} className="flex h-[355px] w-[278px] items-center justify-center text-[#477bea] hover:bg-[#fafafa]"><FolderPlus className="h-9 w-9 stroke-[1.6]" /></button>
      </div>
      {!notes.length && <p className="mt-8 text-center text-sm text-[#999]">This cortex is ready for its first note.</p>}
    </div>
  );
}

type ReadingRelation = {
  note: Note;
  reason: string;
  related: boolean;
};

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
  const expression = new RegExp(`(${escapeRegExp(clean)})`, 'ig');
  return <>{text.split(expression).map((part, index) => part.toLowerCase() === clean.toLowerCase() ? <mark key={`${part}-${index}`} className="bg-transparent text-[#477bea]">{part}</mark> : part)}</>;
}

function NoteReadingWorkspace({ note, allNotes, cortexes, saving, onBack, onAddNote, onImport, onOpenNote, onUpdate, onDelete, onSaveRetrieval }: {
  note: Note; allNotes: Note[]; cortexes: CortexMeta[]; saving: boolean;
  onBack: () => void; onAddNote: () => void; onImport: (drafts: ImportNoteDraft[]) => Promise<void>;
  onOpenNote: (note: Note) => void; onUpdate: (noteId: string, rawText: string) => Promise<void>;
  onDelete: (note: Note) => Promise<void>;
  onSaveRetrieval: (queryText: string, resultNotes: Note[], category: string) => Promise<Note>;
}) {
  const initial = splitNote(note);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [editing, setEditing] = useState(false);
  const [selectedParagraph, setSelectedParagraph] = useState(-1);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [relations, setRelations] = useState<ReadingRelation[]>([]);
  const [relationsLoading, setRelationsLoading] = useState(true);
  const [sourcesOpen, setSourcesOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchRequest, setSearchRequest] = useState<KnowledgeSearchRequest | null>(null);
  const [detailNote, setDetailNote] = useState<Note | null>(null);
  const [instantRetrievalOpen, setInstantRetrievalOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const latestSaveRef = useRef(onUpdate);
  latestSaveRef.current = onUpdate;

  useEffect(() => {
    let active = true;
    setRelationsLoading(true);
    const loadRelations = async () => {
      let connected: Awaited<ReturnType<typeof getNoteRelations>> = [];
      try { connected = await getNoteRelations(note.id); } catch { connected = []; }
      if (!active) return;
      const connectedMap = new Map(connected.map((relation) => [relation.related_note_id, relation]));
      const candidates = allNotes
        .filter((item) => item.id !== note.id)
        .map((item) => ({ item, score: sharedWordScore(note.raw_text, item.raw_text), relation: connectedMap.get(item.id) }))
        .sort((a, b) => Number(Boolean(b.relation)) - Number(Boolean(a.relation)) || b.score - a.score || b.item.created_at.localeCompare(a.item.created_at))
        .slice(0, 8)
        .map(({ item, score, relation }): ReadingRelation => ({
          note: item,
          related: Boolean(relation),
          reason: relation?.reason?.trim() || (score > 0 ? `This note returns to ${score === 1 ? 'a theme' : `${score} themes`} in the page you are reading.` : 'This is a recent note from your knowledge base.'),
        }));
      setRelations(candidates);
      setSelectedSourceId(candidates[0]?.note.id ?? null);
      setRelationsLoading(false);
    };
    void loadRelations();
    return () => { active = false; };
  }, [allNotes, note.id, note.raw_text]);

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
  const paragraphs = body.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const selectedSource = relations.find((item) => item.note.id === selectedSourceId) ?? relations[0] ?? null;
  const selectedSourceContent = selectedSource ? splitNote(selectedSource.note) : null;
  const sourceCortexes = useMemo(() => {
    const names = new Set(relations.map((relation) => cleanCategory(relation.note.category)).filter((value): value is string => Boolean(value)));
    const matching = cortexes.filter((cortex) => names.has(cortex.title));
    return (matching.length ? matching : cortexes).slice(0, 3);
  }, [cortexes, relations]);

  const leaveWorkspace = async (next?: Note | null) => {
    if (rawText && rawText !== note.raw_text.trim()) {
      setSaveState('saving');
      try { await latestSaveRef.current(note.id, rawText); setSaveState('saved'); }
      catch { setSaveState('error'); return; }
    }
    if (next) onOpenNote(next); else onBack();
  };

  const surfaceForParagraph = (paragraph: string) => {
    const ranked = [...relations].sort((a, b) => sharedWordScore(paragraph, b.note.raw_text) - sharedWordScore(paragraph, a.note.raw_text));
    if (ranked[0]) setSelectedSourceId(ranked[0].note.id);
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-white p-3 sm:p-5">
      <header className="relative flex h-14 shrink-0 items-center justify-between px-1 sm:px-2">
        <div className="flex items-center gap-1 text-[#aaa] sm:gap-2">
          <button type="button" onClick={() => void leaveWorkspace()} aria-label="Back to Muse" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-[#f4f4f4] hover:text-[#222]"><ArrowLeft className="h-5 w-5" /></button>
          <span className="mx-1 h-7 w-px bg-[#e5e5e5]" />
          <button type="button" onClick={onAddNote} aria-label="Add a note" className="flex h-8 w-8 items-center justify-center rounded-md bg-[#477bea] text-white hover:bg-[#3d6ed7]"><Plus className="h-5 w-5" /></button>
          <button type="button" onClick={() => setImportOpen(true)} aria-label="Import notes" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-[#f4f4f4] hover:text-[#555]"><Upload className="h-5 w-5" /></button>
          <button type="button" onClick={() => setSearchRequest({ query: '' })} aria-label="Search notes and Muses" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-[#f4f4f4] hover:text-[#555]"><Search className="h-5 w-5" /></button>
        </div>
        <div className="flex items-center gap-1 text-xs text-[#888] sm:gap-2">
          <button type="button" disabled={!previousNote} onClick={() => previousNote && void leaveWorkspace(previousNote)} aria-label="Previous note" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-[#f4f4f4] disabled:opacity-25"><ChevronLeft className="h-4 w-4" /></button>
          <span className="min-w-[48px] text-center">{formatDate(note.created_at)}</span>
          <button type="button" disabled={!nextNote} onClick={() => nextNote && void leaveWorkspace(nextNote)} aria-label="Next note" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-[#f4f4f4] disabled:opacity-25"><ChevronRight className="h-4 w-4" /></button>
          <div className="relative">
            <button type="button" onClick={() => setMenuOpen((open) => !open)} aria-label="Page options" aria-expanded={menuOpen} className="flex h-9 w-9 items-center justify-center rounded-md text-[#222] hover:bg-[#f4f4f4]"><MoreHorizontal className="h-5 w-5" /></button>
            {menuOpen && <div className="absolute right-0 top-10 z-30 w-40 overflow-hidden rounded-lg border border-[#ddd] bg-white py-1 text-sm shadow-xl"><button type="button" onClick={() => { setMenuOpen(false); setEditing(true); }} className="block w-full px-4 py-2.5 text-left hover:bg-[#f5f5f5]">Edit page</button><button type="button" disabled={saving} onClick={() => { setMenuOpen(false); void onDelete(note); }} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-red-600 hover:bg-red-50"><Trash2 className="h-4 w-4" /> Delete page</button></div>}
          </div>
        </div>
      </header>

      <div className={`grid min-h-0 flex-1 overflow-y-auto rounded-xl border border-[#cfcfcf] bg-[#f7f7f9] shadow-[0_2px_9px_rgba(0,0,0,0.16)] lg:overflow-hidden ${sourcesOpen ? 'lg:grid-cols-[minmax(0,1.05fr)_minmax(330px,.92fr)_320px]' : 'lg:grid-cols-[minmax(0,1.35fr)_minmax(350px,.85fr)]'}`}>
        <section className="relative flex min-h-[520px] min-w-0 flex-col overflow-hidden bg-white shadow-[4px_0_12px_rgba(0,0,0,0.13)] lg:min-h-0">
          <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-24 pt-12 sm:px-14 lg:px-[7%] lg:pt-16">
            {editing ? <div className="mx-auto max-w-3xl"><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Note title" className="w-full bg-transparent text-2xl font-semibold outline-none" /><textarea ref={bodyRef} value={body} onChange={(event) => setBody(event.target.value)} aria-label="Note text" className="mt-7 min-h-[420px] w-full resize-none bg-transparent text-base leading-[1.65] outline-none" /></div> : <article className="mx-auto max-w-3xl"><button type="button" onClick={() => setEditing(true)} className="w-full rounded-md text-left outline-none hover:bg-[#f8f8f8] focus:ring-2 focus:ring-[#477bea]/20"><h1 className="px-2 py-1 text-2xl font-semibold">{title}</h1></button><div className="mt-6 space-y-3">{paragraphs.length ? paragraphs.map((paragraph, index) => <button key={`${index}-${paragraph.slice(0, 20)}`} type="button" onMouseEnter={() => surfaceForParagraph(paragraph)} onFocus={() => surfaceForParagraph(paragraph)} onClick={() => { surfaceForParagraph(paragraph); if (selectedParagraph === index) setEditing(true); else setSelectedParagraph(index); }} className={`block w-full rounded-md px-2 py-2 text-left text-base leading-[1.65] transition-colors ${selectedParagraph === index ? 'bg-[#e5edff]' : 'hover:bg-[#f2f5fb]'}`}>{paragraph}</button>) : <button type="button" onClick={() => setEditing(true)} className="block w-full rounded-md px-2 py-3 text-left text-[#aaa] hover:bg-[#f5f5f5]">Tap to start writing.</button>}</div></article>}
          </div>
          {editing && <div className="absolute bottom-5 left-1/2 flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-1 rounded-xl bg-[#f7f7f9] px-3 py-2 text-sm text-[#555] shadow-sm"><button type="button" aria-label="Voice input" className="flex h-8 w-8 items-center justify-center rounded hover:bg-white"><Mic className="h-4 w-4" /></button><span className="mx-1 h-7 w-px bg-[#ddd]" /><button type="button" onClick={() => applyReadingFormat('bold')} className="h-8 w-8 rounded font-bold hover:bg-white">B</button><button type="button" onClick={() => applyReadingFormat('italic')} className="h-8 w-8 rounded italic hover:bg-white">I</button><span className="mx-1 h-7 w-px bg-[#ddd]" />{(['h1', 'h2', 'h3'] as const).map((kind) => <button key={kind} type="button" onClick={() => applyReadingFormat(kind)} className="hidden h-8 rounded px-2 font-semibold hover:bg-white sm:block">{kind.toUpperCase()}</button>)}<button type="button" onClick={() => applyReadingFormat('body')} className="hidden h-8 rounded px-2 hover:bg-white md:block">Body</button><span className="mx-1 hidden h-7 w-px bg-[#ddd] md:block" /><button type="button" onClick={() => applyReadingFormat('bullet')} className="hidden h-8 items-center gap-1 rounded px-2 hover:bg-white lg:flex"><List className="h-4 w-4" /> Bullet list</button><button type="button" onClick={() => applyReadingFormat('number')} className="hidden h-8 items-center gap-1 rounded px-2 hover:bg-white xl:flex"><ListOrdered className="h-4 w-4" /> Numbered list</button><button type="button" onClick={() => setEditing(false)} className="ml-2 h-8 rounded-md bg-[#477bea] px-3 text-white hover:bg-[#3d6ed7]">Done</button></div>}
          <span className="absolute bottom-3 right-4 text-[11px] text-[#aaa]">{saveState === 'saving' || saving ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Save failed' : ''}</span>
        </section>

        <section className="relative min-h-[480px] min-w-0 overflow-y-auto bg-[#f7f7f9] px-8 pb-14 pt-14 sm:px-12 lg:min-h-0">
          <button type="button" onClick={() => setSourcesOpen((open) => !open)} aria-label={sourcesOpen ? 'Hide retrieved notes' : 'Show retrieved notes'} aria-expanded={sourcesOpen} className="absolute left-2 top-2 flex h-8 w-8 items-center justify-center rounded text-[#777] hover:bg-white"><PanelRightOpen className="h-5 w-5" /></button>
          {!sourcesOpen && relations.length > 0 && <button type="button" onClick={() => setSourcesOpen(true)} className="absolute right-3 top-3 rounded-md border border-[#bbb] bg-white px-3 py-1 text-xs text-[#477bea] hover:bg-[#f5f7fb]">See notes</button>}
          {relationsLoading ? <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-[#aaa]" /></div> : selectedSource && selectedSourceContent ? <article className="mx-auto max-w-xl"><h2 className="text-lg font-semibold">{selectedSourceContent.title}</h2><p className="mt-6 whitespace-pre-wrap text-sm leading-[1.55] text-[#333]">{selectedSourceContent.body || selectedSource.note.raw_text}</p>{!sourcesOpen && <div className="mt-7 border-t border-[#ddd] pt-4 text-xs leading-relaxed text-[#777]"><p className="italic"><span className="text-[#477bea]">Why this surfaced:</span> {selectedSource.reason}</p><p className="mt-3 text-[11px] text-[#999]">Muse: {cleanCategory(selectedSource.note.category) || 'Instant retrieval'} · {fullNoteDate(selectedSource.note.created_at)}</p></div>}</article> : <div className="flex h-full items-center justify-center text-center"><div><h2 className="text-lg font-semibold">Your note is ready.</h2><p className="mt-3 max-w-sm text-sm leading-relaxed text-[#777]">As your knowledge base grows, related ideas will proactively appear here.</p></div></div>}
        </section>

        {sourcesOpen && <aside className="min-h-[420px] overflow-y-auto border-l border-[#d6d6d6] bg-white p-4 lg:min-h-0"><h2 className="mb-4 text-center text-sm text-[#999]">Retrieved for this page</h2><div className="space-y-4">{relations.map((relation) => { const content = splitNote(relation.note); return <button key={relation.note.id} type="button" onMouseEnter={() => setSelectedSourceId(relation.note.id)} onFocus={() => setSelectedSourceId(relation.note.id)} onClick={() => { setSelectedSourceId(relation.note.id); setDetailNote(relation.note); }} className={`group block w-full overflow-hidden rounded-lg border bg-[#f5f5f7] text-left shadow-[0_2px_8px_rgba(0,0,0,0.12)] transition-all hover:-translate-y-0.5 hover:shadow-lg ${selectedSourceId === relation.note.id ? 'border-[#6f9cff] ring-1 ring-[#6f9cff]/40' : 'border-[#e2e2e2]'}`}><div className="relative bg-white p-4"><span className="absolute right-3 top-3 text-xs text-[#477bea]">note</span><strong className="block max-w-[82%] truncate text-sm">{content.title}</strong><p className="mt-3 line-clamp-3 text-xs leading-relaxed text-[#777]">{content.body || notePreview(relation.note)}</p></div><div className="max-h-0 overflow-hidden px-4 text-xs italic leading-relaxed text-[#777] opacity-0 transition-all duration-200 group-hover:max-h-24 group-hover:pb-3 group-hover:pt-3 group-hover:opacity-100"><span className="text-[#477bea]">Reason:</span> {relation.reason}</div><div className="flex items-center justify-between border-t border-[#ddd] px-4 py-2 text-[11px] text-[#999]"><span>Muse: {cleanCategory(relation.note.category) || 'Instant retrieval'}</span><span>{formatDate(relation.note.created_at)}</span></div></button>; })}{sourceCortexes.map((cortex) => <button key={`cortex-${cortex.title}`} type="button" onClick={() => setSearchRequest({ query: cortex.title, filter: { kind: 'muse', value: cortex.title, label: cortex.title } })} className="group block w-full overflow-hidden rounded-lg border border-[#e2e2e2] bg-[#f5f5f7] text-left shadow-[0_2px_8px_rgba(0,0,0,0.12)] transition-all hover:-translate-y-0.5 hover:border-[#8fb1ff] hover:shadow-lg"><div className="relative bg-[#f5f5f7] p-4"><span className="absolute right-3 top-3 text-xs text-[#477bea]">cortex</span><strong className="block max-w-[82%] truncate text-sm">{cortex.title}</strong><p className="mt-3 line-clamp-4 text-xs leading-relaxed text-[#777]">{cortex.description || `Notes and ideas organized in ${cortex.title}.`}</p></div><div className="flex items-center justify-between border-t border-[#ddd] px-4 py-2 text-[11px] text-[#999]"><span>{cortex.title}</span><span>{formatDate(cortex.createdAt)}</span></div></button>)}</div></aside>}
      </div>

      {importOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[5px]"><div className="relative max-h-[92vh] overflow-y-auto rounded-2xl bg-white p-7 shadow-2xl"><button type="button" onClick={() => setImportOpen(false)} aria-label="Close importer" className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-md text-[#777] hover:bg-[#f4f4f4]"><X className="h-5 w-5" /></button><NoteImporter onImport={async (drafts) => { await onImport(drafts); setImportOpen(false); }} /></div></div>}
      {detailNote && <RetrievedNoteOverlay key={detailNote.id} note={detailNote} cortexes={cortexes} saving={saving} onClose={() => setDetailNote(null)} onAddNote={onAddNote} onImport={() => { setDetailNote(null); setImportOpen(true); }} onSearch={(request) => { setDetailNote(null); setSearchRequest(request); }} onUpdate={onUpdate} onDelete={async (item) => { await onDelete(item); setDetailNote(null); }} />}
      {searchRequest && <KnowledgeSearchOverlay request={searchRequest} notes={allNotes} cortexes={cortexes} onClose={() => setSearchRequest(null)} onOpenNote={(item) => { setSearchRequest(null); setDetailNote(item); }} onInstantRetrieval={() => { setSearchRequest(null); setInstantRetrievalOpen(true); }} />}
      {instantRetrievalOpen && <InstantRetrievalOverlay notes={allNotes} cortexes={cortexes} saving={saving} onClose={() => setInstantRetrievalOpen(false)} onOpenNote={(item) => { setInstantRetrievalOpen(false); setDetailNote(item); }} onSave={onSaveRetrieval} />}
    </div>
  );
}

function RetrievedNoteOverlay({ note, cortexes, saving, onClose, onAddNote, onImport, onSearch, onUpdate, onDelete }: {
  note: Note; cortexes: CortexMeta[]; saving: boolean;
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
  const usedCortexes = useMemo(() => {
    const direct = cortexes.filter((cortex) => cortex.title.toLowerCase() === muse.toLowerCase());
    return (direct.length ? direct : cortexes).slice(0, 4);
  }, [cortexes, muse]);

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
    <div className="fixed inset-0 z-[70] bg-black/25 p-3 backdrop-blur-[5px] sm:p-6" role="dialog" aria-modal="true" aria-label={`Retrieved note: ${initial.title}`}>
      <div className="relative mx-auto flex h-full max-w-[1760px] flex-col">
        <div className="flex h-14 shrink-0 items-center justify-between px-2 text-white">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => { onClose(); onAddNote(); }} aria-label="Add a note" className="flex h-8 w-24 items-center justify-center rounded-md bg-[#477bea] hover:bg-[#3d6ed7]"><Plus className="h-5 w-5" /></button>
            <button type="button" onClick={onImport} aria-label="Import notes" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-white/10"><Upload className="h-6 w-6" /></button>
            <button type="button" onClick={() => onSearch({ query: '' })} aria-label="Search notes and Muses" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-white/10"><Search className="h-6 w-6" /></button>
          </div>
          <button type="button" onClick={onClose} aria-label="Close retrieved note" className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-white/10"><X className="h-7 w-7" /></button>
        </div>
        <div className="grid min-h-0 flex-1 overflow-hidden rounded-2xl border-[9px] border-white/80 bg-[#f7f7f9] shadow-2xl lg:grid-cols-[minmax(0,1fr)_330px]">
          <section className="relative flex min-h-0 flex-col overflow-hidden bg-white shadow-[4px_0_14px_rgba(0,0,0,0.14)]">
            <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-28 pt-12 sm:px-16 lg:px-[11%] lg:pt-20">
              <input value={title} readOnly={!editing} onClick={() => setEditing(true)} onChange={(event) => setTitle(event.target.value)} aria-label="Retrieved note title" className={`w-full bg-transparent text-2xl font-semibold outline-none ${editing ? 'cursor-text' : 'cursor-pointer'}`} />
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
            <button type="button" onClick={openMuse} className="mt-5 block rounded px-1 py-1 text-left text-sm hover:bg-white"><span className="font-medium">Muse:</span> <span className="text-[#777]">{muse}</span></button>
            <div className="my-6 h-px bg-[#d8d8d8]" />
            <button type="button" onClick={openMuse} className="text-sm text-[#477bea] hover:underline">Used in cortex</button>
            <div className="mt-5 space-y-5">{usedCortexes.map((cortex) => <button key={cortex.title} type="button" onClick={() => onSearch({ query: cortex.title, filter: { kind: 'muse', value: cortex.title, label: cortex.title } })} className="block w-full rounded-lg border border-[#e0e0e0] bg-white p-5 text-left shadow-[0_2px_8px_rgba(0,0,0,0.13)] transition hover:-translate-y-0.5 hover:border-[#8fb1ff]"><strong className="block text-base">{cortex.title}</strong><p className="mt-4 line-clamp-6 text-sm leading-relaxed text-[#777]">{cortex.description || `Notes and ideas organized in ${cortex.title}.`}</p><div className="mt-8 flex justify-between text-xs text-[#aaa]"><span>{cortex.title}</span><span>{formatDate(cortex.createdAt)}</span></div></button>)}</div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function ReadingFormatBar({ onFormat, onDone, editing }: { onFormat: (kind: 'bold' | 'italic' | 'h1' | 'h2' | 'h3' | 'body' | 'bullet' | 'number') => void; onDone: () => void; editing: boolean }) {
  return <div className="absolute bottom-5 left-1/2 flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-1 rounded-xl bg-[#f7f7f9] px-3 py-2 text-sm text-[#555] shadow-sm"><button type="button" aria-label="Voice input" className="flex h-8 w-8 items-center justify-center rounded hover:bg-white"><Mic className="h-4 w-4" /></button><span className="mx-1 h-7 w-px bg-[#ddd]" /><button type="button" onClick={() => onFormat('bold')} className="h-8 w-8 rounded font-bold hover:bg-white">B</button><button type="button" onClick={() => onFormat('italic')} className="h-8 w-8 rounded italic hover:bg-white">I</button><span className="mx-1 h-7 w-px bg-[#ddd]" />{(['h1', 'h2', 'h3'] as const).map((kind) => <button key={kind} type="button" onClick={() => onFormat(kind)} className="hidden h-8 rounded px-2 font-semibold hover:bg-white sm:block">{kind.toUpperCase()}</button>)}<button type="button" onClick={() => onFormat('body')} className="hidden h-8 rounded px-2 hover:bg-white md:block">Body</button><span className="mx-1 hidden h-7 w-px bg-[#ddd] md:block" /><button type="button" onClick={() => onFormat('bullet')} className="hidden h-8 items-center gap-1 rounded px-2 hover:bg-white lg:flex"><List className="h-4 w-4" /> Bullet list</button><button type="button" onClick={() => onFormat('number')} className="hidden h-8 items-center gap-1 rounded px-2 hover:bg-white xl:flex"><ListOrdered className="h-4 w-4" /> Numbered list</button>{editing && <button type="button" onClick={onDone} className="ml-2 h-8 rounded-md bg-[#477bea] px-3 text-white hover:bg-[#3d6ed7]">Done</button>}</div>;
}

function InstantRetrievalCard({ onClick, tall = false }: { onClick: () => void; tall?: boolean }) {
  return <button type="button" onClick={onClick} className={`flex w-full flex-col items-center justify-center rounded-lg border border-[#e6e6e6] bg-[#f7f7f9] text-center shadow-[0_2px_8px_rgba(0,0,0,0.1)] transition hover:-translate-y-0.5 hover:border-[#8fb1ff] hover:shadow-lg ${tall ? 'min-h-[340px]' : 'min-h-[270px]'}`}><span className="flex h-20 w-20 items-center justify-center rounded-md bg-[#477bea] text-[#8fb1ff] shadow-md"><ArrowUp className="h-16 w-16 stroke-[1.8]" /></span><span className="mt-7 text-sm font-medium text-[#222]">Instant retrieval instead</span></button>;
}

function KnowledgeSearchOverlay({ request, notes, cortexes, onClose, onOpenNote, onInstantRetrieval }: {
  request: KnowledgeSearchRequest; notes: Note[]; cortexes: CortexMeta[]; onClose: () => void; onOpenNote: (note: Note) => void; onInstantRetrieval: () => void;
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
  const matchingCortexes = useMemo(() => cortexes.filter((cortex) => {
    if (filter?.kind === 'muse') return cortex.title.toLowerCase() === filter.value.toLowerCase();
    if (filter?.kind === 'date') return filteredNotes.some((note) => cleanCategory(note.category)?.toLowerCase() === cortex.title.toLowerCase());
    return !normalized || `${cortex.title} ${cortex.description}`.toLowerCase().includes(normalized) || notes.some((note) => cleanCategory(note.category)?.toLowerCase() === cortex.title.toLowerCase() && note.raw_text.toLowerCase().includes(normalized));
  }), [cortexes, filter, filteredNotes, normalized, notes]);
  const recentTerms = useMemo(() => {
    const values = [...cortexes.map((cortex) => cortex.title), ...sortedNotes.slice(0, 5).map((note) => splitNote(note).title)];
    return Array.from(new Set(values.filter(Boolean))).slice(0, 6);
  }, [cortexes, sortedNotes]);
  const heading = filter?.kind === 'date' ? `Notes written on ${filter.label}` : filter?.kind === 'muse' ? `Notes in ${filter.label}` : `Notes containing “${query.trim()}”`;

  const changeQuery = (value: string) => { setQuery(value); setFilter(undefined); };

  return (
    <div className="fixed inset-0 z-[80] bg-black/25 p-3 backdrop-blur-[5px] sm:p-6" role="dialog" aria-modal="true" aria-label="Search your cortex and notes">
      <button type="button" onClick={onClose} aria-label="Close search" className="absolute right-5 top-5 z-10 flex h-10 w-10 items-center justify-center rounded-md text-white hover:bg-white/10"><X className="h-7 w-7" /></button>
      <div className="mx-auto mt-12 flex h-[calc(100%-3rem)] max-w-[1640px] flex-col overflow-hidden rounded-[20px] bg-white shadow-2xl sm:mt-16 sm:h-[calc(100%-4rem)]">
        <div className="flex h-20 shrink-0 items-center border-b border-[#ddd] px-7 sm:px-10"><Search className="mr-4 h-6 w-6 shrink-0 text-[#aaa]" /><input autoFocus value={query} onChange={(event) => changeQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }} placeholder="Search your cortex and notes" className="h-full min-w-0 flex-1 bg-transparent text-xl outline-none placeholder:text-[#b3b3b3] sm:text-2xl" />{filter && <button type="button" onClick={() => { setFilter(undefined); setQuery(''); }} className="rounded-full bg-[#edf3ff] px-3 py-1.5 text-xs text-[#477bea]">Clear {filter.kind}</button>}</div>
        {!query.trim() && !filter ? <div className="min-h-0 flex-1 overflow-y-auto px-10 py-12 sm:px-16"><p className="text-sm text-[#aaa]">Recent</p><div className="mt-5 max-w-2xl space-y-1">{recentTerms.map((term) => <button key={term} type="button" onClick={() => setQuery(term)} className="block w-full rounded-lg px-1 py-3 text-left text-base text-[#555] hover:bg-[#f6f6f6] hover:px-3">{term}</button>)}</div></div> : <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[450px_minmax(0,1fr)] lg:overflow-hidden">
          <aside className="border-b border-[#ddd] px-7 py-10 lg:overflow-y-auto lg:border-b-0 lg:border-r sm:px-10"><p className="mb-7 text-sm text-[#aaa]">Found in cortex</p><div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-1">{matchingCortexes.map((cortex) => { const related = notes.filter((note) => cleanCategory(note.category)?.toLowerCase() === cortex.title.toLowerCase()); const preview = cortex.description || related[0]?.raw_text || `Notes organized in ${cortex.title}.`; return <button key={cortex.title} type="button" onClick={() => { setFilter({ kind: 'muse', value: cortex.title, label: cortex.title }); setQuery(cortex.title); }} className="relative min-h-[340px] rounded-lg border border-[#e3e3e3] bg-white p-7 text-left shadow-[0_2px_8px_rgba(0,0,0,0.14)] transition hover:-translate-y-0.5 hover:border-[#8fb1ff]"><strong className="block text-base"><HighlightedText text={cortex.title} query={query} /></strong><p className="mt-5 line-clamp-[12] text-sm leading-relaxed text-[#777]"><HighlightedText text={preview} query={query} /></p><div className="absolute inset-x-4 bottom-4 flex justify-between text-xs text-[#aaa]"><span>{cortex.title}</span><span>{formatDate(cortex.createdAt)}</span></div></button>; })}{!matchingCortexes.length && <p className="text-sm text-[#999] sm:col-span-2 lg:col-span-1">No cortex matches this search.</p>}<InstantRetrievalCard onClick={onInstantRetrieval} tall /></div></aside>
          <section className="min-h-0 px-7 py-10 lg:overflow-y-auto sm:px-12"><p className="mb-7 text-sm text-[#aaa]">{heading}</p><div className="grid gap-7 xl:grid-cols-2">{filteredNotes.map((item) => { const content = splitNote(item); const preview = content.body || notePreview(item); return <button key={item.id} type="button" onClick={() => onOpenNote(item)} className="relative min-h-[250px] rounded-lg border border-[#e3e3e3] bg-[#f7f7f9] p-2 text-left shadow-[0_2px_8px_rgba(0,0,0,0.14)] transition hover:-translate-y-0.5 hover:border-[#8fb1ff]"><div className="h-[190px] rounded-md bg-white p-6"><strong className="block text-base"><HighlightedText text={content.title} query={filter ? '' : query} /></strong><p className="mt-4 line-clamp-6 text-sm leading-relaxed text-[#777]"><HighlightedText text={preview} query={filter ? '' : query} /></p></div><div className="flex items-center justify-between px-3 py-3 text-xs text-[#aaa]"><span>Muse: {cleanCategory(item.category) || 'Instant retrieval'}</span><span>{formatDate(item.created_at)}</span></div></button>; })}{!filteredNotes.length && <p className="text-sm text-[#999] xl:col-span-2">No notes match this search.</p>}<InstantRetrievalCard onClick={onInstantRetrieval} /></div></section>
        </div>}
      </div>
    </div>
  );
}

function retrievalKeywords(value: string): string[] {
  const ignored = new Set(['about', 'after', 'also', 'been', 'between', 'could', 'difference', 'find', 'from', 'have', 'looking', 'note', 'something', 'stated', 'that', 'their', 'there', 'these', 'they', 'this', 'what', 'when', 'where', 'which', 'will', 'with', 'would']);
  return (value.toLowerCase().match(/[a-z0-9']{3,}/g) ?? []).filter((word) => !ignored.has(word));
}

function InstantRetrievalOverlay({ notes, cortexes, initialQuery = '', saving, onClose, onOpenNote, onSave }: {
  notes: Note[]; cortexes: CortexMeta[]; saving: boolean; onClose: () => void; onOpenNote: (note: Note) => void;
  initialQuery?: string;
  onSave: (queryText: string, resultNotes: Note[], category: string) => Promise<Note>;
}) {
  const [phase, setPhase] = useState<'intro' | 'clarify' | 'results'>('intro');
  const [query, setQuery] = useState(initialQuery);
  const [clarificationRound, setClarificationRound] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [newCortex, setNewCortex] = useState('');
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
    : 'Should I search broadly across every Muse and include the closest related ideas?';

  const beginClarification = () => {
    if (!query.trim()) return;
    setClarificationRound(0); setPhase('clarify'); setSaveMessage(''); setSaveError('');
  };

  const answerClarification = (yes: boolean) => {
    if (yes || clarificationRound > 0) setPhase('results');
    else setClarificationRound(1);
  };

  const saveTo = async (category: string) => {
    const clean = cleanCategory(category); if (!clean || !query.trim()) return;
    setSaveError('');
    try {
      await onSave(query, results, clean);
      setSaveMessage(`Saved to ${clean}`); setSaveMenuOpen(false); setNewCortex('');
    } catch (error) { setSaveError(safeErrorMessage(error, 'Unable to save this retrieval.')); }
  };

  if (phase === 'intro') return (
    <div className="fixed inset-0 z-[90] bg-black/25 p-3 backdrop-blur-[5px] sm:p-6" role="dialog" aria-modal="true" aria-label="Instant retrieval introduction">
      <button type="button" onClick={onClose} aria-label="Close instant retrieval" className="absolute right-5 top-5 z-10 flex h-10 w-10 items-center justify-center rounded-md text-white hover:bg-white/10"><X className="h-7 w-7" /></button>
      <button type="button" onClick={() => setPhase('clarify')} className="mx-auto flex h-full w-full max-w-[1760px] items-center justify-center rounded-2xl border-[9px] border-white/80 bg-[#f7f7f9] text-left shadow-2xl">
        <span className="w-[min(90%,720px)] space-y-8 text-base leading-relaxed text-[#222] sm:text-lg"><span className="block">This is a temporary cortex where you can instantly retrieve anything from your Ocreda.</span><span className="block">You can ask for a specific thing you are looking for or go as broad as you want.</span><span className="block">This will not be saved unless you save it to a cortex.</span><span className="block font-medium">Tap on the screen.</span></span>
      </button>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[90] bg-black/25 p-3 backdrop-blur-[5px] sm:p-6" role="dialog" aria-modal="true" aria-label="Instant retrieval temporary cortex">
      <div className="relative mx-auto flex h-full max-w-[1760px] flex-col">
        <div className="relative flex h-14 shrink-0 items-center justify-between px-2 text-white">
          <div className="relative">
            <button type="button" disabled={!query.trim() || saving} onClick={() => setSaveMenuOpen((open) => !open)} className="rounded-md bg-white px-3 py-2 text-sm text-[#222] shadow disabled:opacity-45">{saving ? 'Saving…' : 'Save this to a cortex'}</button>
            {saveMenuOpen && <div className="absolute left-0 top-11 z-30 w-[280px] overflow-hidden rounded-lg border border-[#ddd] bg-white py-2 text-sm text-[#222] shadow-xl"><p className="px-4 pb-2 text-xs text-[#999]">Choose a cortex</p>{cortexes.map((cortex) => <button key={cortex.title} type="button" onClick={() => void saveTo(cortex.title)} className="block w-full px-4 py-2.5 text-left hover:bg-[#f5f5f5]">{cortex.title}</button>)}<div className="mt-1 flex items-center gap-2 border-t border-[#eee] px-3 pt-2"><input value={newCortex} onChange={(event) => setNewCortex(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void saveTo(newCortex); } }} placeholder="New cortex" className="min-w-0 flex-1 rounded border border-[#ddd] px-2 py-2 outline-none focus:border-[#477bea]" /><button type="button" disabled={!newCortex.trim()} onClick={() => void saveTo(newCortex)} aria-label="Create cortex and save" className="rounded bg-[#477bea] p-2 text-white disabled:opacity-35"><Check className="h-4 w-4" /></button></div>{saveError && <p className="px-4 pt-2 text-xs text-red-600">{saveError}</p>}</div>}
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
            {!query.trim() ? <p className="text-base text-[#aaa]">Start typing what you want to find.</p> : phase === 'clarify' ? <div><p className="text-lg leading-relaxed">{clarification}</p><div className="mt-8 flex gap-6"><button type="button" onClick={() => answerClarification(true)} aria-label="Yes" className="flex h-10 w-10 items-center justify-center rounded-full bg-[#477bea] text-white hover:bg-[#3d6ed7]"><Check className="h-5 w-5" /></button><button type="button" onClick={() => answerClarification(false)} aria-label="No" className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-[#222] hover:bg-[#f5f5f5]"><X className="h-5 w-5" /></button></div></div> : <div><Check className="h-10 w-10 rounded-full bg-[#477bea] p-2 text-white" /><p className="mt-10 text-lg">I have found {results.length} {results.length === 1 ? 'note' : 'notes'} that are close to your request.</p>{results[0] && <div className="mt-12 border-t border-[#eee] pt-7"><strong className="text-base">Closest match: {splitNote(results[0]).title}</strong><p className="mt-4 line-clamp-8 whitespace-pre-wrap text-sm leading-relaxed text-[#555]">{splitNote(results[0]).body || notePreview(results[0])}</p></div>}</div>}
          </section>
          {phase === 'results' && <aside className="min-h-[430px] overflow-y-auto border-l border-[#d6d6d6] bg-white p-5 lg:min-h-0"><div className="mb-4 flex items-center justify-between"><h2 className="text-sm text-[#999]">Retrieved notes</h2><span className="rounded border border-[#bbb] px-3 py-1 text-xs text-[#477bea]">See notes</span></div><div className="space-y-5">{results.map((item) => { const content = splitNote(item); return <button key={item.id} type="button" onMouseEnter={() => setSelectedId(item.id)} onFocus={() => setSelectedId(item.id)} onClick={() => onOpenNote(item)} className={`block min-h-[200px] w-full rounded-lg border bg-white p-5 text-left shadow-[0_2px_8px_rgba(0,0,0,0.13)] transition hover:-translate-y-0.5 ${selectedId === item.id ? 'border-[#6f9cff] ring-1 ring-[#6f9cff]/40' : 'border-[#e2e2e2]'}`}><span className="float-right text-xs text-[#477bea]">note</span><strong className="block max-w-[82%] text-base">{content.title}</strong><p className="mt-4 line-clamp-6 whitespace-pre-wrap text-sm leading-relaxed text-[#777]">{content.body || notePreview(item)}</p><div className="mt-7 flex justify-between text-xs text-[#aaa]"><span>{cleanCategory(item.category) || 'Instant retrieval'}</span><span>{formatDate(item.created_at)}</span></div></button>; })}{!results.length && <p className="text-sm text-[#999]">No close notes yet. Try a broader request.</p>}</div></aside>}
        </div>
      </div>
    </div>
  );
}

function NoteEditor({ state, cortexes, saving, error, onChange, onCreateMuse, onClose, onSave, onDelete }: {
  state: NoteEditorState; cortexes: CortexMeta[]; saving: boolean; error: string;
  onChange: (state: NoteEditorState) => void; onCreateMuse: (title: string) => void;
  onClose: () => void; onSave: () => void; onDelete?: () => void;
}) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const speechRef = useRef<SpeechRecognitionLike | null>(null);
  const [dictating, setDictating] = useState(false);
  const [museOpen, setMuseOpen] = useState(false);
  const [newMuse, setNewMuse] = useState('');

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[5px]" role="dialog" aria-modal="true" aria-label={state.note ? 'Edit note' : 'Create note'}>
      <button type="button" onClick={onClose} aria-label="Close note editor" className="absolute right-5 top-5 z-10 text-white drop-shadow sm:right-8 sm:top-7"><X className="h-7 w-7" /></button>
      <div className="flex h-[min(78vh,780px)] min-h-[530px] w-[min(88vw,1340px)] flex-col overflow-visible rounded-[20px] border-[9px] border-[#f5f5f7] bg-white shadow-2xl">
        <div className="min-h-0 flex-1 px-8 pb-5 pt-10 sm:px-16 sm:pt-12">
          <input autoFocus value={state.title} onChange={(event) => onChange({ ...state, title: event.target.value })} placeholder="What’s on your mind?" aria-label="Note title" className="w-full bg-transparent text-xl font-medium italic outline-none placeholder:text-[#252525] sm:text-2xl" />
          <p className="mt-4 text-sm leading-relaxed text-[#777]">For example: Someone made the point that we mostly don&apos;t choose our beliefs, we absorb them and backfill reasons after.<br className="hidden sm:block" /> Uncomfortable but I can&apos;t argue with it. Makes me wonder how much of what I think is actually mine.</p>
          <textarea ref={bodyRef} value={state.body} onChange={(event) => onChange({ ...state, body: event.target.value })} aria-label="Note body" className="mt-6 h-[calc(100%-112px)] w-full resize-none bg-transparent text-base leading-relaxed outline-none" />
        </div>
        <div className="relative flex min-h-[58px] flex-wrap items-center gap-1 border-t border-[#eee] bg-[#f8f8fa] px-3 py-2 text-sm text-[#555] sm:px-5">
          <button type="button" onClick={toggleDictation} aria-label={dictating ? 'Stop dictation' : 'Start dictation'} className={`mr-3 rounded p-2 hover:bg-white ${dictating ? 'text-red-600' : ''}`}><Mic className="h-4 w-4" /></button><span className="mr-3 h-7 w-px bg-[#ddd]" />
          <button type="button" onClick={() => applyFormat('bold')} aria-label="Bold" className="rounded p-2 font-bold hover:bg-white"><Bold className="h-4 w-4" /></button>
          <button type="button" onClick={() => applyFormat('italic')} aria-label="Italic" className="rounded p-2 italic hover:bg-white"><Italic className="h-4 w-4" /></button><span className="mx-2 h-7 w-px bg-[#ddd]" />
          <button type="button" onClick={() => applyFormat('h1')} className="rounded px-2 py-1.5 font-semibold hover:bg-white">H1</button><button type="button" onClick={() => applyFormat('h2')} className="rounded px-2 py-1.5 font-semibold hover:bg-white">H2</button><button type="button" onClick={() => applyFormat('h3')} className="rounded px-2 py-1.5 font-semibold hover:bg-white">H3</button><button type="button" onClick={() => applyFormat('body')} className="rounded px-2 py-1.5 hover:bg-white">Body</button><span className="mx-2 hidden h-7 w-px bg-[#ddd] lg:block" />
          <button type="button" onClick={() => applyFormat('bullet')} className="hidden items-center gap-1 rounded px-2 py-1.5 hover:bg-white sm:flex"><List className="h-4 w-4" /> Bullet list</button><button type="button" onClick={() => applyFormat('number')} className="hidden items-center gap-1 rounded px-2 py-1.5 hover:bg-white md:flex"><ListOrdered className="h-4 w-4" /> Numbered list</button>
          <div className="relative ml-auto">
            <button type="button" onClick={() => setMuseOpen((value) => !value)} className="flex items-center text-sm"><span className="text-[#477bea]">Muse:</span>&nbsp;<span className="border-b border-[#999]">{museLabel}</span><ChevronDown className="ml-1 h-3.5 w-3.5" /></button>
            {museOpen && <div className="absolute bottom-9 right-0 z-[60] w-[285px] overflow-hidden rounded-lg border border-[#ddd] bg-white py-2 shadow-xl">
              <button type="button" onClick={() => { onChange({ ...state, muse: AUTOMATIC_MUSE }); setMuseOpen(false); }} className="flex w-full items-center justify-between px-5 py-3 text-left text-sm hover:bg-[#f6f6f6]">Automatically organize {state.muse === AUTOMATIC_MUSE && <Check className="h-4 w-4 text-[#477bea]" />}</button>
              {cortexes.map((cortex) => <button key={cortex.title} type="button" onClick={() => { onChange({ ...state, muse: cortex.title }); setMuseOpen(false); }} className="flex w-full items-center justify-between px-5 py-3 text-left text-sm hover:bg-[#f6f6f6]">{cortex.title} {state.muse === cortex.title && <Check className="h-4 w-4 text-[#477bea]" />}</button>)}
              <div className="flex items-center gap-2 border-t border-[#eee] px-4 py-2">
                <Plus className="h-4 w-4 shrink-0 text-[#777]" />
                <input value={newMuse} onChange={(event) => setNewMuse(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && newMuse.trim()) { event.preventDefault(); onCreateMuse(newMuse); setNewMuse(''); setMuseOpen(false); } }} placeholder="New Muse" className="min-w-0 flex-1 py-1 text-sm outline-none" />
                <button type="button" disabled={!newMuse.trim()} onClick={() => { onCreateMuse(newMuse); setNewMuse(''); setMuseOpen(false); }} aria-label="Create Muse" className="rounded bg-[#477bea] p-1 text-white disabled:opacity-35"><Check className="h-3.5 w-3.5" /></button>
              </div>
            </div>}
          </div>
          {onDelete && <button type="button" onClick={onDelete} disabled={saving} aria-label="Delete note" className="ml-3 rounded p-2 text-red-600 hover:bg-red-50"><Trash2 className="h-4 w-4" /></button>}
          <button type="button" onClick={onSave} disabled={saving || (!state.title.trim() && !state.body.trim())} className="ml-3 flex h-8 w-32 items-center justify-center rounded-md bg-[#477bea] text-white hover:bg-[#3d6ed7] disabled:opacity-45 sm:w-40">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}</button>
          {error && <p role="alert" className="absolute bottom-full right-0 mb-2 max-w-[420px] rounded-md bg-red-600 px-3 py-2 text-xs text-white">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function CortexEditor({ state, saving, error, onChange, onClose, onSave }: {
  state: CortexEditorState; saving: boolean; error: string; onChange: (state: CortexEditorState) => void; onClose: () => void; onSave: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[6px]" role="dialog" aria-modal="true" aria-label={state.originalTitle ? 'Edit Muse' : 'Create Muse'}>
      <div className="relative w-[min(92vw,570px)]">
        <button type="button" onClick={onClose} aria-label="Close Muse editor" className="absolute right-2 top-2 z-10 text-[#777] sm:-right-10 sm:-top-8 sm:text-white"><X className="h-7 w-7" /></button>
        <div className="rounded-xl border-[9px] border-[#f4f4f6] bg-white p-5 shadow-2xl">
          <input autoFocus value={state.title} onChange={(event) => onChange({ ...state, title: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) onSave(); }} placeholder="Muse title" aria-label="Muse title" className="w-full bg-transparent px-2 pb-5 text-2xl font-bold text-[#555] outline-none placeholder:text-[#777]" />
          <textarea id="cortex-description" value={state.description} onChange={(event) => onChange({ ...state, description: event.target.value })} placeholder={'Describe what this muse is about, this will help Ocreda automatically organize your notes.\n\nE.g: This muse is about my personal experience with philosophy in daily life.'} className="h-[270px] w-full resize-none rounded-lg bg-[#f7f7f9] p-6 text-base leading-relaxed text-[#555] outline-none placeholder:text-[#aaa]" />
        </div>
        <button type="button" onClick={onSave} disabled={saving || !state.title.trim()} className="mx-auto mt-9 flex h-9 w-[180px] max-w-[80vw] items-center justify-center rounded-md bg-[#477bea] text-white hover:bg-[#3d6ed7] disabled:opacity-45">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}</button>
        {error && <p role="alert" className="mt-3 text-center text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}

function SavedConfirmation() {
  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/25 backdrop-blur-[5px]" role="status" aria-live="polite"><div className="flex h-[260px] w-[min(88vw,680px)] items-center justify-center rounded-lg bg-[#477bea] text-xl text-white shadow-2xl sm:text-2xl">Saved to you for you</div></div>;
}
