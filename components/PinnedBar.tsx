'use client';

import { usePinned } from '@/lib/pinned-context';

interface PinnedBarProps {
  onOpenNote?: (noteId: string) => void;
}

export default function PinnedBar({ onOpenNote }: PinnedBarProps) {
  const { pins } = usePinned();

  if (pins.length === 0) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      {pins.map((p) => (
        <button
          key={p.note_id}
          onClick={() => onOpenNote?.(p.note_id)}
          className="text-xs text-muted-foreground hover:text-foreground truncate max-w-[120px] transition-colors"
        >
          {p.note_id}
        </button>
      ))}
    </div>
  );
}
