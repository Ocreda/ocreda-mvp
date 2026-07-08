'use client';

import { usePinned } from '@/lib/pinned-context';

interface TopPillBarProps {
  onOpenNote?: (noteId: string) => void;
}

export default function TopPillBar({ onOpenNote }: TopPillBarProps) {
  const { pins } = usePinned();

  if (pins.length === 0) return null;

  return (
    <div className="flex items-center gap-2 px-4 py-2">
      {pins.map((pin) => {
        const note = pin.note;
        if (!note) return null;
        const firstLine = note.content.split('\n').find((l) => l.trim()) ?? '';
        const subtitle = note.title ? firstLine : '';
        return (
          <button
            key={pin.note_id}
            onClick={() => onOpenNote?.(pin.note_id)}
            className="flex flex-col items-start text-left px-3 py-1.5 rounded-lg bg-accent/50 hover:bg-accent transition-colors max-w-[160px]"
          >
            <span className="text-xs font-medium text-foreground truncate w-full">
              {note.title || firstLine}
            </span>
            {subtitle && (
              <span className="text-[11px] text-muted-foreground truncate w-full">{subtitle}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
