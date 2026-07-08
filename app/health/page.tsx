'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Navigation from '@/components/Navigation';
import SidebarMain from '@/components/SidebarMain';
import NotePopup from '@/components/NotePopup';
import DateNotesModal from '@/components/DateNotesModal';
import MemoryStrengthBar, { getMemoryColor } from '@/components/MemoryStrengthBar';
import ClickableTag from '@/components/ClickableTag';
import { Note, NoteMemoryStrength } from '@/lib/types';
import { getNotes, getMemoryStrengths, reinforceMemoryStrength, deleteNote } from '@/lib/notes-api';
import { useGuest } from '@/lib/guest-context';
import GuestSignupPrompt from '@/components/GuestSignupPrompt';
import { Brain, RotateCcw, Trash2 } from 'lucide-react';

interface NoteWithStrength extends Note {
  score: number;
}

export default function MemoryHealthPage() {
  const router = useRouter();
  const { isGuest } = useGuest();
  const [notes, setNotes] = useState<Note[]>([]);
  const [strengths, setStrengths] = useState<NoteMemoryStrength[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [popupNoteId, setPopupNoteId] = useState<string | null>(null);
  const [dateFilter, setDateFilter] = useState<string | null>(null);
  const [reinforcing, setReinforcing] = useState<string | null>(null);
  const [showSignupPrompt, setShowSignupPrompt] = useState(false);

  const loadData = useCallback(async () => {
    if (isGuest) { setLoadingData(false); return; }
    try {
      const [n, s] = await Promise.all([getNotes(), getMemoryStrengths()]);
      setNotes(n);
      setStrengths(s);
    } finally {
      setLoadingData(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const getScore = (noteId: string) => {
    const s = strengths.find((s) => s.note_id === noteId);
    return s ? s.score : 50;
  };

  const handleReview = async (noteId: string) => {
    setReinforcing(noteId);
    try {
      await reinforceMemoryStrength(noteId, 12);
      setStrengths((prev) => {
        const existing = prev.find((s) => s.note_id === noteId);
        if (existing) {
          return prev.map((s) =>
            s.note_id === noteId
              ? { ...s, score: Math.min(100, s.score + 12), last_accessed: new Date().toISOString() }
              : s
          );
        }
        return [...prev, {
          id: crypto.randomUUID(),
          user_id: '',
          note_id: noteId,
          score: 62,
          last_accessed: new Date().toISOString(),
          access_count: 1,
          updated_at: new Date().toISOString(),
        }];
      });
      setPopupNoteId(noteId);
    } finally {
      setReinforcing(null);
    }
  };

  const handleDelete = async (noteId: string) => {
    if (!window.confirm('delete this note?')) return;
    await deleteNote(noteId);
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
    setStrengths((prev) => prev.filter((s) => s.note_id !== noteId));
  };

  const notesWithStrength: NoteWithStrength[] = notes
    .map((n) => ({ ...n, score: getScore(n.id) }))
    .sort((a, b) => a.score - b.score);

  const getStrengthLabel = (score: number) => {
    if (score > 80) return { label: 'Strong', color: getMemoryColor(score) };
    if (score > 60) return { label: 'Healthy', color: getMemoryColor(score) };
    if (score > 40) return { label: 'Weakening', color: getMemoryColor(score) };
    if (score > 20) return { label: 'Fading', color: getMemoryColor(score) };
    return { label: 'Critical', color: getMemoryColor(score) };
  };

  const weakCount = notesWithStrength.filter((n) => n.score < 40).length;
  const fadingCount = notesWithStrength.filter((n) => n.score >= 40 && n.score < 70).length;
  const strongCount = notesWithStrength.filter((n) => n.score >= 70).length;

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <SidebarMain>
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 sm:py-8">
          <div className="flex items-start justify-between mb-6 sm:mb-8">
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-foreground">Memory Health</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Notes sorted by memory strength — lowest first. Review them to keep them alive.
              </p>
            </div>
          </div>

          {isGuest && (
            <div className="mb-6 px-4 py-3 bg-primary/5 border border-primary/20 rounded-xl text-sm text-muted-foreground">
              Memory Health tracks how well you remember your notes.{' '}
              <button onClick={() => setShowSignupPrompt(true)} className="text-primary hover:underline font-medium">Sign up free</button> to see your memory scores.
            </div>
          )}

          <div className="grid grid-cols-3 gap-2 sm:gap-4 mb-6 sm:mb-8">
            <div className="rounded-2xl p-3 sm:p-4 border" style={{ backgroundColor: `${getMemoryColor(10)}18`, borderColor: `${getMemoryColor(10)}40` }}>
              <p className="text-xl sm:text-2xl font-bold" style={{ color: getMemoryColor(10) }}>{weakCount}</p>
              <p className="text-xs sm:text-sm font-medium" style={{ color: getMemoryColor(10) }}>Weak</p>
              <p className="text-[10px] sm:text-xs mt-0.5 text-muted-foreground hidden sm:block">Score below 40</p>
            </div>
            <div className="rounded-2xl p-3 sm:p-4 border" style={{ backgroundColor: `${getMemoryColor(50)}18`, borderColor: `${getMemoryColor(50)}40` }}>
              <p className="text-xl sm:text-2xl font-bold" style={{ color: getMemoryColor(50) }}>{fadingCount}</p>
              <p className="text-xs sm:text-sm font-medium" style={{ color: getMemoryColor(50) }}>Weakening</p>
              <p className="text-[10px] sm:text-xs mt-0.5 text-muted-foreground hidden sm:block">Score 40–69</p>
            </div>
            <div className="rounded-2xl p-3 sm:p-4 border" style={{ backgroundColor: `${getMemoryColor(90)}18`, borderColor: `${getMemoryColor(90)}40` }}>
              <p className="text-xl sm:text-2xl font-bold" style={{ color: getMemoryColor(90) }}>{strongCount}</p>
              <p className="text-xs sm:text-sm font-medium" style={{ color: getMemoryColor(90) }}>Strong</p>
              <p className="text-[10px] sm:text-xs mt-0.5 text-muted-foreground hidden sm:block">Score 70+</p>
            </div>
          </div>

          {loadingData ? (
            <div className="space-y-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="bg-card border border-border rounded-2xl p-4 h-20 animate-pulse" />
              ))}
            </div>
          ) : notesWithStrength.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
                <Brain className="w-8 h-8 text-muted-foreground" />
              </div>
              <h3 className="font-semibold text-foreground mb-1">No notes yet</h3>
              <p className="text-sm text-muted-foreground">Add some notes first to track memory strength</p>
            </div>
          ) : (
            <div className="space-y-2">
              {notesWithStrength.map((note) => {
                const { label, color } = getStrengthLabel(note.score);
                return (
                  <div
                    key={note.id}
                    className="bg-card border border-border rounded-2xl p-4 hover:shadow-sm transition-all"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h3
                            className="text-sm font-semibold text-foreground cursor-pointer hover:text-primary transition-colors truncate"
                            onClick={() => setPopupNoteId(note.id)}
                          >
                            {note.title}
                          </h3>
                          <span
                            className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md border flex-shrink-0"
                            style={{ color, borderColor: color, backgroundColor: `${color}18` }}
                          >
                            {label}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-1 mb-2">{note.content}</p>
                        {note.tags && note.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mb-2">
                            {note.tags.slice(0, 4).map((tag) => (
                              <ClickableTag key={tag} tag={tag} />
                            ))}
                          </div>
                        )}
                        <MemoryStrengthBar score={note.score} />
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <button
                          onClick={() => handleReview(note.id)}
                          disabled={reinforcing === note.id}
                          className="flex items-center gap-1.5 px-3 py-2.5 sm:py-1.5 rounded-xl text-xs font-medium bg-muted hover:bg-primary hover:text-white text-muted-foreground border border-border hover:border-primary transition-all min-h-[44px] sm:min-h-0"
                        >
                          <RotateCcw className={`w-3 h-3 ${reinforcing === note.id ? 'animate-spin' : ''}`} />
                          Review
                        </button>
                        <button
                          onClick={() => handleDelete(note.id)}
                          className="p-2.5 sm:p-1.5 rounded-xl text-muted-foreground/30 hover:text-destructive hover:bg-destructive/10 border border-transparent hover:border-destructive/20 transition-all min-h-[44px] sm:min-h-0 flex items-center"
                          title="Delete note"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </SidebarMain>

      {popupNoteId && (
        <NotePopup
          noteId={popupNoteId}
          onClose={() => setPopupNoteId(null)}
          onNoteDeleted={handleDelete}
          onRelatedNoteClick={(id) => setPopupNoteId(id)}
          onViewAllConnected={(id) => { setPopupNoteId(null); router.push(`/note/${id}`); }}
          onDateClick={(d) => { setPopupNoteId(null); setDateFilter(d); }}
          onOpen={(id) => { setPopupNoteId(null); router.push(`/note/${id}`); }}
        />
      )}

      {dateFilter && (
        <DateNotesModal
          dateStr={dateFilter}
          onClose={() => setDateFilter(null)}
          onNoteClick={(id) => { setDateFilter(null); setPopupNoteId(id); }}
        />
      )}

      {showSignupPrompt && (
        <GuestSignupPrompt
          onClose={() => setShowSignupPrompt(false)}
          message="Create a free account to track memory health across all your notes."
        />
      )}
    </div>
  );
}
