'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader as Loader2, MessageSquare, Plus, Search, Trash2, X } from 'lucide-react';
import { format } from 'date-fns';
import { Note } from '@/lib/types';
import { deleteNote, getNoteById, getNoteRelations, updateNote } from '@/lib/notes-api';

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
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setEditing(false);
    try {
      const [nextNote, nextRelations] = await Promise.all([getNoteById(noteId), getNoteRelations(noteId)]);
      setNote(nextNote);
      setRelations(hideConnections ? [] : nextRelations);
    } finally {
      setLoading(false);
    }
  }, [hideConnections, noteId]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!note || !editText.trim()) return;
    setSaving(true);
    try {
      const updated = await updateNote(note.id, editText.trim());
      setNote(updated);
      setEditing(false);
      onNoteUpdated?.(updated);
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

  return (
    <div className="fixed inset-0 z-50 bg-black/30 p-3 backdrop-blur-sm sm:p-6" role="dialog" aria-modal="true" aria-label="Full note view">
      <div className="relative mx-auto flex h-full w-full max-w-[1500px] flex-col overflow-hidden bg-card shadow-2xl">
        <header className="flex h-16 shrink-0 items-center px-5 sm:px-7">
          <div className="flex items-center gap-4 text-muted-foreground">
            <button type="button" aria-label="Add note" onClick={() => { window.dispatchEvent(new Event('open-add-note')); onClose(); }} className="rounded-md bg-primary p-1.5 text-white"><Plus className="h-5 w-5" /></button>
            <MessageSquare className="h-5 w-5" />
            <Search className="h-5 w-5" />
          </div>
          <button type="button" onClick={onClose} aria-label="Close full note" className="absolute left-1/2 -translate-x-1/2 rounded-lg p-2 text-muted-foreground hover:bg-accent"><X className="h-5 w-5" /></button>
          <div className="ml-auto flex items-center gap-4">
            <button type="button" onClick={useInChat} className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"><MessageSquare className="h-4 w-4" /> See in chat</button>
            <button type="button" className="text-xl leading-none text-muted-foreground">•••</button>
          </div>
        </header>

        {loading ? (
          <div className="flex flex-1 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : note && (
          <div className="flex min-h-0 flex-1">
            <main className="relative min-w-0 flex-1 overflow-y-auto px-7 pb-20 pt-16 sm:px-14 lg:px-24">
              {editing ? (
                <div className="mx-auto max-w-3xl">
                  <textarea value={editText} onChange={(event) => setEditText(event.target.value)} rows={18} className="w-full resize-none rounded-xl border border-border bg-background p-4 focus:outline-none" />
                  <div className="mt-3 flex justify-end gap-2"><button onClick={() => setEditing(false)} className="px-4 py-2 text-sm">Cancel</button><button onClick={save} className="rounded bg-primary px-4 py-2 text-sm text-white">{saving ? 'Saving…' : 'Save'}</button></div>
                </div>
              ) : (
                <article className="mx-auto max-w-3xl">
                  <h1 className="text-2xl font-bold">{note.summary || note.raw_text.split('\n')[0]}</h1>
                  <p className="mt-7 whitespace-pre-wrap text-[15px] font-medium leading-[1.8]">{note.raw_text}</p>
                </article>
              )}
              <div className="absolute bottom-5 right-6 flex gap-5 text-xs text-muted-foreground sm:right-10">
                <span>Category: Personal knowledge</span><span>{format(new Date(note.created_at), 'MM/dd/yyyy')}</span><span>{relations.length} Connection{relations.length === 1 ? '' : 's'}</span>
              </div>
            </main>

            <aside className="hidden w-[390px] shrink-0 overflow-y-auto border-l border-border bg-muted/20 p-4 lg:block">
              {relations.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                  <p className="max-w-[220px] text-sm leading-relaxed">This note doesn&apos;t have any connections yet.</p>
                  <div className="mt-5 flex gap-2">
                    <button type="button" onClick={() => { window.dispatchEvent(new Event('open-add-note')); onClose(); }} className="rounded bg-primary px-4 py-2 text-xs text-white">Add a note</button>
                    <button type="button" onClick={useInChat} className="rounded bg-foreground px-4 py-2 text-xs text-background">Use this note in chat</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mb-4 flex justify-between"><h2 className="text-sm text-primary">Related notes</h2><button className="text-xs underline">Add more</button></div>
                  <div className="space-y-4">{relations.map((relation) => (
                    <button key={relation.id} onClick={() => onRelatedNoteClick?.(relation.related_note_id)} className="w-full rounded-xl border border-border bg-card p-4 text-left shadow-sm hover:border-primary/40">
                      <div className="flex gap-3"><div className="min-w-0 flex-1"><h3 className="font-bold">{relation.related_note?.summary || relation.related_note?.raw_text.split('\n')[0]}</h3><p className="mt-2 line-clamp-4 text-sm leading-relaxed text-muted-foreground">{relation.related_note?.raw_text}</p></div><span className={`mt-1 h-2 w-2 rounded-full ${((relation.confidence ?? 1) * (relation.weight ?? 1)) >= 1 ? 'bg-foreground' : 'bg-muted-foreground/40'}`} /></div>
                      {relation.reason && <p className="mt-4 border-t border-border pt-3 text-xs italic text-muted-foreground"><strong className="text-foreground">Connection:</strong> {relation.reason}</p>}
                    </button>
                  ))}</div>
                </>
              )}
            </aside>
          </div>
        )}

        {note && !editing && <div className="absolute bottom-5 left-6 flex gap-2"><button onClick={() => { setEditText(note.raw_text); setEditing(true); }} className="rounded px-3 py-2 text-xs text-muted-foreground hover:bg-accent">Edit</button><button onClick={remove} className="rounded p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 className="h-4 w-4" /></button></div>}
      </div>
    </div>
  );
}
