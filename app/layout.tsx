import './globals.css';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { ThemeProvider } from '@/lib/theme-context';
import { SidebarProvider } from '@/lib/sidebar-context';
import { AuthProvider } from '@/lib/auth-context';
import { GuestProvider } from '@/lib/guest-context';
import { PinnedProvider } from '@/lib/pinned-context';
import AppShell from '@/components/AppShell';
import Navigation from '@/components/Navigation';
import SidebarMain from '@/components/SidebarMain';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'My Brain — Personal Knowledge Base',
  description: 'Your AI-powered personal knowledge base',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var p=localStorage.getItem('theme-pref');var t=p==='light'?'light':p==='dark'?'dark':window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.classList.add(t);}catch(e){document.documentElement.classList.add('dark');}})();`,
          }}
        />
      </head>
      <body className={inter.className}>
        <ThemeProvider>
          <AuthProvider>
            <GuestProvider>
              <SidebarProvider>
                <PinnedProvider>
                  <Navigation />
                  <SidebarMain>
                    <AppShell>{children}</AppShell>
                  </SidebarMain>
                </PinnedProvider>
              </SidebarProvider>
            </GuestProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
