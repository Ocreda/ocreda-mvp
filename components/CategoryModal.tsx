'use client';

import { useEffect, useRef } from 'react';
import { Note, NoteMemoryStrength } from '@/lib/types';
import { getCategoryColor } from '@/components/CategoryBox';
import { X, Trash2 } from 'lucide-react';

interface CategoryModalProps {
  name: string;
  notes: Note[];
  strengths: NoteMemoryStrength[];
  colorIndex: number;
  onClose: () => void;
  onNoteClick: (note: Note) => void;
  onNoteDelete?: (noteId: string) => void;
}

export default function CategoryModal({
  name,
  notes,
  strengths,
  colorIndex,
  onClose,
  onNoteClick,
  onNoteDelete,
}: CategoryModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const color = getCategoryColor(colorIndex);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const getScore = (noteId: string) =>
    strengths.find((s) => s.note_id === noteId)?.score;

  return (
    <div
      ref={overlayRef}
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm sm:p-4"
    >
      <div className="bg-background border border-border sm:rounded-2xl rounded-t-2xl shadow-2xl w-full sm:max-w-2xl h-[92dvh] sm:h-auto sm:max-h-[80vh] flex flex-col overflow-hidden">
        <div className="px-6 py-5 flex items-start justify-between" style={{ backgroundColor: color.bg }}>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest mb-1" style={{ color: color.meta }}>
              {notes.length} {notes.length === 1 ? 'note' : 'notes'}
            </p>
            <h2 className="text-xl font-bold" style={{ color: color.title }}>{name}</h2>
          </div>
          <button
            onClick={onClose}
            className="transition-opacity opacity-60 hover:opacity-100 p-1 rounded-lg mt-0.5"
            style={{ color: color.meta }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {notes.length === 0 ? (
            <p className="text-sm text-muted-foreground/60 text-center py-8">No notes in this category yet.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {notes.map((note) => {
                const score = getScore(note.id);
                return (
                  <div key={note.id} className="relative group/card">
                    <button
                      onClick={() => { onNoteClick(note); onClose(); }}
                      className="w-full text-left bg-card border border-border rounded-xl p-4 hover:border-primary/30 hover:shadow-sm transition-all group"
                    >
                      <p className="text-sm font-semibold text-foreground line-clamp-1 group-hover:text-primary transition-colors mb-1 pr-6">
                        {note.title || note.content.slice(0, 60)}
                      </p>
                      <p className="text-xs text-muted-foreground line-clamp-3 leading-relaxed">
                        {note.content}
                      </p>
                      {note.tags && note.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2.5">
                          {note.tags.slice(0, 4).map((tag) => (
                            <span
                              key={tag}
                              className="text-[10px] bg-accent text-muted-foreground px-1.5 py-0.5 rounded-md"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                      {score !== undefined && (
                        <div className="mt-2.5 flex items-center gap-1.5">
                          <div className="flex-1 h-0.5 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full bg-primary/50 transition-all"
                              style={{ width: `${score}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-muted-foreground/50 tabular-nums">{score}</span>
                        </div>
                      )}
                    </button>
                    {onNoteDelete && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm('delete this note?')) onNoteDelete(note.id);
                        }}
                        className="absolute top-2 right-2 p-1 rounded-md text-muted-foreground/30 hover:text-destructive hover:bg-destructive/10 transition-all z-10"
                        title="Delete note"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
