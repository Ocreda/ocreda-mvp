'use client';

import { useMemo, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { Note } from '@/lib/types';
import { getCategoryColor, categorySlug } from '@/components/CategoryBox';

interface CategoryPreviewModalProps {
  name: string;
  notes: Note[];
  colorIndex: number;
  onClose: () => void;
  onNoteClick: (note: Note) => void;
}

export default function CategoryPreviewModal({
  name,
  notes,
  colorIndex,
  onClose,
  onNoteClick,
}: CategoryPreviewModalProps) {
  const router = useRouter();
  const color = getCategoryColor(colorIndex);
  const overlayRef = useRef<HTMLDivElement>(null);

  const preview = useMemo(() => {
    const shuffled = [...notes].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 4);
  }, [notes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSeeAll = () => {
    onClose();
    router.push(`/category/${categorySlug(name)}`);
  };

  return (
    <div
      ref={overlayRef}
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm sm:p-4"
    >
      <div className="bg-background border border-border sm:rounded-2xl rounded-t-2xl shadow-2xl w-full sm:max-w-md overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-200">
        {/* Coloured header */}
        <div className="px-5 py-4 flex items-start justify-between" style={{ backgroundColor: color.bg }}>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest mb-0.5" style={{ color: color.meta }}>
              {notes.length} {notes.length === 1 ? 'note' : 'notes'}
            </p>
            <h2 className="text-lg font-bold" style={{ color: color.title }}>{name}</h2>
          </div>
          <button
            onClick={onClose}
            className="transition-opacity opacity-60 hover:opacity-100 p-1 rounded-lg"
            style={{ color: color.meta }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Note previews */}
        <div className="px-4 py-4 grid grid-cols-1 gap-3">
          {preview.map((note) => (
            <button
              key={note.id}
              onClick={() => { onClose(); onNoteClick(note); }}
              className="w-full text-left bg-muted/50 border border-border hover:border-primary/30 hover:bg-accent rounded-xl px-3.5 py-3 transition-all duration-150 group"
            >
              <p className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors line-clamp-1 leading-snug">
                {note.title || note.content.slice(0, 60)}
              </p>
              <p className="text-xs text-muted-foreground/60 line-clamp-1 mt-1 leading-snug">
                {note.content}
              </p>
            </button>
          ))}
        </div>

        {/* See all */}
        <div className="px-4 pb-4 pt-1 border-t border-border/50 mt-1">
          <button
            onClick={handleSeeAll}
            className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-medium text-primary hover:bg-primary/8 transition-all"
          >
            see all {notes.length}
          </button>
        </div>
      </div>
    </div>
  );
}
