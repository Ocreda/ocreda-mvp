'use client';

import { useState, useEffect } from 'react';
import { Note } from '@/lib/types';
import { getNoteRelations } from '@/lib/notes-api';
import { Sun, ChevronRight, Check, Flag, Tag, Link2, X, Trash2 } from 'lucide-react';
import { format } from 'date-fns';

interface DailyReviewProps {
  notes: Note[];
  sessionId: string;
  onResponse: (noteId: string, response: 'relevant' | 'flagged') => void;
  onComplete: () => void;
  onDismiss: () => void;
  onTagClick?: (tag: string) => void;
  onNoteDelete?: (noteId: string) => void;
}

interface RelatedNote {
  id: string;
  related_note_id: string;
  reason: string;
  related_note: { id: string; title: string };
}

export default function DailyReview({ notes, sessionId, onResponse, onComplete, onDismiss, onTagClick, onNoteDelete }: DailyReviewProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [responded, setResponded] = useState<Record<string, 'relevant' | 'flagged'>>({});
  const [relations, setRelations] = useState<RelatedNote[]>([]);
  const [animating, setAnimating] = useState(false);
  const [direction, setDirection] = useState<'in' | 'out'>('in');

  const currentNote = notes[currentIndex];
  const isLast = currentIndex === notes.length - 1;
  const hasResponded = currentNote ? responded[currentNote.id] : false;

  useEffect(() => {
    if (!currentNote) return;
    getNoteRelations(currentNote.id).then(setRelations).catch(() => setRelations([]));
    setDirection('in');
    setAnimating(true);
    const t = setTimeout(() => setAnimating(false), 300);
    return () => clearTimeout(t);
  }, [currentNote?.id]);

  const handleResponse = (response: 'relevant' | 'flagged') => {
    if (!currentNote || hasResponded) return;
    setResponded((prev) => ({ ...prev, [currentNote.id]: response }));
    onResponse(currentNote.id, response);
  };

  const handleNext = () => {
    if (isLast) {
      onComplete();
      return;
    }
    setDirection('out');
    setAnimating(true);
    setTimeout(() => {
      setCurrentIndex((i) => i + 1);
    }, 200);
  };

  if (!currentNote) return null;

  const progress = ((currentIndex) / notes.length) * 100;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background">
      <button
        onClick={onDismiss}
        className="absolute top-5 right-5 p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
      >
        <X className="w-4 h-4" />
      </button>

      <div className="w-full max-w-xl">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center border border-primary/20">
            <Sun className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground">Morning Review</h2>
            <p className="text-xs text-muted-foreground">{format(new Date(), 'EEEE, MMMM d')}</p>
          </div>
          <div className="ml-auto text-xs text-muted-foreground">
            {currentIndex + 1} of {notes.length}
          </div>
        </div>

        <div className="w-full h-0.5 bg-border rounded-full mb-8 overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div
          className={`transition-all duration-300 ${
            animating && direction === 'out'
              ? 'opacity-0 translate-y-2'
              : animating && direction === 'in'
              ? 'opacity-0 -translate-y-2'
              : 'opacity-100 translate-y-0'
          }`}
        >
          <div className="bg-card rounded-2xl border border-border shadow-sm p-6 mb-4 relative">
            {onNoteDelete && (
              <button
                onClick={() => {
                  if (window.confirm('delete this note?')) {
                    onNoteDelete(currentNote.id);
                  }
                }}
                className="absolute top-3 right-3 p-1 rounded-md text-muted-foreground/30 hover:text-destructive hover:bg-destructive/10 transition-all"
                title="Delete note"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
            <h3 className="text-base font-semibold text-foreground mb-3 leading-snug pr-6">{currentNote.title}</h3>
            <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap mb-4">{currentNote.content}</p>

            {currentNote.tags && currentNote.tags.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap mb-4">
                <Tag className="w-3 h-3 text-muted-foreground" />
                {currentNote.tags.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => onTagClick?.(tag)}
                    className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border hover:bg-primary/10 hover:text-primary hover:border-primary/30 transition-all cursor-pointer"
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}

            {relations.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <Link2 className="w-3 h-3 text-muted-foreground" />
                  <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Connected to</span>
                </div>
                <div className="space-y-1">
                  {relations.slice(0, 3).map((rel) => (
                    <div key={rel.id} className="text-xs text-muted-foreground pl-4 border-l border-border">
                      {rel.related_note?.title}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 mb-6">
            <button
              onClick={() => handleResponse('relevant')}
              disabled={!!hasResponded}
              className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-medium border transition-all ${
                responded[currentNote.id] === 'relevant'
                  ? 'bg-primary/10 text-primary border-primary/30'
                  : hasResponded
                  ? 'opacity-40 bg-card text-muted-foreground border-border cursor-not-allowed'
                  : 'bg-card text-foreground border-border hover:bg-primary/10 hover:text-primary hover:border-primary/30'
              }`}
            >
              <Check className="w-4 h-4" />
              Still relevant
            </button>
            <button
              onClick={() => handleResponse('flagged')}
              disabled={!!hasResponded}
              className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-medium border transition-all ${
                responded[currentNote.id] === 'flagged'
                  ? 'bg-destructive/10 text-destructive border-destructive/30'
                  : hasResponded
                  ? 'opacity-40 bg-card text-muted-foreground border-border cursor-not-allowed'
                  : 'bg-card text-foreground border-border hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30'
              }`}
            >
              <Flag className="w-4 h-4" />
              No longer applies
            </button>
          </div>

          <button
            onClick={handleNext}
            disabled={!hasResponded}
            className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-medium transition-all ${
              hasResponded
                ? 'bg-primary text-white hover:bg-primary/90'
                : 'bg-muted text-muted-foreground cursor-not-allowed'
            }`}
          >
            {isLast ? 'Finish review' : 'Next note'}
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
