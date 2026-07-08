'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { useAuth } from '@/lib/auth-context';
import { Eye, EyeOff, Loader as Loader2, CircleCheck as CheckCircle } from 'lucide-react';

export default function ResetPasswordPage() {
  const { user, loading, updatePassword } = useAuth();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Supabase redirects here with a hash fragment containing the access token.
  // The supabase-js client picks this up automatically via onAuthStateChange.
  // We just wait for the session to be established, then let them set a new password.

  useEffect(() => {
    // If the user ends up here without a reset token (already logged in), redirect home.
    if (!loading && user && !window.location.hash.includes('type=recovery')) {
      router.replace('/notes');
    }
  }, [user, loading, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const { error } = await updatePassword(password);
      if (error) {
        setError(error);
      } else {
        setDone(true);
        setTimeout(() => router.replace('/notes'), 2000);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 flex items-center justify-center mb-3">
            <Image src="/IMG_2929.png" alt="My Brain" width={48} height={48} className="object-contain dark:invert" />
          </div>
          <h1 className="text-xl font-bold text-foreground">My Brain</h1>
        </div>

        <div className="bg-card border border-border rounded-2xl p-6 shadow-sm">
          {done ? (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <CheckCircle className="w-8 h-8 text-emerald-500" />
              <p className="text-sm font-medium text-foreground">Password updated!</p>
              <p className="text-xs text-muted-foreground">Redirecting you to the app...</p>
            </div>
          ) : (
            <>
              <h2 className="text-base font-semibold text-foreground mb-1">Set new password</h2>
              <p className="text-xs text-muted-foreground mb-5">Choose a strong password for your account.</p>

              {error && (
                <div className="mb-4 px-3 py-2.5 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive leading-snug">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1.5" htmlFor="new-password">
                    New password
                  </label>
                  <div className="relative">
                    <input
                      id="new-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
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

                <div>
                  <label className="block text-xs font-medium text-foreground mb-1.5" htmlFor="confirm-password">
                    Confirm password
                  </label>
                  <input
                    id="confirm-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    required
                    value={confirm}
                    onChange={(e) => { setConfirm(e.target.value); setError(null); }}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
                    placeholder="••••••••"
                  />
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-primary hover:bg-primary/90 disabled:opacity-60 text-white text-sm font-medium transition-all mt-1"
                >
                  {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                  Update Password
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
