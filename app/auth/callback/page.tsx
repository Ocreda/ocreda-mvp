'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { useAuth } from '@/lib/auth-context';
import { TriangleAlert as AlertTriangle } from 'lucide-react';

const AUTH_TIMEOUT_MS = 6000;

export default function AuthCallbackPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setTimedOut(true), AUTH_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (loading || !user) return;
    router.replace('/notes');
  }, [loading, user, router]);

  if (!loading && !user && timedOut) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm flex flex-col items-center text-center gap-3">
          <div className="w-12 h-12 flex items-center justify-center mb-2">
            <Image src="/IMG_2929.png" alt="Ocreda" width={48} height={48} className="object-contain dark:invert" />
          </div>
          <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-destructive" />
          </div>
          <h1 className="text-lg font-semibold text-foreground">This link is invalid or has expired</h1>
          <p className="text-sm text-muted-foreground">Request a new sign-in link to continue.</p>
          <button
            type="button"
            onClick={() => router.replace('/auth')}
            className="w-full flex items-center justify-center px-4 py-2.5 rounded-xl bg-primary hover:bg-primary/90 text-white text-sm font-medium transition-all mt-2"
          >
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-muted-foreground">Signing you in...</p>
      </div>
    </div>
  );
}
