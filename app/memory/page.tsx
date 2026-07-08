'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Navigation from '@/components/Navigation';
import SidebarMain from '@/components/SidebarMain';
import NotePopup from '@/components/NotePopup';
import DateNotesModal from '@/components/DateNotesModal';
import { getCategoryColor } from '@/components/CategoryBox';
import { findMemory, resolveMemorySession, getNotes } from '@/lib/notes-api';
import { useGuest } from '@/lib/guest-context';
import GuestSignupPrompt from '@/components/GuestSignupPrompt';
import { Note } from '@/lib/types';
import { ArrowRight, Loader as Loader2, CircleCheck as CheckCircle, History, Link2, Search } from 'lucide-react';

interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

interface RankedNote {
  id: string;
  title: string;
  content: string;
  tags: string[];
  score: number;
  reason: string;
}

interface CategoryChip {
  name: string;
  count: number;
  colorIndex: number;
}

type Phase = 'start' | 'searching' | 'refining' | 'found';

export default function MemoryPage() {
  const router = useRouter();
  const { isGuest } = useGuest();

  const [phase, setPhase] = useState<Phase>('start');
  const [fragment, setFragment] = useState('');
  const [hintCategory, setHintCategory] = useState<string | null>(null);
  const [conversation, setConversation] = useState<ConversationTurn[]>([]);
  const [rankedNotes, setRankedNotes] = useState<RankedNote[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState('');
  const [foundNote, setFoundNote] = useState<RankedNote | null>(null);
  const [categories, setCategories] = useState<CategoryChip[]>([]);

  const [popupNoteId, setPopupNoteId] = useState<string | null>(null);
  const [dateFilter, setDateFilter] = useState<string | null>(null);
  const [showSignupPrompt, setShowSignupPrompt] = useState(false);

  const fragmentRef = useRef<HTMLTextAreaElement>(null);
  const answerRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Load categories from notes on mount
  useEffect(() => {
    if (isGuest) return;
    getNotes().then((notes) => {
      const counts = new Map<string, number>();
      for (const n of notes) {
        if (n.category) counts.set(n.category, (counts.get(n.category) ?? 0) + 1);
      }
      const chips: CategoryChip[] = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, count], i) => ({ name, count, colorIndex: i }));
      setCategories(chips);
    }).catch(() => {});
  }, [isGuest]);

  // Focus answer input when new question arrives
  useEffect(() => {
    if (phase === 'refining' && !loading) {
      answerRef.current?.focus();
    }
  }, [conversation, phase, loading]);

  // Scroll to bottom as conversation grows
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conversation, rankedNotes]);

  const startSearch = useCallback(async () => {
    if (!fragment.trim()) return;
    if (isGuest) { setShowSignupPrompt(true); return; }
    setLoading(true);
    setError('');
    setPhase('searching');
    try {
      const result = await findMemory(fragment.trim(), [], undefined, hintCategory ?? undefined);
      setSessionId(result.session_id);
      setRankedNotes(result.ranked_notes);
      const conv: ConversationTurn[] = result.clarifying_question
        ? [{ role: 'assistant', text: result.clarifying_question }]
        : [];
      setConversation(conv);
      if (result.done && result.ranked_notes[0]) {
        await confirmFound(result.ranked_notes[0], result.session_id, conv);
      } else {
        setPhase('refining');
      }
    } catch {
      setError('Something went wrong. Please try again.');
      setPhase('start');
    } finally {
      setLoading(false);
    }
  }, [fragment, hintCategory, isGuest]);

  const submitAnswer = useCallback(async () => {
    if (!answer.trim() || loading) return;
    setLoading(true);
    setError('');
    const text = answer.trim();
    setAnswer('');
    const updatedConv: ConversationTurn[] = [...conversation, { role: 'user', text }];
    setConversation(updatedConv);
    try {
      const result = await findMemory(fragment, updatedConv, sessionId, hintCategory ?? undefined);
      setSessionId(result.session_id);
      setRankedNotes(result.ranked_notes);
      const nextConv: ConversationTurn[] = [
        ...updatedConv,
        ...(result.clarifying_question && !result.done ? [{ role: 'assistant' as const, text: result.clarifying_question }] : []),
      ];
      setConversation(nextConv);
      if (result.done && result.ranked_notes[0]) {
        await confirmFound(result.ranked_notes[0], result.session_id, nextConv);
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [answer, conversation, fragment, sessionId, hintCategory, loading]);

  const confirmFound = async (note: RankedNote, sid?: string, conv?: ConversationTurn[]) => {
    setFoundNote(note);
    setPhase('found');
    const resolveId = sid ?? sessionId;
    if (resolveId) resolveMemorySession(resolveId, note.id).catch(() => {});
    setConversation((prev) => conv ?? prev);
  };

  const reset = () => {
    setPhase('start');
    setFragment('');
    setHintCategory(null);
    setConversation([]);
    setRankedNotes([]);
    setSessionId(undefined);
    setFoundNote(null);
    setAnswer('');
    setError('');
    setTimeout(() => fragmentRef.current?.focus(), 50);
  };

  // Visible top candidates (notes with meaningful score)
  const topCandidates = rankedNotes.filter((n) => n.score >= 0.15).slice(0, 8);

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <SidebarMain>
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-12">

          {/* ── START PHASE ── */}
          {phase === 'start' && (
            <div className="space-y-10">
              <div>
                <h1 className="text-xl sm:text-2xl font-semibold text-foreground tracking-tight mb-3">
                  Find a memory
                </h1>
                <p className="text-sm text-muted-foreground leading-relaxed max-w-md">
                  Describe what you remember — a feeling, a word, a topic, anything. I'll ask a few questions to narrow it down.
                </p>
              </div>

              {isGuest && (
                <div className="px-4 py-3 bg-primary/5 border border-primary/20 rounded-xl text-sm text-muted-foreground">
                  <button onClick={() => setShowSignupPrompt(true)} className="text-primary hover:underline font-medium">Sign up free</button>{' '}
                  to search your notes by describing a memory.
                </div>
              )}

              {/* Fragment input */}
              <div className="space-y-5">
                <textarea
                  ref={fragmentRef}
                  value={fragment}
                  onChange={(e) => setFragment(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && fragment.trim()) {
                      e.preventDefault();
                      startSearch();
                    }
                  }}
                  placeholder="e.g. something about staying focused when overwhelmed... or a quote about simplicity... or notes from a conversation about habits"
                  rows={4}
                  autoFocus
                  className="w-full px-5 py-4 text-sm rounded-2xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all resize-none leading-relaxed placeholder:text-muted-foreground/35 shadow-sm"
                />

                {/* Category hint chips */}
                {categories.length > 0 && (
                  <div className="space-y-3">
                    <p className="text-[10px] font-medium text-muted-foreground/40 uppercase tracking-widest">
                      Optional starting hint
                    </p>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                      {categories.map((chip) => {
                        const color = getCategoryColor(chip.colorIndex);
                        const selected = hintCategory === chip.name;
                        return (
                          <button
                            key={chip.name}
                            onClick={() => setHintCategory(selected ? null : chip.name)}
                            className="relative text-left rounded-xl px-3.5 py-3 transition-all focus:outline-none hover:scale-[1.02] hover:brightness-105 active:scale-[0.98]"
                            style={{
                              backgroundColor: color.bg,
                              boxShadow: selected
                                ? `0 0 0 2px ${color.title}60, 0 4px 12px ${color.bg}80`
                                : '0 1px 3px rgba(0,0,0,0.06)',
                            }}
                          >
                            <span
                              className="inline-block text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-md mb-1.5 opacity-70"
                              style={{ backgroundColor: `${color.title}18`, color: color.meta }}
                            >
                              {chip.count}
                            </span>
                            <p
                              className="text-xs font-semibold leading-snug line-clamp-2"
                              style={{ color: color.title }}
                            >
                              {chip.name}
                            </p>
                            {selected && (
                              <span
                                className="absolute top-2 right-2 w-2 h-2 rounded-full ring-2 ring-white/40"
                                style={{ backgroundColor: color.title }}
                              />
                            )}
                          </button>
                        );
                      })}
                    </div>
                    {hintCategory && (
                      <p className="text-[11px] text-muted-foreground/40 mt-1">
                        "{hintCategory}" is a hint only — the search still covers all your notes.
                      </p>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-between pt-1">
                  {error && <p className="text-sm text-destructive">{error}</p>}
                  <div className="ml-auto">
                    <button
                      onClick={startSearch}
                      disabled={!fragment.trim() || isGuest}
                      className="flex items-center gap-2 px-6 py-2.5 bg-primary text-primary-foreground text-sm font-semibold rounded-xl hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm hover:shadow-md hover:shadow-primary/20"
                    >
                      <Search className="w-3.5 h-3.5" />
                      Search my notes
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── SEARCHING PHASE ── */}
          {phase === 'searching' && (
            <div className="flex flex-col items-center justify-center py-24 gap-4">
              <Loader2 className="w-5 h-5 text-muted-foreground/50 animate-spin" />
              <p className="text-sm text-muted-foreground/60">Reading through all your notes...</p>
            </div>
          )}

          {/* ── REFINING PHASE ── */}
          {phase === 'refining' && (
            <div className="space-y-6">

              {/* Fragment recap */}
              <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="text-[9px] font-bold text-muted-foreground uppercase">You</span>
                </div>
                <div className="flex-1 bg-foreground text-background text-sm leading-relaxed px-4 py-2.5 rounded-2xl rounded-tl-sm">
                  {fragment}
                  {hintCategory && (
                    <span className="ml-2 text-xs opacity-60">· hint: {hintCategory}</span>
                  )}
                </div>
              </div>

              {/* Conversation turns */}
              {conversation.map((turn, i) => (
                <div key={i} className={`flex items-start gap-3 ${turn.role === 'user' ? 'flex-row-reverse' : ''}`}>
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${turn.role === 'user' ? 'bg-foreground' : 'bg-primary/10'}`}>
                    <span className={`text-[9px] font-bold uppercase ${turn.role === 'user' ? 'text-background' : 'text-primary'}`}>
                      {turn.role === 'user' ? 'You' : 'AI'}
                    </span>
                  </div>
                  <div className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                    turn.role === 'user'
                      ? 'bg-foreground text-background rounded-tr-sm'
                      : 'bg-card border border-border text-foreground rounded-tl-sm shadow-sm'
                  }`}>
                    {turn.text}
                  </div>
                </div>
              ))}

              {/* AI typing indicator */}
              {loading && (
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-[9px] font-bold text-primary uppercase">AI</span>
                  </div>
                  <div className="px-4 py-3 rounded-2xl rounded-tl-sm bg-card border border-border shadow-sm">
                    <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
                  </div>
                </div>
              )}

              {/* Answer input */}
              {!loading && (
                <div className="flex gap-2 pl-9">
                  <input
                    ref={answerRef}
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && answer.trim()) submitAnswer(); }}
                    placeholder="Your answer..."
                    className="flex-1 px-4 py-2.5 text-sm rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all shadow-sm"
                  />
                  <button
                    onClick={submitAnswer}
                    disabled={!answer.trim()}
                    className="px-4 py-2.5 bg-foreground text-background rounded-xl hover:bg-foreground/90 disabled:opacity-40 transition-all"
                  >
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              )}

              {error && <p className="text-sm text-destructive pl-9">{error}</p>}

              {/* Narrowing candidates */}
              {topCandidates.length > 0 && (
                <div className="space-y-2.5 pt-2">
                  <p className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-wider">
                    {topCandidates.length} possible {topCandidates.length === 1 ? 'match' : 'matches'} — tap if you recognise it
                  </p>
                  <div className="space-y-2">
                    {topCandidates.map((note, i) => {
                      const isLead = i === 0 && note.score >= 0.55;
                      return (
                        <div
                          key={note.id}
                          className={`rounded-xl border bg-card transition-all ${isLead ? 'border-primary/25 ring-1 ring-primary/10' : 'border-border'}`}
                        >
                          <div className="px-4 py-3.5">
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex items-start gap-2.5 flex-1 min-w-0">
                                <div className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${
                                  note.score >= 0.7 ? 'bg-primary' :
                                  note.score >= 0.4 ? 'bg-primary/50' : 'bg-muted-foreground/25'
                                }`} />
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-semibold text-foreground leading-snug truncate">
                                    {note.title || 'Untitled'}
                                  </p>
                                  {note.reason && (
                                    <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed line-clamp-2">
                                      {note.reason}
                                    </p>
                                  )}
                                  <p className="text-xs text-muted-foreground/50 mt-1.5 leading-relaxed line-clamp-2">
                                    {note.content.slice(0, 140)}
                                  </p>
                                </div>
                              </div>
                              <button
                                onClick={() => confirmFound(note)}
                                className="flex-shrink-0 text-[11px] font-medium text-primary hover:text-primary/80 transition-colors whitespace-nowrap mt-0.5"
                              >
                                This is it
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div ref={bottomRef} />
            </div>
          )}

          {/* ── FOUND PHASE ── */}
          {phase === 'found' && foundNote && (
            <div className="space-y-6">
              <div className="flex items-center gap-2 text-primary">
                <CheckCircle className="w-4 h-4" />
                <span className="text-sm font-medium">Memory recovered</span>
              </div>

              {/* Full note */}
              <div
                className="bg-card rounded-2xl border border-primary/20 ring-1 ring-primary/10 p-5 space-y-3 cursor-pointer hover:border-primary/40 transition-colors"
                onClick={() => setPopupNoteId(foundNote.id)}
              >
                <h2 className="text-base font-semibold text-foreground leading-snug">
                  {foundNote.title || 'Untitled'}
                </h2>
                <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                  {foundNote.content}
                </p>
                {foundNote.tags?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {foundNote.tags.map((t) => (
                      <span key={t} className="px-2 py-0.5 rounded-md text-[11px] bg-muted border border-border text-muted-foreground">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground/40">Tap to open full note</p>
              </div>

              {/* Recovery path */}
              {(conversation.length > 0 || fragment) && (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <History className="w-3.5 h-3.5 text-muted-foreground/40" />
                    <p className="text-[11px] font-semibold text-muted-foreground/40 uppercase tracking-wider">Recovery path</p>
                  </div>
                  <div className="bg-muted/30 rounded-xl border border-border p-4 space-y-2.5 text-xs">
                    <div className="flex items-start gap-2">
                      <span className="font-semibold text-muted-foreground/60 w-6 flex-shrink-0">You</span>
                      <span className="text-foreground leading-relaxed">{fragment}</span>
                    </div>
                    {conversation.map((turn, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span className={`font-semibold w-6 flex-shrink-0 ${turn.role === 'user' ? 'text-muted-foreground/60' : 'text-primary/70'}`}>
                          {turn.role === 'user' ? 'You' : 'AI'}
                        </span>
                        <span className="text-foreground leading-relaxed">{turn.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <button
                onClick={reset}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
              >
                Find something else
              </button>

              <div ref={bottomRef} />
            </div>
          )}

        </div>
      </SidebarMain>

      {popupNoteId && (
        <NotePopup
          noteId={popupNoteId}
          onClose={() => setPopupNoteId(null)}
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

      {showSignupPrompt && (
        <GuestSignupPrompt
          onClose={() => setShowSignupPrompt(false)}
          message="Create a free account to search your memories — Claude will find notes matching your description."
        />
      )}
    </div>
  );
}
