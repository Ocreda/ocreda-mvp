'use client';

import { useState, useRef, useEffect } from 'react';
import { Tag, Calendar, ArrowUpDown, ArrowUp, ArrowDown, X } from 'lucide-react';
import { useTagFilter } from '@/lib/tag-filter-context';

export type SortOrder = 'newest' | 'oldest';

export interface FilterState {
  dateFrom: string;
  dateTo: string;
  sortOrder: SortOrder;
}

interface NoteFilterBarProps {
  allTags: string[];
  filters: FilterState;
  onChange: (f: FilterState) => void;
}

const defaultFilters = (): FilterState => ({
  dateFrom: '',
  dateTo: '',
  sortOrder: 'newest',
});

type ActivePanel = 'tags' | 'date' | null;

export function useFilterState() {
  const [filters, setFilters] = useState<FilterState>(defaultFilters());
  return { filters, setFilters };
}

export default function NoteFilterBar({ allTags, filters, onChange }: NoteFilterBarProps) {
  const { openTag } = useTagFilter();
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);
  const dateFromRef = useRef<HTMLInputElement>(null);

  const hasDateFilter = filters.dateFrom || filters.dateTo;

  const togglePanel = (panel: ActivePanel) => {
    setActivePanel((prev) => (prev === panel ? null : panel));
  };

  const clearDate = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange({ ...filters, dateFrom: '', dateTo: '' });
  };

  const toggleSort = () => {
    const next: SortOrder = filters.sortOrder === 'newest' ? 'oldest' : 'newest';
    onChange({ ...filters, sortOrder: next });
  };

  useEffect(() => {
    if (activePanel === 'date') {
      setTimeout(() => dateFromRef.current?.focus(), 50);
    }
  }, [activePanel]);

  const chipBase = 'flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all select-none';
  const chipInactive = 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-accent border border-transparent';
  const chipActive = 'text-foreground bg-accent border border-border';

  return (
    <div className="mb-6">
      {/* Chip row */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {/* Tags chip */}
        <button
          onClick={() => togglePanel('tags')}
          className={`${chipBase} ${activePanel === 'tags' ? chipActive : chipInactive} cursor-pointer`}
        >
          <Tag className="w-3 h-3" />
          Tags
          {allTags.length > 0 && (
            <span className="ml-0.5 text-[10px] text-muted-foreground/40">{allTags.length}</span>
          )}
        </button>

        {/* Date chip */}
        <button
          onClick={() => togglePanel('date')}
          className={`${chipBase} ${activePanel === 'date' || hasDateFilter ? chipActive : chipInactive} cursor-pointer`}
        >
          <Calendar className="w-3 h-3" />
          Date
          {hasDateFilter && (
            <button
              onClick={clearDate}
              className="ml-0.5 text-muted-foreground/50 hover:text-foreground transition-colors"
              title="Clear date filter"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          )}
        </button>

        {/* Sort chip */}
        <button
          onClick={toggleSort}
          className={`${chipBase} ${filters.sortOrder === 'oldest' ? chipActive : chipInactive} cursor-pointer`}
        >
          {filters.sortOrder === 'newest' ? (
            <ArrowDown className="w-3 h-3" />
          ) : (
            <ArrowUp className="w-3 h-3" />
          )}
          {filters.sortOrder === 'newest' ? 'Newest' : 'Oldest'}
        </button>
      </div>

      {/* Tags panel */}
      {activePanel === 'tags' && (
        <div className="mt-3 p-3 bg-muted/30 border border-border rounded-xl">
          {allTags.length === 0 ? (
            <p className="text-xs text-muted-foreground/50 py-1">No tags yet.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {allTags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => { setActivePanel(null); openTag(tag); }}
                  className="text-[11px] px-2 py-0.5 rounded-md bg-muted border border-border text-muted-foreground hover:bg-accent hover:text-primary hover:border-primary/20 transition-all"
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Date panel */}
      {activePanel === 'date' && (
        <div className="mt-3 p-3 bg-muted/30 border border-border rounded-xl">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-muted-foreground/60 font-medium whitespace-nowrap">From</label>
              <input
                ref={dateFromRef}
                type="date"
                value={filters.dateFrom}
                onChange={(e) => onChange({ ...filters, dateFrom: e.target.value })}
                className="text-xs px-2 py-1 rounded-lg border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30 transition-all"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-muted-foreground/60 font-medium whitespace-nowrap">To</label>
              <input
                type="date"
                value={filters.dateTo}
                onChange={(e) => onChange({ ...filters, dateTo: e.target.value })}
                className="text-xs px-2 py-1 rounded-lg border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30 transition-all"
              />
            </div>
            {hasDateFilter && (
              <button
                onClick={() => onChange({ ...filters, dateFrom: '', dateTo: '' })}
                className="text-[11px] text-muted-foreground/50 hover:text-foreground transition-colors flex items-center gap-1"
              >
                <X className="w-3 h-3" />
                Clear
              </button>
            )}
          </div>
          {hasDateFilter && (
            <p className="text-[10px] text-muted-foreground/40 mt-2">
              Showing notes{filters.dateFrom ? ` from ${filters.dateFrom}` : ''}{filters.dateTo ? ` to ${filters.dateTo}` : ''}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Apply filter state to a list of notes */
export function applyFilters<T extends { created_at: string }>(
  notes: T[],
  filters: FilterState
): T[] {
  let result = [...notes];

  if (filters.dateFrom) {
    const from = new Date(filters.dateFrom + 'T00:00:00');
    result = result.filter((n) => new Date(n.created_at) >= from);
  }
  if (filters.dateTo) {
    const to = new Date(filters.dateTo + 'T23:59:59');
    result = result.filter((n) => new Date(n.created_at) <= to);
  }

  result.sort((a, b) => {
    const diff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    return filters.sortOrder === 'newest' ? diff : -diff;
  });

  return result;
}
