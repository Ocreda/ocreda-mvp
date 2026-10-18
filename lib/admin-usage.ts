import { supabase } from './supabase';
import { IS_LOCAL_MODE } from '@/dev/local-mode';  // DEV-LOCAL-MODE

/**
 * The admin usage page's data, from the admin-usage Edge Function. Only
 * accounts in public.app_admins can load it; the function refuses everyone else.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const USAGE_WINDOWS = [1, 7, 30, 90] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

export interface UsageTotals {
  requests: number;
  calls: number;
  /** OpenRouter's billed cost in USD. Google calls are not priced; see google_requests. */
  cost_usd: number;
  google_requests: number;
  input_tokens: number;
  output_tokens: number;
  cancelled: number;
  failed: number;
}

export interface UserUsage extends UsageTotals {
  /** Null for requests no signed-in user could be found for. */
  user_id: string | null;
  email: string | null;
  /** Calls per model that answered. */
  models: Record<string, number>;
  /** Calls per provider that served them. */
  providers: Record<string, number>;
  features: Record<string, UsageTotals>;
  last_at: string;
}

export interface UsageRequest {
  id: number;
  user_id: string | null;
  email: string | null;
  feature: string;
  billed_by: 'openrouter' | 'google';
  model: string | null;
  tier: string | null;
  models: Record<string, number> | null;
  providers: Record<string, number> | null;
  steps: Record<string, { calls: number; input_tokens: number; output_tokens: number; cost_usd: number | null }> | null;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  /** Null for Google calls, which report no price. */
  cost_usd: number | null;
  status: 'ok' | 'cancelled' | 'failed';
  duration_ms: number | null;
  created_at: string;
}

export interface OpenRouterBalance {
  key: {
    limit_usd: number | null;
    remaining_usd: number | null;
    used_usd: number | null;
    used_today_usd: number | null;
    used_this_week_usd: number | null;
    used_this_month_usd: number | null;
  } | null;
  account: { credits_usd: number | null; used_usd: number | null; remaining_usd: number | null } | null;
}

export interface AdminUsage {
  days: number;
  since: string;
  /** The window held more rows than the page loads, so the numbers are a lower bound. */
  truncated: boolean;
  totals: UsageTotals;
  users: UserUsage[];
  features: Record<string, UsageTotals>;
  models: Record<string, UsageTotals>;
  recent: UsageRequest[];
  openrouter: OpenRouterBalance | null;
}

/** Whether the signed-in person is on the admin list. Never throws: anything unclear is a no. */
export async function isAdmin(): Promise<boolean> {
  if (IS_LOCAL_MODE) return false;  // DEV-LOCAL-MODE
  try {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return false;
    const { data, error } = await supabase.from('app_admins').select('user_id').eq('user_id', auth.user.id).maybeSingle();
    return !error && Boolean(data);
  } catch {
    return false;
  }
}

export async function getAdminUsage(days: UsageWindow): Promise<AdminUsage> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Sign in to see usage.');
  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/admin-usage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }),
    });
  } catch {
    throw new Error("Couldn't reach the usage service.");
  }
  if (response.status === 403) throw new Error('This page is only for admins.');
  if (!response.ok) throw new Error("Couldn't load usage right now.");
  return response.json() as Promise<AdminUsage>;
}
