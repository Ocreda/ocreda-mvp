'use client';

import { useEffect, useState } from 'react';
import { Note } from '@/lib/types';
import { Pencil, Trash2, Link2, Image as ImageIcon } from 'lucide-react';
import { getNoteRelations } from '@/lib/notes-api';
import MemoryStrengthBar from '@/components/MemoryStrengthBar';
import ClickableTag from '@/components/ClickableTag';
import ClickableDate from '@/components/ClickableDate';

interface NoteRelation {
  id: string;
  related_note_id: string;
  reason: string;
  related_note: { id: string; title: string };
}

interface NoteCardProps {
  note: Note;
  onEdit: (note: Note) => void;
  onDelete: (noteId: string) => void;
  onClick: (note: Note) => void;
  onRelatedNoteClick?: (noteId: string) => void;
  onTagClick?: (tag: string) => void;
  onDateClick?: (dateStr: string) => void;
  memoryScore?: number;
}

export default function NoteCard({ note, onEdit, onDelete, onClick, onRelatedNoteClick, onTagClick, onDateClick, memoryScore }: NoteCardProps) {
  const [relations, setRelations] = useState<NoteRelation[]>([]);

  useEffect(() => {
    getNoteRelations(note.id)
      .then((data) => setRelations(data.slice(0, 3)))
      .catch(() => {});
  }, [note.id]);

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm('delete this note?')) {
      onDelete(note.id);
    }
  };

  return (
    <div
      onClick={() => onClick(note)}
      className="bg-card border border-border rounded-2xl cursor-pointer hover:shadow-md hover:shadow-primary/5 hover:-translate-y-0.5 transition-all duration-200 group flex flex-col gap-0 relative overflow-hidden"
    >
      <div className="p-4 flex flex-col gap-3 flex-1">
        <button
          onClick={handleDelete}
          className="absolute top-2.5 right-2.5 p-1 rounded-md text-muted-foreground/30 hover:text-destructive hover:bg-destructive/10 transition-all z-10"
          title="Delete note"
        >
          <Trash2 className="w-3 h-3" />
        </button>

        {/* Title row — with inline thumbnail if image exists */}
        <div className="flex items-start gap-2.5 pr-5">
          {note.image_url && (
            <div className="flex-shrink-0 w-14 h-14 rounded-lg overflow-hidden bg-muted">
              <img
                src={note.image_url}
                alt=""
                className="w-full h-full object-cover"
              />
            </div>
          )}
          <h3 className="font-semibold text-foreground text-sm leading-snug line-clamp-2 flex-1 mt-0.5">
            {note.image_url && !note.title ? (
              <span className="flex items-center gap-1 text-muted-foreground/60 font-normal">
                <ImageIcon className="w-3 h-3 flex-shrink-0" />
                Image note
              </span>
            ) : (
              note.title
            )}
          </h3>
        </div>

        {/* Preview text: prefer image description if available, else content */}
        {(note.image_description || note.content) && (
          <p className="text-sm text-muted-foreground line-clamp-2 leading-relaxed">
            {note.image_description || note.content}
          </p>
        )}

        {note.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {note.tags.slice(0, 5).map((tag) => (
              <ClickableTag key={tag} tag={tag} />
            ))}
            {note.tags.length > 5 && (
              <span className="text-[10px] text-muted-foreground px-1">+{note.tags.length - 5}</span>
            )}
          </div>
        )}

        {relations.length > 0 && (
          <div className="flex flex-col gap-1 pt-1 border-t border-border/40">
            <span className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
              <Link2 className="w-2.5 h-2.5" />
              Connected
            </span>
            {relations.map((r) => (
              <div key={r.id} className="flex flex-col gap-0.5">
                <button
                  onClick={(e) => { e.stopPropagation(); onRelatedNoteClick?.(r.related_note?.id); }}
                  className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md border w-fit transition-all ${onRelatedNoteClick ? 'bg-muted text-foreground border-border hover:bg-accent hover:border-primary/30 hover:text-primary cursor-pointer' : 'bg-muted text-foreground border-border cursor-default'}`}
                >
                  {r.related_note?.title}
                </button>
                <span className="text-[10px] text-muted-foreground/70 leading-snug line-clamp-1 pl-0.5">{r.reason}</span>
              </div>
            ))}
          </div>
        )}

        {memoryScore !== undefined && (
          <MemoryStrengthBar score={memoryScore} />
        )}

        <div className="flex items-center justify-between pt-1 border-t border-border/50">
          <ClickableDate
            dateStr={note.created_at}
            formatStr="MMM d, yyyy"
            onClick={onDateClick ?? (() => {})}
          />
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(note); }}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
