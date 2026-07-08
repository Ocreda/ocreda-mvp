'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Navigation from '@/components/Navigation';
import SidebarMain from '@/components/SidebarMain';
import NotePopup from '@/components/NotePopup';
import { getCategoryColor } from '@/components/CategoryBox';
import { Note, NoteMemoryStrength } from '@/lib/types';
import {
  getNotes,
  deleteNote,
  getMemoryStrengths,
  reinforceMemoryStrength,
  generateCategoryQuestions,
} from '@/lib/notes-api';
import {
  ArrowLeft,
  RefreshCw,
  Sparkles,
  Send,
  Loader as Loader2,
  Search,
} from 'lucide-react';
import Link from 'next/link';
import ClickableTag from '@/components/ClickableTag';
import NoteFilterBar, { FilterState, applyFilters } from '@/components/NoteFilterBar';
import DateNotesModal from '@/components/DateNotesModal';

export default function CategoryPage() {
  const { name } = useParams<{ name: string }>();
  const router = useRouter();
  const categoryName = decodeURIComponent(name);

  const [notes, setNotes] = useState<Note[]>([]);
  const [strengths, setStrengths] = useState<NoteMemoryStrength[]>([]);
  const [loading, setLoading] = useState(true);
  const [colorIndex, setColorIndex] = useState(0);

  const [questions, setQuestions] = useState<string[]>([]);
  const [loadingQ, setLoadingQ] = useState(false);
  const [qError, setQError] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [popupNoteId, setPopupNoteId] = useState<string | null>(null);
  const [dateFilter, setDateFilter] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>({ dateFrom: '', dateTo: '', sortOrder: 'newest' });
  const questionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const [allNotes, s] = await Promise.all([getNotes(), getMemoryStrengths()]);
        const categoryNotes = allNotes.filter((n) => n.category === categoryName);
        setNotes(categoryNotes);
        setStrengths(s);

        // Derive color index from position in sorted category list
        const cats = Array.from(new Set(allNotes.map((n) => n.category).filter(Boolean))) as string[];
        const idx = cats.indexOf(categoryName);
        setColorIndex(idx >= 0 ? idx : 0);
      } finally {
        setLoading(false);
      }
    })();
  }, [categoryName]);

  const loadQuestions = useCallback(async () => {
    if (notes.length === 0) return;
    setLoadingQ(true);
    setQError(false);
    try {
      const result = await generateCategoryQuestions(categoryName);
      setQuestions(result.questions);
    } catch {
      setQError(true);
    } finally {
      setLoadingQ(false);
    }
  }, [categoryName, notes.length]);

  // Auto-load questions once notes are ready
  useEffect(() => {
    if (!loading && notes.length > 0 && questions.length === 0) {
      loadQuestions();
    }
  }, [loading, notes.length, questions.length, loadQuestions]);

  const handleNoteClick = (note: Note) => {
    setPopupNoteId(note.id);
    reinforceMemoryStrength(note.id).catch(() => {});
  };

  const handleDelete = async (noteId: string) => {
    await deleteNote(noteId);
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
    if (popupNoteId === noteId) setPopupNoteId(null);
  };

  const handleNoteUpdated = (updated: Note) => {
    setNotes((prev) => prev.map((n) => n.id === updated.id ? updated : n));
  };

  const handleAskQuestion = (q: string) => {
    router.push(`/qa?q=${encodeURIComponent(q)}`);
  };

  const color = getCategoryColor(colorIndex);
  const strengthMap = new Map(strengths.map((s) => [s.note_id, s.score]));

  // All tags within this category
  const categoryTags = Array.from(new Set(notes.flatMap((n) => n.tags ?? []))).sort();

  // Apply search then date/sort filters
  const searchFiltered = searchQuery.trim()
    ? notes.filter((n) => {
        const q = searchQuery.toLowerCase();
        return n.title?.toLowerCase().includes(q) || n.content.toLowerCase().includes(q);
      })
    : notes;

  const visibleNotes = applyFilters(searchFiltered, filters);

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <SidebarMain>
        <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-4 sm:pt-10 pb-24">

          {/* Header */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-4">
              <Link
                href="/notes"
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors group"
              >
                <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
                All categories
              </Link>
              </div>

            <div className="rounded-2xl px-6 py-5 shadow-sm" style={{ backgroundColor: color.bg }}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-widest mb-1" style={{ color: color.meta }}>
                    {notes.length} {notes.length === 1 ? 'note' : 'notes'}
                  </p>
                  <h1 className="text-2xl font-bold" style={{ color: color.title }}>{categoryName}</h1>
                </div>
                {!loading && notes.length > 0 && (
                  <button
                    onClick={() => {
                      setSearchOpen((v) => {
                        const next = !v;
                        if (next) setTimeout(() => searchInputRef.current?.focus(), 50);
                        else setSearchQuery('');
                        return next;
                      });
                    }}
                    className="transition-opacity opacity-60 hover:opacity-100 p-1.5 rounded-lg flex-shrink-0 mt-0.5"
                    style={{ color: color.meta }}
                    title="Search notes"
                  >
                    <Search className="w-4 h-4" />
                  </button>
                )}
              </div>

              {searchOpen && (
                <div className="mt-3 relative">
                  <Search
                    className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none opacity-40"
                    style={{ color: color.title }}
                  />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setSearchQuery('');
                        setSearchOpen(false);
                      }
                    }}
                    placeholder="Search in this category..."
                    className="w-full pl-9 pr-4 py-2 text-sm rounded-xl focus:outline-none transition-all"
                    style={{
                      backgroundColor: `${color.title}14`,
                      border: `1px solid ${color.title}25`,
                      color: color.title,
                    }}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Filter bar */}
          {!loading && notes.length > 0 && (
            <NoteFilterBar
              allTags={categoryTags}
              filters={filters}
              onChange={setFilters}
            />
          )}

          {/* Notes grid */}
          {loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="rounded-xl h-32 bg-muted animate-pulse" />
              ))}
            </div>
          ) : notes.length === 0 ? (
            <p className="text-sm text-muted-foreground/60 text-center py-16">No notes in this category.</p>
          ) : visibleNotes.length === 0 ? (
            <p className="text-sm text-muted-foreground/50 text-center py-12">
              {searchQuery ? `No notes match "${searchQuery}"` : 'No notes match the current filters.'}
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-12">
              {visibleNotes.map((note) => {
                const score = strengthMap.get(note.id);
                return (
                  <button
                    key={note.id}
                    onClick={() => handleNoteClick(note)}
                    className="text-left bg-card border border-border rounded-xl p-4 hover:border-primary/30 hover:shadow-sm hover:shadow-primary/5 transition-all duration-200 group"
                  >
                    <div className="flex items-start gap-2.5 mb-1">
                      {note.image_url && (
                        <div className="flex-shrink-0 w-12 h-12 rounded-lg overflow-hidden bg-muted">
                          <img src={note.image_url} alt="" className="w-full h-full object-cover" />
                        </div>
                      )}
                      <p className="text-sm font-semibold text-foreground line-clamp-1 group-hover:text-primary transition-colors flex-1 mt-0.5">
                        {note.title || note.content.slice(0, 60)}
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-3 leading-relaxed">
                      {note.image_description || note.content}
                    </p>
                    {note.tags && note.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2.5">
                        {note.tags.slice(0, 4).map((tag) => (
                          <ClickableTag key={tag} tag={tag} />
                        ))}
                      </div>
                    )}
                    {score !== undefined && (
                      <div className="flex items-center gap-1.5 mt-2.5">
                        <div className="flex-1 h-0.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{
                              width: `${score}%`,
                              background: score > 70 ? '#34d399' : score > 40 ? '#fbbf24' : '#f87171',
                            }}
                          />
                        </div>
                        <span className="text-[10px] text-muted-foreground/40 tabular-nums w-5 text-right">{Math.round(score)}</span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* AI Questions */}
          {!loading && notes.length > 0 && (
            <div ref={questionsRef} className="border-t border-border pt-8">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-primary" />
                  <h2 className="text-sm font-semibold text-foreground">Questions to explore</h2>
                </div>
                <button
                  onClick={loadQuestions}
                  disabled={loadingQ}
                  title="Generate new questions"
                  className="p-1.5 rounded-lg text-muted-foreground/50 hover:text-muted-foreground hover:bg-accent transition-all disabled:opacity-30"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingQ ? 'animate-spin' : ''}`} />
                </button>
              </div>

              {loadingQ ? (
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-14 rounded-xl bg-muted animate-pulse" />
                  ))}
                </div>
              ) : qError ? (
                <p className="text-xs text-muted-foreground/50 text-center py-4">
                  Couldn&apos;t generate questions.{' '}
                  <button onClick={loadQuestions} className="text-primary hover:underline">Try again</button>
                </p>
              ) : (
                <div className="space-y-2">
                  {questions.map((q, i) => (
                    <button
                      key={i}
                      onClick={() => handleAskQuestion(q)}
                      className="w-full text-left flex items-start gap-3 px-4 py-3.5 bg-card border border-border rounded-xl hover:border-primary/30 hover:bg-primary/3 hover:shadow-sm transition-all duration-200 group"
                    >
                      <Send className="w-3.5 h-3.5 text-muted-foreground/40 group-hover:text-primary flex-shrink-0 mt-0.5 transition-colors" />
                      <span className="text-sm text-foreground group-hover:text-primary transition-colors leading-snug">
                        {q}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

        </div>
      </SidebarMain>

      {popupNoteId && (
        <NotePopup
          noteId={popupNoteId}
          onClose={() => setPopupNoteId(null)}
          onNoteUpdated={handleNoteUpdated}
          onNoteDeleted={handleDelete}
          onRelatedNoteClick={(id) => setPopupNoteId(id)}
          onViewAllConnected={(id) => { setPopupNoteId(null); router.push(`/note/${id}`); }}
          onDateClick={(d) => { setPopupNoteId(null); setDateFilter(d); }}
          onOpen={(id) => { setPopupNoteId(null); router.push(`/note/${id}`); }}
        />
      )}

      {dateFilter && (
        <DateNotesModal
          dateStr={dateFilter}
          onClose={() => setDateFilter(null)}
          onNoteClick={(id) => { setDateFilter(null); setPopupNoteId(id); }}
        />
      )}
    </div>
  );
}
