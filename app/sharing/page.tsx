'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Check, Copy, Link2, Loader as Loader2, Plus, Trash2 } from 'lucide-react';
import ShareNotePicker from '@/components/ShareNotePicker';
import { useAuth } from '@/lib/auth-context';
import { Note } from '@/lib/types';
import {
  copyNotesToPublic, copyPublicNoteToPrivate, createShareLink, listPublicNotes, listShareLinks, PublicNote, removePublicNote,
  revokeShareLink, ShareLink, shareUrl,
} from '@/lib/sharing-api';

/**
 * Where a person manages what they share: their public notes (copies they
 * chose to share) and the links they made to them.
 */

function titleOf(text: string): string {
  return text.trim().split('\n')[0].trim() || 'Untitled note';
}

function previewOf(text: string): string {
  return text.trim().split('\n').slice(1).join(' ').trim();
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
}

function messageOf(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' && error.message) return error.message;
  return fallback;
}

export default function SharingPage() {
  const { user } = useAuth();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notes, setNotes] = useState<PublicNote[]>([]);
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [loadedNotes, loadedLinks] = await Promise.all([listPublicNotes(), listShareLinks()]);
      setNotes(loadedNotes); setLinks(loadedLinks);
    } catch (err) { setError(messageOf(err, 'Unable to load your shared notes.')); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (err) { setError(messageOf(err, fallback)); }
    finally { setBusy(false); }
  };

  /** Copies a link's address. False when the browser will not allow it. */
  const copyLink = async (token: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(shareUrl(token));
      setCopiedToken(token);
      window.setTimeout(() => setCopiedToken((current) => current === token ? null : current), 2000);
      return true;
    } catch { return false; }
  };

  const copyLinkFromList = async (token: string) => {
    setError('');
    if (!(await copyLink(token))) setError('Could not copy the link. Select its address below and copy it by hand.');
  };

  const makeLink = () => run(async () => {
    const token = await createShareLink();
    await load();
    const copied = await copyLink(token);
    setNotice(`${copied ? 'Link made and copied.' : 'Link made. Copy its address from the list below.'} Anyone with it can read these notes until you turn it off.`);
  }, 'Unable to make a link.');

  const revoke = (link: ShareLink) => {
    if (!confirm('Turn off this link? It will stop working for everyone. Notes people already added to their own account stay theirs.')) return;
    void run(async () => { await revokeShareLink(link.id); await load(); }, 'Unable to turn off this link.');
  };

  const remove = (note: PublicNote) => {
    if (!confirm(`Remove “${titleOf(note.rawText)}” from your public notes? Links you already made keep showing it until you turn them off.`)) return;
    void run(async () => { await removePublicNote(note.id); await load(); }, 'Unable to remove this note.');
  };

  const addNotes = (picked: Note[]) => run(async () => {
    await copyNotesToPublic(picked);
    await load();
    setPickerOpen(false);
    setNotice(`${picked.length} ${picked.length === 1 ? 'note is' : 'notes are'} now in your public notes. Make a link to share them.`);
  }, 'Unable to add these notes.');

  const copyToPrivate = (note: PublicNote) => run(async () => {
    await copyPublicNoteToPrivate(note);
    setNotice(`“${titleOf(note.rawText)}” was copied to your own notes.`);
  }, 'Unable to copy this note.');

  if (loading) return <div className="flex h-[100dvh] items-center justify-center bg-white"><Loader2 className="h-7 w-7 animate-spin text-[#477bea]" /></div>;

  const activeLinks = links.filter((link) => !link.revokedAt);
  const revokedLinks = links.filter((link) => link.revokedAt);

  return (
    <div className="min-h-[100dvh] bg-[#fafafb] text-[#252525]">
      <header className="border-b border-[#ececef] bg-white">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-3 px-4">
          <Link href="/" aria-label="Back to my notes" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-[#f5f5f5]"><ArrowLeft className="h-4 w-4" /></Link>
          <h1 className="text-base font-semibold text-[#222]">Sharing</h1>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-24 pt-8">
        {error && <p role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
        {notice && <p role="status" className="mb-4 rounded-md border border-[#cfdcff] bg-[#f3f6ff] px-4 py-3 text-sm text-[#333]">{notice}</p>}

        <section aria-labelledby="public-notes-heading">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="public-notes-heading" className="text-lg font-semibold text-[#222]">Public notes</h2>
              <p className="mt-1 max-w-xl text-sm leading-relaxed text-[#777]">Copies of notes you chose to share. Your other notes stay private: a link only ever shows what is listed here.</p>
            </div>
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => setPickerOpen(true)} className="inline-flex items-center gap-2 rounded-md border border-[#dedede] bg-white px-4 py-2 text-sm font-medium hover:border-[#adc3ff] hover:text-[#477bea] disabled:opacity-50"><Plus className="h-4 w-4" aria-hidden />Add notes</button>
              <button type="button" disabled={busy || !notes.length} onClick={() => void makeLink()} className="inline-flex items-center gap-2 rounded-md bg-[#477bea] px-4 py-2 text-sm font-medium text-white hover:bg-[#3d6ed7] disabled:cursor-not-allowed disabled:opacity-50"><Link2 className="h-4 w-4" aria-hidden />Make link</button>
            </div>
          </div>

          {notes.length === 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-[#d5d7dd] bg-white p-8 text-center">
              <p className="text-sm font-medium text-[#333]">No public notes yet</p>
              <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-[#777]">Pick the notes you want to share, then make a link to them.</p>
              <button type="button" onClick={() => setPickerOpen(true)} className="mt-4 inline-flex items-center gap-2 rounded-md bg-[#477bea] px-4 py-2 text-sm font-medium text-white hover:bg-[#3d6ed7]"><Plus className="h-4 w-4" aria-hidden />Add notes</button>
            </div>
          ) : (
            <ul className="mt-5 space-y-2">
              {notes.map((note) => (
                <li key={note.id} className="flex items-start gap-3 rounded-xl border border-[#e6e7eb] bg-white p-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-[#222]">{titleOf(note.rawText)}</p>
                    {previewOf(note.rawText) && <p className="mt-0.5 line-clamp-2 text-sm text-[#777]">{previewOf(note.rawText)}</p>}
                  </div>
                  <button type="button" disabled={busy} onClick={() => void copyToPrivate(note)} className="shrink-0 rounded-md border border-[#dedede] px-3 py-1.5 text-xs hover:border-[#adc3ff] hover:text-[#477bea] disabled:opacity-50">Copy to my notes</button>
                  <button type="button" disabled={busy} onClick={() => remove(note)} aria-label={`Remove ${titleOf(note.rawText)} from public notes`} title="Remove from public notes" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-red-600 hover:bg-red-50 disabled:opacity-50"><Trash2 className="h-4 w-4" /></button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-12" aria-labelledby="links-heading">
          <h2 id="links-heading" className="text-lg font-semibold text-[#222]">Links</h2>
          <p className="mt-1 max-w-xl text-sm leading-relaxed text-[#777]">A link shares your public notes as they were when you made it. After changing them, make a new link.</p>

          {activeLinks.length === 0 && <p className="mt-5 text-sm text-[#9a9aa3]">You have no working links.</p>}
          <ul className="mt-5 space-y-2">
            {activeLinks.map((link) => (
              <li key={link.id} className="rounded-xl border border-[#e6e7eb] bg-white p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 flex-1 text-sm text-[#333]"><span className="font-medium">{link.noteCount} {link.noteCount === 1 ? 'note' : 'notes'}</span> · made {formatDate(link.createdAt)}</p>
                  <button type="button" onClick={() => void copyLinkFromList(link.token)} className="inline-flex items-center gap-1.5 rounded-md border border-[#dedede] px-3 py-1.5 text-xs hover:border-[#adc3ff] hover:text-[#477bea]">{copiedToken === link.token ? <><Check className="h-3.5 w-3.5" aria-hidden />Copied</> : <><Copy className="h-3.5 w-3.5" aria-hidden />Copy link</>}</button>
                  <Link href={`/s/${link.token}`} className="rounded-md border border-[#dedede] px-3 py-1.5 text-xs hover:border-[#adc3ff] hover:text-[#477bea]">Open</Link>
                  <button type="button" disabled={busy} onClick={() => revoke(link)} className="rounded-md px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50">Turn off</button>
                </div>
                <input readOnly value={typeof window === 'undefined' ? '' : shareUrl(link.token)} onFocus={(event) => event.currentTarget.select()} aria-label="Link address" className="mt-3 w-full rounded-md border border-[#ececef] bg-[#fafafb] px-3 py-2 text-xs text-[#555] outline-none focus:border-[#adc3ff]" />
              </li>
            ))}
          </ul>

          {revokedLinks.length > 0 && (
            <details className="mt-6">
              <summary className="cursor-pointer text-sm text-[#777] hover:text-[#333]">{revokedLinks.length} turned off</summary>
              <ul className="mt-3 space-y-1.5">
                {revokedLinks.map((link) => <li key={link.id} className="text-sm text-[#9a9aa3]">{link.noteCount} {link.noteCount === 1 ? 'note' : 'notes'} · made {formatDate(link.createdAt)} · turned off {formatDate(link.revokedAt!)}</li>)}
              </ul>
            </details>
          )}
        </section>
      </main>
      {pickerOpen && user && <ShareNotePicker userId={user.id} alreadyPublic={new Set(notes.map((note) => note.sourceNoteId).filter((id): id is string => Boolean(id)))} onClose={() => setPickerOpen(false)} onAdd={addNotes} />}
    </div>
  );
}
