'use client';

import { useTagFilter } from '@/lib/tag-filter-context';

interface ClickableTagProps {
  tag: string;
  active?: boolean;
  className?: string;
}

export default function ClickableTag({ tag, active, className }: ClickableTagProps) {
  const { openTag } = useTagFilter();

  const base = active
    ? 'bg-primary/10 text-primary border border-primary/30 font-semibold cursor-default'
    : 'bg-muted text-muted-foreground border border-border hover:bg-accent hover:text-primary hover:border-primary/20 cursor-pointer';

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (!active) openTag(tag);
      }}
      className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-md transition-all ${base} ${className ?? ''}`}
    >
      {tag}
    </button>
  );
}
