'use client';

import { createContext, useContext, useState, ReactNode } from 'react';

interface TagFilterContextValue {
  openTag: (tag: string) => void;
}

const TagFilterContext = createContext<TagFilterContextValue>({ openTag: () => {} });

export function useTagFilter() {
  return useContext(TagFilterContext);
}

export function TagFilterProvider({ children, onOpenTag }: { children: ReactNode; onOpenTag: (tag: string) => void }) {
  return (
    <TagFilterContext.Provider value={{ openTag: onOpenTag }}>
      {children}
    </TagFilterContext.Provider>
  );
}
