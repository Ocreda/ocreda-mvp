'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import {
  ArrowUp,
  Trash2,
  Pencil,
  Check,
  X,
  Plus,
  Loader as Loader2,
  Mic,
  Bold as BoldIcon,
  Italic as ItalicIcon,
  List,
  ListOrdered,
  MessageCircle,
  SquarePlus,
  ChevronRight,
  Search,
  Clock3,
  Brain,
  FileText,
  ArrowRight,
  ArrowLeft,
  Save,
  ThumbsUp,
  ThumbsDown,
  ExternalLink,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { Note, Question, ConversationMessage } from '@/lib/types';
import {
  handleMessage,
  createNote,
  getGuidedChatReaction,
  extractGuidedNotes,
  GuidedNoteDraft,
  applyConnectionFeedback,
  processNote,
  getNotes,
  getQuestions,
  getNoteRelations,
  getConversationMessages,
  sendChatMessage,
  updateNote,
  deleteNote,
  deleteQuestion,
} from '@/lib/notes-api';

/* ────────────────────────── helpers ────────────────────────── */

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0].trim();
  return line;
}

function truncate(text: string, n: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n).trimEnd() + '…' : t;
}

function noteTitle(note: Note): string {
  const s = note.summary?.trim();
  if (s) return s;
  return truncate(firstLine(note.raw_text), 60) || 'Untitled note';
}

function relTime(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return '';
  }
}

function renderAnswer(text: string): string {
  const body = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code class="bg-muted px-1 rounded text-xs font-mono">$1</code>')
    .replace(/\n\n/g, '</p><p class="mt-3">')
    .replace(/\n/g, '<br />');
  return `<p>${body}</p>`;
}

type RelatedNote = {
  id: string;
  related_note_id: string;
  reason: string | null;
  confidence?: number;
  weight?: number;
  related_note: { id: string; summary: string | null; raw_text: string };
};

type DisplayMsg = { id: string; role: 'user' | 'assistant'; content: string };

type Active =
  | { kind: 'note'; id: string }
  | { kind: 'chat'; id: string }
  | null;

type ChatState = {
  questionId: string;
  messages: DisplayMsg[];
  sourceIds: string[];
};

const GUIDED_QUESTIONS = [
  "What's been taking up space in your head lately?",
  "What's something you've gotten unreasonably into lately, and why that?",
  "Last one. What's something you thought was true a year ago that you'd argue against now?",
];

type GuidedDraft = GuidedNoteDraft & { id: string; selected: boolean; editing: boolean };
type ConnectionCandidate = { note: Note; relation: RelatedNote };
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};

/* ────────────────────────── logo divider ────────────────────────── */

function LogoDivider({ onClick, title }: { onClick?: () => void; title?: string }) {
  return (
    <div className="flex items-center gap-4 select-none">
      <span className="flex-1 h-px bg-border" />
      <button
        type="button"
        onClick={onClick}
        title={title}
        className={`flex items-center gap-1 ${onClick ? 'cursor-pointer' : 'cursor-default'}`}
      >
        {/* Original Ocreda mark — asset unchanged, only inverted for dark theme */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/ocreda-logo.png" alt="Ocreda" className="w-6 h-6 object-contain" />
        <span className="text-lg font-semibold tracking-tight text-foreground" style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}>
          R
        </span>
      </button>
      <span className="flex-1 h-px bg-border" />
    </div>
  );
}

/* ────────────────────────── avatar (top-right, always) ────────────────────────── */

function AvatarButton({ embedded = false }: { embedded?: boolean }) {
  const { user } = useAuth();
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [name, setName] = useState('');

  useEffect(() => {
    if (!user) return;
    supabase
      .from('user_settings')
      .select('full_name, avatar_url')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        setName(data?.full_name ?? '');
        setAvatarUrl(data?.avatar_url ?? null);
      });
  }, [user]);

  const initials = (() => {
    if (name.trim()) {
      return name.trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 2);
    }
    return (user?.email?.[0] ?? '?').toUpperCase();
  })();

  return (
    <Link
      href="/profile"
      title="Account & appearance"
      className={`${embedded ? 'relative' : 'fixed top-4 right-4 lg:top-6 lg:right-6 z-50'} w-10 h-10 rounded-full overflow-hidden ring-1 ring-border bg-card shadow-sm flex items-center justify-center hover:ring-primary/40 transition-all`}
    >
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatarUrl} alt="You" className="w-full h-full object-cover" />
      ) : (
        <span className="text-sm font-semibold text-primary select-none">{initials}</span>
      )}
    </Link>
  );
}

/* ────────────────────────── composer ────────────────────────── */

function Composer({
  value,
  onChange,
  onSubmit,
  busy,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  placeholder: string;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder={placeholder}
        rows={3}
        className="w-full resize-none rounded-2xl border border-border bg-background/60 px-4 py-3.5 pr-14 text-[15px] leading-relaxed text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/50 transition-all"
      />
      <button
        type="button"
        onClick={onSubmit}
        disabled={!value.trim() || busy}
        aria-label="Send"
        className="absolute right-3 bottom-3 w-9 h-9 rounded-lg bg-primary text-white flex items-center justify-center shadow-sm shadow-primary/20 hover:bg-primary/90 disabled:opacity-30 transition-all"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
      </button>
    </div>
  );
}

/* ────────────────────────── right-rail card ────────────────────────── */

type RailItem = {
  kind: 'note' | 'chat';
  id: string;
  title: string;
  preview: string;
  createdAt: string;
};

function RailCard({
  item,
  active,
  onOpen,
  onDelete,
}: {
  item: RailItem;
  active: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      onClick={onOpen}
      className={`group relative min-w-[220px] lg:min-w-0 shrink-0 lg:shrink cursor-pointer rounded-2xl border px-4 py-4 transition-all duration-200 ${
        active
          ? 'border-primary bg-primary/[0.06] shadow-sm'
          : 'border-border bg-card hover:border-border hover:bg-accent/40'
      }`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className={`text-[10px] font-semibold uppercase tracking-wider ${
            item.kind === 'chat' ? 'text-primary/80' : 'text-muted-foreground/60'
          }`}
        >
          {item.kind === 'chat' ? 'Past chat' : 'Note'}
        </span>
      </div>
      <p className="text-sm font-medium text-foreground leading-snug line-clamp-2">{item.title}</p>
      {item.preview && (
        <p className="mt-1 text-xs text-muted-foreground/70 leading-relaxed line-clamp-2">{item.preview}</p>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground/50">{relTime(item.createdAt)}</p>

      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="Delete"
        className="absolute top-2.5 right-2.5 p-1.5 rounded-lg text-muted-foreground/30 hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

/* ────────────────────────── page ────────────────────────── */

export default function OcredaHome() {
  const { user } = useAuth();
  const [notes, setNotes] = useState<Note[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState('');

  const [active, setActive] = useState<Active>(null);
  const [chat, setChat] = useState<ChatState | null>(null);
  const [relationsCache, setRelationsCache] = useState<Record<string, RelatedNote[]>>({});

  // note map for resolving source ids → titles
  const noteMap = useMemo(() => {
    const m: Record<string, Note> = {};
    for (const n of notes) m[n.id] = n;
    return m;
  }, [notes]);

  // composers
  const [addValue, setAddValue] = useState('');
  const [addTitle, setAddTitle] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [firstNoteWarningShown, setFirstNoteWarningShown] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [savedExiting, setSavedExiting] = useState(false);
  const [launchGuidedAfterSave, setLaunchGuidedAfterSave] = useState(false);
  const [guidedOpen, setGuidedOpen] = useState(false);
  const [guidedStep, setGuidedStep] = useState(0);
  const [guidedValue, setGuidedValue] = useState('');
  const [guidedMessages, setGuidedMessages] = useState<Array<{ answer: string; response: string }>>([]);
  const [guidedDrafts, setGuidedDrafts] = useState<GuidedDraft[]>([]);
  const [guidedBusy, setGuidedBusy] = useState(false);
  const [guidedError, setGuidedError] = useState('');
  const [connectionQueue, setConnectionQueue] = useState<ConnectionCandidate[]>([]);
  const [connectionIndex, setConnectionIndex] = useState(0);
  const addTextareaRef = useRef<HTMLTextAreaElement>(null);
  const addTitleRef = useRef<HTMLInputElement>(null);
  const addFileRef = useRef<HTMLInputElement>(null);
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [dictating, setDictating] = useState(false);
  const [askValue, setAskValue] = useState('');
  const [composerValue, setComposerValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const [chatHistoryLoading, setChatHistoryLoading] = useState(false);
  const [connectionsCount, setConnectionsCount] = useState(0);
  const [chatAnchor, setChatAnchor] = useState<Note | null>(null);
  const recentSectionRef = useRef<HTMLElement>(null);

  // note inline edit
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const isEmpty = !loading && notes.length === 0 && questions.length === 0;

  const load = useCallback(async () => {
    try {
      const [n, q] = await Promise.all([getNotes(), getQuestions()]);
      setNotes(n);
      setQuestions(q);
      return { n, q };
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const useNote = (event: Event) => {
      const detail = (event as CustomEvent<{ note?: Note }>).detail;
      if (!detail?.note) return;
      setChatAnchor(detail.note);
      setActive(null);
      setChat(null);
      setComposerValue('');
      setError('');
    };
    const openAdd = () => { setError(''); setAddOpen(true); };
    window.addEventListener('use-note-in-chat', useNote);
    window.addEventListener('open-add-note', openAdd);
    return () => {
      window.removeEventListener('use-note-in-chat', useNote);
      window.removeEventListener('open-add-note', openAdd);
    };
  }, []);

  useEffect(() => {
    if (!user || loading) return;
    const status = localStorage.getItem(`ocreda-guided-chat:${user.id}`);
    if (status === 'pending' && notes.length > 0) setGuidedOpen(true);
  }, [user, loading, notes.length]);

  useEffect(() => {
    if (loading || notes.length === 0) {
      setConnectionsCount(0);
      return;
    }
    supabase
      .from('note_relations')
      .select('id', { count: 'exact', head: true })
      .then(({ count }) => setConnectionsCount(count ?? 0));
  }, [loading, notes.length]);

  useEffect(() => {
    if (!user) return;
    supabase
      .from('user_settings')
      .select('full_name')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        const profileName = data?.full_name?.trim();
        const authName = String(user.user_metadata?.full_name ?? user.user_metadata?.name ?? '').trim();
        setDisplayName(profileName || authName || user.email?.split('@')[0] || '');
      });
  }, [user]);

  // default selection once data lands: most recent note, else most recent chat
  useEffect(() => {
    if (loading || active) return;
    if (notes.length > 0) setActive({ kind: 'note', id: notes[0].id });
    else if (questions.length > 0) selectChat(questions[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  /* ── relations for the active note ── */
  useEffect(() => {
    if (active?.kind !== 'note') return;
    if (relationsCache[active.id]) return;
    let cancelled = false;
    getNoteRelations(active.id)
      .then((rels) => {
        if (!cancelled) setRelationsCache((prev) => ({ ...prev, [active.id]: rels }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, relationsCache]);

  /* ── selection ── */
  const selectNote = (id: string) => {
    setEditing(false);
    setActive({ kind: 'note', id });
    setChat(null);
  };

  const selectChat = async (q: Question) => {
    setEditing(false);
    setActive({ kind: 'chat', id: q.id });
    setChat({
      questionId: q.id,
      messages: [
        { id: `${q.id}-q`, role: 'user', content: q.question },
        ...(q.answer ? [{ id: `${q.id}-a`, role: 'assistant' as const, content: q.answer }] : []),
      ],
      sourceIds: q.relevant_note_ids ?? [],
    });
    try {
      const msgs: ConversationMessage[] = await getConversationMessages(q.id);
      if (msgs.length > 0) {
        setChat((prev) =>
          prev && prev.questionId === q.id
            ? { ...prev, messages: [...prev.messages, ...msgs.map((m) => ({ id: m.id, role: m.role, content: m.content }))] }
            : prev
        );
      }
    } catch {
      /* keep the base thread */
    }
  };

  const openChatHistory = async () => {
    setChatHistoryOpen(true);
    setChatHistoryLoading(true);
    try {
      setQuestions(await getQuestions());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load chat history');
    } finally {
      setChatHistoryLoading(false);
    }
  };

  const openPreviousChat = async (question: Question) => {
    setChatHistoryOpen(false);
    await selectChat(question);
  };

  /* ── submit: add-a-note / ask / follow-up ── */
  const runHandleMessage = async (text: string): Promise<'note' | 'question' | null> => {
    setError('');
    setBusy(true);
    try {
      const result = await handleMessage(text);
      if (result.type === 'note') {
        processNote(result.note.id).catch(() => {});
        setNotes((prev) => [result.note, ...prev]);
        setChat(null);
        setActive({ kind: 'note', id: result.note.id });
      } else {
        const newChat: ChatState = {
          questionId: result.question_id,
          messages: [
            { id: `${result.question_id}-q`, role: 'user', content: text },
            { id: `${result.question_id}-a`, role: 'assistant', content: result.answer },
          ],
          sourceIds: result.relevant_notes.map((r) => r.id),
        };
        setChat(newChat);
        setActive({ kind: 'chat', id: result.question_id });
        // refresh questions list so the rail shows the new past-chat
        getQuestions().then(setQuestions).catch(() => {});
      }
      return result.type;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const sendFollowup = async (text: string) => {
    if (!chat) return;
    setError('');
    setBusy(true);
    const tempId = `temp-${chat.messages.length}`;
    setChat((prev) => (prev ? { ...prev, messages: [...prev.messages, { id: tempId, role: 'user', content: text }] } : prev));
    try {
      const result = await sendChatMessage(chat.questionId, text);
      setChat((prev) => {
        if (!prev) return prev;
        const base = prev.messages.filter((m) => m.id !== tempId);
        const appended = result.messages.map((m) => ({ id: m.id, role: m.role as 'user' | 'assistant', content: m.content }));
        return {
          ...prev,
          messages: [...base, ...appended],
          sourceIds: result.relevant_notes.length ? result.relevant_notes.map((r) => r.id) : prev.sourceIds,
        };
      });
    } catch (err) {
      setChat((prev) => (prev ? { ...prev, messages: prev.messages.filter((m) => m.id !== tempId) } : prev));
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setBusy(false);
    }
  };

  const submitComposer = () => {
    const text = composerValue.trim();
    if (!text || busy) return;
    setComposerValue('');
    setChatAnchor(null);
    if (active?.kind === 'chat') sendFollowup(text);
    else runHandleMessage(text);
  };

  const submitAdd = async () => {
    const title = addTitle.trim();
    const body = addValue.trim();
    if (!title || busy) return;
    const text = body ? `${title}\n\n${body}` : title;
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (notes.length === 0 && wordCount < 25 && !firstNoteWarningShown) {
      setFirstNoteWarningShown(true);
      setError('Add a bit more so we have something to work with.');
      return;
    }
    const isFirstNote = notes.length === 0;
    setError('');
    setBusy(true);
    try {
      const note = await createNote(text);
      setNotes((prev) => [note, ...prev]);
      setChat(null);
      setActive({ kind: 'note', id: note.id });
      setAddTitle('');
      setAddValue('');
      setAddOpen(false);
      setSavedOpen(true);
      if (isFirstNote && user) {
        localStorage.setItem(`ocreda-guided-chat:${user.id}`, 'pending');
        setLaunchGuidedAfterSave(true);
      }
      processNote(note.id).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save note');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (addOpen) {
      setFirstNoteWarningShown(false);
      setError('');
      requestAnimationFrame(() => addTitleRef.current?.focus());
    }
  }, [addOpen]);

  useEffect(() => {
    if (!savedOpen) return;
    setSavedExiting(false);
    const exitTimer = window.setTimeout(() => setSavedExiting(true), 1400);
    const closeTimer = window.setTimeout(() => {
      setSavedOpen(false);
      if (launchGuidedAfterSave) {
        setGuidedOpen(true);
        setLaunchGuidedAfterSave(false);
      }
    }, 1900);
    return () => {
      window.clearTimeout(exitTimer);
      window.clearTimeout(closeTimer);
    };
  }, [savedOpen, launchGuidedAfterSave]);

  const closeGuidedChat = () => {
    if (user) localStorage.setItem(`ocreda-guided-chat:${user.id}`, 'complete');
    setGuidedOpen(false);
    setGuidedError('');
  };

  const submitGuidedAnswer = async () => {
    const answer = guidedValue.trim();
    if (!answer || guidedBusy) return;
    if (guidedStep < 2 && answer.split(/\s+/).filter(Boolean).length < 15) {
      setGuidedError('Say a bit more about that one.');
      return;
    }
    setGuidedError('');
    setGuidedBusy(true);
    const nextQuestion = GUIDED_QUESTIONS[guidedStep + 1];
    try {
      if (!nextQuestion) {
        const allAnswers = [...guidedMessages.map((message) => message.answer), answer];
        let finalResponse = "That's the real one. Give me a second.";
        try {
          finalResponse = await getGuidedChatReaction(answer, 'Give me a second.');
        } catch {
          // Keep the intentionally restrained fallback copy.
        }
        let drafts: GuidedNoteDraft[];
        try {
          drafts = await extractGuidedNotes(allAnswers);
        } catch {
          drafts = allAnswers.map((sourceAnswer, index) => ({
            title: sourceAnswer.split(/\s+/).slice(0, 6).join(' '),
            body: sourceAnswer,
            source_answer: index + 1,
          }));
        }
        setGuidedMessages((prev) => [...prev, { answer, response: finalResponse }]);
        setGuidedStep(3);
        setGuidedValue('');
        setGuidedDrafts(drafts.map((draft, index) => ({ ...draft, id: `guided-${index}`, selected: true, editing: false })));
        return;
      }
      let response: string;
      try {
        response = await getGuidedChatReaction(answer, nextQuestion);
      } catch {
        const words = answer.replace(/[.!?]+$/, '').split(/\s+/).slice(0, 7).join(' ').toLowerCase();
        response = `${words ? `It sounds like ${words}. ` : ''}${nextQuestion}`;
      }
      setGuidedMessages((prev) => [...prev, { answer, response }]);
      setGuidedStep((step) => step + 1);
      setGuidedValue('');
    } finally {
      setGuidedBusy(false);
    }
  };

  const saveGuidedDrafts = async () => {
    const selected = guidedDrafts.filter((draft) => draft.selected);
    if (selected.length === 0 || guidedBusy) return;
    setGuidedBusy(true);
    setGuidedError('');
    try {
      const created = await Promise.all(selected.map((draft) => createNote(`${draft.title.trim()}\n\n${draft.body.trim()}`)));
      setNotes((prev) => [...[...created].reverse(), ...prev]);
      await Promise.all(created.map((note) => processNote(note.id).catch(() => ({ relations_count: 0 }))));
      const relationGroups = await Promise.all(created.map(async (note) => ({ note, relations: await getNoteRelations(note.id).catch(() => []) })));
      const seen = new Set<string>();
      const candidates: ConnectionCandidate[] = [];
      for (const group of relationGroups) {
        for (const relation of group.relations) {
          const pairKey = [group.note.id, relation.related_note_id].sort().join(':');
          if (!seen.has(pairKey)) {
            seen.add(pairKey);
            candidates.push({ note: group.note, relation });
          }
        }
      }
      closeGuidedChat();
      if (candidates.length > 0) {
        setConnectionQueue(candidates.slice(0, 3));
        setConnectionIndex(0);
      } else if (created[0]) {
        requestAnimationFrame(() => openNotePopup(created[0].id));
      }
    } catch (err) {
      setGuidedError(err instanceof Error ? err.message : 'Failed to add notes');
    } finally {
      setGuidedBusy(false);
    }
  };

  const handleConnectionDecision = async (accepted: boolean) => {
    const candidate = connectionQueue[connectionIndex];
    if (!candidate) return;
    applyConnectionFeedback(candidate.note.id, candidate.relation.related_note_id, accepted).catch(() => {});
    if (connectionIndex < connectionQueue.length - 1) {
      setConnectionIndex((index) => index + 1);
      return;
    }
    const noteId = connectionQueue[0]?.note.id;
    setConnectionQueue([]);
    setConnectionIndex(0);
    if (noteId) requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('open-note-popup', { detail: { noteId, hideConnections: !accepted } }));
    });
  };

  const formatAddText = (prefix: string, suffix = prefix) => {
    const textarea = addTextareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = addValue.slice(start, end);
    const nextValue = `${addValue.slice(0, start)}${prefix}${selected}${suffix}${addValue.slice(end)}`;
    setAddValue(nextValue);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + prefix.length, end + prefix.length);
    });
  };

  const formatAddList = (ordered = false) => {
    const textarea = addTextareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = addValue.slice(start, end) || 'List item';
    const formatted = selected.split('\n').map((line, index) => `${ordered ? `${index + 1}.` : '-'} ${line}`).join('\n');
    setAddValue(`${addValue.slice(0, start)}${formatted}${addValue.slice(end)}`);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start, start + formatted.length);
    });
  };

  const formatAddBody = () => {
    const textarea = addTextareaRef.current;
    if (!textarea) return;
    const cursor = textarea.selectionStart;
    const lineStart = addValue.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1;
    const lineEndIndex = addValue.indexOf('\n', cursor);
    const lineEnd = lineEndIndex === -1 ? addValue.length : lineEndIndex;
    const line = addValue.slice(lineStart, lineEnd);
    const plainLine = line.replace(/^#{1,3}\s+/, '');
    setAddValue(`${addValue.slice(0, lineStart)}${plainLine}${addValue.slice(lineEnd)}`);
    requestAnimationFrame(() => {
      textarea.focus();
      const removed = line.length - plainLine.length;
      textarea.setSelectionRange(Math.max(lineStart, cursor - removed), Math.max(lineStart, cursor - removed));
    });
  };

  const importAddFile = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 2_000_000) {
      setError('Please choose a text file smaller than 2 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === 'string' ? reader.result.trim() : '';
      if (!content) {
        setError('That file does not contain readable text.');
        return;
      }
      setAddValue((current) => `${current}${current.trim() ? '\n\n' : ''}${content}`);
      setError('');
      requestAnimationFrame(() => addTextareaRef.current?.focus());
    };
    reader.onerror = () => setError('Unable to read that file.');
    reader.readAsText(file);
  };

  const toggleAddDictation = () => {
    if (dictating) {
      speechRecognitionRef.current?.stop();
      return;
    }
    const speechWindow = window as Window & {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Recognition) {
      setError('Voice dictation is not supported in this browser. Try Chrome or Safari.');
      return;
    }
    const recognition = new Recognition();
    recognition.lang = navigator.language || 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript?.trim();
      if (transcript) setAddValue((current) => `${current}${current.trim() ? ' ' : ''}${transcript}`);
    };
    recognition.onerror = () => setError('Voice dictation could not start. Please check microphone permission.');
    recognition.onend = () => {
      setDictating(false);
      speechRecognitionRef.current = null;
    };
    speechRecognitionRef.current = recognition;
    setError('');
    setDictating(true);
    recognition.start();
  };

  const submitAsk = () => {
    const text = askValue.trim();
    if (!text || busy) return;
    setAskValue('');
    runHandleMessage(text);
  };

  /* ── deletion ── */
  const removeNote = async (id: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
    if (active?.kind === 'note' && active.id === id) setActive(null);
    try {
      await deleteNote(id);
    } catch {
      load();
    }
  };

  const removeChat = async (id: string) => {
    setQuestions((prev) => prev.filter((q) => q.id !== id));
    if (active?.kind === 'chat' && active.id === id) {
      setActive(null);
      setChat(null);
    }
    try {
      await deleteQuestion(id);
    } catch {
      load();
    }
  };

  /* ── inline note edit ── */
  const activeNote = active?.kind === 'note' ? noteMap[active.id] : undefined;

  const startEdit = () => {
    if (!activeNote) return;
    setEditText(activeNote.raw_text);
    setEditing(true);
  };
  const saveEdit = async () => {
    if (!activeNote || !editText.trim()) return;
    setSavingEdit(true);
    try {
      const updated = await updateNote(activeNote.id, editText.trim());
      setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
      setEditing(false);
    } finally {
      setSavingEdit(false);
    }
  };

  /* ── rail items (notes + chats, newest first) ── */
  const railItems: RailItem[] = useMemo(() => {
    const items: RailItem[] = [
      ...notes.map((n) => ({
        kind: 'note' as const,
        id: n.id,
        title: noteTitle(n),
        preview: truncate(n.raw_text, 80),
        createdAt: n.created_at,
      })),
      ...questions.map((q) => ({
        kind: 'chat' as const,
        id: q.id,
        title: q.question,
        preview: q.answer ? truncate(q.answer, 80) : '',
        createdAt: q.created_at,
      })),
    ];
    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return items;
  }, [notes, questions]);

  const relations = active?.kind === 'note' ? relationsCache[active.id] ?? [] : [];
  const composerPlaceholder = active?.kind === 'chat' ? 'Ask a follow-up…' : 'Write a note, or ask a question…';
  const filteredHomeNotes = notes.filter((note) => {
    const query = searchQuery.trim().toLowerCase();
    return !query || note.raw_text.toLowerCase().includes(query) || note.summary?.toLowerCase().includes(query);
  });
  const openNotePopup = (noteId: string) => {
    window.dispatchEvent(new CustomEvent('open-note-popup', { detail: { noteId } }));
  };

  /* ────────────────── render ────────────────── */

  return (
    <div className="min-h-screen bg-background text-foreground">
      {addOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-end justify-center bg-black/45 backdrop-blur-sm sm:items-center sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-note-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !busy) setAddOpen(false);
          }}
        >
          <button type="button" aria-label="Close note editor" className="absolute inset-0" onClick={() => !busy && setAddOpen(false)} />
          <div className="animate-ocreda-fade-up relative flex h-[88vh] w-full max-w-[1100px] flex-col overflow-hidden rounded-t-2xl border border-border/70 bg-card shadow-2xl sm:h-[640px] sm:rounded-2xl">
            <div className="flex min-h-0 flex-1 flex-col px-6 pb-5 pt-10 sm:px-14 sm:pb-4 sm:pt-12">
              <label id="add-note-title" htmlFor="new-note-title" className="sr-only">Note title</label>
              <input
                id="new-note-title"
                ref={addTitleRef}
                value={addTitle}
                onChange={(e) => setAddTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTextareaRef.current?.focus();
                  }
                }}
                placeholder="What's on your mind?"
                className="w-full bg-transparent text-xl font-medium italic text-foreground placeholder:text-foreground focus:outline-none sm:text-2xl"
              />
              <p className="mt-1 max-w-xl text-sm italic leading-relaxed text-muted-foreground">
                Anything. Something you read, something you&apos;re stuck on, something<br className="hidden sm:block" /> you keep thinking about.
              </p>
              <textarea
                id="new-note"
                ref={addTextareaRef}
                value={addValue}
                onChange={(e) => setAddValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submitAdd();
                  }
                }}
                placeholder="For example: Someone made the point that we mostly don't choose our beliefs, we absorb them and backfill reasons after. Uncomfortable but I can't argue with it. Makes me wonder how much of what I think is actually mine."
                className="mt-7 min-h-[220px] flex-1 resize-none bg-transparent text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/35 focus:outline-none sm:mt-8"
              />
              {error && <p className="mt-2 text-sm font-medium text-destructive">{error}</p>}
            </div>

            <div className="flex min-h-[54px] shrink-0 items-center gap-1 overflow-x-auto border-t border-border/70 bg-muted/25 px-3 py-2 text-sm sm:gap-2 sm:px-5">
              <input ref={addFileRef} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" className="hidden" onChange={(event) => { importAddFile(event.target.files?.[0]); event.target.value = ''; }} />
              <button type="button" onClick={() => addFileRef.current?.click()} title="Import a text or Markdown file" aria-label="Attach a file" className="shrink-0 rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"><Plus className="h-5 w-5" /></button>
              <button type="button" onClick={toggleAddDictation} title={dictating ? 'Stop voice dictation' : 'Start voice dictation'} aria-label={dictating ? 'Stop voice dictation' : 'Record audio'} className={`shrink-0 rounded-md p-2 transition-colors ${dictating ? 'bg-destructive/10 text-destructive' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}><Mic className={`h-4 w-4 ${dictating ? 'animate-pulse' : ''}`} /></button>
              <span className="mx-1 h-7 w-px shrink-0 bg-border" />
              <button type="button" onClick={() => formatAddText('**')} aria-label="Bold" className="shrink-0 rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"><BoldIcon className="h-4 w-4" /></button>
              <button type="button" onClick={() => formatAddText('*')} aria-label="Italic" className="shrink-0 rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"><ItalicIcon className="h-4 w-4" /></button>
              <span className="mx-1 h-7 w-px shrink-0 bg-border" />
              <button type="button" onClick={() => formatAddText('# ', '')} className="shrink-0 rounded-md px-2 py-1.5 font-semibold text-muted-foreground hover:bg-accent hover:text-foreground">H1</button>
              <button type="button" onClick={() => formatAddText('## ', '')} className="shrink-0 rounded-md px-2 py-1.5 font-semibold text-muted-foreground hover:bg-accent hover:text-foreground">H2</button>
              <button type="button" onClick={() => formatAddText('### ', '')} className="shrink-0 rounded-md px-2 py-1.5 font-semibold text-muted-foreground hover:bg-accent hover:text-foreground">H3</button>
              <button type="button" onClick={formatAddBody} className="shrink-0 rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">Body</button>
              <span className="mx-1 h-7 w-px shrink-0 bg-border" />
              <button type="button" onClick={() => formatAddList(false)} className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><List className="h-4 w-4" /> Bullet list</button>
              <button type="button" onClick={() => formatAddList(true)} className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><ListOrdered className="h-4 w-4" /> Numbered list</button>
              <button
                type="button"
                onClick={submitAdd}
                disabled={!addTitle.trim() || busy}
                className="ml-auto inline-flex min-w-[126px] shrink-0 items-center justify-center rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {savedOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center overflow-hidden bg-black/30 px-4 backdrop-blur-[3px]" role="status" aria-live="polite">
          <div
            className={`flex h-[220px] w-full max-w-[516px] items-center justify-center rounded-lg bg-[#4779e8] px-6 text-center text-xl font-normal text-white shadow-xl transition-all duration-500 ease-in sm:h-[300px] ${
              savedExiting ? 'translate-y-[calc(50vh+100%)]' : 'animate-ocreda-fade-up translate-y-0'
            }`}
          >
            Saved to you for you
          </div>
        </div>
      )}

      {guidedOpen && (
        <GuidedChat
          displayName={displayName}
          step={guidedStep}
          messages={guidedMessages}
          value={guidedValue}
          busy={guidedBusy}
          error={guidedError}
          drafts={guidedDrafts}
          onChange={setGuidedValue}
          onSubmit={submitGuidedAnswer}
          onSkip={closeGuidedChat}
          onBack={() => setGuidedOpen(false)}
          onAddNote={() => setAddOpen(true)}
          onDraftsChange={setGuidedDrafts}
          onSaveDrafts={saveGuidedDrafts}
        />
      )}

      {connectionQueue[connectionIndex] && (
        <ConnectionReview
          candidate={connectionQueue[connectionIndex]}
          position={connectionIndex + 1}
          total={connectionQueue.length}
          onAccept={() => handleConnectionDecision(true)}
          onReject={() => handleConnectionDecision(false)}
        />
      )}

      {chatHistoryOpen && (
        <div className="fixed inset-0 z-[75] flex justify-end bg-black/35 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="chat-history-title">
          <button type="button" aria-label="Close chat history" className="absolute inset-0" onClick={() => setChatHistoryOpen(false)} />
          <aside className="animate-ocreda-fade-up relative flex h-full w-full max-w-[480px] flex-col border-l border-border bg-card shadow-2xl">
            <header className="flex h-20 shrink-0 items-center border-b border-border px-6">
              <div>
                <h2 id="chat-history-title" className="text-xl font-semibold">Chat history</h2>
                <p className="mt-1 text-sm text-muted-foreground">Continue any previous conversation.</p>
              </div>
              <button type="button" onClick={() => setChatHistoryOpen(false)} aria-label="Close" className="ml-auto rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground"><X className="h-5 w-5" /></button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
              {chatHistoryLoading ? (
                <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
              ) : questions.length === 0 ? (
                <div className="flex h-56 flex-col items-center justify-center rounded-2xl border border-dashed border-border px-8 text-center">
                  <MessageCircle className="h-7 w-7 text-muted-foreground" />
                  <p className="mt-4 font-medium">No previous chats yet</p>
                  <p className="mt-2 text-sm text-muted-foreground">Ask your first question and it will appear here.</p>
                  <button type="button" onClick={() => setChatHistoryOpen(false)} className="mt-5 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">Start a chat</button>
                </div>
              ) : (
                <div className="space-y-3">
                  {questions.map((question) => (
                    <article key={question.id} className="group relative rounded-2xl border border-border bg-background/30 transition-colors hover:border-primary/35 hover:bg-accent/20">
                      <button type="button" onClick={() => openPreviousChat(question)} className="block w-full px-5 py-4 pr-12 text-left">
                        <h3 className="line-clamp-2 font-semibold leading-snug">{question.question}</h3>
                        {question.answer && <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted-foreground">{question.answer}</p>}
                        <p className="mt-3 text-xs text-muted-foreground/70">{relTime(question.created_at)}</p>
                      </button>
                      <button
                        type="button"
                        aria-label="Delete conversation"
                        title="Delete conversation"
                        onClick={async () => {
                          if (!window.confirm('Delete this conversation?')) return;
                          await removeChat(question.id);
                        }}
                        className="absolute right-3 top-3 rounded-lg p-2 text-muted-foreground opacity-70 hover:bg-destructive/10 hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </aside>
        </div>
      )}

      <div className="p-3 sm:p-5 lg:p-6">
        <div className="mx-auto max-w-[1500px] rounded-3xl border border-border/60 bg-card shadow-sm lg:h-[calc(100vh-3rem)] overflow-hidden">
          {loading ? (
            <div className="h-full flex items-center justify-center py-32">
              <Loader2 className="w-6 h-6 text-muted-foreground/50 animate-spin" />
            </div>
          ) : isEmpty ? (
            /* ───────────── STATE 1 — first-time user ───────────── */
            <div className="animate-ocreda-fade-in relative flex h-full min-h-[calc(100vh-1.5rem)] flex-col bg-card sm:min-h-[calc(100vh-2.5rem)] lg:min-h-0">
              <div className="absolute right-5 top-5 z-10 flex items-center gap-5 sm:right-8 sm:top-6">
                <span className="rounded-md border border-primary/20 bg-primary/10 px-4 py-1.5 text-xs font-medium text-primary">Beta</span>
                <AvatarButton embedded />
              </div>

              <main className="flex flex-1 flex-col items-center px-5 pb-8 pt-28 sm:px-8 sm:pb-10 sm:pt-32">
                <div className="flex items-center justify-center gap-3 text-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/ocreda-logo.png" alt="" className="h-8 w-8 shrink-0 object-contain sm:h-9 sm:w-9" />
                  <h1 className="text-2xl font-medium tracking-tight sm:text-3xl">
                    Welcome to Ocreda{displayName ? `, ${displayName.split(/\s+/)[0]}` : ''}
                  </h1>
                </div>
                <p className="mt-3 text-center text-sm text-muted-foreground sm:text-base">
                  Write notes. Ask questions. Ocreda connects them on its own
                </p>

                <section className="mt-20 flex min-h-[230px] w-full max-w-[630px] flex-col items-center justify-center rounded-2xl bg-muted/45 px-6 py-10 sm:px-10">
                  <h2 className="text-center text-base font-semibold sm:text-lg">
                    Add one note to start. Connections appear as you use them.
                  </h2>
                  <button
                    type="button"
                    onClick={() => {
                      setError('');
                      setAddOpen(true);
                    }}
                    disabled={busy}
                    className="mt-12 flex w-full max-w-[210px] items-center justify-center rounded-md bg-primary px-5 py-3 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/20 transition-colors hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-card disabled:opacity-50"
                  >
                    Add a note
                  </button>
                </section>

                <p className="mt-auto pt-12 text-center text-xs text-muted-foreground sm:text-sm">
                  Your notes are private and secured. Nobody can touch them.
                </p>
                {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
              </main>
            </div>
          ) : (
            /* ───────────── STATE 2 — existing-user home ───────────── */
            <div className="animate-ocreda-fade-in relative flex h-full min-h-[calc(100vh-1.5rem)] flex-col bg-card sm:min-h-[calc(100vh-2.5rem)] lg:min-h-0">
              <header className="absolute right-5 top-5 z-10 sm:right-7 sm:top-6">
                <div className="flex items-center gap-3 sm:gap-6">
                  <span className="hidden rounded-md border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary md:inline-flex">Beta</span>
                  <a href="mailto:feedback@ocreda.com" className="hidden text-sm font-medium text-muted-foreground hover:text-foreground md:inline">Send feedback</a>
                  <AvatarButton embedded />
                </div>
              </header>

              <nav className="absolute left-5 top-5 z-10 hidden w-36 flex-col items-start gap-2 lg:flex">
                <button onClick={() => { setError(''); setAddOpen(true); }} className="inline-flex items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-accent"><SquarePlus className="h-6 w-6 text-primary" /> Add a note</button>
                <button onClick={() => { setActive(null); setChat(null); setSearchOpen((open) => !open); }} className="inline-flex items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-accent"><Search className="h-6 w-6" /> Search</button>
                <button onClick={openChatHistory} className="inline-flex items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-accent"><Clock3 className="h-5 w-5" /> Chat history</button>
              </nav>

              {active?.kind === 'chat' && chat ? (
                <AskResultsView
                  chat={chat}
                  noteMap={noteMap}
                  value={composerValue}
                  busy={busy}
                  error={error}
                  onChange={setComposerValue}
                  onSubmit={submitComposer}
                  onAddNote={() => { setError(''); setAddOpen(true); }}
                  onOpenNote={openNotePopup}
                />
              ) : (
              <main className="flex-1 overflow-y-auto px-5 pb-20 pt-28 scrollbar-thin sm:px-8 lg:px-12">
                <div className="mx-auto w-full max-w-[810px]">
                  {searchOpen && (
                    <div className="mb-6 animate-ocreda-fade-up">
                      <label htmlFor="home-search" className="sr-only">Search notes</label>
                      <div className="relative">
                        <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                        <input id="home-search" autoFocus value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search your notes..." className="w-full rounded-xl border border-border bg-background/30 py-3 pl-12 pr-4 text-sm focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20" />
                      </div>
                    </div>
                  )}

                  <section>
                    <div className="mb-4 flex items-center gap-3">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src="/ocreda-logo.png" alt="" className="h-6 w-6 object-contain" />
                      <h1 className="text-base font-semibold sm:text-lg">Ask yourself anything</h1>
                    </div>
                    {chatAnchor && (
                      <div className="mb-4 rounded-xl border border-primary/25 bg-primary/[0.04] px-5 py-4 text-sm">
                        <strong>I&apos;ve loaded “{noteTitle(chatAnchor)}.”</strong>
                        <p className="mt-1 text-muted-foreground">What would you like to ask about it?</p>
                      </div>
                    )}
                    <div className="rounded-2xl border border-primary/60 bg-muted/20 p-5 shadow-sm focus-within:ring-2 focus-within:ring-primary/10">
                      <textarea
                        value={composerValue}
                        onChange={(e) => setComposerValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComposer(); } }}
                        placeholder={chatAnchor ? `Ask about ${noteTitle(chatAnchor)}…` : 'How do people find meaning in uncertainty?'}
                        rows={2}
                        className="w-full resize-none bg-transparent text-base focus:outline-none placeholder:text-muted-foreground/55"
                      />
                      <div className="mt-2 flex items-center justify-between">
                        <button type="button" onClick={() => { setError(''); setAddOpen(true); }} aria-label="Add a note" className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><Plus className="h-5 w-5" /></button>
                        <div className="flex items-center gap-2">
                          <button type="button" disabled title="Voice capture coming soon" aria-label="Record audio" className="rounded-lg p-1.5 text-muted-foreground opacity-45"><Mic className="h-5 w-5" /></button>
                          {composerValue.trim() && (
                            <button type="button" onClick={submitComposer} disabled={busy} aria-label="Send" className="rounded-lg bg-primary p-2 text-primary-foreground disabled:opacity-40">
                              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                    {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
                  </section>

                  <div className="mt-36">
                    <section ref={recentSectionRef}>
                      <h2 className="mb-4 text-sm font-medium text-primary">From your last session</h2>
                      {filteredHomeNotes[0] ? (
                        <button type="button" onClick={() => openNotePopup(filteredHomeNotes[0].id)} className="group flex min-h-[140px] w-full items-start rounded-2xl border border-border bg-background/20 p-7 text-left shadow-md transition-colors hover:border-primary/35">
                          <span className="min-w-0 flex-1"><strong className="block truncate text-lg">{noteTitle(filteredHomeNotes[0])}</strong><span className="mt-3 block line-clamp-2 text-sm leading-relaxed text-muted-foreground">{truncate(filteredHomeNotes[0].raw_text, 180)}</span></span>
                        </button>
                      ) : <p className="rounded-2xl border border-dashed border-border p-6 text-sm text-muted-foreground">No matching notes.</p>}
                    </section>
                  </div>
                  <div className="fixed bottom-0 left-1/2 z-10 flex w-[min(650px,80vw)] -translate-x-1/2 justify-center gap-10 rounded-t-full border border-b-0 border-border bg-card px-10 py-4 text-xs text-muted-foreground shadow-sm">
                    <span>2 Categories</span><span>{notes.length} Notes</span><span>{connectionsCount} Connections</span>
                  </div>
                </div>
              </main>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────── guided connection review ────────────────────────── */

function ConnectionReview({
  candidate,
  position,
  total,
  onAccept,
  onReject,
}: {
  candidate: ConnectionCandidate;
  position: number;
  total: number;
  onAccept: () => void;
  onReject: () => void;
}) {
  const left = candidate.note;
  const right = candidate.relation.related_note;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/25 p-4 backdrop-blur-[2px]">
      <section className="animate-ocreda-fade-up flex min-h-[600px] w-full max-w-[1340px] flex-col items-center rounded-[28px] bg-card px-6 py-14 text-foreground shadow-2xl sm:px-12">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Connection {position} of {total}</p>
        <h1 className="mt-4 text-3xl font-medium tracking-tight sm:text-4xl">Found a connection</h1>
        <p className="mt-4 max-w-2xl text-center text-base text-primary sm:text-lg">
          {candidate.relation.reason || 'They are connected because they reveal the same underlying pattern.'}
        </p>

        <div className="mt-20 flex w-full max-w-[900px] flex-col items-center gap-6 md:flex-row md:justify-between">
          <ConnectionNoteCard note={left} />
          <div className="flex shrink-0 items-center gap-3 text-primary">
            <span className="h-px w-16 bg-primary" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/ocreda-logo.png" alt="Connected" className="h-7 w-7 object-contain" />
            <span className="h-px w-16 bg-primary" />
          </div>
          <ConnectionNoteCard note={{ ...left, id: right.id, raw_text: right.raw_text, summary: right.summary }} />
        </div>

        <p className="mt-20 max-w-3xl text-center text-sm italic leading-relaxed text-muted-foreground">
          <strong className="text-foreground">Note:</strong> These aren&apos;t based on words in common or tagging. As you use Ocreda, the connections get sharper. This will show you connections you didn&apos;t even expect. Only connections based on how you used Ocreda will be suggested; the rest will be automatically connected.
        </p>

        <div className="mt-auto flex items-center gap-5 pt-12">
          <button type="button" onClick={onAccept} className="inline-flex items-center gap-3 text-sm font-medium text-primary">
            Accept
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary text-white"><Check className="h-6 w-6" /></span>
          </button>
          <button type="button" onClick={onReject} className="inline-flex items-center gap-3 text-sm font-medium text-foreground">
            <span className="flex h-11 w-11 items-center justify-center rounded-full border border-foreground"><X className="h-6 w-6" /></span>
            Reject
          </button>
        </div>
      </section>
    </div>
  );
}

function ConnectionNoteCard({ note }: { note: Pick<Note, 'id' | 'raw_text' | 'summary'> }) {
  return (
    <article className="w-full max-w-[350px] rounded-xl border border-primary bg-card p-6 shadow-md">
      <h2 className="text-lg font-bold">{note.summary || truncate(firstLine(note.raw_text), 48)}</h2>
      <p className="mt-3 line-clamp-5 text-sm leading-relaxed text-muted-foreground">{note.raw_text}</p>
    </article>
  );
}

/* ────────────────────────── one-time guided chat ────────────────────────── */

function GuidedChat({
  displayName,
  step,
  messages,
  value,
  busy,
  error,
  drafts,
  onChange,
  onSubmit,
  onSkip,
  onBack,
  onAddNote,
  onDraftsChange,
  onSaveDrafts,
}: {
  displayName: string;
  step: number;
  messages: Array<{ answer: string; response: string }>;
  value: string;
  busy: boolean;
  error: string;
  drafts: GuidedDraft[];
  onChange: (value: string) => void;
  onSubmit: () => void;
  onSkip: () => void;
  onBack: () => void;
  onAddNote: () => void;
  onDraftsChange: (drafts: GuidedDraft[]) => void;
  onSaveDrafts: () => void;
}) {
  const firstName = displayName.split(/\s+/)[0] || 'there';

  return (
    <div className="fixed inset-0 z-[60] overflow-hidden bg-[#e8e8e8] p-3 sm:p-5">
      <div className="flex h-full min-h-0 bg-card text-foreground">
        <nav className="flex w-[72px] shrink-0 flex-col items-center py-5 sm:w-[86px]">
          <button type="button" onClick={onBack} aria-label="Back home" className="rounded-lg p-2 text-foreground hover:bg-accent"><ArrowLeft className="h-7 w-7" /></button>
          <button type="button" onClick={onAddNote} aria-label="Add note" className="mt-5 rounded-md bg-primary p-2 text-primary-foreground"><Plus className="h-5 w-5" /></button>
          <button type="button" onClick={onBack} aria-label="Search" className="mt-3 rounded-lg p-2 text-foreground hover:bg-accent"><Search className="h-6 w-6" /></button>
          <button type="button" aria-label="Recent" className="mt-auto rounded-lg p-2 text-foreground hover:bg-accent"><Clock3 className="h-5 w-5" /></button>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col border-r border-border/50">
          <div className="flex h-[70px] shrink-0 items-center justify-end px-5 sm:px-7">
            <div className="inline-flex overflow-hidden rounded-md border border-primary/35 text-sm">
              <span className="bg-primary/10 px-5 py-1.5 text-primary">Beta</span>
              <a href="mailto:feedback@ocreda.com" className="px-3 py-1.5 hover:bg-accent">Send feedback</a>
            </div>
          </div>

          <main className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 scrollbar-thin sm:px-10 lg:px-16">
            <div className="mx-auto flex min-h-full max-w-[760px] flex-col">
              <div className="flex-1 py-8 sm:py-10">
                {messages.length === 0 ? (
                  <div className="space-y-7 text-base font-semibold leading-relaxed sm:text-lg">
                    <p>Hey {firstName}, I am you. This is where you ask your notes anything.</p>
                    <p>Before that, three quick things about you. It&apos;ll make what comes back actually useful.</p>
                    <p>{GUIDED_QUESTIONS[0]}</p>
                  </div>
                ) : (
                  <div className="space-y-8">
                    {messages.map((message, index) => (
                      <div key={`${index}:${message.answer.slice(0, 12)}`} className="space-y-7">
                        <div className="ml-auto max-w-[610px] rounded-xl bg-muted/55 px-6 py-5 text-base font-semibold leading-relaxed sm:text-lg">
                          {message.answer}
                          <Check className="ml-2 inline h-4 w-4 text-muted-foreground/40" />
                        </div>
                        <p className="text-base font-semibold leading-relaxed sm:text-lg">{message.response}</p>
                      </div>
                    ))}
                    {drafts.length > 0 && (
                      <p className="text-base font-semibold leading-relaxed sm:text-lg">
                        On the right you can see what we pulled out. You can edit and check the ones you want to save.
                      </p>
                    )}
                  </div>
                )}

                {drafts.length === 0 && <button type="button" onClick={onSkip} className="mt-10 text-base italic text-muted-foreground underline underline-offset-2 hover:text-foreground">Skip</button>}
                <div className="mt-9">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/ocreda-logo.png" alt="Ocreda" className="h-9 w-9 object-contain" />
                </div>
              </div>

              <div className="shrink-0 rounded-2xl border border-primary bg-muted/25 p-4 shadow-sm">
                <textarea
                  autoFocus
                  disabled={drafts.length > 0}
                  value={value}
                  onChange={(e) => onChange(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); } }}
                  placeholder={drafts.length > 0 ? 'Review the notes on the right' : 'Reply to your Ocreda'}
                  rows={3}
                  className="w-full resize-none bg-transparent text-sm italic focus:outline-none placeholder:text-muted-foreground/65"
                />
                <div className="mt-2 flex items-center gap-2">
                  <button type="button" onClick={onAddNote} aria-label="Add note" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><Plus className="h-5 w-5" /></button>
                  <button type="button" disabled aria-label="Record audio" title="Voice capture coming soon" className="rounded-md p-1.5 text-muted-foreground opacity-50"><Mic className="h-4 w-4" /></button>
                  <button type="button" aria-label="Save draft" title="Draft is saved automatically" className="ml-auto rounded-md p-1.5 text-primary"><Save className="h-5 w-5" /></button>
                  <button type="button" onClick={onSubmit} disabled={!value.trim() || busy || drafts.length > 0} aria-label="Send reply" className="rounded-md bg-primary p-2 text-primary-foreground disabled:opacity-40">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                  </button>
                </div>
                {error && <p className="mt-2 text-sm font-medium text-destructive">{error}</p>}
              </div>
            </div>
          </main>
        </div>

        <aside className="hidden w-[29%] min-w-[300px] shrink-0 p-3 lg:block">
          <div className="relative flex h-full flex-col overflow-hidden rounded-xl border border-border/35 bg-background/20 shadow-inner">
            {drafts.length === 0 ? (
              <div className="flex flex-1 items-center justify-center px-8 text-center text-base text-muted-foreground/45">
                Retrieved notes will show up here<br />when you ask something.
              </div>
            ) : (
              <div className="flex-1 space-y-4 overflow-y-auto p-3 pb-20 scrollbar-thin">
                {drafts.map((draft) => (
                  <article key={draft.id} className={`overflow-hidden rounded-xl border bg-card shadow-sm ${draft.selected ? 'border-primary/25' : 'border-border opacity-60'}`}>
                    <div className="p-5">
                      <div className="flex items-start gap-3">
                        {draft.editing ? (
                          <input
                            value={draft.title}
                            onChange={(e) => onDraftsChange(drafts.map((item) => item.id === draft.id ? { ...item, title: e.target.value } : item))}
                            className="min-w-0 flex-1 border-b border-primary/30 bg-transparent text-base font-bold focus:outline-none"
                          />
                        ) : <h3 className="min-w-0 flex-1 text-base font-bold">{draft.title}</h3>}
                        <button
                          type="button"
                          onClick={() => onDraftsChange(drafts.map((item) => item.id === draft.id ? { ...item, selected: !item.selected } : item))}
                          aria-label={draft.selected ? 'Reject note' : 'Accept note'}
                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border ${draft.selected ? 'border-primary bg-primary text-white' : 'border-primary/50'}`}
                        >
                          {draft.selected && <Check className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                      {draft.editing ? (
                        <textarea
                          value={draft.body}
                          onChange={(e) => onDraftsChange(drafts.map((item) => item.id === draft.id ? { ...item, body: e.target.value } : item))}
                          rows={4}
                          className="mt-3 w-full resize-none rounded-md border border-border bg-transparent p-2 text-sm leading-relaxed focus:border-primary/40 focus:outline-none"
                        />
                      ) : <p className="mt-3 line-clamp-4 text-sm leading-relaxed text-muted-foreground">{draft.body}</p>}
                    </div>
                    <div className="flex border-t border-border/50">
                      <button type="button" onClick={() => onDraftsChange(drafts.map((item) => item.id === draft.id ? { ...item, editing: !item.editing } : item))} className="flex-1 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
                        {draft.editing ? 'Done' : 'Edit'}
                      </button>
                      <button type="button" onClick={() => onDraftsChange(drafts.filter((item) => item.id !== draft.id))} aria-label="Delete draft" className="border-l border-border/50 px-3 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </article>
                ))}
              </div>
            )}
            {drafts.length > 0 && (
              <div className="absolute inset-x-0 bottom-0 flex border-t border-border bg-card">
                <button type="button" onClick={onSaveDrafts} disabled={!drafts.some((draft) => draft.selected) || busy} className="flex-1 bg-primary px-4 py-3 text-sm font-medium text-primary-foreground disabled:opacity-40">
                  {busy ? 'Adding…' : 'Add notes'}
                </button>
                <button type="button" onClick={onSkip} aria-label="Close drafts" className="bg-foreground px-4 text-background"><X className="h-5 w-5" /></button>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ────────────────────────── ask results ────────────────────────── */

function AskResultsView({
  chat,
  noteMap,
  value,
  busy,
  error,
  onChange,
  onSubmit,
  onAddNote,
  onOpenNote,
}: {
  chat: ChatState;
  noteMap: Record<string, Note>;
  value: string;
  busy: boolean;
  error: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onAddNote: () => void;
  onOpenNote: (noteId: string) => void;
}) {
  const sources = chat.sourceIds.map((id) => noteMap[id]).filter(Boolean);

  return (
    <div className="flex min-h-0 flex-1 flex-col pt-20 lg:flex-row">
      <main className="min-w-0 flex-1 overflow-y-auto px-5 pb-9 pt-5 scrollbar-thin sm:px-8 lg:pl-[180px] lg:pr-10 lg:pt-6">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-primary/25 bg-primary/10 text-primary">
              <MessageCircle className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Ask anything about your notes.</h1>
              <p className="mt-1 text-sm text-muted-foreground">Ocreda uses your notes to find relevant answers and connections.</p>
            </div>
          </div>

          <div className="mt-9 space-y-6">
            {chat.messages.map((message) => message.role === 'user' ? (
              <div key={message.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl bg-primary/10 px-5 py-3 text-sm font-medium sm:text-base">{message.content}</div>
              </div>
            ) : (
              <div key={message.id}>
                <article className="rounded-2xl border border-border bg-background/20 p-5 shadow-sm sm:p-7">
                  <div className="answer-prose text-sm leading-relaxed text-foreground sm:text-base" dangerouslySetInnerHTML={{ __html: renderAnswer(message.content) }} />
                  {sources.length > 0 && (
                    <div className="mt-6">
                      <p className="text-xs font-medium text-muted-foreground">Used from your notes</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {sources.map((note) => (
                          <button key={note.id} type="button" onClick={() => onOpenNote(note.id)} className="inline-flex items-center gap-2 rounded-xl bg-primary/10 px-3 py-2 text-sm font-semibold text-foreground hover:bg-primary/15">
                            <FileText className="h-4 w-4 text-primary" />
                            {noteTitle(note)}
                            <ExternalLink className="h-3.5 w-3.5 text-primary" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </article>
                <div className="mt-3 flex items-center gap-1">
                  <button type="button" aria-label="Helpful answer" className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground"><ThumbsUp className="h-4 w-4" /></button>
                  <button type="button" aria-label="Not helpful" className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground"><ThumbsDown className="h-4 w-4" /></button>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-8 rounded-2xl border border-primary/30 bg-background/20 p-4 shadow-sm focus-within:border-primary/55 focus-within:ring-2 focus-within:ring-primary/10">
            <textarea
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); } }}
              placeholder="Ask another question..."
              rows={2}
              className="w-full resize-none bg-transparent text-sm focus:outline-none placeholder:text-muted-foreground/60 sm:text-base"
            />
            <div className="mt-2 flex items-center gap-2">
              <button type="button" onClick={onAddNote} aria-label="Add a note" className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><Plus className="h-5 w-5" /></button>
              <button type="button" disabled title="Voice capture coming soon" aria-label="Record audio" className="rounded-lg p-1.5 text-muted-foreground opacity-45"><Mic className="h-5 w-5" /></button>
              <button type="button" onClick={onSubmit} disabled={!value.trim() || busy} aria-label="Send question" className="ml-auto rounded-full bg-primary p-2.5 text-primary-foreground shadow-sm disabled:opacity-40">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
              </button>
            </div>
          </div>
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        </div>
      </main>

      <aside className="shrink-0 border-t border-border/60 bg-background/15 p-5 lg:w-[340px] lg:overflow-y-auto lg:border-l lg:border-t-0 lg:px-7 lg:pb-7 lg:pt-6">
        <h2 className="text-base font-semibold">Relevant from your notes</h2>
        <div className="mt-5 space-y-4">
          {sources.slice(0, 3).map((note) => (
            <button key={note.id} type="button" onClick={() => onOpenNote(note.id)} className="group block w-full rounded-2xl border border-border bg-card p-5 text-left transition-colors hover:border-primary/35 hover:bg-accent/30">
              <strong className="block text-sm sm:text-base">{noteTitle(note)}</strong>
              <span className="mt-3 block text-sm leading-relaxed text-muted-foreground line-clamp-3">{truncate(note.raw_text, 110)}</span>
              <span className="mt-4 block text-xs text-muted-foreground/70">{relTime(note.created_at)}</span>
            </button>
          ))}
          {sources.length === 0 && <p className="rounded-2xl border border-dashed border-border p-5 text-sm text-muted-foreground">No source notes were needed for this answer.</p>}
        </div>
        <Link href="/notes" className="mt-5 flex w-full items-center justify-center rounded-xl border border-border px-4 py-3 text-sm font-medium hover:bg-accent">View more notes</Link>
      </aside>
    </div>
  );
}

/* ────────────────────────── note view ────────────────────────── */

function NoteView({
  note,
  relations,
  editing,
  editText,
  savingEdit,
  onEditText,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onOpenNote,
}: {
  note: Note;
  relations: RelatedNote[];
  editing: boolean;
  editText: string;
  savingEdit: boolean;
  onEditText: (v: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onOpenNote: (id: string) => void;
}) {
  return (
    <div className="animate-ocreda-fade-up max-w-2xl">
      <div className="flex items-start justify-between gap-3 mb-6">
        <span className="inline-flex rounded-xl bg-muted/60 px-4 py-2 text-sm font-semibold text-foreground">
          {noteTitle(note)}
        </span>
        {!editing && (
          <button
            onClick={onStartEdit}
            title="Edit note"
            className="shrink-0 flex items-center gap-1.5 text-xs text-muted-foreground/70 hover:text-foreground px-2.5 py-1.5 rounded-lg hover:bg-accent transition-all"
          >
            <Pencil className="w-3 h-3" /> Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="space-y-4">
          <textarea
            value={editText}
            onChange={(e) => onEditText(e.target.value)}
            rows={10}
            className="w-full resize-none rounded-2xl border border-border bg-background/60 px-4 py-3.5 text-[15px] leading-relaxed text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/50 transition-all"
          />
          <div className="flex items-center gap-2 justify-end">
            <button
              onClick={onCancelEdit}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-3 py-2 rounded-lg border border-border hover:bg-accent transition-all"
            >
              <X className="w-3 h-3" /> Cancel
            </button>
            <button
              onClick={onSaveEdit}
              disabled={savingEdit || !editText.trim()}
              className="flex items-center gap-1.5 text-xs text-white bg-primary hover:bg-primary/90 px-3 py-2 rounded-lg transition-all disabled:opacity-50"
            >
              {savingEdit ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              Save
            </button>
          </div>
        </div>
      ) : (
        <p className="text-[15px] leading-[1.8] text-foreground whitespace-pre-wrap">{note.raw_text}</p>
      )}

      {!editing && relations.length > 0 && (
        <div className="mt-10 space-y-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">Connected notes</p>
          {relations.map((rel) => (
            <button
              key={rel.id}
              onClick={() => onOpenNote(rel.related_note_id)}
              className="group block w-full text-left border-l-2 border-primary/70 pl-4 py-1 transition-colors hover:border-primary"
            >
              <p className="text-[15px] leading-[1.75] text-foreground/90 group-hover:text-foreground">
                {rel.related_note?.summary || truncate(rel.related_note?.raw_text ?? '', 160)}
              </p>
              {rel.reason && <p className="mt-1 text-xs text-muted-foreground/60 leading-relaxed">{rel.reason}</p>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ────────────────────────── chat view ────────────────────────── */

function ChatView({
  chat,
  noteMap,
  onOpenNote,
}: {
  chat: ChatState;
  noteMap: Record<string, Note>;
  onOpenNote: (id: string) => void;
}) {
  const question = chat.messages.find((m) => m.role === 'user')?.content ?? '';
  const rest = chat.messages.filter((m) => m.id !== chat.messages.find((mm) => mm.role === 'user')?.id);
  const sources = chat.sourceIds.map((id) => noteMap[id]).filter(Boolean);

  return (
    <div className="animate-ocreda-fade-up max-w-2xl">
      <div className="mb-8">
        <span className="inline-flex rounded-xl bg-primary/[0.08] px-4 py-2 text-sm font-semibold text-primary">
          {question}
        </span>
      </div>

      <div className="space-y-6">
        {rest.map((m) =>
          m.role === 'assistant' ? (
            <div
              key={m.id}
              className="answer-prose text-[15px] leading-[1.8] text-foreground"
              dangerouslySetInnerHTML={{ __html: renderAnswer(m.content) }}
            />
          ) : (
            <div key={m.id} className="border-l-2 border-primary/70 pl-4">
              <p className="text-[15px] leading-[1.75] text-foreground font-medium whitespace-pre-wrap">{m.content}</p>
            </div>
          )
        )}
      </div>

      {sources.length > 0 && (
        <div className="mt-10">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-3">Related notes</p>
          <div className="flex flex-wrap gap-2">
            {sources.map((n) => (
              <button
                key={n.id}
                onClick={() => onOpenNote(n.id)}
                className="rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-xs font-medium text-foreground hover:border-primary/40 hover:bg-accent transition-all"
              >
                {noteTitle(n)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
