'use client';

import { useState, useEffect, useCallback } from 'react';
import { Note } from '@/lib/types';
import { getNoteById, getNotes, updateNote, getNoteRelations, deleteNote, createTagRelations } from '@/lib/notes-api';
import { X, Pencil, Check, Tag, Calendar, Link2, Loader as Loader2, Trash2, ArrowRight, ExternalLink, ArrowLeft, ZoomIn } from 'lucide-react';
import ClickableTag from '@/components/ClickableTag';
import ClickableDate from '@/components/ClickableDate';
import TagEditor from '@/components/TagEditor';
import PinButton from '@/components/PinButton';

interface RelatedNote {
  id: string;
  related_note_id: string;
  reason: string;
  related_note: { id: string; title: string };
}

interface NotePopupProps {
  noteId: string;
  onClose: () => void;
  onNoteUpdated?: (note: Note) => void;
  onNoteDeleted?: (noteId: string) => void;
  onTagClick?: (tag: string) => void;
  /** @deprecated Navigation is now handled internally via history stack */
  onRelatedNoteClick?: (noteId: string) => void;
  onViewAllConnected?: (noteId: string) => void;
  onDateClick?: (dateStr: string) => void;
  onOpen?: (noteId: string) => void;
}

export default function NotePopup({ noteId, onClose, onNoteUpdated, onNoteDeleted, onTagClick, onViewAllConnected, onDateClick, onOpen }: NotePopupProps) {
  const [history, setHistory] = useState<string[]>([noteId]);
  const currentId = history[history.length - 1];

  const [note, setNote] = useState<Note | null>(null);
  const [relations, setRelations] = useState<RelatedNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editTags, setEditTags] = useState<string[]>([]);
  const [allExistingTags, setAllExistingTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setEditing(false);
    setError('');
    setLightboxOpen(false);
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
  };

  const goBack = () => {
    setHistory((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  };

  const canGoBack = history.length > 1;

  const startEdit = () => {
    if (!note) return;
    setEditTitle(note.title);
    setEditContent(note.content);
    setEditTags(note.tags ?? []);
    setEditing(true);
    getNotes().then((notes) => {
      const all = Array.from(new Set(notes.flatMap((n) => n.tags ?? []))).sort();
      setAllExistingTags(all);
    }).catch(() => {});
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditTitle('');
    setEditContent('');
    setEditTags([]);
  };

  const saveEdit = async () => {
    if (!note || !editContent.trim()) return;
    setSaving(true);
    try {
      const updated = await updateNote(note.id, editTitle.trim(), editContent.trim(), editTags);
      setNote(updated);
      setEditing(false);
      onNoteUpdated?.(updated);
      const newTags = editTags.filter((t) => !(note.tags ?? []).includes(t));
      if (newTags.length > 0) {
        createTagRelations(note.id, newTags).catch(() => {});
      }
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

  const handleSeeAllConnected = () => {
    if (!note) return;
    onViewAllConnected?.(note.id);
  };

  const visibleRelations = relations.slice(0, 3);
  const hasMore = relations.length > 3;

  return (
    <>
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

            <div className="flex-1 min-w-0 px-2">
              {!editing && note && (
                <h2 className="text-sm font-semibold text-foreground truncate text-center">{note.title}</h2>
              )}
            </div>

            <div className="flex items-center gap-1 flex-shrink-0">
              {!editing && note && onOpen && (
                <button
                  onClick={() => { onClose(); onOpen(note.id); }}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2.5 py-1.5 rounded-lg hover:bg-accent transition-all"
                >
                  <ExternalLink className="w-3 h-3" />
                  Open
                </button>
              )}
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
                <>
                  <PinButton noteId={note.id} />
                  <button
                    onClick={handleDelete}
                    className="p-1.5 rounded-lg text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-all"
                    title="Delete note"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </>
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
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-2">Title</label>
                    <input
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className="w-full px-3.5 py-2.5 text-sm rounded-xl border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-2">Content</label>
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      rows={9}
                      className="w-full px-3.5 py-3 text-sm rounded-xl border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all resize-none"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-2">Tags</label>
                    <TagEditor
                      tags={editTags}
                      allTags={allExistingTags}
                      onChange={setEditTags}
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
                      disabled={saving || !editContent.trim()}
                      className="flex items-center gap-1.5 text-xs text-white bg-primary hover:bg-primary/90 px-3 py-2 rounded-lg transition-all disabled:opacity-60"
                    >
                      {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                      {saving ? 'Saving...' : 'Save Changes'}
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  {/* Image — full width, natural aspect ratio */}
                  {note.image_url && (
                    <div className="relative group/img cursor-zoom-in" onClick={() => setLightboxOpen(true)}>
                      <img
                        src={note.image_url}
                        alt=""
                        className="w-full h-auto object-contain"
                      />
                      <div className="absolute inset-0 bg-black/0 group-hover/img:bg-black/20 transition-colors flex items-center justify-center">
                        <ZoomIn className="w-6 h-6 text-white opacity-0 group-hover/img:opacity-100 transition-opacity drop-shadow-lg" />
                      </div>
                    </div>
                  )}

                  {/* Content */}
                  <div className="px-6 pt-7 pb-6">
                    <p className="text-[15px] leading-[1.75] text-foreground whitespace-pre-wrap font-[450]">{note.content}</p>
                  </div>

                  {/* AI image description */}
                  {note.image_description && (
                    <>
                      <div className="border-t border-border mx-6" />
                      <div className="px-6 py-4">
                        <p className="text-xs font-semibold text-muted-foreground/50 uppercase tracking-wider mb-2">Image description</p>
                        <p className="text-sm text-muted-foreground/70 leading-relaxed italic">{note.image_description}</p>
                      </div>
                    </>
                  )}

                  <div className="border-t border-border mx-6" />

                  {/* Tags */}
                  {note.tags && note.tags.length > 0 && (
                    <div className="px-6 py-5">
                      <div className="flex items-center gap-2 mb-3">
                        <Tag className="w-3.5 h-3.5 text-muted-foreground/60" />
                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Tags</span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {note.tags.map((tag) => (
                          <ClickableTag key={tag} tag={tag} />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Date */}
                  <div className="px-6 pb-5 flex items-center gap-2 text-xs text-muted-foreground/60">
                    <Calendar className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="text-muted-foreground/50">Created</span>
                    <ClickableDate
                      dateStr={note.created_at}
                      formatStr="MMM d, yyyy · h:mm a"
                      onClick={onDateClick ?? (() => {})}
                    />
                  </div>

                  {/* Connected notes */}
                  {relations.length > 0 && (
                    <>
                      <div className="border-t border-border mx-6" />
                      <div className="px-6 py-5">
                        <div className="flex items-center gap-2 mb-4">
                          <Link2 className="w-3.5 h-3.5 text-muted-foreground/60" />
                          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Connected Notes</span>
                        </div>
                        <div className="space-y-2.5">
                          {visibleRelations.map((rel) => (
                            <button
                              key={rel.id}
                              onClick={() => navigateTo(rel.related_note?.id)}
                              className="w-full text-left px-4 py-3.5 rounded-xl bg-muted/40 border border-border hover:border-primary/30 hover:bg-accent/60 transition-all group"
                            >
                              <p className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors leading-snug">
                                {rel.related_note?.title}
                              </p>
                              {rel.reason && (
                                <p className="text-xs text-muted-foreground/70 mt-1.5 line-clamp-2 leading-relaxed">{rel.reason}</p>
                              )}
                            </button>
                          ))}
                        </div>
                        {hasMore && (
                          <button
                            onClick={handleSeeAllConnected}
                            className="mt-3.5 flex items-center gap-1.5 text-xs text-muted-foreground/60 hover:text-primary transition-colors"
                          >
                            see all {relations.length} connected notes
                            <ArrowRight className="w-3 h-3" />
                          </button>
                        )}
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

      {/* Lightbox */}
      {lightboxOpen && note?.image_url && (
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
            src={note.image_url}
            alt=""
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
