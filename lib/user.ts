import { supabase } from './supabase';

const FALLBACK_OWNER_ID = 'af0b4a70-8b0c-49ae-a17b-2ff93f404633';

export function getOwnerId(): string {
  if (typeof window === 'undefined') return FALLBACK_OWNER_ID;
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const projectRef = new URL(url).hostname.split('.')[0];
    const storageKey = `sb-${projectRef}-auth-token`;
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      // supabase-js v2 stores the session at the top level or in array form
      const userId = parsed?.user?.id ?? parsed?.[0]?.user?.id;
      if (userId) return userId;
    }
  } catch {
    // fall through
  }
  return FALLBACK_OWNER_ID;
}
