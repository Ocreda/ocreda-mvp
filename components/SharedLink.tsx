'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Check, Loader as Loader2, Lock } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { clearPendingShare, copySharedNotes, FREE_SHARED_NOTES, getSharedLink, rememberPendingShare, SharedLinkView, SharedNote } from '@/lib/sharing-api';
import { IS_LOCAL_MODE } from '@/dev/local-mode';  // DEV-LOCAL-MODE

/**
 * The page a share link opens. Without an account: who shared, how Ocreda
 * works, the first notes in full and the titles of the rest, which signing up
 * unlocks. Signed in: every note, and one button to copy them into your own.
 */

const HOW_IT_WORKS = [
  { title: 'Write notes as you go', text: 'Ideas, lessons, things you read. No folders or tags to keep up.' },
  { title: 'Your notes come back to you', text: 'While you write, Ocreda brings up the older notes that matter to what you are working on.' },
  { title: 'See how they connect', text: 'It shows where a note supports, extends or contradicts another, in your own words.' },
];

function bodyOf(note: SharedNote): string {
  return (note.text ?? '').trim().split('\n').slice(1).join('\n').trim();
}

function Avatar({ name, url }: { name: string; url: string | null }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" className="h-12 w-12 rounded-full object-cover" />;
  }
  return <div aria-hidden className="flex h-12 w-12 items-center justify-center rounded-full bg-[#bd315c] text-lg font-medium text-white">{name.trim().charAt(0).toUpperCase() || '?'}</div>;
}

function NoteCard({ note }: { note: SharedNote }) {
  const [open, setOpen] = useState(false);
  const body = bodyOf(note);
  const long = body.length > 420;
  return (
    <article className="rounded-xl border border-[#e6e7eb] bg-white p-5 shadow-sm">
      <h3 className="text-base font-semibold text-[#222]">{note.title || 'Untitled note'}</h3>
      {body && <p className={`mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[#555] ${long && !open ? 'line-clamp-6' : ''}`}>{body}</p>}
      {long && <button type="button" onClick={() => setOpen((value) => !value)} className="mt-2 text-sm font-medium text-[#477bea] hover:underline">{open ? 'Show less' : 'Read the whole note'}</button>}
    </article>
  );
}

function LockedNoteCard({ note }: { note: SharedNote }) {
  return (
    <article className="rounded-xl border border-[#ececef] bg-[#f7f7f9] p-5" aria-label={`${note.title || 'Note'} (sign up to read)`}>
      <h3 className="flex items-center gap-2 text-base font-semibold text-[#9a9aa3]"><Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />{note.title || 'Untitled note'}</h3>
      <div aria-hidden className="mt-3 space-y-2">
        <div className="h-2.5 w-full rounded bg-[#e6e6ea]" />
        <div className="h-2.5 w-11/12 rounded bg-[#e6e6ea]" />
        <div className="h-2.5 w-2/3 rounded bg-[#e6e6ea]" />
      </div>
    </article>
  );
}

export default function SharedLink({ token }: { token: string }) {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Local development has one account that is always signed in; ?as=visitor shows the signed-out page.
  const asVisitor = IS_LOCAL_MODE && searchParams.get('as') === 'visitor';  // DEV-LOCAL-MODE
  const signedIn = Boolean(user) && !asVisitor;

  const [view, setView] = useState<SharedLinkView | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [copying, setCopying] = useState(false);
  const [copiedTo, setCopiedTo] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (authLoading) return;
    let current = true;
    setState('loading');
    getSharedLink(token, asVisitor)
      .then((loaded) => {
        if (!current) return;
        setView(loaded);
        setCopiedTo(loaded?.copiedToDomain ?? null);
        setState(loaded ? 'ready' : 'missing');
      })
      .catch(() => { if (current) setState('error'); });
    return () => { current = false; };
    // Reloads when the visitor signs in, which unlocks the rest of the notes.
  }, [asVisitor, authLoading, token, user?.id]);

  // Back from signing up: the link has done its job of bringing them here.
  useEffect(() => { if (signedIn) clearPendingShare(); }, [signedIn]);

  const signUp = () => {
    rememberPendingShare(token);
    router.push('/auth');
  };

  const addToMyNotes = async () => {
    setCopying(true); setError('');
    try { setCopiedTo((await copySharedNotes(token)).domain); }
    catch (err) { setError(err instanceof Error && err.message ? err.message : 'These notes could not be added. Please try again.'); }
    finally { setCopying(false); }
  };

  if (authLoading || state === 'loading') {
    return <div className="flex min-h-[100dvh] items-center justify-center bg-white"><Loader2 className="h-7 w-7 animate-spin text-[#477bea]" /></div>;
  }

  if (state !== 'ready' || !view) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-white px-5 text-center">
        <div className="max-w-sm">
          <Image src="/ocreda-logo.png" alt="Ocreda" width={44} height={44} className="mx-auto object-contain" />
          <h1 className="mt-5 text-xl font-semibold text-[#222]">{state === 'error' ? 'This link could not be opened' : 'This link is no longer shared'}</h1>
          <p className="mt-2 text-sm leading-relaxed text-[#777]">{state === 'error' ? 'Check your connection and try again.' : 'The person who shared it has turned it off, or the address is incomplete.'}</p>
          <Link href="/" className="mt-6 inline-block rounded-md bg-[#477bea] px-4 py-2 text-sm font-medium text-white hover:bg-[#3d6ed7]">Go to Ocreda</Link>
        </div>
      </div>
    );
  }

  const total = view.notes.length;
  const readable = view.notes.filter((note) => note.text !== null);
  const locked = view.notes.filter((note) => note.text === null);
  const noteWord = total === 1 ? 'note' : 'notes';

  return (
    <div className="min-h-[100dvh] bg-[#fafafb] text-[#252525]">
      <header className="sticky top-0 z-10 border-b border-[#ececef] bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold text-[#222]"><Image src="/ocreda-logo.png" alt="" width={24} height={24} className="object-contain" />Ocreda</Link>
          {signedIn
            ? <Link href="/" className="rounded-md border border-[#dedede] bg-white px-3 py-1.5 text-sm hover:border-[#adc3ff] hover:text-[#477bea]">My notes</Link>
            : <button type="button" onClick={signUp} className="rounded-md bg-[#477bea] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#3d6ed7]">Sign up free</button>}
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-24 pt-8">
        <section className="flex items-center gap-4">
          <Avatar name={view.sharerName} url={view.sharerAvatarUrl} />
          <div>
            <h1 className="text-xl font-semibold text-[#222] sm:text-2xl">{view.sharerName} shared {total} {noteWord} with you</h1>
            <p className="mt-0.5 text-sm text-[#777]">From their notes on Ocreda</p>
          </div>
        </section>

        {signedIn && (
          <section className="mt-6 rounded-xl border border-[#cfdcff] bg-[#f3f6ff] p-4 sm:flex sm:items-center sm:justify-between sm:gap-4">
            {view.isOwner ? (
              <>
                <p className="text-sm text-[#333]">This is your own link. This is what people you send it to will see.</p>
                <Link href="/sharing" className="mt-3 inline-block shrink-0 rounded-md border border-[#adc3ff] bg-white px-4 py-2 text-sm font-medium text-[#477bea] hover:bg-[#f5f7fb] sm:mt-0">Manage sharing</Link>
              </>
            ) : copiedTo ? (
              <>
                <p className="flex items-center gap-2 text-sm text-[#333]"><Check className="h-4 w-4 shrink-0 text-[#2e9a5b]" aria-hidden />These notes are in your “{copiedTo}” Domain. Ocreda will bring them up while you write.</p>
                <Link href="/" className="mt-3 inline-block shrink-0 rounded-md bg-[#477bea] px-4 py-2 text-sm font-medium text-white hover:bg-[#3d6ed7] sm:mt-0">Open my notes</Link>
              </>
            ) : (
              <>
                <p className="text-sm text-[#333]">Add these {noteWord} to your own Ocreda. They become yours to keep, and show up alongside what you write.</p>
                <button type="button" disabled={copying} onClick={() => void addToMyNotes()} className="mt-3 inline-flex shrink-0 items-center gap-2 rounded-md bg-[#477bea] px-4 py-2 text-sm font-medium text-white hover:bg-[#3d6ed7] disabled:cursor-wait disabled:opacity-60 sm:mt-0">
                  {copying && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}Add {total === 1 ? 'this note' : `all ${total} notes`} to my Ocreda
                </button>
              </>
            )}
          </section>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}

        {!signedIn && (
          <section className="mt-6 rounded-xl border border-[#e6e7eb] bg-white p-5" aria-labelledby="how-ocreda-works">
            <h2 id="how-ocreda-works" className="text-sm font-semibold text-[#222]">How Ocreda works</h2>
            <p className="mt-1 text-sm text-[#777]">You don’t look for your notes. They come to you.</p>
            <ol className="mt-4 grid gap-4 sm:grid-cols-3">
              {HOW_IT_WORKS.map((step, index) => (
                <li key={step.title}>
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[#eef2ff] text-xs font-semibold text-[#477bea]">{index + 1}</div>
                  <h3 className="mt-2 text-sm font-medium text-[#222]">{step.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-[#777]">{step.text}</p>
                </li>
              ))}
            </ol>
          </section>
        )}

        <section className="mt-8 space-y-3" aria-label="Shared notes">
          {readable.map((note) => <NoteCard key={note.position} note={note} />)}
        </section>

        {!signedIn && (
          <section className="mt-3">
            {locked.length > 0 && (
              <>
                <div className="space-y-3">{locked.slice(0, FREE_SHARED_NOTES).map((note) => <LockedNoteCard key={note.position} note={note} />)}</div>
                {locked.length > FREE_SHARED_NOTES && <p className="mt-3 text-center text-sm text-[#9a9aa3]">and {locked.length - FREE_SHARED_NOTES} more</p>}
              </>
            )}
            <div className="mt-6 rounded-xl border border-[#cfdcff] bg-[#f3f6ff] p-6 text-center">
              <h2 className="text-lg font-semibold text-[#222]">{locked.length > 0 ? `Read the other ${locked.length} ${locked.length === 1 ? 'note' : 'notes'} ${view.sharerName} shared` : `Keep ${view.sharerName}’s ${noteWord}`}</h2>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[#555]">Sign up free to {locked.length > 0 ? 'read them all, ' : ''}add them to your own notes, and see how they connect to what you write.</p>
              <button type="button" onClick={signUp} className="mt-4 rounded-md bg-[#477bea] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#3d6ed7]">{locked.length > 0 ? `Show all ${total} notes` : 'Sign up free'}</button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
