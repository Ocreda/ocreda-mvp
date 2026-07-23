'use client';

import { useState, useEffect, useCallback } from 'react';
import Navigation from '@/components/Navigation';
import SidebarMain from '@/components/SidebarMain';
import NotePopup from '@/components/NotePopup';
import { Note } from '@/lib/types';
import { getNotes, deleteNote } from '@/lib/notes-api';
import { Trash2, Clock } from 'lucide-react';
import { format } from 'date-fns';

export default function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [popupNoteId, setPopupNoteId] = useState<string | null>(null);

  const loadNotes = useCallback(async () => {
    try {
      const data = await getNotes();
      setNotes(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadNotes(); }, [loadNotes]);

  const handleDelete = async (noteId: string) => {
    try {
      await deleteNote(noteId);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
    } catch {
      setError('Failed to delete note');
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <SidebarMain>
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-4 sm:py-8">
          <div className="mb-6 sm:mb-8">
            <h1 className="text-xl sm:text-2xl font-bold text-foreground">Notes</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Everything you've saved from My Brain.</p>
          </div>

          {error && (
            <div className="mb-6 px-4 py-3 rounded-xl bg-destructive/10 text-sm text-destructive border border-destructive/20">
              {error}
            </div>
          )}

          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="bg-card border border-border rounded-xl h-16 animate-pulse" />
              ))}
            </div>
          ) : notes.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-sm text-muted-foreground">No notes yet — write one on the My Brain page.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {notes.map((note) => (
                <div
                  key={note.id}
                  onClick={() => setPopupNoteId(note.id)}
                  className="bg-card border border-border rounded-xl px-4 py-3.5 cursor-pointer hover:border-primary/30 hover:bg-accent/40 transition-all group"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm text-foreground leading-relaxed flex-1 min-w-0">
                      {note.summary || note.raw_text}
                    </p>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(note.id); }}
                      className="p-1.5 rounded-lg text-muted-foreground/30 hover:text-destructive hover:bg-destructive/10 transition-all flex-shrink-0 opacity-0 group-hover:opacity-100"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground/60">
                    {note.target_date ? (
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {format(new Date(note.target_date), 'MMM d')}{note.time_of_day ? ` · ${note.time_of_day}` : ''}
                      </span>
                    ) : (
                      <span>{format(new Date(note.created_at), 'MMM d, h:mm a')}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </SidebarMain>

      {popupNoteId && (
        <NotePopup
          noteId={popupNoteId}
          onClose={() => setPopupNoteId(null)}
          onNoteDeleted={(noteId) => { setNotes((prev) => prev.filter((n) => n.id !== noteId)); setPopupNoteId(null); }}
          onRelatedNoteClick={(id) => setPopupNoteId(id)}
        />
      )}
    </div>
  );
}
