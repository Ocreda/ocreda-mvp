'use client';

import { useSidebar } from '@/lib/sidebar-context';

export default function SidebarMain({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const { collapsed } = useSidebar();
  return (
    <main className={`min-h-screen transition-all duration-300 pt-12 md:pt-4 pb-16 md:pb-0 ${collapsed ? 'md:ml-0' : 'md:ml-52'} ${className}`}>
      {children}
    </main>
  );
}
