'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Bold, Check, ChevronDown, ChevronLeft, ChevronRight, Filter, FolderPlus, Grid2X2, Italic, Layers3, List, ListOrdered, Loader as Loader2, Mic, MoreHorizontal, PanelRightOpen, Plus, Rows3, ScanSearch, Search, Trash2, Upload, X } from 'lucide-react';
import NoteImporter, { ImportNoteDraft } from '@/components/NoteImporter';
import { useAuth } from '@/lib/auth-context';
import { backfillSemanticEmbeddings, createNote, deleteNote, getNotes, importNotes, moveNotesToCategory, processNote, retrieveSemanticNotes, updateNote } from '@/lib/notes-api';
import { supabase } from '@/lib/supabase';
import { Note } from '@/lib/types';
import {
  createDomain as createStoredDomain,
  createProject as createStoredProject,
  createProjectPage as createStoredProjectPage,
  deleteDomain as deleteStoredDomain,
  deleteProject as deleteStoredProject,
  deleteProjectPage as deleteStoredProjectPage,
  migrateBrowserWorkspace,
  setNotesDomain,
  updateDomain as updateStoredDomain,
  updateProject as updateStoredProject,
  updateProjectPage as updateStoredProjectPage,
  type CortexProject,
  type Domain as MuseMeta,
  type ProjectPage,
} from '@/lib/workspace-api';

type NoteEditorState = { note: Note | null; title: string; body: string; muse: string };
type MuseEditorState = { originalTitle: string | null; title: string; description: string };
type ProjectEditorState = { project: CortexProject | null; title: string; description: string };
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
  const title = (first.trim() || 'Untitled note').slice(0, 120);
  const body = rest.join('\n').trim();
  return { title, body: body || (first.trim().length > 120 ? first.trim() : '') };
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
  const [projects, setProjects] = useState<CortexProject[]>([]);
  const [view, setView] = useState<'cortex' | 'muses'>('cortex');
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState('');
  const [noteEditor, setNoteEditor] = useState<NoteEditorState | null>(null);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
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

  const load = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    try {
      const [loaded, workspace] = await Promise.all([getNotes(), migrateBrowserWorkspace(user.id)]);
      setMuseMeta(workspace.domains);
      setProjects(workspace.projects);
      setNotes(loaded.map((note) => ({ ...note, category: workspace.noteDomainNames[note.id] ?? null })));
      void backfillSemanticEmbeddings({ batchSize: 25, maxBatches: 2, retryStaleProcessing: true }).catch(() => {});
      const { data } = await supabase.from('user_settings').select('full_name').eq('user_id', user.id).maybeSingle();
      const authName = String(user.user_metadata?.full_name ?? user.user_metadata?.name ?? '').trim();
      setDisplayName(data?.full_name?.trim() || authName || user.email?.split('@')[0] || 'you');
    }
    catch (err) { setError(safeErrorMessage(err, 'Unable to load your workspace.')); }
    finally { setLoading(false); }
  }, [user]);
  useEffect(() => { void load(); }, [load]);

  const muses = useMemo(() => {
    const map = new Map<string, MuseMeta>();
    museMeta.forEach((item) => { const title = cleanCategory(item.title); if (title) map.set(title.toLowerCase(), { ...item, title }); });
    return Array.from(map.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [museMeta]);

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
  const isEmpty = !loading && notes.length === 0 && muses.length === 0 && projects.length === 0;
  const flashSaved = () => { setSavedOpen(true); window.setTimeout(() => setSavedOpen(false), 1350); };
  const closeLibrary = useCallback(() => { setActiveMuse(null); setShowUnsorted(false); setView('cortex'); }, []);
  const openNewNote = (muse = AUTOMATIC_MUSE) => { setError(''); setNoteEditor({ note: null, title: '', body: '', muse }); };
  const openExistingNote = (note: Note) => { setError(''); setActiveNoteId(note.id); };
  const createMuseFromEditor = (value: string) => {
    const requested = cleanCategory(value);
    if (!requested) return;
    const existing = muses.find((item) => item.title.toLowerCase() === requested.toLowerCase());
    const title = existing?.title ?? requested;
    setNoteEditor((current) => current ? { ...current, muse: title } : current);
  };

  const saveNote = async () => {
    if (!noteEditor) return;
    const title = noteEditor.title.trim(); const body = noteEditor.body.trim();
    if (!title && !body) { setError('Write something before saving.'); return; }
    const rawText = title && body ? `${title}\n\n${body}` : title || body;
    const category = noteEditor.muse === AUTOMATIC_MUSE ? inferMuse(rawText, muses) : cleanCategory(noteEditor.muse);
    setSaving(true); setError('');
    try {
      let domain = category ? muses.find((item) => item.title.toLowerCase() === category.toLowerCase()) : null;
      if (category && !domain) {
        domain = await createStoredDomain(category);
        setMuseMeta((current) => [...current.filter((item) => item.title.toLowerCase() !== category.toLowerCase()), domain!]);
      }
      if (noteEditor.note) {
        const updated = await updateNote(noteEditor.note.id, rawText, category);
        await setNotesDomain([updated.id], domain?.id ?? null);
        setNotes((current) => current.map((note) => note.id === updated.id ? { ...updated, category } : note));
      } else {
        const created = await createNote(rawText, category);
        await setNotesDomain([created.id], domain?.id ?? null);
        setNotes((current) => [{ ...created, category }, ...current]);
        processNote(created.id).catch(() => {});
      }
      setNoteEditor(null); flashSaved();
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
      setNotes((items) => items.filter((item) => item.id !== note.id));
      if (activeNoteId === note.id) setActiveNoteId(null);
    } catch (err) { setError(safeErrorMessage(err, 'Unable to delete this page.')); }
    finally { setSaving(false); }
  };

  const saveInstantRetrieval = async (queryText: string, resultNotes: Note[], projectId: string, newProjectTitle?: string) => {
    setSaving(true); setError('');
    try {
      let target = projects.find((project) => project.id === projectId);
      if (!target) {
        const title = cleanCategory(newProjectTitle);
        if (!title) throw new Error('Choose a project or create a new one first.');
        target = await createStoredProject(title, 'Pages saved from Instant Retrieval.');
      }
      const closest = resultNotes[0];
      const closestContent = closest ? splitNote(closest) : null;
      const page = await createStoredProjectPage(
        target.id,
        queryText.trim().replace(/[.!?]+$/, '').slice(0, 100) || 'Instant retrieval',
        closestContent
          ? `${closestContent.title}\n\n${closestContent.body || notePreview(closest)}`
          : `Instant retrieval\n\n${queryText.trim()}`,
      );
      page.sourceNoteIds = resultNotes.slice(0, 6).map((note) => note.id);
      setProjects((current) => {
        const exists = current.some((project) => project.id === target!.id);
        const base = exists ? current : [...current, target!];
        return base.map((project) => project.id === target!.id ? { ...project, pages: [...project.pages, page], updatedAt: page.updatedAt } : project);
      });
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
      const original = museEditor.originalTitle ? muses.find((item) => item.title === museEditor.originalTitle) : null;
      const saved = original
        ? await updateStoredDomain(original.id, title, museEditor.description)
        : await createStoredDomain(title, museEditor.description);
      if (museEditor.originalTitle && museEditor.originalTitle !== title) {
        const affected = notesByMuse.get(museEditor.originalTitle) ?? [];
        setNotes((current) => current.map((note) => affected.some((item) => item.id === note.id) ? { ...note, category: title } : note));
        void moveNotesToCategory(affected.map((note) => note.id), title).catch(() => {});
      }
      setMuseMeta((current) => [...current.filter((item) => item.id !== original?.id && item.title.toLowerCase() !== title.toLowerCase()), saved]);
      if (activeMuse === museEditor.originalTitle) setActiveMuse(title);
      setMuseEditor(null); flashSaved();
    } catch (err) { setError(safeErrorMessage(err, 'Unable to save this Domain.')); }
    finally { setSaving(false); }
  };

  const removeMuse = async (title: string) => {
    if (!confirm(`Delete “${title}”? Its notes will return to Instant retrieval.`)) return;
    setSaving(true);
    try {
      const domain = muses.find((item) => item.title === title);
      if (domain) await deleteStoredDomain(domain.id);
      const affectedIds = (notesByMuse.get(title) ?? []).map((note) => note.id);
      setNotes((current) => current.map((note) => affectedIds.includes(note.id) ? { ...note, category: null } : note));
      void moveNotesToCategory(affectedIds, null).catch(() => {});
      setMuseMeta((current) => current.filter((item) => item.title.toLowerCase() !== title.toLowerCase())); setActiveMuse(null);
    } catch (err) { setError(safeErrorMessage(err, 'Unable to delete this Domain.')); }
    finally { setSaving(false); }
  };

  const saveProject = async () => {
    if (!projectEditor) return;
    const title = cleanCategory(projectEditor.title);
    if (!title) { setError('Add a title for this project.'); return; }
    setSaving(true); setError('');
    try {
      const saved = projectEditor.project
        ? await updateStoredProject(projectEditor.project.id, title, projectEditor.description)
        : await createStoredProject(title, projectEditor.description);
      const nextProject = projectEditor.project ? { ...projectEditor.project, ...saved, pages: projectEditor.project.pages } : saved;
      setProjects((current) => projectEditor.project
        ? current.map((project) => project.id === nextProject.id ? nextProject : project)
        : [...current, nextProject]);
      setProjectEditor(null); setActiveProjectId(nextProject.id); setActivePageId(null); flashSaved();
    } catch (err) { setError(safeErrorMessage(err, 'Unable to save this project.')); }
    finally { setSaving(false); }
  };

  const createProjectPage = async (projectId: string) => {
    setSaving(true); setError('');
    try {
      const page = await createStoredProjectPage(projectId);
      setProjects((current) => current.map((project) => project.id === projectId ? { ...project, pages: [...project.pages, page], updatedAt: page.updatedAt } : project));
      setActivePageId(page.id);
    } catch (err) { setError(safeErrorMessage(err, 'Unable to create this page.')); }
    finally { setSaving(false); }
  };

  const updateProjectPage = async (projectId: string, updatedPage: ProjectPage) => {
    try {
      const saved = await updateStoredProjectPage(projectId, updatedPage);
      setProjects((current) => current.map((project) => project.id === projectId ? { ...project, pages: project.pages.map((page) => page.id === saved.id ? saved : page), updatedAt: saved.updatedAt } : project));
    } catch (err) {
      setError(safeErrorMessage(err, 'Unable to save this page.'));
      throw err;
    }
  };

  const removeProjectPage = async (projectId: string, pageId: string) => {
    const project = projects.find((item) => item.id === projectId);
    const page = project?.pages.find((item) => item.id === pageId);
    if (!project || !page || !confirm(`Delete “${page.title}”?`)) return;
    setSaving(true); setError('');
    try {
      await deleteStoredProjectPage(pageId);
      setProjects((current) => current.map((item) => item.id === projectId ? { ...item, pages: item.pages.filter((candidate) => candidate.id !== pageId), updatedAt: new Date().toISOString() } : item));
      setActivePageId(null);
    } catch (err) { setError(safeErrorMessage(err, 'Unable to delete this page.')); }
    finally { setSaving(false); }
  };

  const removeProject = async (projectId: string) => {
    const project = projects.find((item) => item.id === projectId);
    if (!project || !confirm(`Delete “${project.title}”?`)) return;
    setSaving(true); setError('');
    try {
      await deleteStoredProject(projectId);
      setProjects((current) => current.filter((item) => item.id !== projectId));
      setActiveProjectId(null); setActivePageId(null);
    } catch (err) { setError(safeErrorMessage(err, 'Unable to delete this project.')); }
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

  const activeProject = activeProjectId ? projects.find((project) => project.id === activeProjectId) ?? null : null;
  const activePage = activeProject && activePageId ? activeProject.pages.find((page) => page.id === activePageId) ?? null : null;

  return (
    <main className="light h-[100dvh] w-full overflow-hidden bg-white text-[#141414]">
      <section className="relative flex h-full w-full flex-col overflow-hidden bg-white">
        {activeNoteId && notes.find((note) => note.id === activeNoteId) ? <NoteReadingWorkspace key={activeNoteId} note={notes.find((note) => note.id === activeNoteId)!} allNotes={notes} muses={muses} projects={projects} saving={saving} onBack={() => setActiveNoteId(null)} onAddNote={() => openNewNote(cleanCategory(notes.find((note) => note.id === activeNoteId)?.category) ?? AUTOMATIC_MUSE)} onOpenNote={(note) => setActiveNoteId(note.id)} onOpenPage={(project, page) => { setActiveNoteId(null); setActiveProjectId(project.id); setActivePageId(page.id); }} onUpdate={updateReadingNote} onDelete={removeReadingNote} onSaveRetrieval={saveInstantRetrieval} />
          : activeProject && activePage ? <ProjectPageWorkspace key={activePage.id} project={activeProject} page={activePage} notes={notes} muses={muses} projects={projects} saving={saving} onBack={() => setActivePageId(null)} onChange={(page) => updateProjectPage(activeProject.id, page)} onAddNote={() => openNewNote()} onOpenNote={openExistingNote} onOpenPage={(project, page) => { setActiveProjectId(project.id); setActivePageId(page.id); }} onDelete={() => removeProjectPage(activeProject.id, activePage.id)} onSaveRetrieval={saveInstantRetrieval} />
          : activeProject ? <ProjectPagesGrid project={activeProject} onBack={() => { setActiveProjectId(null); setActivePageId(null); }} onAddPage={() => createProjectPage(activeProject.id)} onOpenPage={(page) => setActivePageId(page.id)} onEdit={() => setProjectEditor({ project: activeProject, title: activeProject.title, description: activeProject.description })} onDelete={() => removeProject(activeProject.id)} />
          : isEmpty ? <EmptyWorkspace displayName={displayName} userEmail={user?.email ?? ''} onAddNote={() => openNewNote()} onImport={handleImport} importError={importError} progress={importProgress} />
          : activeMuse || showUnsorted ? <MuseDetail title={showUnsorted ? 'Instant retrieval' : activeMuse ?? ''} notes={showUnsorted ? unsortedNotes : notesByMuse.get(activeMuse ?? '') ?? []} isUnsorted={showUnsorted} busy={saving} onClose={closeLibrary} onAddNote={() => openNewNote(showUnsorted ? AUTOMATIC_MUSE : activeMuse ?? AUTOMATIC_MUSE)} onOpenNote={openExistingNote} onEdit={() => { const meta = muses.find((item) => item.title === activeMuse); if (meta) setMuseEditor({ originalTitle: meta.title, title: meta.title, description: meta.description }); }} onDelete={() => { if (activeMuse) void removeMuse(activeMuse); }} />
          : view === 'muses' ? <MuseGrid muses={muses} projects={projects} notes={notes} notesByMuse={notesByMuse} busy={saving} onClose={closeLibrary} onAddNote={(muse) => openNewNote(muse ?? AUTOMATIC_MUSE)} onAddMuse={() => setMuseEditor({ originalTitle: null, title: '', description: '' })} onEditMuse={(muse) => setMuseEditor({ originalTitle: muse.title, title: muse.title, description: muse.description })} onDeleteMuse={(title) => void removeMuse(title)} onOpenNote={openExistingNote} onSaveRetrieval={saveInstantRetrieval} />
          : <CortexHome projects={projects} muses={muses} notes={notes} userEmail={user?.email ?? ''} busy={saving} onOpenMuses={() => setView('muses')} onAddNote={() => openNewNote()} onAddProject={() => setProjectEditor({ project: null, title: '', description: '' })} onOpenProject={(project) => { setActiveProjectId(project.id); setActivePageId(null); }} onOpenPage={(project, page) => { setActiveProjectId(project.id); setActivePageId(page.id); }} onOpenNote={openExistingNote} onSaveRetrieval={saveInstantRetrieval} />}
        {error && !noteEditor && !museEditor && !projectEditor && <div role="alert" className="fixed bottom-5 left-1/2 z-40 max-w-[90vw] -translate-x-1/2 rounded-lg bg-[#202020] px-4 py-3 text-sm text-white shadow-xl">{error}<button type="button" onClick={() => setError('')} aria-label="Dismiss error" className="ml-4"><X className="inline h-4 w-4" /></button></div>}
      </section>
      {noteEditor && <NoteEditor state={noteEditor} muses={muses} saving={saving} error={error} onChange={setNoteEditor} onCreateMuse={createMuseFromEditor} onClose={() => { setNoteEditor(null); setError(''); }} onSave={() => void saveNote()} onDelete={noteEditor.note ? () => void removeNote() : undefined} />}
      {museEditor && <MuseEditor state={museEditor} saving={saving} error={error} onChange={setMuseEditor} onClose={() => { setMuseEditor(null); setError(''); }} onSave={() => void saveMuse()} />}
      {projectEditor && <ProjectEditor state={projectEditor} error={error} onChange={setProjectEditor} onClose={() => { setProjectEditor(null); setError(''); }} onSave={saveProject} />}
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
        {feedback && <a href="mailto:feedback@ocreda.com" className="hidden border-l border-[#a8c4ff] px-3 py-1.5 text-[#252525] hover:bg-[#f5f7fb] sm:block">Send feedback</a>}
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

function CortexHome({ projects, muses, notes, userEmail, busy, onOpenMuses, onAddNote, onAddProject, onOpenProject, onOpenPage, onOpenNote, onSaveRetrieval }: {
  projects: CortexProject[]; muses: MuseMeta[]; notes: Note[]; userEmail: string; busy: boolean;
  onOpenMuses: () => void; onAddNote: () => void; onAddProject: () => void;
  onOpenProject: (project: CortexProject) => void; onOpenPage: (project: CortexProject, page: ProjectPage) => void; onOpenNote: (note: Note) => void;
  onSaveRetrieval: (queryText: string, resultNotes: Note[], projectId: string, newProjectTitle?: string) => Promise<void>;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [instantRetrievalOpen, setInstantRetrievalOpen] = useState(false);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-white">
      <header className="relative z-20 flex h-[88px] shrink-0 items-center border-b border-[#eeeeef] px-5 sm:px-8">
        <div className="flex items-center gap-2 text-[#222]">
          <button type="button" onClick={onAddNote} className="flex h-10 items-center gap-2 rounded-md px-2 text-sm hover:bg-[#f5f5f6]" title="Add a note"><span className="flex h-7 w-16 items-center justify-center rounded-md bg-[#477bea] text-white"><Plus className="h-4 w-4" /></span><span className="hidden sm:inline">Add a note</span></button>
          <button type="button" onClick={() => setSearchOpen(true)} aria-label="Search notes, pages, and Domains" title="Search notes, pages, and Domains" className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-[#f5f5f6]"><Search className="h-5 w-5" /></button>
        </div>
        <h1 className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-sm font-normal text-[#b2b2b2] sm:text-base">Your projects</h1>
        <div className="ml-auto"><BetaAndAvatar email={userEmail} feedback /></div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-5 pb-28 pt-12 sm:px-10 lg:px-16">
        <div className="mx-auto grid w-full max-w-[1450px] grid-cols-1 gap-x-12 gap-y-14 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <InstantRetrievalCard onClick={() => setInstantRetrievalOpen(true)} />
          {projects.map((project) => <CortexProjectCard key={project.id} project={project} onClick={() => onOpenProject(project)} />)}
          <button type="button" onClick={onAddProject} aria-label="Add a project" title="Add a project" className="flex h-[286px] items-center justify-center rounded-md text-[#477bea] transition hover:bg-[#f8f9fc]"><FolderPlus className="h-9 w-9 stroke-[1.6]" /></button>
        </div>
      </main>

      <button type="button" onClick={onOpenMuses} aria-label="Open Domains and notes" className="absolute bottom-0 left-1/2 z-20 flex h-16 w-[min(88vw,420px)] -translate-x-1/2 items-center justify-center gap-10 rounded-t-[52px] border border-b-0 border-[#e0e0e0] bg-white px-8 text-xs text-[#777] shadow-[0_-4px_16px_rgba(0,0,0,0.10)] transition hover:h-[70px] hover:text-[#222] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#477bea]">
        <span className="flex items-center gap-2"><Layers3 className="h-4 w-4 text-[#477bea]" /> {muses.length} {muses.length === 1 ? 'Domain' : 'Domains'}</span>
        <span>{notes.length} {notes.length === 1 ? 'Note' : 'Notes'}</span>
      </button>

      {searchOpen && <KnowledgeSearchOverlay request={{ query: '' }} notes={notes} muses={muses} projects={projects} onClose={() => setSearchOpen(false)} onOpenPage={(project, page) => { setSearchOpen(false); onOpenPage(project, page); }} onOpenNote={(note) => { setSearchOpen(false); onOpenNote(note); }} onInstantRetrieval={() => { setSearchOpen(false); setInstantRetrievalOpen(true); }} />}
      {instantRetrievalOpen && <InstantRetrievalOverlay notes={notes} muses={muses} projects={projects} saving={busy} onClose={() => setInstantRetrievalOpen(false)} onOpenNote={(note) => { setInstantRetrievalOpen(false); onOpenNote(note); }} onSave={onSaveRetrieval} />}
    </div>
  );
}

function CortexProjectCard({ project, onClick }: { project: CortexProject; onClick: () => void }) {
  const pages = project.pages.length;
  return (
    <button type="button" onClick={onClick} className="relative h-[286px] overflow-hidden rounded-md border border-[#e0e0e0] bg-[#f7f7f9] p-2 text-left shadow-[0_2px_9px_rgba(0,0,0,0.14)] transition hover:-translate-y-0.5 hover:border-[#8fb1ff] hover:shadow-lg">
      <span className="block h-[230px] overflow-hidden rounded bg-white px-5 py-5 text-sm leading-relaxed text-[#777]"><span className="line-clamp-[10]">{project.description || project.content || 'Start writing freely in this project.'}</span></span>
      <span className="absolute inset-x-4 bottom-3 flex items-center justify-between gap-4 text-xs"><strong className="truncate font-semibold text-[#666]">{project.title}</strong><span className="shrink-0 text-[#b5b5b5]">{pages} {pages === 1 ? 'page' : 'pages'}</span></span>
    </button>
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
  onBack: () => void; onChange: (page: ProjectPage) => Promise<void>;
  onAddNote: () => void; onOpenNote: (note: Note) => void; onOpenPage: (project: CortexProject, page: ProjectPage) => void; onDelete: () => void;
  onSaveRetrieval: (queryText: string, resultNotes: Note[], projectId: string, newProjectTitle?: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(page.title);
  const [content, setContent] = useState(page.content);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [contextOpen, setContextOpen] = useState(true);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [searchRequest, setSearchRequest] = useState<KnowledgeSearchRequest | null>(null);
  const [instantRetrievalOpen, setInstantRetrievalOpen] = useState(false);
  const [surfacedNotes, setSurfacedNotes] = useState<Note[]>([]);
  const [retrievalState, setRetrievalState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const latestChangeRef = useRef(onChange);
  latestChangeRef.current = onChange;

  useEffect(() => {
    if (content === page.content && title === page.title) return;
    setSaveState('saving');
    const timeout = window.setTimeout(() => {
      void latestChangeRef.current({ ...page, title: title.trim() || 'Untitled page', content })
        .then(() => setSaveState('saved'))
        .catch(() => setSaveState('error'));
    }, 550);
    return () => window.clearTimeout(timeout);
  }, [content, page, title]);

  useEffect(() => {
    const pageText = `${title.trim()}\n\n${content.trim()}`.trim();
    if (pageText.length < 3) { setSurfacedNotes([]); setRetrievalState('idle'); return; }
    let cancelled = false;
    setRetrievalState('loading');
    const timeout = window.setTimeout(() => {
      void retrieveSemanticNotes(pageText, { candidateLimit: 60 }).then((result) => {
        if (cancelled) return;
        const byId = new Map(notes.map((note) => [note.id, note]));
        setSurfacedNotes(result.candidates.map((candidate) => byId.get(candidate.note_id)).filter((note): note is Note => !!note).slice(0, 8));
        setRetrievalState('ready');
      }).catch(() => {
        if (!cancelled) { setSurfacedNotes([]); setRetrievalState('error'); }
      });
    }, 650);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [content, notes, title]);

  useEffect(() => {
    setSelectedNoteId((current) => surfacedNotes.some((note) => note.id === current) ? current : surfacedNotes[0]?.id ?? null);
  }, [surfacedNotes]);

  const selectedNote = surfacedNotes.find((note) => note.id === selectedNoteId) ?? surfacedNotes[0] ?? null;
  const selectedContent = selectedNote ? splitNote(selectedNote) : null;

  const leave = () => {
    if (content !== page.content || title !== page.title) {
      void latestChangeRef.current({ ...page, title: title.trim() || 'Untitled page', content }).catch(() => {});
    }
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
          <span className={`text-xs ${saveState === 'error' ? 'text-red-600' : 'text-[#aaa]'}`}>{saveState === 'saving' ? 'Saving...' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Save failed' : ''}</span>
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
          {selectedContent && selectedNote ? <article className="mx-auto max-w-xl"><h2 className="text-lg font-semibold">{selectedContent.title}</h2><p className="mt-6 whitespace-pre-wrap text-sm leading-[1.6] text-[#333]">{selectedContent.body || selectedNote.raw_text}</p><div className="mt-8 border-t border-[#ddd] pt-4 text-xs text-[#999]">Domain: {cleanCategory(selectedNote.category) || 'Instant retrieval'} · {fullNoteDate(selectedNote.created_at)}</div></article> : <div className="flex h-full items-center justify-center text-center"><div><h2 className="text-lg font-semibold">Write to retrieve your knowledge.</h2><p className="mt-3 max-w-sm text-sm leading-relaxed text-[#777]">Related text will appear here as your page develops.</p></div></div>}
        </section>}
        {contextOpen && <aside className="min-h-[420px] overflow-y-auto border-l border-[#dedede] bg-white p-4 lg:min-h-0">
          <h2 className="mb-4 text-center text-sm font-normal text-[#999]">Retrieved for this page</h2>
          <div className="space-y-4">
            {surfacedNotes.map((note) => { const noteContent = splitNote(note); return <button key={note.id} type="button" onMouseEnter={() => setSelectedNoteId(note.id)} onFocus={() => setSelectedNoteId(note.id)} onClick={() => onOpenNote(note)} className={`block h-[190px] w-full overflow-hidden rounded-md border bg-[#f7f7f9] p-2 text-left shadow-sm transition hover:border-[#8fb1ff] ${selectedNoteId === note.id ? 'border-[#7ca2ff] ring-1 ring-[#7ca2ff]/30' : 'border-[#e0e0e0]'}`}><span className="block h-[142px] overflow-hidden rounded bg-white p-4"><span className="float-right text-[11px] text-[#477bea]">note</span><strong className="block max-w-[80%] truncate text-sm">{noteContent.title}</strong><span className="mt-3 block line-clamp-4 text-xs leading-relaxed text-[#777]">{noteContent.body || notePreview(note)}</span></span><span className="mt-2 flex items-center justify-between px-2 text-[11px] text-[#aaa]"><span className="truncate">Domain: {cleanCategory(note.category) || 'Instant retrieval'}</span><span>{formatDate(note.created_at)}</span></span></button>; })}
            {!surfacedNotes.length && <p className="px-4 py-12 text-center text-sm leading-relaxed text-[#999]">{retrievalState === 'loading' ? 'Finding semantic connections…' : retrievalState === 'error' ? 'Semantic retrieval is temporarily unavailable.' : 'Related notes will appear here as your knowledge base grows.'}</p>}
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
  const toggleMuse = (title: string) => setSelectedMuses((current) => {
    const next = new Set(current);
    if (next.has(title)) next.delete(title); else next.add(title);
    return next;
  });

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-white">
      <header className="relative z-20 flex h-[118px] shrink-0 items-end gap-3 overflow-x-auto bg-[#bdbdbd] px-5 pb-4 pt-10 lg:px-7">
        <button type="button" onClick={onAddMuse} className="h-10 shrink-0 rounded-md border border-white bg-transparent px-8 text-sm italic text-white shadow hover:bg-white/10">Create</button>
        <button type="button" onClick={resetLibrary} className={`h-10 shrink-0 rounded-md px-9 text-sm shadow ${selectedMuses.size === 0 ? 'bg-[#202020] text-white' : 'bg-white text-[#222]'}`}>All</button>
        {muses.slice(0, 5).map((muse) => <button key={muse.title} type="button" onClick={() => toggleMuse(muse.title)} className={`h-10 min-w-[174px] shrink-0 rounded-md px-5 text-sm shadow ${selectedMuses.has(muse.title) ? 'bg-[#202020] text-white' : 'bg-[#fbfbfd] text-[#b5b5b5]'}`}>{muse.title}</button>)}
        <button type="button" onClick={() => setMusesOpen(true)} className="ml-auto h-10 min-w-[170px] shrink-0 rounded-md bg-white px-8 text-sm text-[#222] shadow hover:bg-[#f8f8f8]">See all</button>
        <button type="button" onClick={onClose} aria-label="Close note library" title="Close note library" className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-md text-white drop-shadow hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"><X className="h-6 w-6" /></button>
      </header>

      <div className="flex min-h-0 flex-1 bg-white">
        <aside className="relative z-10 flex w-[88px] shrink-0 flex-col items-center border-r border-[#f0f0f0] py-12 text-[#aaa] sm:w-[112px] lg:w-[138px]">
          <button type="button" onClick={() => onAddNote(firstSelectedMuse)} aria-label="Add note" title="Add note" className="flex h-32 w-9 items-center justify-center rounded-md bg-[#477bea] text-white shadow hover:bg-[#3d6ed7]"><Plus className="h-5 w-5" /></button>
          <span className="mt-16 text-center text-xs text-[#477bea]">{visibleNotes.length} {visibleNotes.length === 1 ? 'note' : 'notes'}</span>
          <div className="relative mt-6">
            <button type="button" onClick={() => setSortOpen((open) => !open)} aria-label="Sort notes" title="Sort notes" className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-[#f4f4f4]"><Filter className="h-5 w-5" /></button>
            {sortOpen && <div className="absolute left-11 top-0 z-30 w-28 rounded-md border border-[#e5e5e5] bg-white p-2 text-left text-xs text-[#aaa] shadow-xl">{(['newest', 'oldest', 'random', 'date'] as LibrarySort[]).map((option) => <button key={option} type="button" onClick={() => { setSort(option); if (option === 'random') setRandomSeed(Date.now()); if (option !== 'date') setDate(''); setSortOpen(false); }} className={`block w-full rounded px-2 py-1.5 capitalize hover:bg-[#f5f5f5] ${sort === option ? 'text-[#222]' : ''}`}>{option}</button>)}</div>}
          </div>
          {sort === 'date' && <input type="date" value={date} onChange={(event) => setDate(event.target.value)} aria-label="Filter by date" className="mt-1 w-[82px] rounded border border-[#ddd] px-1 py-1 text-[9px] text-[#555] sm:w-24 sm:text-[10px]" />}
          <button type="button" onClick={() => setLayout((value) => value === 'grid' ? 'large' : 'grid')} aria-label={layout === 'grid' ? 'Use large card view' : 'Use grid view'} title={layout === 'grid' ? 'Use large card view' : 'Use grid view'} aria-pressed={layout === 'grid'} className={`mt-1 flex h-10 w-10 items-center justify-center rounded-md transition ${layout === 'grid' ? 'bg-[#f4f4f6] text-[#777]' : 'hover:bg-[#f4f4f4]'}`}>{layout === 'grid' ? <Grid2X2 className="h-5 w-5" /> : <Rows3 className="h-5 w-5" />}</button>
          <button type="button" onClick={() => { setSearchOpen((open) => !open); if (searchOpen) setQuery(''); }} aria-label="Search notes" title="Search notes" className="mt-1 flex h-10 w-10 items-center justify-center rounded-md hover:bg-[#f4f4f4]"><Search className="h-5 w-5" /></button>
          <button type="button" onClick={() => setInstantRetrievalOpen(true)} aria-label="Open Instant Retrieval" title="Open Instant Retrieval" className="mt-1 flex h-10 w-10 items-center justify-center rounded-md text-[#477bea] hover:bg-[#edf3ff]"><ScanSearch className="h-5 w-5" /></button>
        </aside>

        <section className="min-w-0 flex-1 overflow-y-auto px-5 pt-12 sm:px-8 lg:px-12 lg:pt-16">
          {searchOpen && <label className="mb-10 flex h-12 w-full max-w-[330px] items-center rounded-xl bg-[#f7f7f9] px-4 shadow"><Search className="mr-3 h-5 w-5 text-[#aaa]" /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setSearchOpen(false); setQuery(''); } }} placeholder="Search your notes" className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label>}
          <div data-testid="note-library-cards" data-layout={query.trim() ? 'search' : layout} className={`grid gap-7 pb-20 lg:gap-10 ${query.trim() ? 'grid-cols-1 xl:grid-cols-2' : layout === 'grid' ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4' : 'grid-cols-1 lg:grid-cols-2'}`}>
            {selectedMuses.size === 0 && !query.trim() && <AddLibraryCard layout={layout} onClick={() => onAddNote()} />}
            {visibleNotes.map((note) => <LibraryNoteCard key={note.id} note={note} query={query} layout={query.trim() ? 'search' : layout} onClick={() => onOpenNote(note)} />)}
            {query.trim() && <InstantRetrievalCard onClick={() => setInstantRetrievalOpen(true)} tall />}
            {selectedMuses.size > 0 && !query.trim() && <AddLibraryCard layout={layout} onClick={() => onAddNote(firstSelectedMuse)} />}
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
  return <button type="button" onClick={onClick} className={`relative overflow-hidden rounded-md border border-[#e1e1e1] bg-white text-left text-[#477bea] shadow-[0_2px_9px_rgba(0,0,0,0.14)] transition hover:-translate-y-0.5 hover:shadow-lg ${layout === 'grid' ? 'h-[300px] p-6' : 'h-[430px] p-8'}`}><span className="flex items-center gap-2 text-base"><Plus className="h-5 w-5" /> Add</span><span className="absolute inset-x-5 bottom-6 text-center text-sm italic text-[#bbb]">You can always add more</span><span className="sr-only">{layout === 'grid' ? 'grid' : 'large card'} layout</span></button>;
}

function LibraryNoteCard({ note, query, layout, onClick }: { note: Note; query: string; layout: LibraryLayout | 'search'; onClick: () => void }) {
  const content = splitNote(note);
  const isGrid = layout === 'grid';
  const isLarge = layout === 'large';
  return <button type="button" onClick={onClick} className={`relative overflow-hidden rounded-md border border-[#e1e1e1] bg-[#f7f7f9] p-2 text-left shadow-[0_2px_9px_rgba(0,0,0,0.14)] transition hover:-translate-y-0.5 hover:border-[#7ca2ff] hover:shadow-lg ${isGrid ? 'h-[300px]' : isLarge ? 'h-[430px]' : 'h-[340px]'}`}><span className={`block overflow-hidden rounded bg-white ${isGrid ? 'h-[246px] px-5 py-5' : isLarge ? 'h-[376px] px-8 py-8' : 'h-[286px] px-6 py-6'}`}><strong className={`block text-base leading-snug ${isLarge ? 'line-clamp-4 text-lg' : 'line-clamp-3'}`}><HighlightedText text={content.title} query={query} /></strong><span className={`mt-4 block whitespace-pre-wrap text-sm leading-relaxed text-[#777] ${isGrid ? 'line-clamp-[7]' : isLarge ? 'line-clamp-[12]' : 'line-clamp-[8]'}`}><HighlightedText text={content.body || notePreview(note)} query={query} /></span></span><span className="absolute inset-x-4 bottom-3 flex items-center justify-between gap-3 text-xs text-[#aaa]"><span className="truncate">Domain: {cleanCategory(note.category) || 'Instant retrieval'}</span><span className="shrink-0">{formatDate(note.created_at)}</span></span><span className="sr-only">{isLarge ? 'large card' : layout} layout</span></button>;
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
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[#bdbdbd] pt-20">
      <button type="button" onClick={onClose} aria-label="Close Domain and return home" title="Close Domain and return home" className="absolute right-5 top-5 z-20 flex h-10 w-10 items-center justify-center rounded-md text-white drop-shadow hover:bg-white/10"><X className="h-6 w-6" /></button>
      <section className="relative min-h-0 flex-1 overflow-y-auto rounded-t-[28px] bg-white px-5 pb-16 pt-9 sm:px-12 lg:px-20">
      <h1 className="text-center text-sm font-normal text-[#aaa]">{title}</h1>
      {!isUnsorted && <div className="absolute right-6 top-4 sm:right-10"><button type="button" onClick={() => setMenuOpen((value) => !value)} aria-label="Domain options" aria-expanded={menuOpen} className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-[#f4f4f4]"><MoreHorizontal className="h-5 w-5" /></button>{menuOpen && <div className="absolute right-0 top-11 z-10 w-40 overflow-hidden rounded-lg border border-[#ddd] bg-white py-1 text-sm shadow-xl"><button type="button" onClick={() => { setMenuOpen(false); onEdit(); }} className="block w-full px-4 py-2.5 text-left hover:bg-[#f5f5f5]">Edit Domain</button><button type="button" disabled={busy} onClick={() => { setMenuOpen(false); onDelete(); }} className="block w-full px-4 py-2.5 text-left text-red-600 hover:bg-red-50">Delete Domain</button></div>}</div>}
      <div className="mx-auto mt-12 grid max-w-[1300px] grid-cols-1 justify-items-center gap-x-14 gap-y-16 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {notes.map((note) => { const content = splitNote(note); return <button key={note.id} type="button" onClick={() => onOpenNote(note)} className="relative h-[355px] w-[278px] overflow-hidden rounded-md border border-[#e2e2e2] bg-white p-6 text-left shadow-[0_2px_9px_rgba(0,0,0,0.15)] transition-all hover:-translate-y-0.5 hover:shadow-lg"><strong className="block line-clamp-3 text-base leading-snug">{content.title}</strong><span className="mt-4 block whitespace-pre-wrap text-sm leading-relaxed text-[#727272] line-clamp-[10]">{content.body || notePreview(note)}</span><span className="absolute bottom-4 right-4 text-xs text-[#b8b8b8]">{formatDate(note.created_at)}</span></button>; })}
        <button type="button" onClick={onAddNote} aria-label={`Add a note to ${title}`} className="flex h-[355px] w-[278px] items-center justify-center text-[#477bea] hover:bg-[#fafafa]"><FolderPlus className="h-9 w-9 stroke-[1.6]" /></button>
      </div>
      {!notes.length && <p className="mt-8 text-center text-sm text-[#999]">This Domain is ready for its first note.</p>}
      </section>
    </div>
  );
}

type KnowledgeFilter = { kind: 'muse' | 'date'; value: string; label: string };
type KnowledgeSearchRequest = { query: string; filter?: KnowledgeFilter };

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

function NoteReadingWorkspace({ note, allNotes, muses, projects, saving, onBack, onAddNote, onOpenNote, onOpenPage, onUpdate, onDelete, onSaveRetrieval }: {
  note: Note; allNotes: Note[]; muses: MuseMeta[]; projects: CortexProject[]; saving: boolean;
  onBack: () => void; onAddNote: () => void; onOpenNote: (note: Note) => void; onOpenPage: (project: CortexProject, page: ProjectPage) => void;
  onUpdate: (noteId: string, rawText: string) => Promise<void>; onDelete: (note: Note) => Promise<void>;
  onSaveRetrieval: (queryText: string, resultNotes: Note[], projectId: string, newProjectTitle?: string) => Promise<void>;
}) {
  const initial = splitNote(note);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
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
  const usedPages = useMemo(() => {
    const noteTitle = splitNote(note).title.toLowerCase();
    return projects.flatMap((project) => project.pages.map((page) => ({ project, page }))).filter(({ page }) =>
      page.sourceNoteIds.includes(note.id) || (noteTitle.length > 4 && `${page.title} ${page.content}`.toLowerCase().includes(noteTitle))
    ).sort((left, right) => right.page.updatedAt.localeCompare(left.page.updatedAt)).slice(0, 6);
  }, [note, projects]);

  const leaveWorkspace = async (next?: Note | null) => {
    if (rawText && rawText !== note.raw_text.trim()) {
      setSaveState('saving');
      try { await latestSaveRef.current(note.id, rawText); setSaveState('saved'); }
      catch { setSaveState('error'); return; }
    }
    if (next) onOpenNote(next); else onBack();
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
  const openMuse = () => setSearchRequest({ query: muse, filter: { kind: 'muse', value: muse, label: muse } });

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[#bdbdbd] p-3 sm:p-5">
      <header className="relative flex h-14 shrink-0 items-center justify-between px-1 text-white sm:px-2">
        <div className="flex items-center gap-1 sm:gap-2">
          <button type="button" onClick={onAddNote} aria-label="Add a note" className="flex h-8 w-24 items-center justify-center rounded-md bg-[#477bea] hover:bg-[#3d6ed7]"><Plus className="h-5 w-5" /></button>
          <button type="button" onClick={() => setInstantRetrievalOpen(true)} aria-label="Open Instant Retrieval" title="Open Instant Retrieval" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-white/10"><ScanSearch className="h-5 w-5" /></button>
          <button type="button" onClick={() => setSearchRequest({ query: '' })} aria-label="Search notes, pages, and Domains" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-white/10"><Search className="h-5 w-5" /></button>
        </div>
        <div className="flex items-center gap-1 text-xs sm:gap-2">
          <button type="button" disabled={!previousNote} onClick={() => previousNote && void leaveWorkspace(previousNote)} aria-label="Previous note" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-white/10 disabled:opacity-25"><ChevronLeft className="h-4 w-4" /></button>
          <span className="min-w-[60px] text-center">{formatDate(note.created_at)}</span>
          <button type="button" disabled={!nextNote} onClick={() => nextNote && void leaveWorkspace(nextNote)} aria-label="Next note" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-white/10 disabled:opacity-25"><ChevronRight className="h-4 w-4" /></button>
          <button type="button" onClick={() => void leaveWorkspace()} aria-label="Close note view" title="Close note view" className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-white/10"><X className="h-6 w-6" /></button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 overflow-y-auto rounded-2xl border-[8px] border-white/80 bg-[#f7f7f9] shadow-2xl lg:grid-cols-[minmax(0,1fr)_340px] lg:overflow-hidden">
        <section className="relative flex min-h-[560px] min-w-0 flex-col overflow-hidden bg-white shadow-[4px_0_14px_rgba(0,0,0,0.14)] lg:min-h-0">
          <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-28 pt-12 sm:px-16 lg:px-[11%] lg:pt-20">
            {editing ? <div className="mx-auto max-w-4xl"><input autoFocus maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Note title" className="w-full bg-transparent text-2xl font-semibold outline-none" /><textarea ref={bodyRef} maxLength={4000} value={body} onChange={(event) => setBody(event.target.value)} aria-label="Note text" className="mt-8 min-h-[560px] w-full resize-none bg-transparent text-base leading-[1.7] outline-none" /></div> : <article className="mx-auto max-w-4xl"><button type="button" onClick={() => setEditing(true)} className="block w-full rounded-md px-2 py-1 text-left outline-none hover:bg-[#f8f8f8] focus-visible:ring-2 focus-visible:ring-[#477bea]/20"><h1 className="text-2xl font-semibold">{title}</h1></button><button type="button" onClick={() => { setEditing(true); requestAnimationFrame(() => bodyRef.current?.focus()); }} className="mt-8 block w-full rounded-md px-2 py-2 text-left text-base leading-[1.7] outline-none hover:bg-[#f8f8f8] focus-visible:ring-2 focus-visible:ring-[#477bea]/20"><span className="whitespace-pre-wrap">{body || note.raw_text || 'Tap to start writing.'}</span></button></article>}
          </div>
          <ReadingFormatBar onFormat={applyReadingFormat} onDone={() => setEditing(false)} editing={editing} />
          <span className="absolute bottom-3 right-5 text-[11px] text-[#999]">{saving || saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Save failed' : ''}</span>
        </section>

        <aside className="relative min-h-[420px] overflow-y-auto bg-[#f7f7f9] px-6 pb-8 pt-16 lg:min-h-0">
          <div className="absolute right-4 top-3">
            <button type="button" onClick={() => setMenuOpen((open) => !open)} aria-label="Note options" aria-expanded={menuOpen} className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-white"><MoreHorizontal className="h-5 w-5" /></button>
            {menuOpen && <div className="absolute right-0 top-10 z-10 w-40 overflow-hidden rounded-lg border border-[#ddd] bg-white py-1 text-sm shadow-xl"><button type="button" onClick={() => { setMenuOpen(false); setEditing(true); requestAnimationFrame(() => bodyRef.current?.focus()); }} className="block w-full px-4 py-2.5 text-left hover:bg-[#f5f5f5]">Edit note</button><button type="button" disabled={saving} onClick={() => { setMenuOpen(false); void onDelete(note); }} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-red-600 hover:bg-red-50"><Trash2 className="h-4 w-4" /> Delete note</button></div>}
          </div>
          <button type="button" onClick={openDate} aria-label={`Search notes from ${fullNoteDate(note.created_at)}`} className="block rounded px-1 py-1 text-left text-sm text-[#777] hover:bg-white hover:text-[#477bea]">{fullNoteDate(note.created_at)}</button>
          <button type="button" onClick={openMuse} aria-label={`Search notes in ${muse}`} className="mt-5 block rounded px-1 py-1 text-left text-sm hover:bg-white"><span className="font-medium">Domain:</span> <span className="text-[#777]">{muse}</span></button>
          <div className="my-6 h-px bg-[#d8d8d8]" />
          <h2 className="text-sm font-normal text-[#477bea]">Used in pages</h2>
          <div className="mt-5 space-y-5">{usedPages.map(({ project, page }) => <button key={`${project.id}-${page.id}`} type="button" onClick={() => onOpenPage(project, page)} className="block w-full overflow-hidden rounded-lg border border-[#e0e0e0] bg-[#f7f7f9] p-2 text-left shadow-[0_2px_8px_rgba(0,0,0,0.13)] transition hover:-translate-y-0.5 hover:border-[#8fb1ff]"><span className="block min-h-[150px] rounded bg-white p-5"><strong className="block text-base">{page.title}</strong><span className="mt-4 block line-clamp-6 whitespace-pre-wrap text-sm leading-relaxed text-[#777]">{page.content || 'Empty page'}</span></span><span className="mt-2 flex justify-between px-2 text-xs text-[#aaa]"><span>{project.title}</span><span>Page</span></span></button>)}{!usedPages.length && <p className="py-8 text-sm leading-relaxed text-[#999]">This note has not been used on a project page yet.</p>}</div>
        </aside>
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

function KnowledgeSearchOverlay({ request, notes, muses, projects, onClose, onOpenPage, onOpenNote, onInstantRetrieval }: {
  request: KnowledgeSearchRequest; notes: Note[]; muses: MuseMeta[]; projects: CortexProject[]; onClose: () => void; onOpenPage: (project: CortexProject, page: ProjectPage) => void; onOpenNote: (note: Note) => void; onInstantRetrieval: () => void;
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
    const values = [...muses.map((muse) => muse.title), ...sortedNotes.slice(0, 5).map((note) => splitNote(note).title)];
    return Array.from(new Set(values.filter(Boolean))).slice(0, 6);
  }, [muses, sortedNotes]);
  const heading = filter?.kind === 'date' ? `Notes written on ${filter.label}` : filter?.kind === 'muse' ? `Notes in ${filter.label}` : `Notes containing “${query.trim()}”`;

  const changeQuery = (value: string) => { setQuery(value); setFilter(undefined); };

  return (
    <div className="fixed inset-0 z-[80] bg-black/25 p-3 backdrop-blur-[5px] sm:p-6" role="dialog" aria-modal="true" aria-label="Search notes, pages, and Domains" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <button type="button" onClick={onClose} aria-label="Close search" className="absolute right-5 top-5 z-10 flex h-10 w-10 items-center justify-center rounded-md text-white hover:bg-white/10"><X className="h-7 w-7" /></button>
      <div className="mx-auto mt-12 flex h-[calc(100%-3rem)] max-w-[1640px] flex-col overflow-hidden rounded-[20px] bg-white shadow-2xl sm:mt-16 sm:h-[calc(100%-4rem)]">
        <div className="flex h-20 shrink-0 items-center border-b border-[#ddd] px-7 sm:px-10"><Search className="mr-4 h-6 w-6 shrink-0 text-[#aaa]" /><input autoFocus value={query} onChange={(event) => changeQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }} placeholder="Search notes, pages, and Domains" className="h-full min-w-0 flex-1 bg-transparent text-xl outline-none placeholder:text-[#b3b3b3] sm:text-2xl" />{filter && <button type="button" onClick={() => { setFilter(undefined); setQuery(''); }} className="rounded-full bg-[#edf3ff] px-3 py-1.5 text-xs text-[#477bea]">Clear {filter.kind === 'muse' ? 'domain' : filter.kind}</button>}</div>
        {!query.trim() && !filter ? <div className="min-h-0 flex-1 overflow-y-auto px-10 py-12 sm:px-16"><p className="text-sm text-[#aaa]">Recent</p><div className="mt-5 max-w-2xl space-y-1">{recentTerms.map((term) => <button key={term} type="button" onClick={() => setQuery(term)} className="block w-full rounded-lg px-1 py-3 text-left text-base text-[#555] hover:bg-[#f6f6f6] hover:px-3">{term}</button>)}</div></div> : <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[450px_minmax(0,1fr)] lg:overflow-hidden">
          <aside className="border-b border-[#ddd] px-7 py-10 lg:overflow-y-auto lg:border-b-0 lg:border-r sm:px-10"><p className="mb-7 text-sm text-[#aaa]">Found in project pages</p><div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-1">{matchingPages.map(({ project, page }) => <button key={`${project.id}-${page.id}`} type="button" onClick={() => onOpenPage(project, page)} className="relative min-h-[300px] rounded-lg border border-[#e3e3e3] bg-white p-7 text-left shadow-[0_2px_8px_rgba(0,0,0,0.14)] transition hover:-translate-y-0.5 hover:border-[#8fb1ff]"><strong className="block text-base"><HighlightedText text={page.title} query={query} /></strong><p className="mt-5 line-clamp-[10] whitespace-pre-wrap text-sm leading-relaxed text-[#777]"><HighlightedText text={page.content || 'Empty page'} query={query} /></p><div className="absolute inset-x-4 bottom-4 flex justify-between text-xs text-[#aaa]"><span>{project.title}</span><span>{formatDate(page.updatedAt)}</span></div></button>)}{!matchingPages.length && <p className="text-sm text-[#999] sm:col-span-2 lg:col-span-1">No project page contains this search.</p>}<InstantRetrievalCard onClick={onInstantRetrieval} tall /></div></aside>
          <section className="min-h-0 px-7 py-10 lg:overflow-y-auto sm:px-12"><p className="mb-7 text-sm text-[#aaa]">{heading}</p><div className="grid gap-7 xl:grid-cols-2">{filteredNotes.map((item) => { const content = splitNote(item); const preview = content.body || notePreview(item); return <button key={item.id} type="button" onClick={() => onOpenNote(item)} className="relative min-h-[250px] rounded-lg border border-[#e3e3e3] bg-[#f7f7f9] p-2 text-left shadow-[0_2px_8px_rgba(0,0,0,0.14)] transition hover:-translate-y-0.5 hover:border-[#8fb1ff]"><div className="h-[190px] rounded-md bg-white p-6"><strong className="block text-base"><HighlightedText text={content.title} query={filter ? '' : query} /></strong><p className="mt-4 line-clamp-6 text-sm leading-relaxed text-[#777]"><HighlightedText text={preview} query={filter ? '' : query} /></p></div><div className="flex items-center justify-between px-3 py-3 text-xs text-[#aaa]"><span>Domain: {cleanCategory(item.category) || 'Instant retrieval'}</span><span>{formatDate(item.created_at)}</span></div></button>; })}{!filteredNotes.length && <p className="text-sm text-[#999] xl:col-span-2">No notes match this search.</p>}<InstantRetrievalCard onClick={onInstantRetrieval} /></div></section>
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
  const [results, setResults] = useState<Note[]>([]);
  const [retrievalState, setRetrievalState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [retrievalError, setRetrievalError] = useState('');

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

  const runRetrieval = async () => {
    setPhase('results'); setRetrievalState('loading'); setRetrievalError('');
    try {
      const result = await retrieveSemanticNotes(query, { candidateLimit: 60 });
      const byId = new Map(notes.map((note) => [note.id, note]));
      setResults(result.candidates.map((candidate) => byId.get(candidate.note_id)).filter((note): note is Note => !!note).slice(0, 6));
      setRetrievalState('ready');
    } catch (error) {
      setResults([]); setRetrievalState('error');
      setRetrievalError(safeErrorMessage(error, 'Semantic retrieval is temporarily unavailable.'));
    }
  };

  const answerClarification = (yes: boolean) => {
    if (yes || clarificationRound > 0) void runRetrieval();
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
            <textarea autoFocus value={query} onChange={(event) => { setQuery(event.target.value); if (phase === 'results') { setPhase('clarify'); setResults([]); setRetrievalState('idle'); } }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); beginClarification(); } }} placeholder="Ask for a specific note or explore a broad idea…" aria-label="Instant retrieval request" className="h-full min-h-[300px] w-full resize-none bg-transparent text-lg leading-relaxed outline-none placeholder:text-[#aaa]" />
            <span className="absolute bottom-5 left-1/2 -translate-x-1/2 text-xs text-[#aaa]">Press Enter to continue · Shift+Enter for a new line</span>
          </section>
          <section className="relative min-h-[430px] overflow-y-auto bg-white px-8 py-16 sm:px-14 lg:min-h-0">
            {!query.trim() ? <p className="text-base text-[#aaa]">Start typing what you want to find.</p> : phase === 'clarify' ? <div><p className="text-lg leading-relaxed">{clarification}</p><div className="mt-8 flex gap-6"><button type="button" onClick={() => answerClarification(true)} aria-label="Yes" className="flex h-10 w-10 items-center justify-center rounded-full bg-[#477bea] text-white hover:bg-[#3d6ed7]"><Check className="h-5 w-5" /></button><button type="button" onClick={() => answerClarification(false)} aria-label="No" className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-[#222] hover:bg-[#f5f5f5]"><X className="h-5 w-5" /></button></div></div> : retrievalState === 'loading' ? <div className="flex h-full items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-[#477bea]" /></div> : retrievalState === 'error' ? <div><h2 className="text-lg font-semibold">Retrieval unavailable</h2><p role="alert" className="mt-4 text-sm leading-relaxed text-red-600">{retrievalError}</p><button type="button" onClick={() => void runRetrieval()} className="mt-6 rounded-md bg-[#477bea] px-4 py-2 text-sm text-white">Try again</button></div> : <div><Check className="h-10 w-10 rounded-full bg-[#477bea] p-2 text-white" /><p className="mt-10 text-lg">I have found {results.length} {results.length === 1 ? 'note' : 'notes'} that are close to your request.</p>{results[0] && <div className="mt-12 border-t border-[#eee] pt-7"><strong className="text-base">Closest match: <HighlightedText text={splitNote(results[0]).title} query={query} /></strong><p className="mt-4 line-clamp-8 whitespace-pre-wrap text-sm leading-relaxed text-[#555]"><HighlightedText text={splitNote(results[0]).body || notePreview(results[0])} query={query} /></p></div>}</div>}
          </section>
          {phase === 'results' && <aside className="min-h-[430px] overflow-y-auto border-l border-[#d6d6d6] bg-white p-5 lg:min-h-0"><div className="mb-4 flex items-center justify-between"><h2 className="text-sm text-[#999]">Retrieved notes</h2><span className="rounded border border-[#bbb] px-3 py-1 text-xs text-[#477bea]">See notes</span></div><div className="space-y-5">{results.map((item) => { const content = splitNote(item); return <button key={item.id} type="button" onMouseEnter={() => setSelectedId(item.id)} onFocus={() => setSelectedId(item.id)} onClick={() => onOpenNote(item)} className={`block min-h-[200px] w-full rounded-lg border bg-white p-5 text-left shadow-[0_2px_8px_rgba(0,0,0,0.13)] transition hover:-translate-y-0.5 ${selectedId === item.id ? 'border-[#6f9cff] ring-1 ring-[#6f9cff]/40' : 'border-[#e2e2e2]'}`}><span className="float-right text-xs text-[#477bea]">note</span><strong className="block max-w-[82%] text-base"><HighlightedText text={content.title} query={query} /></strong><p className="mt-4 line-clamp-6 whitespace-pre-wrap text-sm leading-relaxed text-[#777]"><HighlightedText text={content.body || notePreview(item)} query={query} /></p><div className="mt-7 flex justify-between text-xs text-[#aaa]"><span>{cleanCategory(item.category) || 'Instant retrieval'}</span><span>{formatDate(item.created_at)}</span></div></button>; })}{!results.length && <p className="text-sm text-[#999]">No close notes yet. Try a broader request.</p>}</div></aside>}
        </div>
      </div>
    </div>
  );
}

function NoteEditor({ state, muses, saving, error, onChange, onCreateMuse, onClose, onSave, onDelete }: {
  state: NoteEditorState; muses: MuseMeta[]; saving: boolean; error: string;
  onChange: (state: NoteEditorState) => void; onCreateMuse: (title: string) => void;
  onClose: () => void; onSave: () => void; onDelete?: () => void;
}) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const speechRef = useRef<SpeechRecognitionLike | null>(null);
  const [dictating, setDictating] = useState(false);
  const [museOpen, setMuseOpen] = useState(false);
  const [newMuse, setNewMuse] = useState('');
  const [editingStarted, setEditingStarted] = useState(Boolean(state.note || state.title || state.body));

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[5px]" role="dialog" aria-modal="true" aria-label={state.note ? 'Edit note' : 'Create note'} onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <button type="button" onClick={onClose} aria-label="Close note editor" className="absolute right-5 top-5 z-10 text-white drop-shadow sm:right-8 sm:top-7"><X className="h-7 w-7" /></button>
      <div className="flex h-[min(78vh,780px)] min-h-[530px] w-[min(88vw,1340px)] flex-col overflow-visible rounded-[20px] border-[9px] border-[#f5f5f7] bg-white shadow-2xl">
        <div className="min-h-0 flex-1 px-8 pb-5 pt-10 sm:px-16 sm:pt-12">
          <input maxLength={120} value={state.title} onFocus={() => setEditingStarted(true)} onChange={(event) => onChange({ ...state, title: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); setEditingStarted(true); bodyRef.current?.focus(); } }} placeholder="What’s on your mind?" aria-label="Note title" className="w-full bg-transparent text-xl font-medium italic outline-none placeholder:text-[#252525] sm:text-2xl" />
          <textarea ref={bodyRef} maxLength={2000} value={state.body} onFocus={() => setEditingStarted(true)} onChange={(event) => onChange({ ...state, body: event.target.value })} placeholder={editingStarted ? '' : "For example: Someone made the point that we mostly don't choose our beliefs, we absorb them and backfill reasons after. Uncomfortable but I can't argue with it. Makes me wonder how much of what I think is actually mine."} aria-label="Note body" className="mt-5 h-[calc(100%-64px)] w-full resize-none bg-transparent text-base leading-relaxed outline-none placeholder:text-[#8a8a8a]" />
        </div>
        <div className="relative flex min-h-[58px] flex-wrap items-center gap-1 border-t border-[#eee] bg-[#f8f8fa] px-3 py-2 text-sm text-[#555] sm:px-5">
          <button type="button" onClick={toggleDictation} aria-label={dictating ? 'Stop dictation' : 'Start dictation'} className={`mr-3 rounded p-2 hover:bg-white ${dictating ? 'text-red-600' : ''}`}><Mic className="h-4 w-4" /></button><span className="mr-3 h-7 w-px bg-[#ddd]" />
          <button type="button" onClick={() => applyFormat('bold')} aria-label="Bold" className="rounded p-2 font-bold hover:bg-white"><Bold className="h-4 w-4" /></button>
          <button type="button" onClick={() => applyFormat('italic')} aria-label="Italic" className="rounded p-2 italic hover:bg-white"><Italic className="h-4 w-4" /></button><span className="mx-2 h-7 w-px bg-[#ddd]" />
          <button type="button" onClick={() => applyFormat('h1')} className="rounded px-2 py-1.5 font-semibold hover:bg-white">H1</button><button type="button" onClick={() => applyFormat('h2')} className="rounded px-2 py-1.5 font-semibold hover:bg-white">H2</button><button type="button" onClick={() => applyFormat('h3')} className="rounded px-2 py-1.5 font-semibold hover:bg-white">H3</button><button type="button" onClick={() => applyFormat('body')} className="rounded px-2 py-1.5 hover:bg-white">Body</button><span className="mx-2 hidden h-7 w-px bg-[#ddd] lg:block" />
          <button type="button" onClick={() => applyFormat('bullet')} className="hidden items-center gap-1 rounded px-2 py-1.5 hover:bg-white sm:flex"><List className="h-4 w-4" /> Bullet list</button><button type="button" onClick={() => applyFormat('number')} className="hidden items-center gap-1 rounded px-2 py-1.5 hover:bg-white md:flex"><ListOrdered className="h-4 w-4" /> Numbered list</button>
          <div className="relative ml-auto">
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
          </div>
          {onDelete && <button type="button" onClick={onDelete} disabled={saving} aria-label="Delete note" className="ml-3 rounded p-2 text-red-600 hover:bg-red-50"><Trash2 className="h-4 w-4" /></button>}
          <button type="button" onClick={onSave} disabled={saving || (!state.title.trim() && !state.body.trim())} className="ml-3 flex h-8 w-32 items-center justify-center rounded-md bg-[#477bea] text-white hover:bg-[#3d6ed7] disabled:opacity-45 sm:w-40">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}</button>
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
