'use client';

import { useSyncExternalStore } from 'react';

/**
 * Which model the relevance search runs on. "best" is the production model and
 * the default; "basic" is a far cheaper one for testing. The server maps these
 * names to models itself, so this can only ever choose between the two.
 */
export type AiMode = 'basic' | 'best';

const STORAGE_KEY = 'ocreda-ai-mode';
const CHANGE_EVENT = 'ocreda-ai-mode-change';

/** Kept in this browser only: a per-person testing preference, not account data. */
export function getAiMode(): AiMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'basic' ? 'basic' : 'best';
  } catch {
    return 'best';
  }
}

export function setAiMode(mode: AiMode): void {
  try {
    if (mode === 'best') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Without storage the choice lasts until the page is closed.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  // The storage event carries changes made in other tabs.
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** The current mode, re-rendering when it changes here or in another tab. */
export function useAiMode(): AiMode {
  return useSyncExternalStore(subscribe, getAiMode, () => 'best');
}
