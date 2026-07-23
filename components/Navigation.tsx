'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Sparkles, PenLine, Menu, X, User } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useSidebar } from '@/lib/sidebar-context';
import { supabase } from '@/lib/supabase';
import { useEffect, useState } from 'react';

const NAV_ITEMS = [
  { href: '/', label: 'My Brain', icon: Sparkles },
  { href: '/notes', label: 'Notes', icon: PenLine },
];

// Sidebar toggle icon: rounded rect split vertically with a chevron on the left half
function SidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.5" y="1.5" width="17" height="17" rx="3.5" stroke="currentColor" strokeWidth="1.4" />
      <line x1="7" y1="1.5" x2="7" y2="18.5" stroke="currentColor" strokeWidth="1.4" />
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
  const { collapsed, toggle, mobileOpen, setMobileOpen } = useSidebar();

  const [displayName, setDisplayName] = useState('');

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

  const sidebarBody = (isMobile = false) => (
    <div className="flex flex-col h-full">
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
      {!isMobile && <div className="flex-shrink-0 h-10" />}

      <nav className="flex-1 overflow-y-auto px-3 pt-2">
        <div className="space-y-0.5">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + '/');
            return (
              <Link
                key={href}
                href={href}
                onClick={() => isMobile && setMobileOpen(false)}
                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors duration-150 ${
                  active ? 'text-[#487BE9]' : 'text-muted-foreground/60 hover:text-foreground'
                }`}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {label}
              </Link>
            );
          })}
        </div>
      </nav>

      {user && (
        <div className="flex-shrink-0 pt-3 pb-4 px-4">
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
        </div>
      )}
    </div>
  );

  return (
    <>
      <div className="hidden md:block fixed left-0 top-0 z-50 p-3">
        <button
          onClick={toggle}
          className="p-1.5 rounded-lg text-muted-foreground/35 hover:text-foreground hover:bg-accent/50 transition-colors"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <SidebarToggleIcon collapsed={collapsed} />
        </button>
      </div>

      <aside
        className={`hidden md:flex fixed left-0 top-0 h-full bg-background border-r border-border/50 flex-col z-40 transition-all duration-300 overflow-hidden ${
          collapsed ? 'w-0' : 'w-52'
        }`}
      >
        {sidebarBody(false)}
      </aside>

      <header className="md:hidden fixed top-0 left-0 right-0 h-12 bg-background border-b border-border/50 flex items-center px-4 z-40">
        <button
          onClick={() => setMobileOpen(true)}
          className="p-2 -ml-1 rounded-lg text-muted-foreground/50 hover:text-foreground transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>
      </header>

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
