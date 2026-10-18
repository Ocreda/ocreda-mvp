'use client';

import { useSyncExternalStore } from 'react';

/**
 * Whether someone is exploring the sample notes. While it is on, only sample
 * notes and their Domains are listed and searched, and the person's own notes
 * are hidden; anything written meanwhile is a sample note too. Kept per
 * browser and per account, like the Domains themselves.
 */

const CHANGE_EVENT = 'ocreda-sample-mode-change';

function storageKey(userId: string): string {
  return `ocreda-sample-mode:${userId}`;
}

export function getSampleMode(userId: string | null | undefined): boolean {
  if (!userId || typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(storageKey(userId)) === 'on';
  } catch {
    return false;
  }
}

export function setSampleMode(userId: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(storageKey(userId), 'on');
    else localStorage.removeItem(storageKey(userId));
  } catch {
    // Without storage the choice lasts until the page is closed.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * The id that browser-stored workspace data (Domains, their assignments, pins,
 * projects) is filed under, so the sample Domains never mix with the person's
 * own. Every such key ends with it.
 */
export function workspaceScope(userId: string, sampleMode: boolean): string {
  return sampleMode ? `sample:${userId}` : userId;
}

/** Forgets every browser-stored piece of the sample workspace. */
export function clearSampleWorkspace(userId: string): void {
  const marker = `:${workspaceScope(userId, true)}`;
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && (key.endsWith(marker) || key.includes(`${marker}:`))) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
  } catch {
    // Nothing stored, or storage is unavailable.
  }
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

/** The current mode for this account, re-rendering when it changes here or in another tab. */
export function useSampleMode(userId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => getSampleMode(userId), () => false);
}
