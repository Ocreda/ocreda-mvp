'use client';

import { format } from 'date-fns';

interface ClickableDateProps {
  dateStr: string;
  formatStr?: string;
  onClick: (dateStr: string) => void;
  className?: string;
}

export default function ClickableDate({ dateStr, formatStr = 'MMM d, yyyy', onClick, className }: ClickableDateProps) {
  const label = format(new Date(dateStr), formatStr);
  const calDay = format(new Date(dateStr), 'yyyy-MM-dd');

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick(calDay);
      }}
      className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground border border-border hover:bg-accent hover:text-primary hover:border-primary/20 transition-all cursor-pointer ${className ?? ''}`}
    >
      {label}
    </button>
  );
}
