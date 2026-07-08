'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Navigation from '@/components/Navigation';
import SidebarMain from '@/components/SidebarMain';
import NoteForm from '@/components/NoteForm';
import NotePopup from '@/components/NotePopup';
import CategoryBox from '@/components/CategoryBox';
import CategoryPreviewModal from '@/components/CategoryPreviewModal';
import GuestSignupPrompt from '@/components/GuestSignupPrompt';
import { Note } from '@/lib/types';
import {
  getNotes,
  createNote,
  updateNote,
  deleteNote,
  processNote,
  uploadNoteImage,
  categorizeNotes,
  reinforceMemoryStrength,
  getLastCategorizedAt,
  setLastCategorizedAt,
  searchNotes,
} from '@/lib/notes-api';
import { useGuest } from '@/lib/guest-context';
import {
  Plus,
  Mic,
  MicOff,
  Loader as Loader2,
  Sparkles,
  MessageSquare,
  Search,
  ArrowUpDown,
  RotateCcw,
  X,
  Brain,
  BookOpen,
} from 'lucide-react';
import Link from 'next/link';

const MAX_CATEGORIES = 8;

const FORBIDDEN_CATEGORY_NAMES = /^(other|miscellaneous|uncategorized|general|various|misc|mixed|rest|leftovers?|additional|extra|assorted|random|unrelated|unsorted|remaining|catch.all|default|unknown)$/i;

function buildCategoryMap(notes: Note[]): Map<string, Note[]> {
  const raw = new Map<string, Note[]>();
  for (const note of notes) {
    if (!note.category) continue;
    if (FORBIDDEN_CATEGORY_NAMES.test(note.category.trim())) continue;
    if (!raw.has(note.category)) raw.set(note.category, []);
    raw.get(note.category)!.push(note);
  }
  const sorted = Array.from(raw.entries()).sort((a, b) => b[1].length - a[1].length);
  return new Map(sorted.slice(0, MAX_CATEGORIES));
}

export default function NotesPage() {
  const router = useRouter();
  const { isGuest, guestNotes, addGuestNote, canAddNote } = useGuest();

  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);

  // Note form
  const [showNoteForm, setShowNoteForm] = useState(false);
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [processing, setProcessing] = useState(false);
  const [processingDone, setProcessingDone] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  // Popup & category preview
  const [popupNoteId, setPopupNoteId] = useState<string | null>(null);
  const [previewCategory, setPreviewCategory] = useState<string | null>(null);

  // Organize
  const [organizing, setOrganizing] = useState(false);
  const [organizeMessage, setOrganizeMessage] = useState('');
  const [organizeError, setOrganizeError] = useState('');
  const [organizeStats, setOrganizeStats] = useState<{ db: number; cat: number } | null>(null);

  // Signup prompt
  const [showSignupPrompt, setShowSignupPrompt] = useState(false);

  // Search mode — shows flat note-card list
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Note[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Sort mode — shows flat note-card list (newest/oldest)
  const [sortOpen, setSortOpen] = useState(false);
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [lastCategorizedAt, setLastCategorizedAtState] = useState<string | null>(null);

  // Inline input bar
  const [inputTitle, setInputTitle] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [inputFocused, setInputFocused] = useState(false);
  const [recording, setRecording] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ── Load notes ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (isGuest) {
      setNotes(guestNotes as unknown as Note[]);
      setLoading(false);
      return;
    }
    Promise.all([getNotes(), getLastCategorizedAt()])
      .then(([n, lastAt]) => { setNotes(n); setLastCategorizedAtState(lastAt ?? null); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isGuest, guestNotes]);

  // ── Open-note-popup event (sidebar pinned notes) ─────────────────────────────

  useEffect(() => {
    const handler = (e: Event) => {
      const { noteId } = (e as CustomEvent).detail ?? {};
      if (noteId) setPopupNoteId(noteId);
    };
    window.addEventListener('open-note-popup', handler);
    return () => window.removeEventListener('open-note-popup', handler);
  }, []);

  // ── Search ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!searchOpen) { setSearchQuery(''); setSearchResults([]); return; }
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, [searchOpen]);

  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) { setSearchResults([]); return; }

    // Client-side quick filter first (instant feedback)
    const lower = q.toLowerCase();
    const local = notes.filter(
      (n) =>
        n.title?.toLowerCase().includes(lower) ||
        n.content.toLowerCase().includes(lower)
    );
    setSearchResults(local);

    // Debounce full-text search for logged-in users
    if (isGuest) return;
    const t = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const remote = await searchNotes(q);
        setSearchResults(remote);
      } catch {
        // keep local results
      } finally {
        setSearchLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [searchQuery, notes, isGuest]);

  // ── Category map ─────────────────────────────────────────────────────────────

  const rawCategoryMap = buildCategoryMap(notes);
  const categories = Array.from(rawCategoryMap.entries());
  const uncategorizedCount = notes.filter((n) => !n.category).length;
  const totalNoteCount = notes.length;

  // ── Sorted note list (for sort mode) ────────────────────────────────────────

  const sortedNotes = [...notes].sort((a, b) =>
    sortOrder === 'newest'
      ? new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      : new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  // ── Note CRUD ────────────────────────────────────────────────────────────────

  const handleSaveNote = async (title: string, content: string) => {
    if (isGuest) {
      if (!canAddNote) { setShowSignupPrompt(true); return; }
      addGuestNote(title, content);
      setShowNoteForm(false);
      return;
    }

    let imageUrl: string | undefined;
    if (imageFile) {
      try { imageUrl = await uploadNoteImage(imageFile); } catch { /* silently skip */ }
    }

    if (editingNote) {
      const updated = await updateNote(editingNote.id, title, content);
      setNotes((prev) => prev.map((n) => n.id === editingNote.id ? updated : n));
      setEditingNote(null);
      setShowNoteForm(false);
      return;
    }

    const note = await createNote(title, content, imageUrl);
    setNotes((prev) => [note, ...prev]);
    setShowNoteForm(false);
    setEditingNote(null);
    setProcessing(true);
    setProcessingDone(false);
    try {
      const result = await processNote(note.id, note.title, note.content, imageUrl);
      setNotes((prev) =>
        prev.map((n) =>
          n.id === note.id ? { ...n, tags: result.tags, title: result.title || n.title } : n
        )
      );
      setProcessingDone(true);
      setTimeout(() => setProcessingDone(false), 4000);
    } finally {
      setProcessing(false);
    }
  };

  const handleDelete = async (noteId: string) => {
    if (isGuest) return;
    await deleteNote(noteId);
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
    if (popupNoteId === noteId) setPopupNoteId(null);
  };

  const handleNoteUpdated = useCallback((updated: Note) => {
    setNotes((prev) => prev.map((n) => n.id === updated.id ? updated : n));
  }, []);

  // ── Organize with AI ─────────────────────────────────────────────────────────

  const handleOrganize = async () => {
    console.log('[organize] clicked — isGuest:', isGuest, '| notes in memory:', notes.length);
    if (isGuest) { setShowSignupPrompt(true); return; }

    setOrganizing(true);
    setOrganizeMessage('');
    setOrganizeError('');

    try {
      // Step 1: fetch the last-categorized timestamp (so we skip unchanged notes)
      console.log('[organize] step 1 — fetching last_categorized_at from user_settings...');
      const lastAt = await getLastCategorizedAt();
      console.log('[organize] lastAt =', lastAt);

      // Step 2: call the categorize-notes edge function
      console.log('[organize] step 2 — calling categorize-notes edge function...');
      const result = await categorizeNotes(lastAt);
      console.log('[organize] step 2 result:', JSON.stringify(result));

      // Always refresh notes and show counts
      const nowTs = new Date().toISOString();
      await setLastCategorizedAt(nowTs);
      setLastCategorizedAtState(nowTs);
      const updated = await getNotes();
      setNotes(updated);

      const dbTotal = result.db_total ?? result.total_notes ?? 0;
      const catTotal = result.categorized_count ?? result.assigned_count ?? 0;
      setOrganizeStats({ db: dbTotal, cat: catTotal });

      if (result.changed_count > 0) {
        setOrganizeMessage(`${result.changed_count} notes organized`);
        console.log('[organize] done — db_total:', dbTotal, 'categorized_count:', catTotal, 'changed:', result.changed_count);
      } else {
        setOrganizeMessage('Already up to date');
        console.log('[organize] done — nothing changed. db_total:', dbTotal, 'categorized_count:', catTotal);
      }
      setTimeout(() => { setOrganizeMessage(''); setOrganizeStats(null); }, 12000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[organize] FAILED —', msg);
      setOrganizeError(msg);
      setTimeout(() => setOrganizeError(''), 10000);
    } finally {
      setOrganizing(false);
    }
  };

  // ── Inline note submission ───────────────────────────────────────────────────

  const submitInlineNote = useCallback(async () => {
    const content = inputValue.trim();
    if (!content && !imageFile) return;
    const title = inputTitle.trim();
    if (isGuest) {
      if (!canAddNote) { setShowSignupPrompt(true); return; }
      addGuestNote(title, content);
      setInputValue(''); setInputTitle(''); setInputFocused(false);
      setImageFile(null); setImagePreview(null);
      return;
    }
    setInputValue(''); setInputTitle(''); setInputFocused(false);
    let imageUrl: string | undefined;
    if (imageFile) {
      try { imageUrl = await uploadNoteImage(imageFile); } catch { /* silently fail */ }
    }
    const note = await createNote(title, content, imageUrl);
    setImageFile(null); setImagePreview(null);
    if (imageInputRef.current) imageInputRef.current.value = '';
    setNotes((prev) => [note, ...prev]);
    setProcessing(true);
    try {
      const result = await processNote(note.id, title, content);
      setNotes((prev) =>
        prev.map((n) =>
          n.id === note.id ? { ...n, tags: result.tags, title: result.title || n.title } : n
        )
      );
    } finally {
      setProcessing(false);
    }
  }, [inputValue, inputTitle, isGuest, canAddNote, addGuestNote]);

  // ── Voice input ──────────────────────────────────────────────────────────────

  const toggleVoice = useCallback(() => {
    if (recording) {
      recognitionRef.current?.stop();
      setRecording(false);
      return;
    }
    const SpeechAPI =
      typeof window !== 'undefined' &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
    if (!SpeechAPI) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recognition = new SpeechAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    let final = inputValue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += (final ? ' ' : '') + t;
        else interim = t;
      }
      setInputValue(final + (interim ? ' ' + interim : ''));
    };
    recognition.onend = () => { setRecording(false); setInputValue(final); };
    recognition.onerror = () => setRecording(false);
    recognitionRef.current = recognition;
    recognition.start();
    setRecording(true);
    setInputFocused(true);
    inputRef.current?.focus();
  }, [recording, inputValue]);

  // ── Image upload (Plus icon) ─────────────────────────────────────────────────

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (isGuest && !canAddNote) { setShowSignupPrompt(true); return; }
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => setImagePreview(ev.target?.result as string);
    reader.readAsDataURL(file);
    setInputFocused(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  // ── Derived ──────────────────────────────────────────────────────────────────

  const previewCategoryNotes = previewCategory ? (rawCategoryMap.get(previewCategory) ?? []) : [];
  const previewCategoryIndex = Array.from(rawCategoryMap.keys()).indexOf(previewCategory ?? '');

  // Which view are we showing?
  const showingSearch = searchOpen && searchQuery.trim().length > 0;
  const showingSort = sortOpen && !searchOpen;

  // ────────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <SidebarMain>
        <div className="max-w-2xl mx-auto px-4 sm:px-6 pt-6 sm:pt-10 pb-24">

          {/* ── Inline note input ── */}
          <div className="mb-5">
            <div
              className={`bg-card border rounded-2xl px-4 py-3.5 transition-all duration-200 shadow-sm ${
                inputFocused
                  ? 'border-primary/40 shadow-primary/10 ring-2 ring-primary/10'
                  : 'border-border hover:border-border/70'
              }`}
            >
              {inputFocused && (
                <input
                  type="text"
                  value={inputTitle}
                  onChange={(e) => setInputTitle(e.target.value)}
                  placeholder="Title (optional)"
                  className="w-full text-sm font-semibold text-foreground placeholder:text-muted-foreground/30 bg-transparent focus:outline-none mb-2 pb-2 border-b border-border/50"
                />
              )}
              {imagePreview && (
                <div className="relative mb-2 inline-block">
                  <img
                    src={imagePreview}
                    alt=""
                    className="h-16 w-16 rounded-lg object-cover border border-border/50"
                  />
                  <button
                    type="button"
                    onClick={() => { setImageFile(null); setImagePreview(null); if (imageInputRef.current) imageInputRef.current.value = ''; }}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-foreground text-background flex items-center justify-center shadow-sm hover:bg-foreground/80 transition-colors"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </div>
              )}
              <div className="flex items-start gap-2.5">
                <textarea
                  ref={inputRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onFocus={() => setInputFocused(true)}
                  onBlur={() => { if (!inputValue && !inputTitle) setInputFocused(false); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') { setInputValue(''); setInputTitle(''); setInputFocused(false); }
                    if (e.key === 'Enter' && !e.shiftKey && inputValue.trim()) {
                      e.preventDefault();
                      submitInlineNote();
                    }
                  }}
                  placeholder="What's on your mind..."
                  rows={inputFocused ? 3 : 1}
                  className="flex-1 text-sm text-foreground placeholder:text-muted-foreground/40 bg-transparent focus:outline-none resize-none leading-relaxed"
                />
                <div className="flex items-center gap-1 flex-shrink-0 mt-0.5">
                  <button
                    onClick={toggleVoice}
                    className={`p-1.5 rounded-lg transition-all ${
                      recording
                        ? 'text-destructive bg-destructive/10 animate-pulse'
                        : 'text-muted-foreground/40 hover:text-foreground hover:bg-accent'
                    }`}
                    title={recording ? 'Stop recording' : 'Voice input'}
                  >
                    {recording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                  </button>
                  <button
                    onClick={() => imageInputRef.current?.click()}
                    className="p-1.5 rounded-lg text-muted-foreground/40 hover:text-foreground hover:bg-accent transition-all"
                    title="Attach image"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                  <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageSelect} />
                </div>
              </div>
            </div>
            {inputFocused && (inputValue.trim() || imageFile) && (
              <div className="mt-2 flex items-center justify-between px-1">
                <p className="text-[11px] text-muted-foreground/40">↵ to save · ⇧↵ newline</p>
                <button
                  onClick={submitInlineNote}
                  className="px-3 py-1 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-all"
                >
                  Save note
                </button>
              </div>
            )}
          </div>

          {/* ── Quick action chips (centered) ── */}
          <div className="flex items-center justify-center gap-2 mb-8 flex-wrap">
            <Link
              href="/memory"
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-card border border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:border-border/70 hover:shadow-sm transition-all"
            >
              <Brain className="w-3 h-3" />
              Remember
            </Link>
            <Link
              href="/qa"
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-card border border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:border-border/70 hover:shadow-sm transition-all"
            >
              <MessageSquare className="w-3 h-3" />
              Ask a question
            </Link>
            <Link
              href="/journal"
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-card border border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:border-border/70 hover:shadow-sm transition-all"
            >
              <BookOpen className="w-3 h-3" />
              Journal
            </Link>
          </div>

          {/* ── Categories section ── */}
          {loading ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="rounded-2xl h-[200px] bg-muted animate-pulse" />
              ))}
            </div>
          ) : rawCategoryMap.size > 0 ? (
            <>
              {/* Section header */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-widest">
                    Categories
                  </span>
                  <span className="text-[11px] text-muted-foreground/30">·</span>
                  <span className="text-[11px] text-muted-foreground/50">
                    {totalNoteCount} {totalNoteCount === 1 ? 'note' : 'notes'}
                  </span>
                </div>

                <div className="flex items-center gap-0.5">
                  {(organizeMessage || organizeStats) && (
                    <span className="text-[10px] text-muted-foreground/60 mr-1">
                      {organizeStats ? `${organizeStats.cat}/${organizeStats.db} categorized` : organizeMessage}
                    </span>
                  )}

                  {/* Search toggle */}
                  <button
                    onClick={() => { setSearchOpen((v) => !v); setSortOpen(false); }}
                    className={`p-1.5 rounded-lg transition-all ${
                      searchOpen
                        ? 'text-primary bg-primary/10'
                        : 'text-muted-foreground/50 hover:text-foreground hover:bg-accent'
                    }`}
                    title="Search notes"
                  >
                    <Search className="w-3.5 h-3.5" />
                  </button>

                  {/* Sort toggle */}
                  <button
                    onClick={() => { setSortOpen((v) => !v); setSearchOpen(false); }}
                    className={`p-1.5 rounded-lg transition-all ${
                      sortOpen
                        ? 'text-primary bg-primary/10'
                        : 'text-muted-foreground/50 hover:text-foreground hover:bg-accent'
                    }`}
                    title="Sort notes"
                  >
                    <ArrowUpDown className="w-3.5 h-3.5" />
                  </button>

                  {/* Organize */}
                  <button
                    onClick={handleOrganize}
                    disabled={organizing}
                    className="p-1.5 rounded-lg text-muted-foreground/50 hover:text-foreground hover:bg-accent transition-all disabled:opacity-40"
                    title="Organize with AI"
                  >
                    {organizing
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <RotateCcw className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              {/* Unorganized notes reminder */}
              {(() => {
                const uncategorized = notes.filter(
                  (n) => !n.category || FORBIDDEN_CATEGORY_NAMES.test(n.category.trim())
                ).length;
                if (uncategorized === 0) return null;
                return (
                  <div className="flex items-center justify-between mb-3 px-3 py-2 rounded-xl bg-muted/40 border border-border/30">
                    <span className="text-[11px] text-muted-foreground/60">
                      {uncategorized} {uncategorized === 1 ? 'note' : 'notes'} ready to organize
                    </span>
                    <button
                      onClick={handleOrganize}
                      disabled={organizing}
                      className="text-[11px] font-medium text-primary/70 hover:text-primary transition-colors disabled:opacity-40"
                    >
                      Organize now
                    </button>
                  </div>
                );
              })()}

              {/* Search bar */}
              {searchOpen && (
                <div className="mb-4 relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/30 pointer-events-none" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search notes by title or content..."
                    className="w-full pl-9 pr-9 py-2.5 text-sm rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 placeholder:text-muted-foreground/30 text-foreground shadow-sm transition-all"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground/40 hover:text-muted-foreground"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )}

              {/* Sort bar */}
              {sortOpen && !searchOpen && (
                <div className="mb-4 flex items-center gap-2">
                  <span className="text-xs text-muted-foreground/50">Sort:</span>
                  <button
                    onClick={() => setSortOrder('newest')}
                    className={`px-3 py-1 rounded-full text-xs font-medium border transition-all ${
                      sortOrder === 'newest'
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-card text-muted-foreground border-border hover:border-border/70'
                    }`}
                  >
                    Newest first
                  </button>
                  <button
                    onClick={() => setSortOrder('oldest')}
                    className={`px-3 py-1 rounded-full text-xs font-medium border transition-all ${
                      sortOrder === 'oldest'
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-card text-muted-foreground border-border hover:border-border/70'
                    }`}
                  >
                    Oldest first
                  </button>
                  <button
                    onClick={() => setSortOpen(false)}
                    className="ml-auto p-1 rounded-lg text-muted-foreground/40 hover:text-muted-foreground"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Search results — flat note list */}
              {showingSearch && (
                <div className="space-y-2">
                  {searchLoading && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground/50 py-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Searching...
                    </div>
                  )}
                  {searchResults.length === 0 && !searchLoading && (
                    <p className="text-sm text-muted-foreground/50 text-center py-8">
                      No notes found for &ldquo;{searchQuery}&rdquo;
                    </p>
                  )}
                  {searchResults.map((note) => (
                    <NoteListRow
                      key={note.id}
                      note={note}
                      onClick={(id) => setPopupNoteId(id)}
                    />
                  ))}
                </div>
              )}

              {/* Sort results — flat note list */}
              {showingSort && (
                <div className="space-y-2">
                  {sortedNotes.map((note) => (
                    <NoteListRow
                      key={note.id}
                      note={note}
                      onClick={(id) => setPopupNoteId(id)}
                    />
                  ))}
                  {sortedNotes.length === 0 && (
                    <p className="text-sm text-muted-foreground/50 text-center py-8">No notes yet.</p>
                  )}
                </div>
              )}

              {/* Category grid — 4 columns on sm+, 2 on mobile */}
              {!showingSearch && !showingSort && (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {categories.map(([name, catNotes], idx) => (
                      <CategoryBox
                        key={name}
                        name={name}
                        notes={catNotes}
                        colorIndex={idx}
                        onPreview={() => setPreviewCategory(name)}
                      />
                    ))}
                  </div>
                  {uncategorizedCount > 0 && (
                    <p className="text-[11px] text-muted-foreground/40 mt-4 text-center">
                      {uncategorizedCount} uncategorized — tap the reload icon above to sort them
                    </p>
                  )}
                </>
              )}
            </>
          ) : notes.length === 0 ? (
            <div className="text-center py-24">
              <p className="text-sm text-muted-foreground/50">
                {isGuest
                  ? 'Write your first note above to get started.'
                  : 'No notes yet. Start capturing your thoughts above.'}
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 py-16">
              <p className="text-sm text-muted-foreground/60">
                You have {notes.length} {notes.length === 1 ? 'note' : 'notes'} — let AI organize them into categories.
              </p>
              <button
                onClick={handleOrganize}
                disabled={organizing}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary/10 border border-primary/20 text-sm font-medium text-primary hover:bg-primary/15 transition-all disabled:opacity-50"
              >
                {organizing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {organizing ? 'Organizing…' : 'Organize notes with AI'}
              </button>
              {organizeMessage && <p className="text-xs text-muted-foreground/60">{organizeMessage}</p>}
            </div>
          )}

          {/* ── Organize progress banner ── */}
          {organizing && (
            <div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-3 px-4 py-3 bg-primary text-primary-foreground text-sm font-medium shadow-md">
              <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
              Organizing your notes with AI — this may take up to 60 seconds...
            </div>
          )}

          {/* ── Organize success banner ── */}
          {organizeMessage && !organizing && (
            <div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 px-4 py-3 bg-green-600 text-white text-sm font-medium shadow-md">
              <Sparkles className="w-4 h-4 flex-shrink-0" />
              {organizeMessage}
              <button onClick={() => setOrganizeMessage('')} className="ml-2 opacity-70 hover:opacity-100">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* ── Organize error banner ── */}
          {organizeError && (
            <div className="fixed top-0 left-0 right-0 z-50 flex items-start justify-between gap-2 px-4 py-3 bg-destructive text-destructive-foreground text-sm shadow-md">
              <div className="flex items-start gap-2 min-w-0">
                <span className="font-semibold flex-shrink-0">Organize failed:</span>
                <span className="line-clamp-2 break-all">{organizeError}</span>
              </div>
              <button onClick={() => setOrganizeError('')} className="flex-shrink-0 opacity-70 hover:opacity-100 ml-2">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Processing indicators */}
          {processing && (
            <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 bg-card border border-border rounded-full shadow-lg text-xs text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
              AI is processing your note...
            </div>
          )}
          {processingDone && !processing && (
            <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 bg-primary/10 border border-primary/20 rounded-full shadow-lg text-xs text-primary">
              <Sparkles className="w-3.5 h-3.5" />
              Note processed — title, tags and connections added
            </div>
          )}

        </div>
      </SidebarMain>

      {showNoteForm && (
        <NoteForm
          note={editingNote}
          onSave={handleSaveNote}
          onClose={() => { setShowNoteForm(false); setEditingNote(null); setImageFile(null); }}
          processing={processing}
          processingDone={processingDone}
        />
      )}

      {popupNoteId && (
        <NotePopup
          noteId={popupNoteId}
          onClose={() => setPopupNoteId(null)}
          onNoteUpdated={handleNoteUpdated}
          onNoteDeleted={handleDelete}
          onRelatedNoteClick={(id) => setPopupNoteId(id)}
          onViewAllConnected={(id) => { setPopupNoteId(null); router.push(`/note/${id}`); }}
          onDateClick={() => {}}
          onOpen={(id) => { setPopupNoteId(null); router.push(`/note/${id}`); }}
        />
      )}

      {previewCategory && (
        <CategoryPreviewModal
          name={previewCategory}
          notes={previewCategoryNotes}
          colorIndex={previewCategoryIndex >= 0 ? previewCategoryIndex : 0}
          onClose={() => setPreviewCategory(null)}
          onNoteClick={(note) => {
            setPreviewCategory(null);
            setPopupNoteId(note.id);
            reinforceMemoryStrength(note.id).catch(() => {});
          }}
        />
      )}

      {showSignupPrompt && (
        <GuestSignupPrompt
          onClose={() => setShowSignupPrompt(false)}
          message="You've reached the guest limit. Sign up free to save unlimited notes."
        />
      )}
    </div>
  );
}

// ── Lightweight note list row (used for search + sort results) ────────────────

function NoteListRow({ note, onClick }: { note: Note; onClick: (id: string) => void }) {
  const date = new Date(note.created_at).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  return (
    <button
      onClick={() => onClick(note.id)}
      className="w-full text-left bg-card border border-border hover:border-border/70 hover:shadow-sm rounded-xl px-4 py-3 transition-all group"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {note.title ? (
            <p className="text-sm font-semibold text-foreground line-clamp-1 leading-snug group-hover:text-primary transition-colors">
              {note.title}
            </p>
          ) : null}
          <p className={`text-xs text-muted-foreground line-clamp-2 leading-relaxed ${note.title ? 'mt-0.5' : ''}`}>
            {note.content}
          </p>
        </div>
        <span className="flex-shrink-0 text-[10px] text-muted-foreground/40 mt-0.5 whitespace-nowrap">{date}</span>
      </div>
      {note.category && (
        <span className="mt-1.5 inline-block text-[10px] text-muted-foreground/60 bg-muted border border-border px-1.5 py-0.5 rounded-md">
          {note.category}
        </span>
      )}
    </button>
  );
}
