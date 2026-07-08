'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Navigation from '@/components/Navigation';
import SidebarMain from '@/components/SidebarMain';
import ConversationThread from '@/components/ConversationThread';
import NotePopup from '@/components/NotePopup';
import GuestSignupPrompt from '@/components/GuestSignupPrompt';
import { useGuest } from '@/lib/guest-context';
import { useTagFilter } from '@/lib/tag-filter-context';
import { Question, ConversationMessage } from '@/lib/types';
import {
  answerQuestion,
  getQuestions,
  deleteQuestion,
  deleteNote,
  getConversationMessages,
  getNotes,
} from '@/lib/notes-api';
import {
  Send,
  MessageSquare,
  ChevronDown,
  ChevronUp,
  Clock,
  Sparkles,
  BookOpen,
  Trash2,
  MessageCircle,
  Search,
} from 'lucide-react';
import { format } from 'date-fns';

interface SourceNote {
  id: string;
  title: string;
  similarity: number;
  content?: string;
  tags?: string[];
}

interface ActiveThread {
  questionId: string;
  question: string;
  answer: string;
  sources: SourceNote[];
  existingMessages: ConversationMessage[];
  keyPoints?: string[];
  noteTitleMap?: Record<string, { id: string; title: string }>;
}

function renderAnswer(text: string) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code class="bg-muted px-1 rounded text-xs font-mono">$1</code>')
    .replace(/\n\n/g, '</p><p class="mt-2">');
}

function QAPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { isGuest } = useGuest();
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [activeThread, setActiveThread] = useState<ActiveThread | null>(null);
  const [history, setHistory] = useState<Question[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [noteMap, setNoteMap] = useState<Record<string, { title: string; content: string }>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandedMessages, setExpandedMessages] = useState<Record<string, ConversationMessage[]>>({});
  const [loadingMessages, setLoadingMessages] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [popupNoteId, setPopupNoteId] = useState<string | null>(null);
  const [showSignupPrompt, setShowSignupPrompt] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const { openTag } = useTagFilter();
  const threadRef = useRef<HTMLDivElement>(null);
  const autoSubmittedRef = useRef(false);

  const loadHistory = useCallback(async () => {
    if (isGuest) { setLoadingHistory(false); return; }
    try {
      const [data, notes] = await Promise.all([getQuestions(), getNotes()]);
      setHistory(data);
      const map: Record<string, { title: string; content: string }> = {};
      for (const n of notes) map[n.id] = { title: n.title, content: n.content };
      setNoteMap(map);
    } finally {
      setLoadingHistory(false);
    }
  }, [isGuest]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  // Auto-submit a question passed via ?q= (from category page AI questions)
  useEffect(() => {
    const q = searchParams.get('q');
    if (!q || autoSubmittedRef.current) return;
    autoSubmittedRef.current = true;
    setError('');
    setAsking(true);
    answerQuestion(q).then((result) => {
      setActiveThread({
        questionId: result.question_id,
        question: q,
        answer: result.answer,
        sources: result.relevant_notes,
        existingMessages: [],
        keyPoints: result.key_points,
        noteTitleMap: result.note_title_map,
      });
      loadHistory();
      setTimeout(() => threadRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    }).catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to get answer');
    }).finally(() => {
      setAsking(false);
    });
  // loadHistory and searchParams are stable refs — only run once on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAsk = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() || asking) return;
    if (isGuest) { setShowSignupPrompt(true); return; }
    const q = question.trim();
    setQuestion('');
    setActiveThread(null);
    setError('');
    setAsking(true);
    try {
      const result = await answerQuestion(q);
      setActiveThread({
        questionId: result.question_id,
        question: q,
        answer: result.answer,
        sources: result.relevant_notes,
        existingMessages: [],
        keyPoints: result.key_points,
        noteTitleMap: result.note_title_map,
      });
      await loadHistory();
      setTimeout(() => threadRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get answer');
    } finally {
      setAsking(false);
    }
  };

  const handleToggleExpand = async (item: Question) => {
    if (expanded === item.id) { setExpanded(null); return; }
    setExpanded(item.id);
    if (!expandedMessages[item.id]) {
      setLoadingMessages(item.id);
      try {
        const msgs = await getConversationMessages(item.id);
        setExpandedMessages((prev) => ({ ...prev, [item.id]: msgs }));
      } finally {
        setLoadingMessages(null);
      }
    }
  };

  const handleOpenThread = async (item: Question) => {
    const msgs = expandedMessages[item.id] ?? [];
    setActiveThread({
      questionId: item.id,
      question: item.question,
      answer: item.answer ?? '',
      sources: [],
      existingMessages: msgs,
    });
    setTimeout(() => threadRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  };

  const handleDeleteQuestion = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteQuestion(id);
      setHistory((prev) => prev.filter((q) => q.id !== id));
      if (expanded === id) setExpanded(null);
      if (activeThread?.questionId === id) setActiveThread(null);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <SidebarMain>
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 sm:py-8">
          <div className="flex items-start justify-between mb-6 sm:mb-8">
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-foreground">Ask Your Brain</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Claude answers using only your notes
              </p>
            </div>
          </div>

          {isGuest && (
            <div className="mb-5 px-4 py-3 bg-primary/5 border border-primary/20 rounded-xl text-sm text-muted-foreground">
              Ask a question and Claude will answer using your notes.{' '}
              <button onClick={() => setShowSignupPrompt(true)} className="text-primary hover:underline font-medium">Sign up free</button> to use this feature.
            </div>
          )}

          <form onSubmit={handleAsk} className="mb-6 sm:mb-8">
            <div className="relative">
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAsk(e); }
                }}
                placeholder="Ask anything..."
                rows={3}
                className="w-full px-4 py-3 pr-14 text-sm rounded-2xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all placeholder:text-muted-foreground/50 resize-none shadow-sm"
              />
              <button
                type="submit"
                disabled={!question.trim() || asking}
                className="absolute right-3 bottom-3 p-3 sm:p-2.5 rounded-xl bg-primary hover:bg-primary/90 text-white disabled:opacity-40 transition-all shadow-sm shadow-primary/20 min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </form>

          {asking && (
            <div className="mb-8 bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
              <div className="px-5 py-6 flex items-center gap-3">
                <div className="flex items-center gap-1">
                  <span className="w-2 h-2 bg-primary rounded-full inline-block animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-2 h-2 bg-primary rounded-full inline-block animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-2 h-2 bg-primary rounded-full inline-block animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
                <span className="text-sm text-muted-foreground">Reading your notes and crafting an answer...</span>
              </div>
            </div>
          )}

          {activeThread && !asking && (
            <div ref={threadRef} className="mb-8 bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
              <div className="px-5 py-3.5 bg-gradient-to-r from-primary/5 to-transparent border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MessageCircle className="w-4 h-4 text-primary" />
                  <span className="text-xs font-semibold text-primary uppercase tracking-wider">Conversation</span>
                </div>
                <button onClick={() => setActiveThread(null)} className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-lg hover:bg-accent">
                  Close
                </button>
              </div>
              <div className="px-5 py-4">
                <ConversationThread
                  key={activeThread.questionId}
                  questionId={activeThread.questionId}
                  originalQuestion={activeThread.question}
                  originalAnswer={activeThread.answer}
                  initialSources={activeThread.sources}
                  existingMessages={activeThread.existingMessages}
                  onNoteClick={(id) => setPopupNoteId(id)}
                  onTagClick={(tag) => openTag(tag)}
                  keyPoints={activeThread.keyPoints}
                  noteTitleMap={activeThread.noteTitleMap}
                />
              </div>
            </div>
          )}

          {error && (
            <div className="mb-6 px-4 py-3 rounded-xl bg-destructive/10 text-sm text-destructive border border-destructive/20">
              {error}
            </div>
          )}

          {!isGuest && <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                <Clock className="w-3.5 h-3.5" />
                Question History
              </h2>
            </div>
            {history.length > 0 && (
              <div className="relative mb-4">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/40 pointer-events-none" />
                <input
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  placeholder="Search questions and answers..."
                  className="w-full pl-9 pr-4 py-2 text-sm rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all placeholder:text-muted-foreground/40"
                />
              </div>
            )}
            {loadingHistory ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="bg-card border border-border rounded-xl h-14 animate-pulse" />
                ))}
              </div>
            ) : history.length === 0 ? (
              <div className="text-center py-12">
                <MessageSquare className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">No questions yet. Ask something!</p>
              </div>
            ) : (() => {
              const q = historySearch.trim().toLowerCase();
              const filtered = q
                ? history.filter((item) =>
                    item.question.toLowerCase().includes(q) ||
                    (item.answer ?? '').toLowerCase().includes(q)
                  )
                : history;
              return filtered.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-sm text-muted-foreground">No matching questions.</p>
                </div>
              ) : (
              <div className="space-y-2">
                {filtered.map((item) => (
                  <div key={item.id} className="bg-card border border-border rounded-xl overflow-hidden">
                    <div className="flex items-center gap-2 px-4 py-3">
                      <button
                        onClick={() => handleToggleExpand(item)}
                        className="flex-1 flex items-center justify-between gap-3 hover:opacity-80 transition-opacity text-left min-w-0"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{item.question}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{format(new Date(item.created_at), 'MMM d, yyyy · h:mm a')}</p>
                        </div>
                        {expanded === item.id ? <ChevronUp className="w-4 h-4 text-muted-foreground flex-shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
                      </button>
                      <button onClick={() => handleOpenThread(item)} className="p-1.5 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all flex-shrink-0" title="Continue conversation">
                        <MessageCircle className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => handleDeleteQuestion(item.id)} disabled={deletingId === item.id} className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all flex-shrink-0 disabled:opacity-40" title="Delete question">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {expanded === item.id && (
                      <div className="border-t border-border">
                        {loadingMessages === item.id ? (
                          <div className="px-4 py-4 flex items-center gap-2 text-sm text-muted-foreground">
                            <div className="w-4 h-4 border-2 border-muted-foreground/30 border-t-primary rounded-full animate-spin" />
                            Loading conversation...
                          </div>
                        ) : (
                          <div className="px-4 py-4 space-y-3">
                            {item.answer && (
                              <div className="bg-muted/30 rounded-xl p-3">
                                <div className="flex items-center gap-1.5 mb-2">
                                  <Sparkles className="w-3 h-3 text-primary" />
                                  <span className="text-xs font-semibold text-primary uppercase tracking-wider">Answer</span>
                                </div>
                                <div className="answer-prose text-sm text-foreground leading-relaxed" dangerouslySetInnerHTML={{ __html: `<p>${renderAnswer(item.answer)}</p>` }} />
                              </div>
                            )}
                            {(expandedMessages[item.id] ?? []).length > 0 && (
                              <div className="space-y-2 pl-2 border-l-2 border-border">
                                {(expandedMessages[item.id] ?? []).map((msg) => (
                                  <div key={msg.id} className={`text-sm ${msg.role === 'user' ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                                    <span className={`text-xs uppercase tracking-wider font-semibold mr-2 ${msg.role === 'user' ? 'text-muted-foreground' : 'text-primary'}`}>
                                      {msg.role === 'user' ? 'You' : 'Claude'}
                                    </span>
                                    <span>{msg.content}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {item.relevant_note_ids && item.relevant_note_ids.length > 0 && (
                              <div className="pt-1">
                                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                                  <BookOpen className="w-3 h-3" />
                                  Sources
                                </p>
                                <div className="flex flex-wrap gap-1.5">
                                  {item.relevant_note_ids.map((nid) => {
                                    const n = noteMap[nid];
                                    const label = n ? (n.title || n.content.trim().split(/\s+/).slice(0, 4).join(' ')) : 'View note';
                                    return (
                                      <button key={nid} onClick={() => setPopupNoteId(nid)} className="px-2.5 py-1 rounded-lg text-xs border bg-muted text-foreground border-border hover:bg-accent transition-all font-medium">
                                        {label}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                            <button onClick={() => handleOpenThread(item)} className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-dashed border-border text-xs text-muted-foreground hover:text-primary hover:border-primary/40 hover:bg-primary/5 transition-all">
                              <MessageCircle className="w-3.5 h-3.5" />
                              Continue this conversation
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              );
            })()}
          </div>}
        </div>
      </SidebarMain>

      {popupNoteId && (
        <NotePopup
          noteId={popupNoteId}
          onClose={() => setPopupNoteId(null)}
          onNoteDeleted={async (noteId) => { await deleteNote(noteId); setPopupNoteId(null); }}
          onRelatedNoteClick={(id) => setPopupNoteId(id)}
          onViewAllConnected={(id) => { setPopupNoteId(null); router.push(`/note/${id}`); }}
          onOpen={(id) => { setPopupNoteId(null); router.push(`/note/${id}`); }}
        />
      )}

      {showSignupPrompt && (
        <GuestSignupPrompt
          onClose={() => setShowSignupPrompt(false)}
          message="Create a free account to ask questions — Claude will answer using your notes."
        />
      )}
    </div>
  );
}

export default function QAPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <QAPageInner />
    </Suspense>
  );
}
