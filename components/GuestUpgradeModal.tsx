'use client';

import { useRouter } from 'next/navigation';
import { X, Sparkles } from 'lucide-react';
import { useGuest, GUEST_MAX_NOTES } from '@/lib/guest-context';

interface GuestUpgradeModalProps {
  onClose: () => void;
  reason?: 'note_limit' | 'ai_feature';
}

export default function GuestUpgradeModal({ onClose, reason = 'note_limit' }: GuestUpgradeModalProps) {
  const router = useRouter();
  const { noteCount } = useGuest();

  const headline =
    reason === 'note_limit'
      ? 'You\'ve been thinking.'
      : 'You\'ve been thinking.';

  const body =
    reason === 'note_limit'
      ? `Sign up to unlock unlimited notes — your ${noteCount} ${noteCount === 1 ? 'note' : 'notes'} will be saved to your account.`
      : `Sign up to unlock AI features and unlimited notes — your ${noteCount} ${noteCount === 1 ? 'note' : 'notes'} will be saved to your account.`;

  const handleSignUp = () => {
    router.push('/auth?mode=signup');
    onClose();
  };

  const handleSignIn = () => {
    router.push('/auth?mode=signin');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-full max-w-sm bg-card border border-border rounded-2xl shadow-xl p-6 animate-in fade-in slide-in-from-bottom-4 duration-200">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Sparkles className="w-4.5 h-4.5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">{headline}</p>
          </div>
        </div>

        <p className="text-sm text-muted-foreground leading-relaxed mb-5">
          {body}
        </p>

        {reason === 'note_limit' && (
          <div className="mb-5">
            <div className="flex justify-between items-center mb-1.5">
              <span className="text-xs text-muted-foreground">Notes used</span>
              <span className="text-xs font-medium text-foreground">{noteCount} / {GUEST_MAX_NOTES}</span>
            </div>
            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all"
                style={{ width: `${(noteCount / GUEST_MAX_NOTES) * 100}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={handleSignUp}
            className="flex-1 px-4 py-2.5 bg-primary hover:bg-primary/90 text-white text-sm font-medium rounded-xl transition-all shadow-sm shadow-primary/20"
          >
            Sign up free
          </button>
          <button
            onClick={handleSignIn}
            className="flex-1 px-4 py-2.5 border border-border hover:bg-accent text-foreground text-sm font-medium rounded-xl transition-all"
          >
            Sign in
          </button>
        </div>

        <p className="text-[11px] text-muted-foreground/50 text-center mt-3">
          Your notes transfer automatically when you sign in.
        </p>
      </div>
    </div>
  );
}
