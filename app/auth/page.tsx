'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Image from 'next/image';
import { useAuth } from '@/lib/auth-context';
import { useGuest, GUEST_STORAGE_KEY } from '@/lib/guest-context';
import { supabase } from '@/lib/supabase';
import { Eye, EyeOff, Loader as Loader2, ArrowLeft, CircleCheck as CheckCircle } from 'lucide-react';

type Mode = 'signin' | 'signup' | 'forgot';

async function transferGuestNotes(userId: string): Promise<void> {
  try {
    const raw = localStorage.getItem(GUEST_STORAGE_KEY);
    if (!raw) return;
    const guestNotes = JSON.parse(raw);
    if (!Array.isArray(guestNotes) || guestNotes.length === 0) return;

    // Insert guest notes in reverse order so they appear newest-first
    const rows = [...guestNotes].reverse().map((n) => ({
      user_id: userId,
      title: n.title || '',
      content: n.content,
      tags: n.tags || [],
      type: 'note',
      created_at: n.created_at,
      updated_at: n.updated_at,
    }));

    await supabase.from('notes').insert(rows);
    localStorage.removeItem(GUEST_STORAGE_KEY);
  } catch {
    // non-critical — don't block the sign-in flow
  }
}

function friendlyError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes('invalid login') || m.includes('invalid credentials') || m.includes('wrong password')) {
    return 'Incorrect email or password. Please try again.';
  }
  if (m.includes('user not found') || m.includes('no user found') || m.includes('email not confirmed')) {
    return 'No account found with that email address.';
  }
  if (m.includes('email already') || m.includes('already registered') || m.includes('already in use')) {
    return 'An account with this email already exists. Try signing in.';
  }
  if (m.includes('password') && m.includes('least')) {
    return 'Password must be at least 6 characters.';
  }
  if (m.includes('rate limit') || m.includes('too many')) {
    return 'Too many attempts. Please wait a few minutes and try again.';
  }
  if (m.includes('network') || m.includes('fetch')) {
    return 'Network error. Check your connection and try again.';
  }
  return msg;
}

function AuthPageInner() {
  const { user, loading, signIn, signUp, resetPassword } = useAuth();
  const { clearGuestNotes } = useGuest();
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialMode = (searchParams.get('mode') as Mode) ?? 'signin';
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && user) {
      router.replace('/notes');
    }
  }, [user, loading, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSubmitting(true);

    try {
      if (mode === 'forgot') {
        const { error: err } = await resetPassword(email);
        if (err) {
          setError(friendlyError(err));
        } else {
          setSuccess('Check your email — we sent a password reset link.');
        }
        return;
      }

      if (mode === 'signin') {
        const { error: err } = await signIn(email, password);
        if (err) {
          setError(friendlyError(err));
        } else {
          // Transfer any guest notes to the account
          const { data: { session } } = await supabase.auth.getSession();
          if (session?.user?.id) {
            await transferGuestNotes(session.user.id);
            clearGuestNotes();
          }
          router.replace('/notes');
        }
      } else {
        if (password.length < 6) {
          setError('Password must be at least 6 characters.');
          return;
        }
        const { error: signUpErr } = await signUp(email, password);
        if (signUpErr) {
          setError(friendlyError(signUpErr));
        } else {
          setSuccess('Account created! Signing you in...');
          const { error: signInErr } = await signIn(email, password);
          if (!signInErr) {
            // Transfer any guest notes to the new account
            const { data: { session } } = await supabase.auth.getSession();
            if (session?.user?.id) {
              await transferGuestNotes(session.user.id);
              clearGuestNotes();
            }
            router.replace('/notes');
          } else {
            setSuccess('Account created! You can now sign in.');
            setMode('signin');
          }
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setSuccess(null);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Already signed in — show a brief redirect state instead of the form
  if (user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-muted-foreground">Redirecting...</p>
        </div>
      </div>
    );
  }

  const title = mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Reset password';
  const subtitle =
    mode === 'signin'
      ? 'Enter your email and password to continue.'
      : mode === 'signup'
      ? 'Set up your personal knowledge base.'
      : "Enter your email and we'll send you a reset link.";

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 flex items-center justify-center mb-3">
            <Image src="/IMG_2929.png" alt="My Brain" width={48} height={48} className="object-contain dark:invert" />
          </div>
          <h1 className="text-xl font-bold text-foreground">My Brain</h1>
          <p className="text-sm text-muted-foreground mt-1">Personal Knowledge Base</p>
        </div>

        <div className="bg-card border border-border rounded-2xl p-6 shadow-sm">
          {mode === 'forgot' && (
            <button
              onClick={() => switchMode('signin')}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-4"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to sign in
            </button>
          )}

          <h2 className="text-base font-semibold text-foreground mb-1">{title}</h2>
          <p className="text-xs text-muted-foreground mb-5">{subtitle}</p>

          {error && (
            <div className="mb-4 px-3 py-2.5 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive leading-snug">
              {error}
            </div>
          )}

          {success && (
            <div className="mb-4 px-3 py-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-sm text-emerald-700 dark:text-emerald-400 flex items-start gap-2">
              <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              {success}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-foreground mb-1.5" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError(null); }}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
                placeholder="you@example.com"
              />
            </div>

            {mode !== 'forgot' && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-medium text-foreground" htmlFor="password">
                    Password
                  </label>
                  {mode === 'signin' && (
                    <button
                      type="button"
                      onClick={() => switchMode('forgot')}
                      className="text-xs text-muted-foreground hover:text-primary transition-colors"
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                    required
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setError(null); }}
                    className="w-full px-3 py-2 pr-9 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
                    placeholder="••••••••"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-primary hover:bg-primary/90 disabled:opacity-60 text-white text-sm font-medium transition-all mt-1"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {mode === 'signin' ? 'Sign In' : mode === 'signup' ? 'Create Account' : 'Send Reset Link'}
            </button>
          </form>

          {mode !== 'forgot' && (
            <div className="mt-4 pt-4 border-t border-border text-center">
              <span className="text-xs text-muted-foreground">
                {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
              </span>
              <button
                onClick={() => switchMode(mode === 'signin' ? 'signup' : 'signin')}
                className="text-xs text-primary hover:text-primary/80 font-medium transition-colors"
              >
                {mode === 'signin' ? 'Sign up' : 'Sign in'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AuthPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <AuthPageInner />
    </Suspense>
  );
}
