'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Note } from '@/lib/types';
import { ArrowRight } from 'lucide-react';

// Original distinct muted pastel palette — 8 clearly different hues
const CATEGORY_COLORS = [
  { bg: '#E8E4F0', title: '#1A1018', meta: '#4A3F58', preview: '#3D3349', border: '#D8D0E8' },  // soft lavender
  { bg: '#B8C9D9', title: '#0D1C28', meta: '#2E4A5E', preview: '#243D50', border: '#A4BAD0' },  // muted steel blue
  { bg: '#C5D5C5', title: '#0F1F0F', meta: '#2E4A2E', preview: '#263D26', border: '#B0C8B0' },  // soft sage green
  { bg: '#E8C5C5', title: '#2A0F0F', meta: '#5E2E2E', preview: '#4A2424', border: '#DDB0B0' },  // warm dusty rose
  { bg: '#E8DDB5', title: '#1F1A00', meta: '#4A3F0A', preview: '#3D3308', border: '#DDD0A0' },  // muted warm yellow
  { bg: '#D9B8A8', title: '#221208', meta: '#4A2E1A', preview: '#3D2614', border: '#CCAA94' },  // soft terracotta
  { bg: '#B5D0D0', title: '#081E1E', meta: '#1A4040', preview: '#143333', border: '#A0C4C4' },  // muted teal
  { bg: '#D5C0D0', title: '#1E0F1C', meta: '#4A2E48', preview: '#3D263B', border: '#C8AEC4' },  // soft dusty mauve
  { bg: '#C8D0C0', title: '#0F1A0C', meta: '#2E3D2A', preview: '#263322', border: '#B8C8B0' },  // muted sage grey
];

export function getCategoryColor(index: number) {
  const c = CATEGORY_COLORS[index % CATEGORY_COLORS.length];
  // Compatibility shim: callers may reference .hover — map to bg
  return { ...c, hover: c.bg };
}

export function categorySlug(name: string): string {
  return encodeURIComponent(name);
}

interface CategoryBoxProps {
  name: string;
  notes: Note[];
  colorIndex: number;
  onPreview: () => void;
}

export default function CategoryBox({ name, notes, colorIndex, onPreview }: CategoryBoxProps) {
  const color = getCategoryColor(colorIndex);
  const slug = categorySlug(name);

  const preview = useMemo(() => {
    const shuffled = [...notes].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 3);
  }, [notes]);

  return (
    <div
      className="relative rounded-2xl flex flex-col min-h-[260px] group transition-shadow duration-150 hover:shadow-md"
      style={{ backgroundColor: color.bg, border: `1px solid ${color.border}` }}
    >
      {/* Clickable body */}
      <button
        onClick={onPreview}
        className="flex-1 flex flex-col p-5 w-full text-left active:scale-[0.98] transition-transform rounded-t-2xl min-h-0"
      >
        {/* Top row: count + arrow */}
        <div className="flex items-center justify-between mb-3 flex-shrink-0">
          <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: color.meta }}>
            {notes.length}
          </span>
          <Link
            href={`/category/${slug}`}
            onClick={(e) => e.stopPropagation()}
            className="opacity-40 hover:opacity-80 transition-opacity p-0.5 -mr-0.5 rounded"
            style={{ color: color.meta }}
            title={`Open ${name}`}
          >
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>

        {/* Title */}
        <h3 className="text-sm font-bold leading-snug break-words mb-4 flex-shrink-0" style={{ color: color.title }}>
          {name}
        </h3>

        {/* Preview lines */}
        <div className="flex flex-col gap-2 overflow-hidden flex-1 min-h-0">
          {Array.from({ length: 3 }).map((_, i) => {
            const note = preview[i];
            return (
              <p key={i} className="text-[11px] line-clamp-1 leading-normal" style={{ color: color.preview }}>
                {note ? (note.title || note.content.slice(0, 60)) : '\u00A0'}
              </p>
            );
          })}
        </div>
      </button>

      {/* Footer */}
      <div
        className="flex-shrink-0 px-5 py-3 rounded-b-2xl"
        style={{ borderTop: `1px solid ${color.border}` }}
      >
        <Link
          href={`/category/${slug}`}
          onClick={(e) => e.stopPropagation()}
          className="text-[11px] font-medium opacity-60 hover:opacity-100 transition-opacity"
          style={{ color: color.meta }}
        >
          see all {notes.length}
        </Link>
      </div>
    </div>
  );
}
