'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Image from 'next/image';
import { MessageSquare, Sparkles, BookOpen, LogIn } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useGuest, GUEST_MAX_NOTES } from '@/lib/guest-context';

const TABS = [
  { href: '/journal', label: 'Journal', icon: BookOpen },
  { href: '/qa', label: 'Ask', icon: MessageSquare },
  { href: '/memory', label: 'Remember', icon: Sparkles },
];

export default function MobileTabBar() {
  const pathname = usePathname();
  const { user } = useAuth();
  const { isGuest, noteCount } = useGuest();

  // Guest mode: show a simplified bar with home + sign-up indicator
  if (isGuest) {
    return (
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-background border-t border-border">
        <div className="flex items-stretch h-16">
          <Link
            href="/"
            className="flex-1 flex flex-col items-center justify-center transition-colors opacity-100"
          >
            <Image
              src="/IMG_2929.png"
              alt="Home"
              width={20}
              height={20}
              className="object-contain dark:invert"
            />
          </Link>
          <Link
            href="/auth?mode=signup"
            className="flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors text-primary"
          >
            <LogIn className="w-5 h-5" />
            <span className="text-[10px] font-medium leading-none">
              {noteCount}/{GUEST_MAX_NOTES} · Sign up
            </span>
          </Link>
        </div>
      </nav>
    );
  }

  // Not authenticated and not guest (edge case during loading) — show nothing
  if (!user) return null;

  const homeActive = pathname === '/' || pathname === '/notes';

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-background border-t border-border">
      <div className="flex items-stretch h-16">
        {/* Home tab — app logo, no label */}
        <Link
          href="/"
          className={`flex-1 flex flex-col items-center justify-center transition-colors ${
            homeActive ? 'opacity-100' : 'opacity-40'
          }`}
        >
          <Image
            src="/IMG_2929.png"
            alt="Home"
            width={20}
            height={20}
            className="object-contain dark:invert"
          />
        </Link>

        {TABS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + '/');
          return (
            <Link
              key={href}
              href={href}
              className={`flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors ${
                active ? 'text-primary' : 'text-muted-foreground'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] font-medium leading-none">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
