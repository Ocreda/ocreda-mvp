'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  PenLine,
  MessageSquare,
  LogIn,
  Sparkles,
  Activity,
  FileText,
  Menu,
  X,
  User,
  Pin,
  ChevronDown,
  ChevronRight,
  BookOpen,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useGuest } from '@/lib/guest-context';
import { useSidebar } from '@/lib/sidebar-context';
import { usePinned } from '@/lib/pinned-context';
import { supabase } from '@/lib/supabase';
import { useEffect, useState } from 'react';

const NAV_GROUPS = [
  {
    label: null,
    items: [
      { href: '/', label: 'Add Note', icon: PenLine, exact: true },
    ],
  },
  {
    label: 'Explore',
    items: [
      { href: '/qa', label: 'Ask a Question', icon: MessageSquare },
      { href: '/memory', label: 'Remember', icon: Sparkles },
      { href: '/journal', label: 'Journal', icon: BookOpen },
    ],
  },
  {
    label: 'Insights',
    items: [
      { href: '/health', label: 'Memory Health', icon: Activity },
      { href: '/reports', label: 'Reports', icon: FileText },
    ],
  },
];

// Sidebar toggle icon: rounded rect split vertically with a chevron on the left half
function SidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Outer rounded rectangle */}
      <rect x="1.5" y="1.5" width="17" height="17" rx="3.5" stroke="currentColor" strokeWidth="1.4" />
      {/* Vertical divider line */}
      <line x1="7" y1="1.5" x2="7" y2="18.5" stroke="currentColor" strokeWidth="1.4" />
      {/* Chevron: points left when expanded (collapse), points right when collapsed (expand) */}
      {collapsed ? (
        <path d="M11 7.5L14 10L11 12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M13 7.5L10 10L13 12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

export default function Navigation() {
  const pathname = usePathname();
  const { user } = useAuth();
  const { isGuest, noteCount } = useGuest();
  const { collapsed, toggle, mobileOpen, setMobileOpen } = useSidebar();
  const { pins } = usePinned();

  const [displayName, setDisplayName] = useState('');
  const [pinnedOpen, setPinnedOpen] = useState(true);

  useEffect(() => {
    if (!user) return;
    supabase
      .from('user_settings')
      .select('full_name')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        setDisplayName(data?.full_name ?? '');
      });
  }, [user]);

  const openNotePopup = (noteId: string, closeMobile = false) => {
    if (closeMobile) setMobileOpen(false);
    window.dispatchEvent(new CustomEvent('open-note-popup', { detail: { noteId } }));
  };

  const sidebarBody = (isMobile = false) => (
    <div className="flex flex-col h-full">
      {/* Header: close button (mobile only — desktop toggle is rendered outside the aside) */}
      {isMobile && (
        <div className="flex-shrink-0 flex items-center px-3 pt-3 pb-2">
          <button
            onClick={() => setMobileOpen(false)}
            className="p-1.5 rounded-lg text-muted-foreground/40 hover:text-foreground transition-colors"
            title="Close menu"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
      {/* Spacer on desktop so nav doesn't sit under the fixed toggle button */}
      {!isMobile && <div className="flex-shrink-0 h-10" />}

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto px-3 pt-2">
        {NAV_GROUPS.map((group, gi) => (
          <div key={gi} className={gi === 0 ? 'mb-4' : 'mt-4'}>
            {group.label && (
              <p className="px-2.5 mb-0.5 text-[9px] font-normal uppercase tracking-[0.1em] text-muted-foreground/25 select-none">
                {group.label}
              </p>
            )}
            <div className="space-y-0.5">
              {group.items.map(({ href, label, icon: Icon, ...rest }) => {
                const exact = (rest as { exact?: boolean }).exact;
                const active = exact
                  ? pathname === href
                  : pathname === href || pathname.startsWith(href + '/');
                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => isMobile && setMobileOpen(false)}
                    className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors duration-150 ${
                      active
                        ? 'text-[#487BE9]'
                        : 'text-muted-foreground/60 hover:text-foreground'
                    }`}
                  >
                    <Icon className="w-4 h-4 flex-shrink-0" />
                    {label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}

        {/* Pinned section — only shown when there are pins */}
        {user && pins.length > 0 && (
          <div className="mt-14">
            <button
              onClick={() => setPinnedOpen((v) => !v)}
              className="flex items-center gap-1.5 w-full px-2.5 mb-0.5 text-muted-foreground/25 hover:text-muted-foreground/50 transition-colors"
            >
              <Pin className="w-2.5 h-2.5 flex-shrink-0" />
              <span className="text-[9px] font-normal uppercase tracking-[0.1em] select-none flex-1 text-left">
                Pinned
              </span>
              {pinnedOpen ? (
                <ChevronDown className="w-2.5 h-2.5" />
              ) : (
                <ChevronRight className="w-2.5 h-2.5" />
              )}
            </button>
            {pinnedOpen && (
              <div className="space-y-0.5">
                {pins.slice(0, 3).map((pin) => {
                  const note = pin.note;
                  if (!note) return null;
                  const label = note.title || note.content.slice(0, 40);
                  return (
                    <button
                      key={pin.note_id}
                      onClick={() => openNotePopup(pin.note_id, isMobile)}
                      className="w-full text-left px-2.5 py-1.5 rounded-lg text-[12px] text-muted-foreground/50 hover:text-foreground hover:bg-accent/50 transition-colors truncate"
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </nav>

      {/* Bottom: account / auth */}
      <div className="flex-shrink-0 pt-3 pb-4 px-4">
        {user ? (
          <Link
            href="/profile"
            onClick={() => isMobile && setMobileOpen(false)}
            className="flex items-center gap-2 text-muted-foreground/45 hover:text-muted-foreground transition-colors"
          >
            <User className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="text-[12px] truncate">
              {displayName || user.email?.split('@')[0] || 'Account'}
            </span>
          </Link>
        ) : isGuest ? (
          <div className="space-y-2">
            <div className="px-0.5">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] text-muted-foreground/40 uppercase tracking-widest font-medium">
                  Guest
                </span>
                <span className="text-[10px] text-muted-foreground/40">{noteCount}/5</span>
              </div>
              <div className="h-px bg-border/50 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary/40 rounded-full transition-all"
                  style={{ width: `${(noteCount / 5) * 100}%` }}
                />
              </div>
            </div>
            <Link
              href="/auth"
              onClick={() => isMobile && setMobileOpen(false)}
              className="flex items-center gap-2 px-0.5 text-[12px] font-medium text-primary/70 hover:text-primary transition-colors"
            >
              <LogIn className="w-3.5 h-3.5" />
              Sign in
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar toggle — always visible, outside the collapsible aside */}
      <div className="hidden md:block fixed left-0 top-0 z-50 p-3">
        <button
          onClick={toggle}
          className="p-1.5 rounded-lg text-muted-foreground/35 hover:text-foreground hover:bg-accent/50 transition-colors"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <SidebarToggleIcon collapsed={collapsed} />
        </button>
      </div>

      {/* Desktop sidebar */}
      <aside
        className={`hidden md:flex fixed left-0 top-0 h-full bg-background border-r border-border/50 flex-col z-40 transition-all duration-300 overflow-hidden ${
          collapsed ? 'w-0' : 'w-52'
        }`}
      >
        {sidebarBody(false)}
      </aside>

      {/* Mobile header */}
      <header className="md:hidden fixed top-0 left-0 right-0 h-12 bg-background border-b border-border/50 flex items-center px-4 z-40">
        <button
          onClick={() => setMobileOpen(true)}
          className="p-2 -ml-1 rounded-lg text-muted-foreground/50 hover:text-foreground transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>
      </header>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative w-64 max-w-[85vw] h-full bg-background border-r border-border/50 flex flex-col z-10 overflow-hidden">
            {sidebarBody(true)}
          </aside>
        </div>
      )}
    </>
  );
}
