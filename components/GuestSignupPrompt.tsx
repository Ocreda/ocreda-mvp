'use client';

import Link from 'next/link';
import { X, Sparkles } from 'lucide-react';

interface GuestSignupPromptProps {
  onClose: () => void;
  message?: string;
}

export default function GuestSignupPrompt({ onClose, message }: GuestSignupPromptProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm p-6 flex flex-col gap-5">
        <button
          onClick={onClose}
          className="absolute top-3.5 right-3.5 p-1.5 rounded-lg text-muted-foreground/40 hover:text-foreground hover:bg-accent transition-all"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex flex-col items-center text-center gap-3 pt-2">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-primary" />
          </div>
          <h2 className="text-base font-semibold text-foreground">
            Create a free account
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {message ?? 'Create a free account to use this feature — your notes will be saved.'}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Link
            href="/auth"
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-white text-sm font-medium rounded-xl hover:bg-primary/90 transition-all"
          >
            Continue with email
          </Link>
        </div>
      </div>
    </div>
  );
}
