'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useAuth } from './auth-context';
import { supabase } from './supabase';

export interface GuestNote {
  id: string;
  title: string;
  content: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export const GUEST_MAX_NOTES = 5;
export const GUEST_STORAGE_KEY = 'mybrain_guest_notes';

interface GuestContextType {
  isGuest: boolean;
  guestNotes: GuestNote[];
  addGuestNote: (title: string, content: string) => GuestNote | null; // null = limit reached
  canAddNote: boolean;
  clearGuestNotes: () => void;
  noteCount: number;
}

const GuestContext = createContext<GuestContextType>({
  isGuest: false,
  guestNotes: [],
  addGuestNote: () => null,
  canAddNote: true,
  clearGuestNotes: () => {},
  noteCount: 0,
});

function loadGuestNotes(): GuestNote[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(GUEST_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as GuestNote[];
  } catch {
    return [];
  }
}

function saveGuestNotes(notes: GuestNote[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(notes));
}

export async function transferGuestNotes(userId: string): Promise<void> {
  try {
    const raw = localStorage.getItem(GUEST_STORAGE_KEY);
    if (!raw) return;
    const guestNotes = JSON.parse(raw) as GuestNote[];
    if (!Array.isArray(guestNotes) || guestNotes.length === 0) return;

    // Insert guest notes in reverse order so they appear newest-first
    const rows = [...guestNotes].reverse().map((n) => ({
      user_id: userId,
      title: n.title || '',
      content: n.content,
      tags: n.tags || [],
      type: 'note',
      created_at: n.created_at,
      updated_at: n.updated_at,
    }));

    await supabase.from('notes').insert(rows);
    localStorage.removeItem(GUEST_STORAGE_KEY);
  } catch {
    // non-critical — don't block the sign-in flow
  }
}

export function GuestProvider({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const isGuest = !loading && !user;
  const [guestNotes, setGuestNotes] = useState<GuestNote[]>([]);

  useEffect(() => {
    if (isGuest) {
      setGuestNotes(loadGuestNotes());
    }
  }, [isGuest]);

  const addGuestNote = useCallback((title: string, content: string): GuestNote | null => {
    const current = loadGuestNotes();
    if (current.length >= GUEST_MAX_NOTES) return null;
    const now = new Date().toISOString();
    const note: GuestNote = {
      id: `guest-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title,
      content,
      tags: [],
      created_at: now,
      updated_at: now,
    };
    const updated = [note, ...current];
    saveGuestNotes(updated);
    setGuestNotes(updated);
    return note;
  }, []);

  const clearGuestNotes = useCallback(() => {
    if (typeof window !== 'undefined') localStorage.removeItem(GUEST_STORAGE_KEY);
    setGuestNotes([]);
  }, []);

  return (
    <GuestContext.Provider
      value={{
        isGuest,
        guestNotes,
        addGuestNote,
        canAddNote: guestNotes.length < GUEST_MAX_NOTES,
        clearGuestNotes,
        noteCount: guestNotes.length,
      }}
    >
      {children}
    </GuestContext.Provider>
  );
}

export const useGuest = () => useContext(GuestContext);
