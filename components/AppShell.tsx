'use client';

import { useState, useEffect, useCallback } from 'react';
import { usePathname, useRouter } from 'next/navigation';


import QuickCapture from '@/components/QuickCapture';
import DailyReview from '@/components/DailyReview';
import TagFilterModal from '@/components/TagFilterModal';
import NotePopup from '@/components/NotePopup';
import { Note } from '@/lib/types';
import { useAuth } from '@/lib/auth-context';
import { TagFilterProvider } from '@/lib/tag-filter-context';
import { useGuest } from '@/lib/guest-context';
import {
  getNotes,
  createNote,
  deleteNote,
  processNote,
  getTodayReviewSession,
  createDailyReviewSession,
  getDailyReviewNotes,
  saveDailyReviewResponse,
  reinforceMemoryStrength,
} from '@/lib/notes-api';
import { Pen } from 'lucide-react';

const PUBLIC_PATHS = ['/auth'];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { isGuest } = useGuest();
  const pathname = usePathname();
  const router = useRouter();

  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  // No redirect for guests — they can browse all pages freely.
  // Individual pages show a signup prompt when a guest tries to perform an AI action.

  const [showCapture, setShowCapture] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [reviewNotes, setReviewNotes] = useState<Note[]>([]);
  const [reviewSessionId, setReviewSessionId] = useState<string | null>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k' && !e.shiftKey) {
        e.preventDefault();
        setShowCapture((v) => !v);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const checkDailyReview = useCallback(async () => {
    try {
      const existing = await getTodayReviewSession();
      if (existing) return;
      const notes = await getDailyReviewNotes();
      if (notes.length === 0) return;
      const session = await createDailyReviewSession(notes.map((n) => n.id));
      setReviewNotes(notes);
      setReviewSessionId(session.id);
      setShowReview(true);
    } catch {
      // silently fail
    }
  }, []);

  useEffect(() => {
    if (user && !isPublic) checkDailyReview();
  }, [user, isPublic, checkDailyReview]);

  const handleQuickSave = async (content: string) => {
    const note = await createNote('', content);
    processNote(note.id, '', content).catch(() => {});
  };

  const handleReviewResponse = async (noteId: string, response: 'relevant' | 'flagged') => {
    if (!reviewSessionId) return;
    await saveDailyReviewResponse(reviewSessionId, noteId, response);
    if (response === 'relevant') {
      await reinforceMemoryStrength(noteId, 10);
    }
  };

  const [popupNoteId, setPopupNoteId] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [allNotes, setAllNotes] = useState<Note[]>([]);

  const openNote = useCallback((noteId: string) => {
    setPopupNoteId(noteId);
  }, []);

  // Listen for open-note-popup events fired from the sidebar pinned section
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { noteId: string };
      if (detail?.noteId) setPopupNoteId(detail.noteId);
    };
    window.addEventListener('open-note-popup', handler);
    return () => window.removeEventListener('open-note-popup', handler);
  }, []);

  useEffect(() => {
    if (user && !isPublic) getNotes().then(setAllNotes).catch(() => {});
  }, [user, isPublic]);

  return (
    <TagFilterProvider onOpenTag={(tag) => setTagFilter(tag)}>
      {children}

      {(user || isGuest) && !isPublic && (
        <button
          onClick={() => setShowCapture(true)}
          className="fixed bottom-6 right-4 md:right-6 z-[50] w-12 h-12 bg-primary hover:bg-primary/90 text-white rounded-2xl shadow-lg shadow-primary/30 flex items-center justify-center transition-all hover:scale-105 active:scale-95"
          title="Quick capture (⌘K)"
        >
          <Pen className="w-4 h-4" />
        </button>
      )}

      {showCapture && (
        <QuickCapture
          onSave={handleQuickSave}
          onClose={() => setShowCapture(false)}
        />
      )}

      {showReview && reviewSessionId && (
        <DailyReview
          notes={reviewNotes}
          sessionId={reviewSessionId}
          onResponse={handleReviewResponse}
          onComplete={() => setShowReview(false)}
          onDismiss={() => setShowReview(false)}
          onTagClick={(tag) => { setShowReview(false); setTagFilter(tag); }}
          onNoteDelete={async (noteId) => {
            await deleteNote(noteId);
            setReviewNotes((prev) => {
              const updated = prev.filter((n) => n.id !== noteId);
              if (updated.length === 0) setShowReview(false);
              return updated;
            });
          }}
        />
      )}

      {popupNoteId && (
        <NotePopup
          noteId={popupNoteId}
          onClose={() => setPopupNoteId(null)}
          onNoteDeleted={async (noteId) => { await deleteNote(noteId); setAllNotes((prev) => prev.filter((n) => n.id !== noteId)); setPopupNoteId(null); }}
          onTagClick={(tag) => { setPopupNoteId(null); setTagFilter(tag); }}
          onRelatedNoteClick={(id) => openNote(id)}
          onViewAllConnected={(id) => { setPopupNoteId(null); router.push(`/note/${id}`); }}
          onOpen={(id) => { setPopupNoteId(null); router.push(`/note/${id}`); }}
        />
      )}

      {tagFilter && (
        <TagFilterModal
          tag={tagFilter}
          notes={allNotes}
          onClose={() => setTagFilter(null)}
          onTagClick={(tag) => setTagFilter(tag)}
        />
      )}
    </TagFilterProvider>
  );
}
