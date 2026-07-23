'use client';

import { useState, useCallback, useEffect } from 'react';
import NotePopup from '@/components/NotePopup';
import { deleteNote } from '@/lib/notes-api';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [popupNoteId, setPopupNoteId] = useState<string | null>(null);

  const openNote = useCallback((noteId: string) => {
    setPopupNoteId(noteId);
  }, []);

  // Listen for open-note-popup events fired from anywhere in the app (e.g. source chips in Q&A)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { noteId: string };
      if (detail?.noteId) setPopupNoteId(detail.noteId);
    };
    window.addEventListener('open-note-popup', handler);
    return () => window.removeEventListener('open-note-popup', handler);
  }, []);

  return (
    <>
      {children}

      {popupNoteId && (
        <NotePopup
          noteId={popupNoteId}
          onClose={() => setPopupNoteId(null)}
          onNoteDeleted={async (noteId) => { await deleteNote(noteId); setPopupNoteId(null); }}
          onRelatedNoteClick={(id) => openNote(id)}
        />
      )}
    </>
  );
}
