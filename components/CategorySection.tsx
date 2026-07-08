'use client';

import { useState, useRef, useCallback } from 'react';
import { Note, NoteMemoryStrength } from '@/lib/types';
import { narrowNotes } from '@/lib/notes-api';
import MemoryStrengthBar from '@/components/MemoryStrengthBar';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface CategorySectionProps {
  category: string;
  notes: Note[];
  allOtherNotes: Note[];
  strengths: NoteMemoryStrength[];
  onNoteClick: (note: Note) => void;
  onNoteEdit: (note: Note) => void;
  onNoteDelete: (noteId: string) => void;
  onTagClick?: (tag: string) => void;
  isCustom?: boolean;
}

function MiniNoteCard({
  note,
  memoryScore,
  onClick,
  onTagClick,
}: {
  note: Note;
  memoryScore?: number;
  onClick: () => void;
  onTagClick?: (tag: string) => void;
}) {
  return (
    <div
      onClick={onClick}
      className="w-full text-left bg-card border border-border rounded-xl p-3.5 hover:border-primary/30 hover:shadow-sm hover:shadow-primary/5 transition-all duration-200 group cursor-pointer"
    >
      <p className="text-sm font-medium text-foreground leading-snug line-clamp-1 mb-1 group-hover:text-primary transition-colors">
        {note.title || note.content.slice(0, 60)}
      </p>
      <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
        {note.content}
      </p>
      {note.tags && note.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {note.tags.slice(0, 3).map((tag) => (
            <button
              key={tag}
              onClick={(e) => { e.stopPropagation(); onTagClick?.(tag); }}
              className="text-[10px] bg-accent text-muted-foreground px-1.5 py-0.5 rounded-md hover:bg-primary/10 hover:text-primary transition-all cursor-pointer"
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      {memoryScore !== undefined && <MemoryStrengthBar score={memoryScore} />}
    </div>
  );
}

export default function CategorySection({
  category,
  notes,
  allOtherNotes,
  strengths,
  onNoteClick,
  onTagClick,
  isCustom = false,
}: CategorySectionProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [narrowQuery, setNarrowQuery] = useState('');
  const [narrowing, setNarrowing] = useState(false);
  const [narrowedIds, setNarrowedIds] = useState<string[] | null>(null);
  const [crossIds, setCrossIds] = useState<string[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getScore = (noteId: string) => strengths.find((s) => s.note_id === noteId)?.score;

  const handleNarrow = useCallback(
    (value: string) => {
      setNarrowQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);

      if (!value.trim()) {
        setNarrowedIds(null);
        setCrossIds([]);
        return;
      }

      debounceRef.current = setTimeout(async () => {
        setNarrowing(true);
        try {
          const result = await narrowNotes(
            value.trim(),
            notes.map((n) => ({ id: n.id, title: n.title, content: n.content })),
            allOtherNotes.map((n) => ({ id: n.id, title: n.title, content: n.content, category: n.category ?? null }))
          );
          setNarrowedIds(result.category_matches);
          setCrossIds(result.cross_category_matches);
        } catch {
          setNarrowedIds(null);
          setCrossIds([]);
        } finally {
          setNarrowing(false);
        }
      }, 600);
    },
    [notes, allOtherNotes]
  );

  const displayNotes =
    narrowedIds !== null
      ? narrowedIds.map((id) => notes.find((n) => n.id === id)).filter(Boolean) as Note[]
      : notes;

  const crossNotes =
    crossIds.length > 0
      ? crossIds.map((id) => allOtherNotes.find((n) => n.id === id)).filter(Boolean) as Note[]
      : [];

  return (
    <section className="mb-10">
      <div
        className={`rounded-2xl border transition-all duration-200 ${
          collapsed
            ? 'border-border bg-card/40'
            : 'border-border bg-card shadow-sm'
        }`}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/60">
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="flex items-center gap-2 flex-1 text-left group"
          >
            <span className="text-muted-foreground/40 group-hover:text-muted-foreground transition-colors">
              {collapsed
                ? <ChevronRight className="w-3.5 h-3.5" />
                : <ChevronDown className="w-3.5 h-3.5" />
              }
            </span>
            <h2 className="text-sm font-semibold text-foreground group-hover:text-foreground transition-colors">
              {category}
            </h2>
            <span className="text-[11px] text-muted-foreground/50 tabular-nums">{notes.length}</span>
            {isCustom && (
              <span className="text-[9px] font-semibold text-muted-foreground/40 uppercase tracking-widest px-1.5 py-0.5 rounded border border-border/60 ml-1">
                custom
              </span>
            )}
          </button>

          {!collapsed && (
            <div className="relative flex-shrink-0">
              <input
                type="text"
                value={narrowQuery}
                onChange={(e) => handleNarrow(e.target.value)}
                placeholder="narrow this..."
                className="text-xs px-2.5 py-1 rounded-lg border border-border bg-background/80 text-muted-foreground placeholder:text-muted-foreground/35 focus:outline-none focus:border-primary/40 focus:text-foreground transition-all w-28 focus:w-44"
              />
              {narrowing && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full border border-primary border-t-transparent animate-spin" />
              )}
            </div>
          )}
        </div>

        {!collapsed && (
          <div className="p-4">
            {displayNotes.length === 0 && narrowedIds !== null ? (
              <p className="text-xs text-muted-foreground/50 py-2 text-center">
                Nothing in this category matches that.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {displayNotes.map((note) => (
                  <MiniNoteCard
                    key={note.id}
                    note={note}
                    memoryScore={getScore(note.id)}
                    onClick={() => onNoteClick(note)}
                    onTagClick={onTagClick}
                  />
                ))}
              </div>
            )}

            {crossNotes.length > 0 && (
              <div className="mt-5 pt-4 border-t border-border/50">
                <p className="text-[11px] text-muted-foreground/50 mb-2.5 italic">
                  also related to this in other categories
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {crossNotes.map((note) => (
                    <button
                      key={note.id}
                      onClick={() => onNoteClick(note)}
                      className="text-left bg-background/60 border border-border/60 rounded-xl p-3 hover:border-primary/20 transition-all"
                    >
                      <p className="text-xs font-medium text-foreground/70 line-clamp-1 hover:text-primary transition-colors">
                        {note.title || note.content.slice(0, 50)}
                      </p>
                      {note.category && (
                        <p className="text-[10px] text-muted-foreground/50 mt-0.5">{note.category}</p>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
