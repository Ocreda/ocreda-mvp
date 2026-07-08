'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Note, NoteMemoryStrength } from '@/lib/types';
import { X, Tag, Link2, Trash2 } from 'lucide-react';
import NotePopup from '@/components/NotePopup';
import MemoryStrengthBar from '@/components/MemoryStrengthBar';
import ClickableTag from '@/components/ClickableTag';
import { getNoteRelations, deleteNote } from '@/lib/notes-api';

interface RelatedNote {
  id: string;
  related_note_id: string;
  reason: string;
  related_note: { id: string; title: string };
}

interface TagFilterModalProps {
  tag: string;
  notes: Note[];
  onClose: () => void;
  onTagClick?: (tag: string) => void;
  strengths?: NoteMemoryStrength[];
}

function NoteCardWithRelations({
  note,
  memoryScore,
  onNoteClick,
  onTagClick,
  onDelete,
  activeTag,
}: {
  note: Note;
  memoryScore?: number;
  onNoteClick: (id: string) => void;
  onTagClick?: (tag: string) => void;
  onDelete?: (noteId: string) => void;
  activeTag: string;
}) {
  const [relations, setRelations] = useState<RelatedNote[]>([]);

  useEffect(() => {
    getNoteRelations(note.id)
      .then((data) => setRelations(data.slice(0, 3)))
      .catch(() => {});
  }, [note.id]);

  return (
    <div className="bg-card border border-border rounded-xl hover:border-primary/20 transition-all relative overflow-hidden h-[168px] flex flex-col">
      {onDelete && (
        <button
          onClick={() => { if (window.confirm('delete this note?')) onDelete(note.id); }}
          className="absolute top-2.5 right-2.5 p-1 rounded-md text-muted-foreground/30 hover:text-destructive hover:bg-destructive/10 transition-all z-10"
          title="Delete note"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      )}
      <button
        onClick={() => onNoteClick(note.id)}
        className="w-full text-left group px-4 pt-4 flex-1 min-h-0 overflow-hidden"
      >
        <p className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors leading-snug mb-1.5 pr-6 truncate">
          {note.title || 'Untitled'}
        </p>
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3 overflow-hidden">{note.content}</p>
      </button>

      <div className="px-4 pb-3 flex-shrink-0">
        {note.tags && note.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2 overflow-hidden max-h-[22px]">
            {note.tags.slice(0, 4).map((t) => (
              <ClickableTag key={t} tag={t} active={t === activeTag} />
            ))}
          </div>
        )}

        {memoryScore !== undefined && (
          <div className="mt-2">
            <MemoryStrengthBar score={memoryScore} />
          </div>
        )}
      </div>
    </div>
  );
}

export default function TagFilterModal({ tag, notes, onClose, onTagClick, strengths }: TagFilterModalProps) {
  const router = useRouter();
  const [popupNoteId, setPopupNoteId] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState(tag);
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setActiveTag(tag);
  }, [tag]);

  const handleDelete = async (noteId: string) => {
    await deleteNote(noteId);
    setDeletedIds((prev) => { const next = new Set(prev); next.add(noteId); return next; });
    if (popupNoteId === noteId) setPopupNoteId(null);
  };

  const matching = notes.filter((n) => n.tags?.includes(activeTag) && !deletedIds.has(n.id));

  const getScore = (noteId: string) => strengths?.find((s) => s.note_id === noteId)?.score;

  const handleTagClick = (t: string) => {
    if (t === activeTag) return;
    if (onTagClick) {
      onTagClick(t);
    } else {
      setActiveTag(t);
    }
  };

  const handleNoteClick = (id: string) => {
    setPopupNoteId(id);
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
        <div className="relative bg-card rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden border border-border">

          <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-muted/30 flex-shrink-0">
            <div className="flex items-center gap-2">
              <Tag className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-semibold text-foreground">{activeTag}</span>
              <span className="text-xs text-muted-foreground">
                · {matching.length} {matching.length === 1 ? 'note' : 'notes'}
              </span>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {matching.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No notes with this tag.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {matching.map((note) => (
                  <NoteCardWithRelations
                    key={note.id}
                    note={note}
                    memoryScore={getScore(note.id)}
                    onNoteClick={handleNoteClick}
                    onTagClick={handleTagClick}
                    onDelete={handleDelete}
                    activeTag={activeTag}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {popupNoteId && (
        <NotePopup
          noteId={popupNoteId}
          onClose={() => setPopupNoteId(null)}
          onTagClick={handleTagClick}
          onRelatedNoteClick={(id) => setPopupNoteId(id)}
          onViewAllConnected={(id) => { setPopupNoteId(null); onClose(); router.push(`/note/${id}`); }}
          onOpen={(id) => { setPopupNoteId(null); onClose(); router.push(`/note/${id}`); }}
        />
      )}
    </>
  );
}
