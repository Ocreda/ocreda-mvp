'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Navigation from '@/components/Navigation';
import SidebarMain from '@/components/SidebarMain';
import NotePopup from '@/components/NotePopup';
import {
  getJournalEntry,
  upsertJournalEntry,
  getAdjacentJournalDates,
  getYesterdayTomorrowNote,
  getRelatedNotesByIds,
  journalAI,
  saveJournalInsights,
  uploadNoteImage,
} from '@/lib/notes-api';
import { ChevronLeft, ChevronRight, Loader as Loader2, Sparkles, BookOpen, Lightbulb, CircleCheck as CheckCircle2, Calendar, X, Image as ImageIcon, ZoomIn } from 'lucide-react';
import { format, parseISO, isToday } from 'date-fns';

const MOODS = [
  { value: 1, label: 'Very low', color: '#b34040' },
  { value: 2, label: 'Low',      color: '#e07a3a' },
  { value: 3, label: 'Okay',     color: '#d4a820' },
  { value: 4, label: 'Good',     color: '#7bbf6a' },
  { value: 5, label: 'Great',    color: '#2db552' },
];

interface RelatedNote {
  id: string;
  title: string;
  content: string;
  tags: string[];
  similarity?: number;
}

function SavedIndicator({ show }: { show: boolean }) {
  return (
    <span className={`text-[11px] text-muted-foreground/50 transition-opacity duration-500 ${show ? 'opacity-100' : 'opacity-0'}`}>
      Saved
    </span>
  );
}

function adjustTextareaToContent(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

export default function JournalEntryPage() {
  const params = useParams();
  const router = useRouter();
  const dateStr = params.date as string;

  const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(dateStr);

  const [content, setContent] = useState('');
  const [mood, setMood] = useState<number | null>(null);
  const [aiSummary, setAiSummary] = useState('');
  const [relatedNotes, setRelatedNotes] = useState<RelatedNote[]>([]);
  const [relatedNotesExpanded, setRelatedNotesExpanded] = useState(false);
  const [loadingEntry, setLoadingEntry] = useState(true);
  const [loadingAI, setLoadingAI] = useState(false);
  const [savedIndicator, setSavedIndicator] = useState(false);
  const [prevDate, setPrevDate] = useState<string | null>(null);
  const [nextDate, setNextDate] = useState<string | null>(null);
  const [popupNoteId, setPopupNoteId] = useState<string | null>(null);
  const [savingInsights, setSavingInsights] = useState(false);
  const [insightsSaved, setInsightsSaved] = useState(false);
  const [insightsCount, setInsightsCount] = useState(0);

  const [tomorrowNote, setTomorrowNote] = useState('');
  const [yesterdayNote, setYesterdayNote] = useState<string | null>(null);
  const [yesterdayNoteDismissed, setYesterdayNoteDismissed] = useState(false);

  // Image attachment
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [savedImageUrl, setSavedImageUrl] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageUrlRef = useRef<string | null>(null);

  // Refs so async callbacks always read the latest values without stale closures
  const tomorrowNoteRef = useRef('');
  const moodRef = useRef<number | null>(null);
  const aiSummaryRef = useRef('');

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tomorrowSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedContent = useRef('');
  const lastAIContent = useRef('');
  const lastSavedTomorrowNote = useRef('');

  const mainTextareaRef = useRef<HTMLTextAreaElement>(null);
  const tomorrowTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep refs in sync with state
  useEffect(() => { tomorrowNoteRef.current = tomorrowNote; }, [tomorrowNote]);
  useEffect(() => { moodRef.current = mood; }, [mood]);
  useEffect(() => { aiSummaryRef.current = aiSummary; }, [aiSummary]);

  // Adjust main textarea height whenever content changes (including on load)
  useEffect(() => { adjustTextareaToContent(mainTextareaRef.current); }, [content]);

  useEffect(() => {
    if (!isValidDate) return;
    let cancelled = false;
    setLoadingEntry(true);
    setContent('');
    setMood(null);
    setAiSummary('');
    setRelatedNotes([]);
    setRelatedNotesExpanded(false);
    setInsightsSaved(false);
    setTomorrowNote('');
    setYesterdayNote(null);
    setYesterdayNoteDismissed(false);
    setImageFile(null);
    setImagePreview(null);
    setSavedImageUrl(null);
    imageUrlRef.current = null;
    lastSavedContent.current = '';
    lastAIContent.current = '';
    lastSavedTomorrowNote.current = '';

    Promise.all([
      getJournalEntry(dateStr),
      getAdjacentJournalDates(dateStr),
      getYesterdayTomorrowNote(dateStr),
    ]).then(async ([entry, adj, yesterdayMsg]) => {
      if (cancelled) return;

      if (entry) {
        setContent(entry.content);
        setMood(entry.mood ?? null);
        setAiSummary(entry.ai_summary ?? '');
        const tn = entry.tomorrow_note ?? '';
        setTomorrowNote(tn);
        if (entry.image_url) {
          setSavedImageUrl(entry.image_url);
          imageUrlRef.current = entry.image_url;
        }
        lastSavedContent.current = entry.content;
        lastAIContent.current = entry.content;
        lastSavedTomorrowNote.current = tn;

        // Load persisted related notes from saved IDs — no AI call needed
        if (entry.related_note_ids && entry.related_note_ids.length > 0) {
          try {
            const savedNotes = await getRelatedNotesByIds(entry.related_note_ids);
            if (!cancelled) setRelatedNotes(savedNotes);
          } catch { /* silently fail */ }
        }
      }

      setPrevDate(adj.prev);
      setNextDate(adj.next);
      if (yesterdayMsg) setYesterdayNote(yesterdayMsg);
    }).catch(() => {}).finally(() => {
      if (!cancelled) {
        setLoadingEntry(false);
      }
    });

    return () => { cancelled = true; };
  }, [dateStr, isValidDate]);

  // Adjust tomorrow textarea height after loading existing content
  useEffect(() => {
    if (!loadingEntry) {
      adjustTextareaToContent(tomorrowTextareaRef.current);
    }
  }, [loadingEntry, tomorrowNote]);

  const showSaved = useCallback(() => {
    setSavedIndicator(true);
    setTimeout(() => setSavedIndicator(false), 2000);
  }, []);

  const handleImageSelect = async (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => setImagePreview(e.target?.result as string);
    reader.readAsDataURL(file);
    setImageFile(file);
    try {
      const url = await uploadNoteImage(file);
      setSavedImageUrl(url);
      imageUrlRef.current = url;
      await upsertJournalEntry(dateStr, lastSavedContent.current, moodRef.current, aiSummaryRef.current || null, tomorrowNoteRef.current || null, url);
      lastSavedContent.current = lastSavedContent.current;
      showSaved();
    } catch { /* silently fail */ }
  };

  const clearImage = async () => {
    setImageFile(null);
    setImagePreview(null);
    setSavedImageUrl(null);
    imageUrlRef.current = null;
    if (imageInputRef.current) imageInputRef.current.value = '';
    try {
      await upsertJournalEntry(dateStr, lastSavedContent.current, moodRef.current, aiSummaryRef.current || null, tomorrowNoteRef.current || null, null);
    } catch { /* silently fail */ }
  };

  const scheduleSave = useCallback((text: string) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      if (text === lastSavedContent.current && tomorrowNoteRef.current === lastSavedTomorrowNote.current) return;
      try {
        await upsertJournalEntry(
          dateStr, text, moodRef.current, aiSummaryRef.current || null,
          tomorrowNoteRef.current || null, imageUrlRef.current
        );
        lastSavedContent.current = text;
        lastSavedTomorrowNote.current = tomorrowNoteRef.current;
        showSaved();
      } catch { /* silently fail */ }
    }, 1200);
  }, [dateStr, showSaved]);

  const scheduleAI = useCallback((text: string) => {
    if (aiTimerRef.current) clearTimeout(aiTimerRef.current);
    if (text.trim().length < 30) return;
    aiTimerRef.current = setTimeout(async () => {
      // Skip if summary already exists and content hasn't changed significantly
      const prevContent = lastAIContent.current;
      if (aiSummaryRef.current && Math.abs(text.length - prevContent.length) < 50 && text.startsWith(prevContent.slice(0, 40))) return;
      setLoadingAI(true);
      try {
        const result = await journalAI(text, dateStr, imageUrlRef.current || undefined);
        lastAIContent.current = text;
        const newSummary = result.summary;
        const newNotes = result.related_notes ?? [];
        const newIds = newNotes.map((n) => n.id);
        setAiSummary(newSummary);
        setRelatedNotes(newNotes);
        setRelatedNotesExpanded(false);
        await upsertJournalEntry(
          dateStr, text, moodRef.current, newSummary || null,
          tomorrowNoteRef.current || null, imageUrlRef.current, newIds
        );
        lastSavedContent.current = text;
        lastSavedTomorrowNote.current = tomorrowNoteRef.current;
      } catch { /* silently fail */ } finally {
        setLoadingAI(false);
      }
    }, 3000);
  }, [dateStr]);

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    setContent(text);
    scheduleSave(text);
    scheduleAI(text);
  };

  const handleTomorrowNoteChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    setTomorrowNote(text);
    adjustTextareaToContent(e.currentTarget);
    if (tomorrowSaveTimerRef.current) clearTimeout(tomorrowSaveTimerRef.current);
    tomorrowSaveTimerRef.current = setTimeout(async () => {
      if (text === lastSavedTomorrowNote.current) return;
      try {
        await upsertJournalEntry(
          dateStr, lastSavedContent.current, moodRef.current,
          aiSummaryRef.current || null, text || null, imageUrlRef.current
        );
        lastSavedTomorrowNote.current = text;
        showSaved();
      } catch { /* silently fail */ }
    }, 1200);
  };

  const handleMoodSelect = async (m: number) => {
    const newMood = mood === m ? null : m;
    setMood(newMood);
    try {
      await upsertJournalEntry(
        dateStr, content, newMood, aiSummaryRef.current || null,
        tomorrowNoteRef.current || null, imageUrlRef.current
      );
      lastSavedContent.current = content;
      showSaved();
    } catch { /* silently fail */ }
  };

  const handleSaveInsights = async () => {
    if (!content.trim() || savingInsights) return;
    setSavingInsights(true);
    try {
      const result = await saveJournalInsights(content, dateStr);
      setInsightsCount(result.count ?? 0);
      setInsightsSaved(true);
    } catch { /* silently fail */ } finally {
      setSavingInsights(false);
    }
  };

  const parsedDate = isValidDate ? parseISO(dateStr + 'T00:00:00') : new Date();
  const isTodayEntry = isToday(parsedDate);

  if (!isValidDate) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <SidebarMain>
          <div className="max-w-2xl mx-auto px-6 py-10">
            <p className="text-sm text-muted-foreground">Invalid date.</p>
          </div>
        </SidebarMain>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <SidebarMain>
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10">

          {/* Top row */}
          <div className="flex items-center justify-between mb-8">
            <button
              onClick={() => router.push('/journal')}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <Calendar className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Journal</span>
            </button>
            <SavedIndicator show={savedIndicator} />
          </div>

          {/* Yesterday's note banner */}
          {yesterdayNote && !yesterdayNoteDismissed && (
            <div className="relative mb-8 px-4 py-3.5 rounded-xl border border-border/50 bg-muted/30">
              <button
                onClick={() => setYesterdayNoteDismissed(true)}
                className="absolute top-2.5 right-2.5 p-1 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                aria-label="Dismiss"
              >
                <X className="w-3 h-3" />
              </button>
              <p className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-wider mb-1.5 pr-5">
                Yesterday you left this for today
              </p>
              <p className="text-sm text-muted-foreground/70 italic leading-relaxed pr-5">
                {yesterdayNote}
              </p>
            </div>
          )}

          {/* Date header */}
          <div className="mb-8">
            <h1 className="text-2xl sm:text-3xl font-semibold text-foreground tracking-tight">
              {isTodayEntry ? 'Today' : format(parsedDate, 'EEEE')}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {format(parsedDate, 'MMMM d, yyyy')}
            </p>
          </div>

          {/* Mood selector + image button */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              {MOODS.map((m) => {
                const selected = mood === m.value;
                return (
                  <button
                    key={m.value}
                    onClick={() => handleMoodSelect(m.value)}
                    title={m.label}
                    className="transition-all duration-150 rounded-full focus:outline-none"
                    style={{
                      width: selected ? 14 : 12,
                      height: selected ? 14 : 12,
                      backgroundColor: m.color,
                      opacity: selected ? 1 : 0.4,
                      flexShrink: 0,
                    }}
                  />
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleImageSelect(file);
                }}
              />
              <button
                onClick={() => imageInputRef.current?.click()}
                title="Attach image"
                className={`p-1.5 rounded-lg transition-all focus:outline-none ${savedImageUrl ? 'text-primary opacity-80 hover:opacity-100' : 'text-muted-foreground/30 hover:text-muted-foreground hover:bg-accent'}`}
              >
                <ImageIcon className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Attached image preview */}
          {(imagePreview || savedImageUrl) && (
            <div className="relative mb-6 group/img inline-block">
              <img
                src={imagePreview || savedImageUrl!}
                alt=""
                className="max-h-48 rounded-xl object-cover cursor-zoom-in"
                onClick={() => setLightboxOpen(true)}
              />
              <div className="absolute inset-0 rounded-xl bg-black/0 group-hover/img:bg-black/20 transition-colors flex items-center justify-center pointer-events-none">
                <ZoomIn className="w-5 h-5 text-white opacity-0 group-hover/img:opacity-100 transition-opacity drop-shadow-lg" />
              </div>
              <button
                onClick={clearImage}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-foreground text-background flex items-center justify-center shadow-sm hover:bg-foreground/80 transition-colors"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          )}

          {/* Writing area */}
          {loadingEntry ? (
            <div className="flex items-center justify-center py-24">
              <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
            </div>
          ) : (
            <>
              {/* Auto-expanding main textarea */}
              <textarea
                ref={mainTextareaRef}
                value={content}
                onChange={handleContentChange}
                placeholder="What's on your mind today..."
                autoFocus={isTodayEntry}
                rows={1}
                className="w-full bg-transparent border-none outline-none resize-none overflow-hidden text-[15px] sm:text-base leading-[1.8] text-foreground placeholder:text-muted-foreground/30 focus:outline-none caret-primary"
                style={{ fontFamily: 'inherit', minHeight: '220px' }}
              />

              {/* Tomorrow note — auto-expands, correct height on mount */}
              <div className="mt-6 mb-2">
                <textarea
                  ref={tomorrowTextareaRef}
                  value={tomorrowNote}
                  onChange={handleTomorrowNoteChange}
                  placeholder="Leave a note for tomorrow..."
                  rows={1}
                  className="w-full bg-transparent border-none outline-none resize-none overflow-hidden text-sm leading-relaxed text-muted-foreground/60 placeholder:text-muted-foreground/25 focus:outline-none caret-primary italic"
                  style={{ fontFamily: 'inherit', minHeight: '1.6rem', maxHeight: '80px' }}
                />
              </div>

              <div className="border-t border-border/50 my-6" />

              {/* AI Summary */}
              <div className="space-y-3 mb-6">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-3.5 h-3.5 text-primary/60" />
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Your brain responds
                  </span>
                  {loadingAI && <Loader2 className="w-3 h-3 text-muted-foreground animate-spin ml-auto" />}
                </div>
                {!aiSummary && !loadingAI && content.trim().length < 30 && (
                  <p className="text-sm text-muted-foreground/40 italic leading-relaxed">
                    Keep writing — reflections appear as you think out loud.
                  </p>
                )}
                {aiSummary && (
                  <p className="text-sm text-muted-foreground leading-relaxed">{aiSummary}</p>
                )}
              </div>

              {/* Related notes */}
              {relatedNotes.length > 0 && (
                <>
                  <div className="border-t border-border/50 my-6" />
                  <div className="space-y-3 mb-8">
                    <div className="flex items-center gap-2">
                      <BookOpen className="w-3.5 h-3.5 text-muted-foreground/50" />
                      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Related notes
                      </span>
                    </div>
                    <div className="space-y-2">
                      {(relatedNotesExpanded ? relatedNotes.slice(0, 10) : relatedNotes.slice(0, 3)).map((note) => (
                        <button
                          key={note.id}
                          onClick={() => setPopupNoteId(note.id)}
                          className="w-full text-left bg-card border border-border rounded-xl px-4 py-3 hover:border-primary/30 hover:bg-accent/40 transition-all group"
                        >
                          <p className="text-sm font-medium text-foreground group-hover:text-primary transition-colors leading-snug truncate">
                            {note.title || 'Untitled'}
                          </p>
                          <p className="text-xs text-muted-foreground mt-1 leading-relaxed line-clamp-2">
                            {note.content}
                          </p>
                          {note.tags && note.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2 overflow-hidden max-h-5">
                              {note.tags.slice(0, 4).map((t) => (
                                <span key={t} className="px-1.5 py-0.5 rounded text-[9px] bg-muted border border-border text-muted-foreground">
                                  {t}
                                </span>
                              ))}
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                    {relatedNotes.length > 3 && !relatedNotesExpanded && (
                      <button
                        onClick={() => setRelatedNotesExpanded(true)}
                        className="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                      >
                        see {Math.min(relatedNotes.length - 3, 7)} more
                      </button>
                    )}
                    {relatedNotesExpanded && relatedNotes.length > 3 && (
                      <button
                        onClick={() => setRelatedNotesExpanded(false)}
                        className="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                      >
                        show less
                      </button>
                    )}
                  </div>
                </>
              )}

              {/* Save insights */}
              {content.trim().length > 30 && (
                <div className="border-t border-border/50 pt-6">
                  {insightsSaved ? (
                    <div className="flex items-center gap-2 text-sm text-primary">
                      <CheckCircle2 className="w-4 h-4" />
                      <span className="font-medium">
                        {insightsCount > 0
                          ? `${insightsCount} insight${insightsCount !== 1 ? 's' : ''} saved as notes`
                          : 'Insights saved'}
                      </span>
                    </div>
                  ) : (
                    <button
                      onClick={handleSaveInsights}
                      disabled={savingInsights}
                      className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 group"
                    >
                      {savingInsights
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <Lightbulb className="w-3.5 h-3.5 group-hover:text-primary transition-colors" />
                      }
                      {savingInsights ? 'Extracting insights...' : 'Save key insights as notes'}
                    </button>
                  )}
                </div>
              )}
            </>
          )}

          {/* Page-flip navigation */}
          <div className="flex items-center justify-between mt-12 pt-6 border-t border-border/30">
            {prevDate ? (
              <button
                onClick={() => router.push(`/journal/${prevDate}`)}
                className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors group"
              >
                <ChevronLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
                <span className="hidden sm:inline">{format(parseISO(prevDate + 'T00:00:00'), 'MMM d')}</span>
                <span className="sm:hidden">Prev</span>
              </button>
            ) : <div />}

            <button
              onClick={() => router.push('/journal')}
              className="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            >
              {format(parsedDate, 'MMM yyyy')}
            </button>

            {nextDate ? (
              <button
                onClick={() => router.push(`/journal/${nextDate}`)}
                className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors group"
              >
                <span className="hidden sm:inline">{format(parseISO(nextDate + 'T00:00:00'), 'MMM d')}</span>
                <span className="sm:hidden">Next</span>
                <ChevronRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
              </button>
            ) : <div />}
          </div>

        </div>
      </SidebarMain>

      {popupNoteId && (
        <NotePopup noteId={popupNoteId} onClose={() => setPopupNoteId(null)} />
      )}

      {/* Journal image lightbox */}
      {lightboxOpen && (imagePreview || savedImageUrl) && (
        <div
          className="fixed inset-0 z-[100] bg-black/92 flex items-center justify-center p-4 cursor-zoom-out"
          onClick={() => setLightboxOpen(false)}
        >
          <button
            onClick={() => setLightboxOpen(false)}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
          <img
            src={imagePreview || savedImageUrl!}
            alt=""
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
