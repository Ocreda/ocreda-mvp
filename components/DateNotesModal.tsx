'use client';

import { useEffect, useState } from 'react';
import { X, Calendar, Loader as Loader2 } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { getNotes } from '@/lib/notes-api';
import { Note } from '@/lib/types';
import ClickableTag from '@/components/ClickableTag';

interface DateNotesModalProps {
  dateStr: string; // 'yyyy-MM-dd'
  onClose: () => void;
  onNoteClick: (noteId: string) => void;
}

export default function DateNotesModal({ dateStr, onClose, onNoteClick }: DateNotesModalProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getNotes()
      .then((all) => {
        const filtered = all.filter((n) => {
          const day = format(new Date(n.created_at), 'yyyy-MM-dd');
          return day === dateStr;
        });
        setNotes(filtered);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [dateStr]);

  const label = format(parseISO(dateStr), 'MMMM d, yyyy');

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card sm:rounded-2xl rounded-t-2xl shadow-2xl w-full sm:max-w-lg h-[80dvh] sm:h-auto sm:max-h-[76vh] flex flex-col overflow-hidden border border-border">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <Calendar className="w-3.5 h-3.5 text-muted-foreground/60" />
            <span className="text-sm font-semibold text-foreground">{label}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
            </div>
          ) : notes.length === 0 ? (
            <p className="text-sm text-muted-foreground/60 text-center py-12">No notes created on this day.</p>
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] text-muted-foreground/40 mb-3">
                {notes.length} {notes.length === 1 ? 'note' : 'notes'} created on this day
              </p>
              {notes.map((note) => (
                <button
                  key={note.id}
                  onClick={() => { onNoteClick(note.id); onClose(); }}
                  className="w-full text-left bg-muted/40 border border-border rounded-xl p-4 hover:border-primary/30 hover:bg-accent/60 transition-all group"
                >
                  <p className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors leading-snug mb-1 line-clamp-1">
                    {note.title || note.content.slice(0, 60)}
                  </p>
                  <p className="text-xs text-muted-foreground/70 line-clamp-2 leading-relaxed">
                    {note.content}
                  </p>
                  {note.tags && note.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2.5">
                      {note.tags.slice(0, 4).map((tag) => (
                        <ClickableTag key={tag} tag={tag} />
                      ))}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
