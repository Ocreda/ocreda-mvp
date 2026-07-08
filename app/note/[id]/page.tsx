'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Navigation from '@/components/Navigation';
import SidebarMain from '@/components/SidebarMain';
import { Note } from '@/lib/types';
import { getNoteById, getNotes, updateNote, deleteNote, getNoteRelationsFull, reinforceMemoryStrength, createTagRelations } from '@/lib/notes-api';
import {
  ArrowLeft,
  Pencil,
  Trash2,
  Check,
  X,
  Tag,
  Calendar,
  Link2,
  Loader as Loader2,
  ZoomIn,
} from 'lucide-react';
import ClickableTag from '@/components/ClickableTag';
import ClickableDate from '@/components/ClickableDate';
import DateNotesModal from '@/components/DateNotesModal';
import TagEditor from '@/components/TagEditor';
import PinButton from '@/components/PinButton';

interface FullRelation {
  id: string;
  related_note_id: string;
  reason: string;
  related_note: { id: string; title: string; content: string; tags: string[] };
}

export default function NoteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [note, setNote] = useState<Note | null>(null);
  const [relations, setRelations] = useState<FullRelation[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editTags, setEditTags] = useState<string[]>([]);
  const [allExistingTags, setAllExistingTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [dateFilter, setDateFilter] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [n, rels] = await Promise.all([getNoteById(id), getNoteRelationsFull(id)]);
      setNote(n);
      setRelations(rels);
      reinforceMemoryStrength(id).catch(() => {});
    } catch {
      setError('Failed to load note');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const startEdit = () => {
    if (!note) return;
    setEditTitle(note.title || '');
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
      const newTags = editTags.filter((t) => !(note.tags ?? []).includes(t));
      if (newTags.length > 0) {
        createTagRelations(note.id, newTags).catch(() => {});
      }
    } catch {
      setError('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!note) return;
    if (!window.confirm('Delete this note?')) return;
    try {
      await deleteNote(note.id);
      router.back();
    } catch {
      setError('Failed to delete');
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <SidebarMain>
        <div className="max-w-2xl mx-auto px-4 sm:px-6 pt-4 sm:pt-10 pb-24">

          {/* Top nav row */}
          <div className="flex items-center justify-between mb-8">
            <button
              onClick={() => router.back()}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors group"
            >
              <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
              Back
            </button>

            <div className="flex items-center gap-1">
                {!editing && note && (
                <>
                  <PinButton noteId={note.id} />
                  <button
                    onClick={startEdit}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2.5 py-1.5 rounded-lg hover:bg-accent transition-all"
                  >
                    <Pencil className="w-3 h-3" />
                    Edit
                  </button>
                  <button
                    onClick={handleDelete}
                    className="p-1.5 rounded-lg text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-all"
                    title="Delete note"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-24">
              <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
            </div>
          ) : error ? (
            <p className="text-sm text-destructive py-8">{error}</p>
          ) : note ? (
            editing ? (
              /* ── Edit mode ── */
              <div className="space-y-5">
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-2">Title</label>
                  <input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Note title"
                    className="w-full px-4 py-3 text-base rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-2">Content</label>
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    rows={12}
                    className="w-full px-4 py-3 text-sm rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all resize-none leading-relaxed"
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
                <div className="flex items-center gap-2 justify-end">
                  <button
                    onClick={cancelEdit}
                    className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground px-4 py-2 rounded-xl border border-border hover:bg-accent transition-all"
                  >
                    <X className="w-3.5 h-3.5" />
                    Cancel
                  </button>
                  <button
                    onClick={saveEdit}
                    disabled={saving || !editContent.trim()}
                    className="flex items-center gap-1.5 text-sm text-white bg-primary hover:bg-primary/90 px-4 py-2 rounded-xl transition-all disabled:opacity-60"
                  >
                    {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    {saving ? 'Saving…' : 'Save Changes'}
                  </button>
                </div>
              </div>
            ) : (
              /* ── View mode ── */
              <article>
                {/* Image — full width, natural height */}
                {note.image_url && (
                  <div
                    className="relative group/img cursor-zoom-in mb-8 -mx-4 sm:-mx-6 rounded-xl overflow-hidden"
                    onClick={() => setLightboxOpen(true)}
                  >
                    <img
                      src={note.image_url}
                      alt=""
                      className="w-full h-auto object-contain"
                    />
                    <div className="absolute inset-0 bg-black/0 group-hover/img:bg-black/20 transition-colors flex items-center justify-center">
                      <ZoomIn className="w-7 h-7 text-white opacity-0 group-hover/img:opacity-100 transition-opacity drop-shadow-lg" />
                    </div>
                  </div>
                )}

                {/* Title */}
                {note.title && (
                  <h1 className="text-2xl sm:text-3xl font-bold text-foreground leading-tight mb-8">
                    {note.title}
                  </h1>
                )}

                {/* Content */}
                {note.content && (
                  <div className="bg-card border border-border rounded-2xl px-6 py-7 mb-6 shadow-sm">
                    <p className="text-[15px] sm:text-base leading-[1.85] text-foreground whitespace-pre-wrap font-[450]">
                      {note.content}
                    </p>
                  </div>
                )}

                {/* AI image description */}
                {note.image_description && (
                  <div className="bg-muted/40 border border-border rounded-2xl px-6 py-5 mb-10">
                    <p className="text-xs font-semibold text-muted-foreground/50 uppercase tracking-wider mb-2">Image description</p>
                    <p className="text-sm text-muted-foreground/70 leading-relaxed italic">{note.image_description}</p>
                  </div>
                )}

                {/* Spacing when no description or content box above divider */}
                {!note.image_description && note.content && <div className="mb-4" />}

                {/* Divider */}
                <div className="border-t border-border mb-8" />

                {/* Tags */}
                {note.tags && note.tags.length > 0 && (
                  <div className="mb-8">
                    <div className="flex items-center gap-2 mb-3">
                      <Tag className="w-3.5 h-3.5 text-muted-foreground/50" />
                      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Tags</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {note.tags.map((tag) => (
                        <ClickableTag key={tag} tag={tag} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Dates */}
                <div className="flex items-center gap-2 text-xs text-muted-foreground/50 mb-10">
                  <Calendar className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>Created</span>
                  <ClickableDate
                    dateStr={note.created_at}
                    formatStr="MMMM d, yyyy · h:mm a"
                    onClick={setDateFilter}
                  />
                </div>

                {/* Connected notes */}
                {relations.length > 0 && (
                  <>
                    <div className="border-t border-border mb-8" />
                    <div>
                      <div className="flex items-center gap-2 mb-5">
                        <Link2 className="w-3.5 h-3.5 text-muted-foreground/50" />
                        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                          Connected Notes
                          <span className="ml-2 text-muted-foreground/40 font-normal normal-case tracking-normal">
                            {relations.length}
                          </span>
                        </h2>
                      </div>
                      <div className="space-y-3">
                        {relations.map((rel) => (
                          <button
                            key={rel.id}
                            onClick={() => router.push(`/note/${rel.related_note.id}`)}
                            className="w-full text-left bg-card border border-border rounded-xl px-5 py-4 hover:border-primary/30 hover:shadow-sm hover:shadow-primary/5 transition-all duration-200 group"
                          >
                            <p className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors leading-snug mb-1.5">
                              {rel.related_note.title || rel.related_note.content.slice(0, 60)}
                            </p>
                            <p className="text-xs text-muted-foreground/70 line-clamp-2 leading-relaxed mb-2">
                              {rel.related_note.content}
                            </p>
                            {rel.reason && (
                              <div className="flex items-start gap-1.5 mt-2 pt-2 border-t border-border/60">
                                <Link2 className="w-3 h-3 text-muted-foreground/40 flex-shrink-0 mt-0.5" />
                                <p className="text-[11px] text-muted-foreground/50 leading-relaxed italic line-clamp-2">
                                  {rel.reason}
                                </p>
                              </div>
                            )}
                            {rel.related_note.tags && rel.related_note.tags.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-2.5">
                                {rel.related_note.tags.slice(0, 4).map((tag) => (
                                  <ClickableTag key={tag} tag={tag} />
                                ))}
                              </div>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </article>
            )
          ) : null}

        </div>
      </SidebarMain>

      {dateFilter && (
        <DateNotesModal
          dateStr={dateFilter}
          onClose={() => setDateFilter(null)}
          onNoteClick={(noteId) => router.push(`/note/${noteId}`)}
        />
      )}

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
    </div>
  );
}
