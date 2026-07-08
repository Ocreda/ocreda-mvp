import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  // Auth is handled entirely client-side via Supabase's localStorage session.
  // Middleware cannot read localStorage, so we let all requests through and
  // rely on client-side guards in each page to redirect unauthenticated users.
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
