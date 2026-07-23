'use client';

import { useState, useEffect, useCallback } from 'react';
import { Note } from '@/lib/types';
import { getNoteById, updateNote, getNoteRelations, deleteNote } from '@/lib/notes-api';
import { X, Pencil, Check, Calendar, Link2, Loader as Loader2, Trash2, ArrowLeft, Clock } from 'lucide-react';
import { format } from 'date-fns';

interface RelatedNote {
  id: string;
  related_note_id: string;
  reason: string | null;
  related_note: { id: string; summary: string | null; raw_text: string };
}

interface NotePopupProps {
  noteId: string;
  onClose: () => void;
  onNoteUpdated?: (note: Note) => void;
  onNoteDeleted?: (noteId: string) => void;
  onRelatedNoteClick?: (noteId: string) => void;
}

export default function NotePopup({ noteId, onClose, onNoteUpdated, onNoteDeleted, onRelatedNoteClick }: NotePopupProps) {
  const [history, setHistory] = useState<string[]>([noteId]);
  const currentId = history[history.length - 1];

  const [note, setNote] = useState<Note | null>(null);
  const [relations, setRelations] = useState<RelatedNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setEditing(false);
    setError('');
    try {
      const [n, rels] = await Promise.all([getNoteById(currentId), getNoteRelations(currentId)]);
      setNote(n);
      setRelations(rels);
    } catch {
      setError('Failed to load note');
    } finally {
      setLoading(false);
    }
  }, [currentId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    setHistory([noteId]);
  }, [noteId]);

  const navigateTo = (id: string) => {
    setHistory((prev) => [...prev, id]);
    onRelatedNoteClick?.(id);
  };

  const goBack = () => {
    setHistory((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  };

  const canGoBack = history.length > 1;

  const startEdit = () => {
    if (!note) return;
    setEditText(note.raw_text);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditText('');
  };

  const saveEdit = async () => {
    if (!note || !editText.trim()) return;
    setSaving(true);
    try {
      const updated = await updateNote(note.id, editText.trim());
      setNote(updated);
      setEditing(false);
      onNoteUpdated?.(updated);
    } catch {
      setError('Failed to save note');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!note) return;
    if (!window.confirm('Delete this note?')) return;
    try {
      await deleteNote(note.id);
      onNoteDeleted?.(note.id);
      onClose();
    } catch {
      setError('Failed to delete note');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card sm:rounded-2xl rounded-t-2xl shadow-2xl w-full sm:max-w-xl h-[92dvh] sm:h-auto sm:max-h-[88vh] flex flex-col overflow-hidden border border-border">

        {/* Header bar */}
        <div className="flex items-center justify-between px-4 py-4 border-b border-border flex-shrink-0">
          <div className="w-8 flex-shrink-0">
            {canGoBack && (
              <button
                onClick={goBack}
                className="p-1.5 rounded-lg text-muted-foreground/50 hover:text-foreground hover:bg-accent transition-all"
                title="Back"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="flex-1" />

          <div className="flex items-center gap-1 flex-shrink-0">
            {!editing && (
              <button
                onClick={startEdit}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2.5 py-1.5 rounded-lg hover:bg-accent transition-all"
              >
                <Pencil className="w-3 h-3" />
                Edit
              </button>
            )}
            {!editing && note && (
              <button
                onClick={handleDelete}
                className="p-1.5 rounded-lg text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-all"
                title="Delete note"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
            </div>
          ) : error ? (
            <div className="px-6 py-8 text-sm text-destructive">{error}</div>
          ) : note ? (
            editing ? (
              <div className="px-6 py-6 space-y-4">
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-2">Note</label>
                  <textarea
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    rows={9}
                    className="w-full px-3.5 py-3 text-sm rounded-xl border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all resize-none"
                  />
                </div>
                <div className="flex items-center gap-2 justify-end pt-1">
                  <button
                    onClick={cancelEdit}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-3 py-2 rounded-lg border border-border hover:bg-accent transition-all"
                  >
                    <X className="w-3 h-3" />
                    Cancel
                  </button>
                  <button
                    onClick={saveEdit}
                    disabled={saving || !editText.trim()}
                    className="flex items-center gap-1.5 text-xs text-white bg-primary hover:bg-primary/90 px-3 py-2 rounded-lg transition-all disabled:opacity-60"
                  >
                    {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                    {saving ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <div className="px-6 pt-7 pb-6">
                  <p className="text-[15px] leading-[1.75] text-foreground whitespace-pre-wrap font-[450]">{note.raw_text}</p>
                </div>

                {note.target_date && (
                  <>
                    <div className="border-t border-border mx-6" />
                    <div className="px-6 py-4 flex items-center gap-2 text-xs text-muted-foreground/70">
                      <Clock className="w-3.5 h-3.5 flex-shrink-0" />
                      <span>{format(new Date(note.target_date), 'MMM d, yyyy')}{note.time_of_day ? ` · ${note.time_of_day}` : ''}</span>
                    </div>
                  </>
                )}

                <div className="border-t border-border mx-6" />

                <div className="px-6 py-5 flex items-center gap-2 text-xs text-muted-foreground/60">
                  <Calendar className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="text-muted-foreground/50">Created</span>
                  <span>{format(new Date(note.created_at), 'MMM d, yyyy · h:mm a')}</span>
                </div>

                {relations.length > 0 && (
                  <>
                    <div className="border-t border-border mx-6" />
                    <div className="px-6 py-5">
                      <div className="flex items-center gap-2 mb-4">
                        <Link2 className="w-3.5 h-3.5 text-muted-foreground/60" />
                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                          Connects to {relations.length} other note{relations.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <div className="space-y-2.5">
                        {relations.map((rel) => (
                          <button
                            key={rel.id}
                            onClick={() => navigateTo(rel.related_note_id)}
                            className="w-full text-left px-4 py-3.5 rounded-xl bg-muted/40 border border-border hover:border-primary/30 hover:bg-accent/60 transition-all group"
                          >
                            <p className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors leading-snug">
                              {rel.related_note?.summary || rel.related_note?.raw_text}
                            </p>
                            {rel.reason && (
                              <p className="text-xs text-muted-foreground/70 mt-1.5 line-clamp-2 leading-relaxed">{rel.reason}</p>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}

                <div className="h-4" />
              </div>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}
