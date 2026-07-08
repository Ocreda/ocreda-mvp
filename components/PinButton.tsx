'use client';

import { useState, useRef, useEffect } from 'react';
import { Pin, PinOff, Clock, Loader as Loader2 } from 'lucide-react';
import { usePinned } from '@/lib/pinned-context';

const DURATION_OPTIONS = [
  { label: 'Always', ms: null },
  { label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '30 days', ms: 30 * 24 * 60 * 60 * 1000 },
] as const;

interface PinButtonProps {
  noteId: string;
}

export default function PinButton({ noteId }: PinButtonProps) {
  const { isPinned, pin, unpin } = usePinned();
  const pinned = isPinned(noteId);

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setError('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleUnpin = async () => {
    setLoading(true);
    try {
      await unpin(noteId);
    } finally {
      setLoading(false);
      setOpen(false);
    }
  };

  const handlePin = async (ms: number | null) => {
    setLoading(true);
    setError('');
    try {
      const result = await pin(noteId, ms);
      if (result.error) {
        setError(result.error);
        setLoading(false);
        return;
      }
      setOpen(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => { setOpen((v) => !v); setError(''); }}
        className={`p-1.5 rounded-lg transition-all ${
          pinned
            ? 'text-amber-500 hover:text-amber-400 hover:bg-amber-500/10'
            : 'text-muted-foreground/40 hover:text-foreground hover:bg-accent'
        }`}
        title={pinned ? 'Pinned — click to manage' : 'Pin note'}
        disabled={loading}
      >
        {loading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : pinned ? (
          <Pin className="w-3.5 h-3.5 fill-current" />
        ) : (
          <Pin className="w-3.5 h-3.5" />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-[200] bg-popover border border-border rounded-xl shadow-xl overflow-hidden min-w-[170px]">
          {pinned ? (
            <>
              <div className="px-3 py-2 border-b border-border/50">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Pinned</p>
              </div>
              {DURATION_OPTIONS.map(({ label, ms }) => (
                <button
                  key={label}
                  onClick={() => handlePin(ms)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-foreground/80 hover:bg-accent hover:text-foreground transition-colors text-left"
                >
                  <Clock className="w-3 h-3 text-muted-foreground/50 flex-shrink-0" />
                  {label}
                </button>
              ))}
              <div className="border-t border-border/50">
                <button
                  onClick={handleUnpin}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-destructive/70 hover:bg-destructive/10 hover:text-destructive transition-colors text-left"
                >
                  <PinOff className="w-3 h-3 flex-shrink-0" />
                  Unpin
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="px-3 py-2 border-b border-border/50">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Pin for</p>
              </div>
              {DURATION_OPTIONS.map(({ label, ms }) => (
                <button
                  key={label}
                  onClick={() => handlePin(ms)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-foreground/80 hover:bg-accent hover:text-foreground transition-colors text-left"
                >
                  <Clock className="w-3 h-3 text-muted-foreground/50 flex-shrink-0" />
                  {label}
                </button>
              ))}
            </>
          )}
          {error && (
            <div className="px-3 py-2 border-t border-border/50 bg-destructive/5">
              <p className="text-[11px] text-destructive leading-snug">{error}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
