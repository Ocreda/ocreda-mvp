'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { ArrowUp, Trash2, Pencil, Check, X, Plus, Loader as Loader2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { Note, Question, ConversationMessage } from '@/lib/types';
import {
  handleMessage,
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
        <img src="/IMG_2929.png" alt="Ocreda" className="w-6 h-6 object-contain dark:invert" />
        <span className="text-lg font-semibold tracking-tight text-foreground" style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}>
          R
        </span>
      </button>
      <span className="flex-1 h-px bg-border" />
    </div>
  );
}

/* ────────────────────────── avatar (top-right, always) ────────────────────────── */

function AvatarButton() {
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
      className="fixed top-4 right-4 lg:top-6 lg:right-6 z-50 w-10 h-10 rounded-full overflow-hidden ring-1 ring-border bg-card shadow-sm flex items-center justify-center hover:ring-primary/40 transition-all"
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
  const [askValue, setAskValue] = useState('');
  const [composerValue, setComposerValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
    if (!user) return;
    supabase
      .from('user_settings')
      .select('full_name')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => setDisplayName(data?.full_name?.trim() ?? ''));
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
  const runHandleMessage = async (text: string): Promise<boolean> => {
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
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      return false;
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
    const saved = await runHandleMessage(text);
    if (saved) {
      setAddValue('');
      setAddOpen(false);
    }
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

  /* ────────────────── render ────────────────── */

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AvatarButton />

      {addOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-note-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !busy) setAddOpen(false);
          }}
        >
          <button
            type="button"
            aria-label="Close add note dialog"
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => !busy && setAddOpen(false)}
          />
          <div className="animate-ocreda-fade-up relative w-full sm:max-w-md rounded-t-[1.75rem] sm:rounded-[1.75rem] border border-border/80 bg-card p-5 shadow-2xl shadow-black/20">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div className="flex items-center gap-3.5">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-border/70 bg-background/70 shadow-sm">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/IMG_2929.png" alt="" className="h-7 w-7 object-contain dark:invert" />
                </div>
                <div>
                  <h2 id="add-note-title" className="text-lg font-bold tracking-tight text-foreground">Add a note</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">Save a thought, task, or memory.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setAddOpen(false)}
                disabled={busy}
                aria-label="Close"
                className="rounded-lg p-2 text-muted-foreground/60 hover:bg-accent hover:text-foreground disabled:opacity-40 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <textarea
              autoFocus
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submitAdd();
                }
              }}
              placeholder="What would you like to remember?"
              rows={5}
              className="w-full resize-none rounded-2xl border border-border/80 bg-background/50 px-4 py-3.5 text-[15px] leading-relaxed text-foreground shadow-inner shadow-black/[0.03] placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all"
            />

            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

            <div className="mt-4 flex items-center justify-between gap-3">
              <span className="hidden sm:block text-xs text-muted-foreground/50">⌘/Ctrl + Enter to save</span>
              <button
                type="button"
                onClick={submitAdd}
                disabled={!addValue.trim() || busy}
                className="ml-auto inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-primary/20 hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40 transition-all"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {busy ? 'Saving…' : 'Save note'}
              </button>
            </div>
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
            <div className="animate-ocreda-fade-in h-full flex flex-col items-center justify-center px-6 py-16">
              <div className="w-full max-w-xl flex flex-col items-center">
                {displayName && (
                  <div className="mb-7 flex items-center gap-2 rounded-full border border-primary/15 bg-primary/[0.07] px-4 py-2">
                    <span className="h-2 w-2 rounded-full bg-primary shadow-sm shadow-primary/40" />
                    <p className="text-sm text-muted-foreground">
                      Welcome back, <span className="font-semibold text-foreground">{displayName}</span>
                    </p>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setError('');
                    setAddOpen(true);
                  }}
                  disabled={busy}
                  className="mb-14 px-6 py-2 rounded-full bg-primary/10 text-primary text-sm font-semibold hover:bg-primary/15 transition-colors disabled:opacity-50"
                >
                  <Plus className="mr-1.5 inline h-4 w-4" />
                  Add
                </button>

                <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground mb-6">Add a note</h1>

                <textarea
                  value={addValue}
                  onChange={(e) => setAddValue(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
                      e.preventDefault();
                      submitAdd();
                    }
                  }}
                  placeholder="Write anything you want to remember…"
                  rows={3}
                  className="w-full resize-none bg-transparent text-center text-lg text-foreground placeholder:text-muted-foreground/40 focus:outline-none mb-16"
                />

                <div className="w-full mb-16">
                  <LogoDivider />
                </div>

                <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground mb-6">Ask a question</h2>

                <div className="w-full max-w-md">
                  <input
                    value={askValue}
                    onChange={(e) => setAskValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        submitAsk();
                      }
                    }}
                    placeholder="Ask about anything you've saved…"
                    className="w-full rounded-2xl border border-border bg-background/60 px-4 py-4 text-[15px] text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/50 transition-all"
                  />
                </div>

                {error && <p className="mt-6 text-sm text-destructive">{error}</p>}
              </div>
            </div>
          ) : (
            /* ───────────── STATE 2 / 3 — populated workspace ───────────── */
            <div className="h-full flex flex-col lg:flex-row">
              {/* main workspace */}
              <section className="flex-1 min-w-0 flex flex-col lg:h-full px-5 sm:px-8 lg:px-10 pt-14 lg:pt-8 pb-5">
                {displayName && (
                  <div className="mb-5 flex shrink-0 items-center gap-3 pr-12">
                    <div className="h-8 w-1 rounded-full bg-primary" />
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary/75">Your second brain</p>
                      <p className="text-sm text-muted-foreground">
                        Welcome back, <span className="font-semibold text-foreground">{displayName}</span>
                      </p>
                    </div>
                  </div>
                )}
                <div className="flex-1 lg:overflow-y-auto scrollbar-thin -mx-1 px-1">
                  {active?.kind === 'chat' && chat ? (
                    <ChatView
                      key={chat.questionId}
                      chat={chat}
                      noteMap={noteMap}
                      onOpenNote={selectNote}
                    />
                  ) : activeNote ? (
                    <NoteView
                      key={activeNote.id}
                      note={activeNote}
                      relations={relations}
                      editing={editing}
                      editText={editText}
                      savingEdit={savingEdit}
                      onEditText={setEditText}
                      onStartEdit={startEdit}
                      onCancelEdit={() => setEditing(false)}
                      onSaveEdit={saveEdit}
                      onOpenNote={selectNote}
                    />
                  ) : (
                    <div className="h-full flex items-center justify-center text-center animate-ocreda-fade-in">
                      <p className="text-sm text-muted-foreground/60 max-w-xs">
                        Pick a note or a past chat on the right — or write something new below.
                      </p>
                    </div>
                  )}
                </div>

                {/* logo divider + composer, anchored below the knowledge */}
                <div className="shrink-0 pt-6">
                  <div className="mb-5">
                    <LogoDivider onClick={() => { setActive(null); setChat(null); }} title="Compose something new" />
                  </div>
                  <Composer
                    value={composerValue}
                    onChange={setComposerValue}
                    onSubmit={submitComposer}
                    busy={busy}
                    placeholder={composerPlaceholder}
                  />
                  {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
                </div>
              </section>

              {/* right rail — notes + past chats */}
              <aside className="animate-ocreda-slide-in-right border-t lg:border-t-0 lg:border-l border-border/60 bg-background/30 lg:w-[320px] shrink-0 lg:h-full">
                <div className="h-full lg:overflow-y-auto scrollbar-thin p-4 lg:p-5 lg:pt-16">
                  <div className="flex lg:flex-col gap-3 overflow-x-auto lg:overflow-x-visible pb-1 lg:pb-0">
                    {railItems.map((item) => (
                      <RailCard
                        key={`${item.kind}:${item.id}`}
                        item={item}
                        active={active?.kind === item.kind && active.id === item.id}
                        onOpen={() => (item.kind === 'note' ? selectNote(item.id) : selectChat(questions.find((q) => q.id === item.id)!))}
                        onDelete={() => (item.kind === 'note' ? removeNote(item.id) : removeChat(item.id))}
                      />
                    ))}
                  </div>
                </div>
              </aside>
            </div>
          )}
        </div>
      </div>
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
