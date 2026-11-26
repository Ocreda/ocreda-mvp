'use client';

import { useEffect, useRef, useState } from 'react';
import { countWords, MAX_FEEDBACK_CHARS, MAX_FEEDBACK_WORDS, sendFeedback } from '@/lib/feedback';

type Status = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'error'; message: string };

/**
 * The header's "Send feedback" button. Opens a small comment box right under
 * it; Send posts the comment to the server, which emails it to the team.
 */
export function FeedbackButton({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const wrapperRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The button sits inside the Beta pill, which clips overflow, so the box is
  // placed on the page under the button rather than inside it.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    textareaRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function openBox() {
    const rect = wrapperRef.current?.getBoundingClientRect();
    setAnchor(rect ? { top: rect.bottom + 8, right: Math.max(16, window.innerWidth - rect.right) } : null);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    // A sent comment is done; an unsent draft stays for next time.
    setStatus((current) => {
      if (current.kind === 'sent') setMessage('');
      return { kind: 'idle' };
    });
  }

  async function submit() {
    const text = message.trim();
    if (!text) {
      setStatus({ kind: 'error', message: 'Write a comment before sending.' });
      return;
    }
    setStatus({ kind: 'sending' });
    try {
      await sendFeedback(text);
      setStatus({ kind: 'sent' });
    } catch (error) {
      setStatus({ kind: 'error', message: error instanceof Error ? error.message : "Couldn't send your feedback right now." });
    }
  }

  const sending = status.kind === 'sending';
  const words = countWords(message);
  const tooLong = words > MAX_FEEDBACK_WORDS || message.length > MAX_FEEDBACK_CHARS;

  return (
    <div ref={wrapperRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => (open ? close() : openBox())}
        aria-expanded={open}
        className="h-full px-3 py-1.5 text-[#252525] hover:bg-[#f5f7fb] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#477bea]"
      >
        Send feedback
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Send feedback"
          style={anchor ? { top: anchor.top, right: anchor.right } : undefined}
          className="fixed right-4 top-14 z-[130] w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-[#dfe3ea] bg-white p-3 text-left shadow-lg"
        >
          {status.kind === 'sent' ? (
            <div className="space-y-3">
              <p role="status" className="text-sm text-[#252525]">Thanks — your feedback was sent.</p>
              <div className="flex justify-end">
                <button type="button" onClick={close} className="rounded-md bg-[#477bea] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#3a6bd6]">Close</button>
              </div>
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
              className="space-y-2"
            >
              <label htmlFor="ocreda-feedback" className="block text-sm font-medium text-[#252525]">What&apos;s on your mind?</label>
              <textarea
                id="ocreda-feedback"
                ref={textareaRef}
                value={message}
                onChange={(event) => {
                  setMessage(event.target.value);
                  if (status.kind === 'error') setStatus({ kind: 'idle' });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void submit();
                  }
                }}
                disabled={sending}
                rows={5}
                placeholder="A bug, an idea, anything that felt off…"
                className="block w-full resize-y rounded-md border border-[#dfe3ea] px-2.5 py-2 text-sm text-[#252525] placeholder:text-[#9aa0ab] focus:border-[#477bea] focus:outline-none focus:ring-1 focus:ring-[#477bea] disabled:bg-[#f7f8fa]"
              />
              {tooLong && <p className="text-xs text-[#b42318]">Please keep it under {MAX_FEEDBACK_WORDS.toLocaleString('en-US')} words ({words.toLocaleString('en-US')} now).</p>}
              {status.kind === 'error' && <p role="alert" className="text-xs text-[#b42318]">{status.message}</p>}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button type="button" onClick={close} disabled={sending} className="rounded-md px-3 py-1.5 text-sm text-[#555b66] hover:bg-[#f5f7fb] disabled:opacity-50">Cancel</button>
                <button
                  type="submit"
                  disabled={sending || tooLong || !message.trim()}
                  className="rounded-md bg-[#477bea] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#3a6bd6] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
