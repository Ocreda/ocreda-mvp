'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { IS_LOCAL_MODE, LOCAL_USER } from '@/dev/local-mode';  // DEV-LOCAL-MODE
import { authCallbackUrl } from './sharing-api';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signInWithOtp: (email: string) => Promise<{ error: string | null }>;
  signInWithGoogle: () => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  loading: true,
  signInWithOtp: async () => ({ error: null }),
  signInWithGoogle: async () => ({ error: null }),
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Local mode starts already "signed in" as a fake user, which is what lets
  // AppChrome render instead of redirecting to /auth.
  const [user, setUser] = useState<User | null>(IS_LOCAL_MODE ? (LOCAL_USER as unknown as User) : null);  // DEV-LOCAL-MODE
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(!IS_LOCAL_MODE);  // DEV-LOCAL-MODE

  useEffect(() => {
    if (IS_LOCAL_MODE) return;  // DEV-LOCAL-MODE

    let mounted = true;
    supabase.auth.getSession()
      .then(({ data: { session } }) => {
        if (!mounted) return;
        setSession(session);
        setUser(session?.user ?? null);
      })
      .catch(() => {
        if (!mounted) return;
        setSession(null);
        setUser(null);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const signInWithOtp = async (email: string) => {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: authCallbackUrl(),
      },
    });
    return { error: error?.message ?? null };
  };

  const signInWithGoogle = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: authCallbackUrl(),
      },
    });
    return { error: error?.message ?? null };
  };

  const signOut = async () => {
    if (IS_LOCAL_MODE) return;  // DEV-LOCAL-MODE
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signInWithOtp, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
