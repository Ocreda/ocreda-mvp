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
  Sparkles,
  LockKeyhole,
  Paperclip,
  Mic,
  Bold as BoldIcon,
  Italic as ItalicIcon,
  List,
  Lightbulb,
  Save,
  MessageCircle,
  SquarePlus,
  House,
  ChevronRight,
  Search,
  Clock3,
  Brain,
  FileText,
  ArrowRight,
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
  const [addOpen, setAddOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [focusComposer, setFocusComposer] = useState(false);
  const addTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [askValue, setAskValue] = useState('');
  const [composerValue, setComposerValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [connectionsCount, setConnectionsCount] = useState(0);
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
    if (active?.kind === 'chat') sendFollowup(text);
    else runHandleMessage(text);
  };

  const submitAdd = async () => {
    const text = addValue.trim();
    if (!text || busy) return;
    setError('');
    setBusy(true);
    try {
      const note = await createNote(text);
      setNotes((prev) => [note, ...prev]);
      setChat(null);
      setActive({ kind: 'note', id: note.id });
      setAddValue('');
      setAddOpen(false);
      setSavedOpen(true);
      processNote(note.id).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save note');
    } finally {
      setBusy(false);
    }
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

  const formatAddList = () => {
    const textarea = addTextareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = addValue.slice(start, end) || 'List item';
    const formatted = selected.split('\n').map((line) => `- ${line}`).join('\n');
    setAddValue(`${addValue.slice(0, start)}${formatted}${addValue.slice(end)}`);
    requestAnimationFrame(() => textarea.focus());
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
          className="fixed inset-0 z-[70] overflow-y-auto bg-background p-3 sm:p-5 lg:p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-note-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !busy) setAddOpen(false);
          }}
        >
          <div className="animate-ocreda-fade-in mx-auto flex min-h-[calc(100vh-1.5rem)] max-w-[1500px] flex-col overflow-hidden rounded-3xl border border-border/60 bg-card shadow-sm sm:min-h-[calc(100vh-2.5rem)] lg:h-[calc(100vh-3rem)] lg:min-h-0">
            <header className="flex h-[76px] shrink-0 items-center justify-between gap-4 border-b border-border/60 px-5 sm:h-[84px] sm:px-8">
              <button
                type="button"
                onClick={() => !busy && setAddOpen(false)}
                disabled={busy}
                aria-label="Return to Ocreda"
                className="flex items-center gap-3 disabled:opacity-50"
              >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/ocreda-logo.png" alt="" className="h-9 w-9 object-contain" />
                <span className="text-xl font-bold tracking-tight sm:text-2xl">Ocreda</span>
              </button>
              <div className="flex items-center gap-3 sm:gap-7">
                <span className="hidden rounded-md border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary sm:inline-flex">Beta</span>
                <a href="mailto:feedback@ocreda.com" className="hidden text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline">
                  Send feedback
                </a>
                <AvatarButton embedded />
              </div>
            </header>

            <main className="flex min-h-0 flex-1 flex-col px-5 py-8 sm:px-8 sm:py-10">
              <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">
                <div className="mb-5 flex items-center justify-between gap-4">
                  <h1 id="add-note-title" className="text-xl font-bold tracking-tight sm:text-2xl">Add a note</h1>
                  <button
                    type="button"
                    onClick={() => setAddOpen(false)}
                    disabled={busy}
                    aria-label="Close editor"
                    className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>

                <section className="flex min-h-[430px] flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-background/20 shadow-sm">
                  <div className="flex min-h-0 flex-1 flex-col px-5 py-7 sm:px-8 sm:py-9">
                    <label htmlFor="new-note" className="text-xl font-medium text-muted-foreground sm:text-2xl">What&apos;s on your mind?</label>
                    <textarea
                      id="new-note"
                      ref={addTextareaRef}
                      autoFocus
                      value={addValue}
                      onChange={(e) => setAddValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          submitAdd();
                        }
                      }}
                      placeholder="Write, paste, or capture something you want to remember..."
                      className="mt-7 min-h-[220px] flex-1 resize-none bg-transparent text-base leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:outline-none sm:text-lg"
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-1 border-t border-border/70 px-3 py-3 sm:gap-2 sm:px-5">
                    <button type="button" disabled title="Attachments coming soon" aria-label="Attach a file" className="rounded-lg p-2.5 text-muted-foreground opacity-45"><Paperclip className="h-5 w-5" /></button>
                    <button type="button" disabled title="Voice capture coming soon" aria-label="Record audio" className="rounded-lg p-2.5 text-muted-foreground opacity-45"><Mic className="h-5 w-5" /></button>
                    <span className="mx-1 h-8 w-px bg-border" />
                    <button type="button" onClick={() => formatAddText('**')} aria-label="Bold" className="rounded-lg p-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"><BoldIcon className="h-5 w-5" /></button>
                    <button type="button" onClick={() => formatAddText('*')} aria-label="Italic" className="rounded-lg p-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"><ItalicIcon className="h-5 w-5" /></button>
                    <button type="button" onClick={formatAddList} aria-label="Bulleted list" className="rounded-lg p-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"><List className="h-5 w-5" /></button>
                    <button
                      type="button"
                      onClick={submitAdd}
                      disabled={!addValue.trim() || busy}
                      className="ml-auto inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm shadow-primary/20 transition-all hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40 sm:px-6"
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                      {busy ? 'Saving…' : 'Save note'}
                    </button>
                  </div>
                </section>

                {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
                <p className="mt-7 flex items-center gap-2 text-xs text-muted-foreground sm:text-sm">
                  <Lightbulb className="h-4 w-4" />
                  Tip: You can ask about this note once it&apos;s saved.
                </p>
              </div>
            </main>
          </div>
        </div>
      )}

      {savedOpen && (
        <div className="fixed inset-0 z-[80] overflow-y-auto bg-background p-3 sm:p-5 lg:p-6" role="dialog" aria-modal="true" aria-labelledby="note-saved-title">
          <div className="animate-ocreda-fade-in mx-auto flex min-h-[calc(100vh-1.5rem)] max-w-[1500px] flex-col overflow-hidden rounded-3xl border border-border/60 bg-card shadow-sm sm:min-h-[calc(100vh-2.5rem)] lg:h-[calc(100vh-3rem)] lg:min-h-0">
            <header className="flex h-[76px] shrink-0 items-center justify-between gap-4 border-b border-border/60 px-5 sm:h-[84px] sm:px-8">
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/ocreda-logo.png" alt="" className="h-9 w-9 object-contain" />
                <span className="text-xl font-bold tracking-tight sm:text-2xl">Ocreda</span>
              </div>
              <div className="flex items-center gap-3 sm:gap-7">
                <span className="hidden rounded-md border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary sm:inline-flex">Beta</span>
                <a href="mailto:feedback@ocreda.com" className="hidden text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline">Send feedback</a>
                <AvatarButton embedded />
              </div>
            </header>

            <main className="flex flex-1 flex-col items-center justify-center px-5 py-10 sm:px-8 sm:py-14">
              <div className="relative flex h-24 w-24 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500 sm:h-28 sm:w-28">
                <Check className="h-12 w-12" strokeWidth={2.2} />
                <span className="absolute -left-10 top-8 h-2 w-2 rotate-45 rounded-sm bg-primary/55" />
                <span className="absolute -right-9 top-4 h-2 w-2 rotate-45 rounded-sm bg-emerald-400/60" />
                <span className="absolute -right-12 bottom-6 h-2 w-2 rotate-45 rounded-sm bg-pink-400/60" />
                <span className="absolute -left-6 -top-5 h-2 w-2 rotate-45 rounded-sm bg-amber-400/60" />
              </div>

              <h1 id="note-saved-title" className="mt-8 text-3xl font-bold tracking-tight sm:text-4xl">Note saved</h1>
              <p className="mt-3 text-center text-sm text-muted-foreground sm:text-base">Ocreda will connect this as you add more notes.</p>

              <section className="mt-10 w-full max-w-2xl rounded-2xl border border-border bg-background/20 p-5 shadow-sm sm:mt-12 sm:p-7">
                <h2 className="text-lg font-semibold">What&apos;s next?</h2>
                <div className="mt-5 space-y-3">
                  <button
                    type="button"
                    onClick={() => {
                      setSavedOpen(false);
                      setFocusComposer(true);
                    }}
                    className="group flex w-full items-center gap-4 rounded-xl border border-border bg-card px-4 py-4 text-left transition-colors hover:border-primary/35 hover:bg-accent/40"
                  >
                    <MessageCircle className="h-5 w-5 text-primary" />
                    <span className="flex-1 text-sm font-medium sm:text-base">Ask about this note</span>
                    <ChevronRight className="h-5 w-5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSavedOpen(false);
                      setFocusComposer(false);
                      setAddOpen(true);
                    }}
                    className="group flex w-full items-center gap-4 rounded-xl border border-border bg-card px-4 py-4 text-left transition-colors hover:border-primary/35 hover:bg-accent/40"
                  >
                    <SquarePlus className="h-5 w-5 text-primary" />
                    <span className="flex-1 text-sm font-medium sm:text-base">Add another note</span>
                    <ChevronRight className="h-5 w-5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSavedOpen(false);
                      setFocusComposer(false);
                    }}
                    className="group flex w-full items-center gap-4 rounded-xl border border-border bg-card px-4 py-4 text-left transition-colors hover:border-primary/35 hover:bg-accent/40"
                  >
                    <House className="h-5 w-5 text-primary" />
                    <span className="flex-1 text-sm font-medium sm:text-base">Go to home</span>
                    <ChevronRight className="h-5 w-5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </button>
                </div>
              </section>
            </main>
          </div>
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
            <div className="animate-ocreda-fade-in h-full min-h-[calc(100vh-1.5rem)] sm:min-h-[calc(100vh-2.5rem)] lg:min-h-0 flex flex-col bg-card">
              <header className="h-[76px] sm:h-[84px] shrink-0 flex items-center justify-between gap-4 border-b border-border/60 px-5 sm:px-8">
                <div className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/ocreda-logo.png" alt="" className="h-9 w-9 object-contain" />
                  <span className="text-xl sm:text-2xl font-bold tracking-tight">Ocreda</span>
                </div>
                <div className="flex items-center gap-3 sm:gap-7">
                  <span className="hidden sm:inline-flex rounded-md border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">Beta</span>
                  <a
                    href="mailto:feedback@ocreda.com"
                    className="hidden sm:inline text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Send feedback
                  </a>
                  <AvatarButton embedded />
                </div>
              </header>

              <main className="flex flex-1 flex-col items-center px-5 pb-7 pt-10 sm:px-8 sm:pb-10 sm:pt-14">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/ocreda-logo.png" alt="Ocreda" className="h-14 w-14 object-contain" />

                <h1 className="mt-7 text-center text-3xl font-bold tracking-tight sm:text-4xl">
                  Welcome to Ocreda{displayName ? `, ${displayName.split(/\s+/)[0]}` : ''}
                </h1>
                <p className="mt-3 text-center text-sm text-muted-foreground sm:text-base">
                  Write notes. Ask questions. Ocreda connects them on its own.
                </p>

                <section className="mt-10 w-full max-w-2xl rounded-2xl border border-border bg-background/25 p-5 shadow-sm sm:mt-14 sm:p-8">
                  <div className="flex items-start gap-4 sm:gap-5">
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary sm:h-16 sm:w-16">
                      <Sparkles className="h-7 w-7" strokeWidth={1.8} />
                    </div>
                    <div className="pt-1">
                      <h2 className="text-lg font-semibold sm:text-xl">Start with one thought.</h2>
                      <p className="mt-2 text-sm leading-relaxed text-muted-foreground sm:text-base">
                        Ocreda will connect it to what you add next.
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setError('');
                      setAddOpen(true);
                    }}
                    disabled={busy}
                    className="mt-7 flex w-full items-center justify-center rounded-xl bg-primary px-5 py-3.5 text-base font-semibold text-primary-foreground shadow-sm shadow-primary/25 hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-card disabled:opacity-50 transition-all sm:ml-[84px] sm:w-[calc(100%-84px)]"
                  >
                    Add your first note
                  </button>
                </section>

                <div className="mt-auto flex items-center gap-2 pt-12 text-xs text-muted-foreground sm:text-sm">
                  <LockKeyhole className="h-4 w-4" />
                  <span>Private by default. Your notes belong to you.</span>
                </div>
                {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
              </main>
            </div>
          ) : (
            /* ───────────── STATE 2 — existing-user home ───────────── */
            <div className="animate-ocreda-fade-in flex h-full min-h-[calc(100vh-1.5rem)] flex-col bg-card sm:min-h-[calc(100vh-2.5rem)] lg:min-h-0">
              <header className="flex min-h-[76px] shrink-0 flex-wrap items-center gap-3 border-b border-border/60 px-5 py-3 sm:min-h-[84px] sm:px-8">
                <button type="button" onClick={() => { setActive(null); setChat(null); setError(''); }} className="mr-auto flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/ocreda-logo.png" alt="" className="h-9 w-9 object-contain" />
                  <span className="text-xl font-bold tracking-tight sm:text-2xl">Ocreda</span>
                </button>
                <nav className="order-3 flex w-full items-center gap-1 overflow-x-auto sm:order-none sm:w-auto sm:gap-2">
                  <button onClick={() => { setError(''); setAddOpen(true); }} className="inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent transition-colors">
                    <SquarePlus className="h-4 w-4 text-primary" /> Add note
                  </button>
                  <button onClick={() => { setActive(null); setChat(null); setSearchOpen((open) => !open); }} className="inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent transition-colors">
                    <Search className="h-4 w-4" /> Search
                  </button>
                  <button onClick={() => { setActive(null); setChat(null); requestAnimationFrame(() => recentSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })); }} className="inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent transition-colors">
                    <Clock3 className="h-4 w-4" /> Recent
                  </button>
                </nav>
                <div className="ml-auto flex items-center gap-3 sm:gap-6">
                  <span className="hidden rounded-md border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary md:inline-flex">Beta</span>
                  <a href="mailto:feedback@ocreda.com" className="hidden text-sm font-medium text-muted-foreground hover:text-foreground md:inline">Send feedback</a>
                  <AvatarButton embedded />
                </div>
              </header>

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
              <main className="flex-1 overflow-y-auto px-5 py-9 scrollbar-thin sm:px-8 lg:px-12">
                <div className="mx-auto w-full max-w-5xl">
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
                    <div className="rounded-2xl border border-primary/25 bg-background/20 p-4 shadow-sm focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/10">
                      <textarea
                        value={composerValue}
                        onChange={(e) => setComposerValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComposer(); } }}
                        placeholder="What's on your mind?"
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

                  <section className="mt-8 flex items-center gap-5 rounded-2xl border border-border bg-background/20 p-5 shadow-sm">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><Brain className="h-6 w-6" /></div>
                    <div>
                      <p className="font-semibold"><span>{notes.length} {notes.length === 1 ? 'note' : 'notes'}</span><span className="mx-5 text-muted-foreground">•</span><span>{connectionsCount} {connectionsCount === 1 ? 'connection' : 'connections'}</span></p>
                      <p className="mt-1 text-sm text-muted-foreground">Your brain is getting smarter every day.</p>
                    </div>
                  </section>

                  <div className="mt-10 grid gap-8 md:grid-cols-2 md:gap-12">
                    <section>
                      <h2 className="mb-4 text-sm font-semibold sm:text-base">Continue where you left off</h2>
                      {filteredHomeNotes[0] ? (
                        <button type="button" onClick={() => openNotePopup(filteredHomeNotes[0].id)} className="group flex min-h-[150px] w-full items-start gap-4 rounded-2xl border border-border bg-background/20 p-5 text-left transition-colors hover:border-primary/35 hover:bg-accent/30">
                          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><FileText className="h-5 w-5" /></span>
                          <span className="min-w-0 flex-1"><strong className="block truncate text-sm sm:text-base">{noteTitle(filteredHomeNotes[0])}</strong><span className="mt-2 block line-clamp-2 text-sm leading-relaxed text-muted-foreground">{truncate(filteredHomeNotes[0].raw_text, 110)}</span><span className="mt-4 block text-xs text-muted-foreground/70">Edited {relTime(filteredHomeNotes[0].created_at)}</span></span>
                          <ChevronRight className="mt-3 h-5 w-5 text-muted-foreground group-hover:translate-x-0.5 transition-transform" />
                        </button>
                      ) : <p className="rounded-2xl border border-dashed border-border p-6 text-sm text-muted-foreground">No matching notes.</p>}
                    </section>

                    <section ref={recentSectionRef}>
                      <h2 className="mb-4 text-sm font-semibold sm:text-base">Recently added</h2>
                      <div className="overflow-hidden rounded-2xl border border-border bg-background/20">
                        {filteredHomeNotes.slice(0, 2).map((note, index) => (
                          <button key={note.id} type="button" onClick={() => openNotePopup(note.id)} className={`group flex w-full items-center gap-4 p-5 text-left transition-colors hover:bg-accent/30 ${index > 0 ? 'border-t border-border' : ''}`}>
                            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><FileText className="h-5 w-5" /></span>
                            <span className="min-w-0 flex-1"><strong className="block truncate text-sm sm:text-base">{noteTitle(note)}</strong><span className="mt-1 block text-xs text-muted-foreground">{relTime(note.created_at)}</span></span>
                            <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:translate-x-0.5 transition-transform" />
                          </button>
                        ))}
                        {filteredHomeNotes.length === 0 && <p className="p-6 text-sm text-muted-foreground">No matching notes.</p>}
                      </div>
                    </section>
                  </div>

                  <div className="mt-10 text-center">
                    <Link href="/notes" className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground">View all notes <ArrowRight className="h-4 w-4" /></Link>
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
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <main className="min-w-0 flex-1 overflow-y-auto px-5 py-9 scrollbar-thin sm:px-8 lg:px-10">
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

      <aside className="shrink-0 border-t border-border/60 bg-background/15 p-5 lg:w-[340px] lg:overflow-y-auto lg:border-l lg:border-t-0 lg:p-7">
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
