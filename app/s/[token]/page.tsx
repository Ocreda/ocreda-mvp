import type { Metadata } from 'next';
import { Suspense } from 'react';
import SharedLink from '@/components/SharedLink';

type Props = { params: { token: string } };

const FALLBACK: Metadata = {
  title: 'Notes shared on Ocreda',
  description: 'Open to read them. No account needed.',
  // Shared notes are for the people sent the link, not for search engines.
  robots: { index: false, follow: false },
};

/** The title and description shown when the link is pasted into a chat or post. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return FALLBACK;
  try {
    const response = await fetch(`${url}/rest/v1/rpc/get_shared_link`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ link_token: params.token }),
      cache: 'no-store',
    });
    const view = response.ok ? await response.json() as { sharer_name?: string; notes?: Array<{ title?: string }> } | null : null;
    if (!view?.notes?.length) return FALLBACK;
    const count = view.notes.length;
    const title = `${view.sharer_name ?? 'Someone'} shared ${count} ${count === 1 ? 'note' : 'notes'} on Ocreda`;
    const titles = view.notes.slice(0, 3).map((note) => note.title).filter(Boolean).join(' · ');
    const description = titles ? `${titles}${count > 3 ? ' and more' : ''}` : FALLBACK.description!;
    return { ...FALLBACK, title, description, openGraph: { title, description, type: 'article', siteName: 'Ocreda' }, twitter: { card: 'summary', title, description } };
  } catch {
    return FALLBACK;
  }
}

export default function SharedLinkPage({ params }: Props) {
  return <Suspense fallback={null}><SharedLink token={params.token} /></Suspense>;
}
