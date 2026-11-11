'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader as Loader2, Search, X } from 'lucide-react';
import { getNotes } from '@/lib/notes-api';
import { loadDomains } from '@/lib/domains-api';
import { Note } from '@/lib/types';

/**
 * Picks many of the person's own notes to copy into their public notes:
 * search, narrow to one Domain, select everything shown, then add.
 */

const UNSORTED = 'No Domain';

function titleOf(text: string): string {
  return text.trim().split('\n')[0].trim() || 'Untitled note';
}

export default function ShareNotePicker({ userId, alreadyPublic, onClose, onAdd }: {
  userId: string;
  /** Ids of private notes that already have a public copy. */
  alreadyPublic: Set<string>;
  onClose: () => void;
  onAdd: (notes: Note[]) => Promise<void>;
}) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [domainOf, setDomainOf] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [domain, setDomain] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let current = true;
    Promise.all([getNotes(), loadDomains(userId, false)])
      .then(([loaded, domains]) => {
        if (!current) return;
        // Sample notes are not the person's own, so they are not offered.
        setNotes(loaded.filter((note) => !note.is_sample));
        setDomainOf(domains.assignments);
      })
      .catch(() => { if (current) setLoadError('Unable to load your notes.'); });
    return () => { current = false; };
  }, [userId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const domains = useMemo(() => {
    const counts = new Map<string, number>();
    (notes ?? []).forEach((note) => {
      const name = domainOf[note.id] ?? UNSORTED;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    });
    return Array.from(counts.entries()).sort((left, right) => (left[0] === UNSORTED ? 1 : right[0] === UNSORTED ? -1 : left[0].localeCompare(right[0])));
  }, [domainOf, notes]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (notes ?? []).filter((note) =>
      (!domain || (domainOf[note.id] ?? UNSORTED) === domain) && (!needle || note.raw_text.toLowerCase().includes(needle)));
  }, [domain, domainOf, notes, query]);

  const allShownSelected = shown.length > 0 && shown.every((note) => selected.has(note.id));

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleAllShown = () => setSelected((current) => {
    const next = new Set(current);
    shown.forEach((note) => { if (allShownSelected) next.delete(note.id); else next.add(note.id); });
    return next;
  });

  const add = async () => {
    setAdding(true);
    try { await onAdd((notes ?? []).filter((note) => selected.has(note.id))); }
    finally { setAdding(false); }
  };

  const chip = (active: boolean) => `shrink-0 rounded-full border px-3 py-1 text-xs ${active ? 'border-[#477bea] bg-[#eef2ff] text-[#2f5fd0]' : 'border-[#dedede] bg-white text-[#555] hover:border-[#adc3ff]'}`;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 backdrop-blur-[4px] sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-label="Add notes to public notes" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-white text-[#252525] shadow-2xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-[#ececef] px-5 py-4">
          <h2 className="text-base font-semibold text-[#222]">Add notes to public notes</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-[#f5f5f5]"><X className="h-4 w-4" /></button>
        </div>

        <div className="space-y-3 border-b border-[#ececef] px-5 py-3">
          <label className="flex items-center gap-2 rounded-md border border-[#dedede] px-3 py-2 focus-within:border-[#adc3ff]">
            <Search className="h-4 w-4 shrink-0 text-[#9a9aa3]" aria-hidden />
            <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your notes" aria-label="Search your notes" className="w-full bg-transparent text-sm outline-none placeholder:text-[#9a9aa3]" />
          </label>
          {domains.length > 1 && (
            <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Show notes from">
              <button type="button" aria-pressed={!domain} onClick={() => setDomain(null)} className={chip(!domain)}>All · {notes?.length ?? 0}</button>
              {domains.map(([name, count]) => <button key={name} type="button" aria-pressed={domain === name} onClick={() => setDomain(name)} className={chip(domain === name)}>{name} · {count}</button>)}
            </div>
          )}
          <label className="flex cursor-pointer items-center gap-3 text-sm text-[#333]">
            <input type="checkbox" checked={allShownSelected} disabled={!shown.length} onChange={toggleAllShown} className="h-4 w-4 accent-[#477bea]" />
            Select all {shown.length} shown
          </label>
        </div>

        <div className="min-h-[160px] flex-1 overflow-y-auto px-2 py-2">
          {loadError ? <p role="alert" className="px-3 py-6 text-center text-sm text-red-600">{loadError}</p>
            : !notes ? <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-[#477bea]" /></div>
            : !notes.length ? <p className="px-3 py-10 text-center text-sm text-[#777]">You have no notes of your own yet. If you are exploring the sample notes, go back to your notes first.</p>
            : !shown.length ? <p className="px-3 py-10 text-center text-sm text-[#777]">No notes match.</p>
            : (
              <ul>
                {shown.map((note) => (
                  <li key={note.id}>
                    <label className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-[#f7f7f9]">
                      <input type="checkbox" checked={selected.has(note.id)} onChange={() => toggle(note.id)} className="mt-0.5 h-4 w-4 shrink-0 accent-[#477bea]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-[#222]">{titleOf(note.raw_text)}</span>
                        <span className="block truncate text-xs text-[#777]">{domainOf[note.id] ?? UNSORTED}{alreadyPublic.has(note.id) ? ' · already public, will be updated' : ''}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[#ececef] px-5 py-4">
          <p className="text-sm text-[#777]" aria-live="polite">{selected.size} selected</p>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-md border border-[#dedede] px-4 py-2 text-sm hover:bg-[#f5f5f5]">Cancel</button>
            <button type="button" disabled={!selected.size || adding} onClick={() => void add()} className="inline-flex items-center gap-2 rounded-md bg-[#477bea] px-4 py-2 text-sm font-medium text-white hover:bg-[#3d6ed7] disabled:cursor-not-allowed disabled:opacity-50">
              {adding && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}Add {selected.size > 0 ? selected.size : ''} {selected.size === 1 ? 'note' : 'notes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
