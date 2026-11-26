// DEV-LOCAL-MODE — delete this whole directory to remove local mode.
// The implementation lives in dev/local-feedback-route.ts. The handler returns
// 404 unless NEXT_PUBLIC_LOCAL_MODE=1; the real path is the send-feedback
// Edge Function.
export { POST } from '@/dev/local-feedback-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
