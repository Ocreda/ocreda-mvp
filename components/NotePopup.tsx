'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader as Loader2, Maximize2, MessageSquare, MoreHorizontal, Plus, Search, Trash2, X } from 'lucide-react';
import { format } from 'date-fns';
import { Note } from '@/lib/types';
import { applyConnectionFeedback, createNote, deleteNote, getNoteById, getNoteRelations, processNote, updateNote } from '@/lib/notes-api';

type Relation = Awaited<ReturnType<typeof getNoteRelations>>[number];

export default function NotePopup({
  noteId,
  hideConnections = false,
  onClose,
  onNoteUpdated,
  onNoteDeleted,
  onRelatedNoteClick,
}: {
  noteId: string;
  hideConnections?: boolean;
  onClose: () => void;
  onNoteUpdated?: (note: Note) => void;
  onNoteDeleted?: (id: string) => void;
  onRelatedNoteClick?: (id: string) => void;
}) {
  const [note, setNote] = useState<Note | null>(null);
  const [relations, setRelations] = useState<Relation[]>([]);
  const [loading, setLoading] = useState(true);
  const [fullView, setFullView] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addTitle, setAddTitle] = useState('');
  const [addBody, setAddBody] = useState('');
  const [adding, setAdding] = useState(false);
  const [reviewedRelationIds, setReviewedRelationIds] = useState<string[]>([]);
  const [reviewingRelation, setReviewingRelation] = useState(false);
  const [showAllRelations, setShowAllRelations] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setEditing(false);
    setReviewedRelationIds([]);
    setShowAllRelations(false);
    try {
      const [nextNote, nextRelations] = await Promise.all([getNoteById(noteId), getNoteRelations(noteId)]);
      setNote(nextNote);
      setEditText(nextNote.raw_text);
      setRelations(hideConnections ? [] : nextRelations);
    } finally {
      setLoading(false);
    }
  }, [hideConnections, noteId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (addOpen) setAddOpen(false);
      else if (moreOpen) setMoreOpen(false);
      else if (chatOpen) setChatOpen(false);
      else if (editing) { setEditing(false); setEditText(note?.raw_text ?? ''); }
      else onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [addOpen, chatOpen, editing, moreOpen, note?.raw_text, onClose]);

  const save = async () => {
    if (!note || !editText.trim()) return;
    if (editText.trim() === note.raw_text.trim()) { setEditing(false); return; }
    setSaving(true);
    try {
      const updated = await updateNote(note.id, editText.trim());
      setNote(updated);
      setEditing(false);
      onNoteUpdated?.(updated);
      window.dispatchEvent(new CustomEvent('note-updated', { detail: { note: updated } }));
      await processNote(updated.id).catch(() => ({ relations_count: 0 }));
      const nextRelations = await getNoteRelations(updated.id).catch(() => []);
      setRelations(hideConnections ? [] : nextRelations);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!note || !window.confirm('Delete this note?')) return;
    await deleteNote(note.id);
    onNoteDeleted?.(note.id);
    onClose();
  };

  const useInChat = () => {
    if (!note) return;
    window.dispatchEvent(new CustomEvent('use-note-in-chat', { detail: { note } }));
    onClose();
  };

  const openPastChats = () => {
    window.dispatchEvent(new Event('open-chat-history'));
    onClose();
  };

  const saveAddedNote = async () => {
    const title = addTitle.trim();
    const body = addBody.trim();
    if (!title || adding) return;
    setAdding(true);
    try {
      const created = await createNote(body ? `${title}\n\n${body}` : title);
      processNote(created.id).catch(() => {});
      window.dispatchEvent(new CustomEvent('note-created', { detail: { note: created } }));
      setAddTitle('');
      setAddBody('');
      setAddOpen(false);
    } finally {
      setAdding(false);
    }
  };

  const reviewConnection = async (relation: Relation, accepted: boolean) => {
    if (!note || reviewingRelation) return;
    setReviewingRelation(true);
    try {
      await applyConnectionFeedback(note.id, relation.related_note_id, accepted);
      setReviewedRelationIds((ids) => ids.includes(relation.id) ? ids : [...ids, relation.id]);
    } finally {
      setReviewingRelation(false);
    }
  };

  const suggestedRelation = relations.find((relation) => !reviewedRelationIds.includes(relation.id));
  const relatedRelations = relations.filter((relation) => relation.id !== suggestedRelation?.id);
  const relatedLimit = suggestedRelation ? 4 : 5;
  const visibleRelations = showAllRelations ? relatedRelations : relatedRelations.slice(0, relatedLimit);
  const hasMoreRelations = relatedRelations.length > relatedLimit;

  const shellClass = fullView
    ? 'fixed inset-0 z-50 bg-card'
    : 'fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-3 backdrop-blur-sm sm:p-8';
  const panelClass = fullView
    ? 'relative flex h-full w-full flex-col overflow-hidden bg-card'
    : 'relative flex h-[82vh] w-full max-w-[1180px] flex-col overflow-hidden rounded-2xl bg-card shadow-2xl';

  return (
    <div
      className={shellClass}
      role="dialog"
      aria-modal="true"
      aria-label={fullView ? 'Full note view' : 'Note overlay'}
      onMouseDown={(event) => { if (!fullView && event.target === event.currentTarget) onClose(); }}
    >
      <div className={panelClass}>
        <header className="flex h-16 shrink-0 items-center border-b border-border/40 px-5 sm:px-7">
          <div className="flex items-center gap-4 text-muted-foreground">
            <button type="button" aria-label="Add note" onClick={() => { setAddOpen(true); requestAnimationFrame(() => titleRef.current?.focus()); }} className="rounded-md bg-primary p-1.5 text-white"><Plus className="h-5 w-5" /></button>
            <MessageSquare className="h-5 w-5" />
            <Search className="h-5 w-5" />
          </div>
          {fullView && <button type="button" onClick={onClose} aria-label="Close full note" className="absolute left-1/2 -translate-x-1/2 rounded-lg p-2 text-muted-foreground hover:bg-accent"><X className="h-5 w-5" /></button>}
          <div className="ml-auto flex items-center gap-4">
            {!fullView && <button type="button" onClick={() => setFullView(true)} aria-label="Open full note view" title="Open full note view" className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"><Maximize2 className="h-5 w-5" /></button>}
            <div className="relative">
              <button type="button" onClick={() => { setChatOpen((open) => !open); setMoreOpen(false); }} className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"><MessageSquare className="h-4 w-4" /> See in chat</button>
              {chatOpen && <div className="absolute right-0 top-8 z-20 w-48 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-xl"><button type="button" onClick={openPastChats} className="block w-full px-4 py-2 text-left text-sm hover:bg-accent">See past chats</button><button type="button" onClick={useInChat} className="block w-full px-4 py-2 text-left text-sm hover:bg-accent">Use this note in chat</button></div>}
            </div>
            <div className="relative">
              <button type="button" onClick={() => { setMoreOpen((open) => !open); setChatOpen(false); }} aria-label="More note options" className="rounded-md p-2 text-muted-foreground hover:bg-accent"><MoreHorizontal className="h-5 w-5" /></button>
              {moreOpen && <div className="absolute right-0 top-10 z-20 w-36 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-xl"><button type="button" onClick={remove} className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10"><Trash2 className="h-4 w-4" /> Delete</button></div>}
            </div>
          </div>
        </header>

        {loading ? <div className="flex flex-1 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div> : note && (
          <div className="flex min-h-0 flex-1">
            <main className="relative min-w-0 flex-1 overflow-y-auto px-7 pb-20 pt-12 sm:px-14 lg:px-24">
              <div className="mx-auto max-w-3xl">
                {editing ? <><textarea autoFocus value={editText} onChange={(event) => setEditText(event.target.value)} rows={fullView ? 22 : 15} className="w-full resize-none rounded-xl border border-primary/30 bg-background/30 p-5 text-[15px] leading-[1.8] focus:border-primary focus:outline-none" /><div className="mt-3 flex justify-end gap-2"><button type="button" onClick={() => { setEditing(false); setEditText(note.raw_text); }} className="px-4 py-2 text-sm">Cancel</button><button type="button" onClick={save} disabled={saving} className="rounded bg-primary px-4 py-2 text-sm text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button></div></> : <article role="button" tabIndex={0} aria-label="Edit note content" onClick={() => setEditing(true)} onKeyDown={(event) => { if (event.key === 'Enter') setEditing(true); }} className="min-h-[300px] cursor-text rounded-xl px-2 py-2 outline-none hover:bg-muted/20 focus:bg-muted/20"><h1 className="text-2xl font-bold">{note.summary || note.raw_text.split('\n')[0]}</h1><p className="mt-7 whitespace-pre-wrap text-[15px] font-medium leading-[1.8]">{note.raw_text}</p></article>}
              </div>
              <div className="absolute bottom-5 right-6 flex gap-5 text-xs text-muted-foreground sm:right-10"><span>Category: Personal knowledge</span><span>{format(new Date(note.created_at), 'MM/dd/yyyy')}</span><span>{relations.length} Connection{relations.length === 1 ? '' : 's'}</span></div>
            </main>

            <aside className="hidden w-[390px] shrink-0 overflow-y-auto border-l border-border bg-muted/20 p-4 lg:block">
              {relations.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                  <p className="max-w-[220px] text-sm leading-relaxed">This note doesn&apos;t have any connections yet.</p>
                  <div className="mt-5 flex gap-2">
                    <button type="button" onClick={() => setAddOpen(true)} className="rounded bg-primary px-4 py-2 text-xs text-white">Add a note</button>
                    <button type="button" onClick={useInChat} className="rounded bg-foreground px-4 py-2 text-xs text-background">Use this note in chat</button>
                  </div>
                </div>
              ) : (
                <>
                  {suggestedRelation && (
                    <section className="mb-5">
                      <h2 className="mb-3 text-center text-sm font-medium text-primary">Found a connection</h2>
                      <div className="overflow-hidden rounded-xl border border-primary/50 bg-primary/10 shadow-sm">
                        <button type="button" onClick={() => onRelatedNoteClick?.(suggestedRelation.related_note_id)} className="block w-full bg-card p-4 text-left hover:bg-accent/30">
                          <h3 className="font-bold">{suggestedRelation.related_note?.summary || suggestedRelation.related_note?.raw_text.split('\n')[0]}</h3>
                          <p className="mt-2 line-clamp-4 text-sm leading-relaxed text-muted-foreground">{suggestedRelation.related_note?.raw_text}</p>
                        </button>
                        <div className="px-4 py-4 text-xs">
                          <p className="italic leading-relaxed text-primary">
                            <strong>Reason:</strong> {suggestedRelation.reason || 'These notes are repeatedly used together.'}
                          </p>
                          <div className="mt-4 flex items-center justify-center gap-5 border-t border-primary/15 pt-4">
                            <button type="button" disabled={reviewingRelation} onClick={() => reviewConnection(suggestedRelation, true)} className="inline-flex items-center gap-2 font-medium text-primary disabled:opacity-50">Accept <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-white"><Check className="h-4 w-4" /></span></button>
                            <button type="button" disabled={reviewingRelation} onClick={() => reviewConnection(suggestedRelation, false)} className="inline-flex items-center gap-2 font-medium text-foreground disabled:opacity-50"><span className="flex h-7 w-7 items-center justify-center rounded-full border border-foreground"><X className="h-4 w-4" /></span> Reject</button>
                          </div>
                        </div>
                      </div>
                    </section>
                  )}

                  <div className="mb-4 flex justify-between">
                    <h2 className="text-sm text-muted-foreground">Related notes</h2>
                    <button type="button" onClick={() => setAddOpen(true)} className="text-xs underline">Add more</button>
                  </div>
                  <div className="space-y-4">
                    {visibleRelations.map((relation) => (
                      <button key={relation.id} onClick={() => onRelatedNoteClick?.(relation.related_note_id)} className="w-full rounded-xl border border-border bg-card p-4 text-left shadow-sm hover:border-primary/40">
                        <div className="flex gap-3">
                          <div className="min-w-0 flex-1">
                            <h3 className="font-bold">{relation.related_note?.summary || relation.related_note?.raw_text.split('\n')[0]}</h3>
                            <p className="mt-2 line-clamp-4 text-sm leading-relaxed text-muted-foreground">{relation.related_note?.raw_text}</p>
                          </div>
                          <span className="mt-1 h-2 w-2 rounded-full bg-foreground" />
                        </div>
                        <p className="mt-4 border-t border-border pt-3 text-xs italic text-muted-foreground">
                          <strong className="text-foreground">Connection:</strong> {relation.reason || 'These notes are repeatedly used together.'}
                        </p>
                      </button>
                    ))}
                  </div>
                  {hasMoreRelations && (
                    <button type="button" onClick={() => setShowAllRelations((show) => !show)} className="mt-5 w-full text-center text-sm font-medium text-primary underline underline-offset-4">
                      {showAllRelations ? 'Show less' : 'Show all'}
                    </button>
                  )}
                </>
              )}
            </aside>
          </div>
        )}
      </div>

      {addOpen && <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget && !adding) setAddOpen(false); }}><section className="flex h-[min(640px,88vh)] w-full max-w-[1050px] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl" role="dialog" aria-modal="true" aria-label="Add a note"><div className="flex min-h-0 flex-1 flex-col px-8 pb-6 pt-10 sm:px-14"><input ref={titleRef} value={addTitle} onChange={(event) => setAddTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); document.getElementById('nested-note-body')?.focus(); } }} placeholder="What's on your mind?" className="bg-transparent text-2xl font-medium italic outline-none placeholder:text-foreground" /><textarea id="nested-note-body" value={addBody} onChange={(event) => setAddBody(event.target.value)} placeholder="For example: Someone made the point that we mostly don't choose our beliefs, we absorb them and backfill reasons after." className="mt-8 min-h-0 flex-1 resize-none bg-transparent text-sm leading-relaxed outline-none placeholder:text-muted-foreground/40" /></div><footer className="flex shrink-0 justify-end border-t border-border bg-muted/20 px-5 py-3"><button type="button" onClick={() => setAddOpen(false)} disabled={adding} className="px-5 py-2 text-sm">Cancel</button><button type="button" onClick={saveAddedNote} disabled={!addTitle.trim() || adding} className="min-w-[126px] rounded-md bg-primary px-6 py-2 text-sm text-white disabled:opacity-40">{adding ? 'Saving…' : 'Save'}</button></footer></section></div>}
    </div>
  );
}
