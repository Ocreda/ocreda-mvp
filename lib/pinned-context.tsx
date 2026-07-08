'use client';

import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useAuth } from './auth-context';
import { getPinnedNotes, pinNote, unpinNote, PinnedNote } from './notes-api';

const MAX_PINS = 3;

interface PinnedContextValue {
  pins: PinnedNote[];
  isLoading: boolean;
  isPinned: (noteId: string) => boolean;
  pin: (noteId: string, durationMs: number | null) => Promise<{ error?: string }>;
  unpin: (noteId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const PinnedContext = createContext<PinnedContextValue | null>(null);

export function usePinned() {
  const ctx = useContext(PinnedContext);
  if (!ctx) throw new Error('usePinned must be used inside PinnedProvider');
  return ctx;
}

export function PinnedProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [pins, setPins] = useState<PinnedNote[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const data = await getPinnedNotes();
      const now = new Date();
      const active = data.filter((p) => !p.pinned_until || new Date(p.pinned_until) > now);
      setPins(active);
    } catch {}
  }, [user]);

  useEffect(() => {
    if (!user) { setPins([]); return; }
    setIsLoading(true);
    refresh().finally(() => setIsLoading(false));
  }, [user, refresh]);

  const isPinned = useCallback((noteId: string) => pins.some((p) => p.note_id === noteId), [pins]);

  const pin = useCallback(async (noteId: string, durationMs: number | null): Promise<{ error?: string }> => {
    const alreadyPinned = pins.some((p) => p.note_id === noteId);
    if (!alreadyPinned && pins.length >= MAX_PINS) {
      return { error: 'You already have 3 pinned notes. Unpin one to add another.' };
    }
    const pinnedUntil = durationMs === null ? null : new Date(Date.now() + durationMs).toISOString();
    const updated = await pinNote(noteId, pinnedUntil);
    setPins((prev) => {
      const without = prev.filter((p) => p.note_id !== noteId);
      return [updated, ...without];
    });
    return {};
  }, [pins]);

  const unpin = useCallback(async (noteId: string) => {
    await unpinNote(noteId);
    setPins((prev) => prev.filter((p) => p.note_id !== noteId));
  }, []);

  return (
    <PinnedContext.Provider value={{ pins, isLoading, isPinned, pin, unpin, refresh }}>
      {children}
    </PinnedContext.Provider>
  );
}
