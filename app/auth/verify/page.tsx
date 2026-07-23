'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Image from 'next/image';
import { useAuth } from '@/lib/auth-context';
import { Loader as Loader2, Mail, CircleCheck as CheckCircle } from 'lucide-react';

const RESEND_COOLDOWN_SECONDS = 30;

function VerifyPageInner() {
  const { signInWithOtp } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const email = searchParams.get('email');
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);

  useEffect(() => {
    if (!email) {
      router.replace('/auth');
    }
  }, [email, router]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  if (!email) return null;

  const handleResend = async () => {
    setError(null);
    setResent(false);
    setResending(true);
    try {
      const { error: err } = await signInWithOtp(email);
      if (err) {
        setError(err);
      } else {
        setResent(true);
        setCooldown(RESEND_COOLDOWN_SECONDS);
      }
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 flex items-center justify-center mb-4">
            <Image src="/IMG_2929.png" alt="Ocreda" width={48} height={48} className="object-contain dark:invert" />
          </div>
        </div>

        <div className="flex flex-col items-center text-center gap-3">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Mail className="w-5 h-5 text-primary" />
          </div>
          <h1 className="text-lg font-semibold text-foreground">Verification link sent</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            We sent a sign-in link to <span className="font-medium text-foreground">{email}</span>.
            Click the link in the email to continue.
          </p>

          {error && (
            <div className="w-full px-3 py-2.5 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive leading-snug">
              {error}
            </div>
          )}

          {resent && !error && (
            <div className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-sm text-emerald-700 dark:text-emerald-400">
              <CheckCircle className="w-4 h-4 flex-shrink-0" />
              Link resent — check your inbox.
            </div>
          )}

          <button
            type="button"
            onClick={handleResend}
            disabled={resending || cooldown > 0}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-border bg-card hover:bg-accent disabled:opacity-60 text-sm font-medium text-foreground transition-all mt-2"
          >
            {resending && <Loader2 className="w-4 h-4 animate-spin" />}
            {cooldown > 0 ? `Resend link (${cooldown}s)` : 'Resend link'}
          </button>

          <button
            type="button"
            onClick={() => router.replace('/auth')}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors mt-1"
          >
            Use a different email
          </button>
        </div>
      </div>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <VerifyPageInner />
    </Suspense>
  );
}
