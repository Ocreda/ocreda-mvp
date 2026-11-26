import { supabase } from './supabase';
import { IS_LOCAL_MODE } from '@/dev/local-mode';  // DEV-LOCAL-MODE

/**
 * Sends a comment from the "Send feedback" box to the send-feedback Edge
 * Function, which emails it to the team. Where it goes is configured on the
 * server only; the browser never learns the address.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Same limits the server enforces (supabase/functions/_shared/feedback.ts).
export const MAX_FEEDBACK_WORDS = 4000;
export const MAX_FEEDBACK_CHARS = 60_000;

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export async function sendFeedback(message: string): Promise<void> {
  const body = JSON.stringify({
    message,
    page: typeof window === 'undefined' ? null : window.location.pathname + window.location.search,
    sent_at: new Date().toISOString(),
  });

  let response: Response;
  try {
    if (IS_LOCAL_MODE) {  // DEV-LOCAL-MODE
      response = await fetch('/api/send-feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });  // DEV-LOCAL-MODE
    } else {  // DEV-LOCAL-MODE
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('Sign in to send feedback.');
      response = await fetch(`${SUPABASE_URL}/functions/v1/send-feedback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body,
      });
    }  // DEV-LOCAL-MODE
  } catch (error) {
    if (error instanceof Error && error.message === 'Sign in to send feedback.') throw error;
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    throw new Error(typeof payload?.error === 'string' ? payload.error : "Couldn't send your feedback right now. Please try again.");
  }
}
