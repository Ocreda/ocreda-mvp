'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

export type ThemePreference = 'light' | 'dark' | 'auto';
type ResolvedTheme = 'light' | 'dark';

interface ThemeContextValue {
  theme: ResolvedTheme;
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  preference: 'auto',
  setPreference: () => {},
});

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolve(pref: ThemePreference): ResolvedTheme {
  if (pref === 'auto') return getSystemTheme();
  return pref;
}

function applyTheme(t: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.remove('dark', 'light');
  root.classList.add(t);
  try { localStorage.setItem('theme-pref', t); } catch {}
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>('auto');
  const [theme, setTheme] = useState<ResolvedTheme>('dark');

  // On mount: read localStorage for instant apply, then fetch from Supabase
  useEffect(() => {
    const saved = (() => {
      try { return localStorage.getItem('theme-pref') as ThemePreference | null; } catch { return null; }
    })();
    const initial = saved && ['light', 'dark', 'auto'].includes(saved) ? saved as ThemePreference : 'auto';
    const resolved = resolve(initial);
    setPreferenceState(initial);
    setTheme(resolved);
    applyTheme(resolved);

    // Fetch from Supabase (may override)
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      supabase
        .from('user_settings')
        .select('theme')
        .eq('user_id', user.id)
        .maybeSingle()
        .then(({ data }) => {
          const pref = (data?.theme ?? 'auto') as ThemePreference;
          const r = resolve(pref);
          setPreferenceState(pref);
          setTheme(r);
          applyTheme(r);
          try { localStorage.setItem('theme-pref', pref); } catch {}
        });
    });
  }, []);

  // Listen for system theme changes when in 'auto' mode
  useEffect(() => {
    if (preference !== 'auto') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      const next: ResolvedTheme = e.matches ? 'dark' : 'light';
      setTheme(next);
      applyTheme(next);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [preference]);

  const setPreference = useCallback(async (pref: ThemePreference) => {
    const resolved = resolve(pref);
    setPreferenceState(pref);
    setTheme(resolved);
    applyTheme(resolved);
    try { localStorage.setItem('theme-pref', pref); } catch {}

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await supabase
      .from('user_settings')
      .upsert({ user_id: user.id, theme: pref, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, preference, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
