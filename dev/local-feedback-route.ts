import { NextResponse } from 'next/server';
import {
  deliverFeedback,
  feedbackEmailText,
  overFeedbackLimit,
  readFeedbackInput,
} from '@/supabase/functions/_shared/feedback';
import { LOCAL_USER } from '@/dev/local-mode';

/**
 * Development-only stand-in for the send-feedback Edge Function. Same checks
 * and the same email, from _shared/feedback.ts. With RESEND_API_KEY and
 * FEEDBACK_TO_EMAIL in .env.local it really emails; without them it prints the
 * feedback to the dev server's terminal.
 *
 * No authentication here (local mode has one fake user), so it refuses to run
 * unless local mode is on.
 */
export async function POST(request: Request) {
  if (process.env.NEXT_PUBLIC_LOCAL_MODE !== '1') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const input = readFeedbackInput(await request.json().catch(() => null));
  if ('error' in input) return NextResponse.json({ error: input.error }, { status: 400 });
  if (overFeedbackLimit(LOCAL_USER.id)) {
    return NextResponse.json({ error: "Thanks — that's a lot of feedback at once. Please try again in a few minutes." }, { status: 429 });
  }

  const sender = { userId: LOCAL_USER.id, email: LOCAL_USER.email };
  const receivedAt = new Date().toISOString();
  try {
    const outcome = await deliverFeedback(input, sender, {
      resendApiKey: process.env.RESEND_API_KEY || null,
      to: process.env.FEEDBACK_TO_EMAIL || null,
      from: process.env.FEEDBACK_FROM_EMAIL || null,
    }, receivedAt);
    if (outcome.status === 'failed') {
      console.error(`[local feedback] ${outcome.detail}`);
      return NextResponse.json({ error: "Couldn't send your feedback right now. Please try again." }, { status: 502 });
    }
    if (outcome.status === 'logged') {
      console.log(`[local feedback] No RESEND_API_KEY/FEEDBACK_TO_EMAIL set, so not emailed:\n${feedbackEmailText(input, sender, receivedAt)}`);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[local feedback]', error);
    return NextResponse.json({ error: "Couldn't send your feedback right now. Please try again." }, { status: 502 });
  }
}
