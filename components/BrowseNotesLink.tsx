'use client';

import Link from 'next/link';
import { Network } from 'lucide-react';

export default function BrowseNotesLink() {
  return (
    <Link
      href="/connections"
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-all"
    >
      <Network className="w-3.5 h-3.5" />
      Browse notes
    </Link>
  );
}
