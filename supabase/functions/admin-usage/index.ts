import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { authenticateRequest, isAuthenticationError } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/gemini.ts";

/**
 * The admin usage page's data: AI spend and requests per person, the models
 * and providers each one used, the most recent requests, and the OpenRouter
 * balance. Only accounts listed in public.app_admins may call it; everyone
 * else gets a 403 and learns nothing about the data.
 */

const WINDOWS = [1, 7, 30, 90] as const;
const PAGE_SIZE = 1000;
/** Enough for months of an early product; the page says when the window was cut short. */
const MAX_ROWS = 50_000;
const RECENT_LIMIT = 100;

type UsageRow = {
  id: number;
  user_id: string | null;
  feature: string;
  billed_by: "openrouter" | "google";
  model: string | null;
  tier: string | null;
  models: Record<string, number> | null;
  providers: Record<string, number> | null;
  steps: Record<string, { calls: number; input_tokens: number; output_tokens: number; cost_usd: number | null }> | null;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | string | null;
  status: "ok" | "cancelled" | "failed";
  duration_ms: number | null;
  created_at: string;
};

type Totals = {
  requests: number;
  calls: number;
  /** OpenRouter's billed cost. Google calls are not priced, so they are counted apart. */
  cost_usd: number;
  google_requests: number;
  input_tokens: number;
  output_tokens: number;
  cancelled: number;
  failed: number;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function emptyTotals(): Totals {
  return { requests: 0, calls: 0, cost_usd: 0, google_requests: 0, input_tokens: 0, output_tokens: 0, cancelled: 0, failed: 0 };
}

function add(totals: Totals, row: UsageRow): void {
  totals.requests += 1;
  totals.calls += row.calls;
  totals.cost_usd += Number(row.cost_usd ?? 0);
  if (row.billed_by === "google") totals.google_requests += 1;
  totals.input_tokens += row.input_tokens;
  totals.output_tokens += row.output_tokens;
  if (row.status === "cancelled") totals.cancelled += 1;
  if (row.status === "failed") totals.failed += 1;
}

function tally(target: Record<string, number>, counts: Record<string, number> | null): void {
  for (const [name, count] of Object.entries(counts ?? {})) target[name] = (target[name] ?? 0) + Number(count);
}

/** What OpenRouter says about the key in use and the account behind it. Missing parts stay null. */
async function openRouterBalance(apiKey: string | undefined) {
  if (!apiKey) return null;
  const get = async (path: string) => {
    try {
      const response = await fetch(`https://openrouter.ai/api/v1/${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!response.ok) return null;
      return (await response.json())?.data ?? null;
    } catch {
      return null;
    }
  };
  const [key, credits] = await Promise.all([get("key"), get("credits")]);
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return {
    key: key && {
      limit_usd: num(key.limit),
      remaining_usd: num(key.limit_remaining),
      used_usd: num(key.usage),
      used_today_usd: num(key.usage_daily),
      used_this_week_usd: num(key.usage_weekly),
      used_this_month_usd: num(key.usage_monthly),
    },
    account: credits && {
      credits_usd: num(credits.total_credits),
      used_usd: num(credits.total_usage),
      remaining_usd: num(credits.total_credits) !== null && num(credits.total_usage) !== null
        ? num(credits.total_credits)! - num(credits.total_usage)!
        : null,
    },
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const { user } = await authenticateRequest(req);
    const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: admin, error: adminError } = await service.from("app_admins").select("user_id").eq("user_id", user.id).maybeSingle();
    if (adminError) throw adminError;
    if (!admin) return json({ error: "Not available" }, 403);

    const body = await req.json().catch(() => ({})) as { days?: unknown };
    const days = WINDOWS.includes(body.days as typeof WINDOWS[number]) ? body.days as number : 7;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const rows: UsageRow[] = [];
    for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
      const { data, error } = await service
        .from("ai_usage")
        .select("id,user_id,feature,billed_by,model,tier,models,providers,steps,calls,input_tokens,output_tokens,reasoning_tokens,cost_usd,status,duration_ms,created_at")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      rows.push(...((data ?? []) as UsageRow[]));
      if ((data ?? []).length < PAGE_SIZE) break;
    }

    // Emails come from the auth system, which only the service role can read.
    const userIds = [...new Set(rows.map((row) => row.user_id).filter((id): id is string => Boolean(id)))];
    const emails = new Map<string, string>();
    await Promise.all(userIds.map(async (id) => {
      const { data } = await service.auth.admin.getUserById(id);
      if (data.user?.email) emails.set(id, data.user.email);
    }));

    const totals = emptyTotals();
    const byUser = new Map<string, Totals & { models: Record<string, number>; providers: Record<string, number>; features: Record<string, Totals>; last_at: string }>();
    const byFeature: Record<string, Totals> = {};
    const byModel: Record<string, Totals> = {};
    for (const row of rows) {
      add(totals, row);
      const key = row.user_id ?? "unknown";
      const person = byUser.get(key) ?? { ...emptyTotals(), models: {}, providers: {}, features: {}, last_at: row.created_at };
      add(person, row);
      tally(person.models, row.models);
      tally(person.providers, row.providers);
      person.features[row.feature] ??= emptyTotals();
      add(person.features[row.feature], row);
      if (row.created_at > person.last_at) person.last_at = row.created_at;
      byUser.set(key, person);
      byFeature[row.feature] ??= emptyTotals();
      add(byFeature[row.feature], row);
      const model = row.model ?? "unknown";
      byModel[model] ??= emptyTotals();
      add(byModel[model], row);
    }

    const users = [...byUser.entries()]
      .map(([id, person]) => ({ user_id: id === "unknown" ? null : id, email: id === "unknown" ? null : emails.get(id) ?? null, ...person }))
      .sort((a, b) => b.cost_usd - a.cost_usd || b.requests - a.requests);

    const recent = rows.slice(0, RECENT_LIMIT).map((row) => ({
      ...row,
      cost_usd: row.cost_usd === null ? null : Number(row.cost_usd),
      email: row.user_id ? emails.get(row.user_id) ?? null : null,
    }));

    return json({
      days,
      since,
      truncated: rows.length >= MAX_ROWS,
      totals,
      users,
      features: byFeature,
      models: byModel,
      recent,
      openrouter: await openRouterBalance(Deno.env.get("OPENROUTER_API_KEY")),
    });
  } catch (error) {
    if (isAuthenticationError(error)) return json({ error: "Invalid or expired session" }, 401);
    console.error("admin-usage failed:", error instanceof Error ? error.message : error);
    return json({ error: "Could not load usage." }, 500);
  }
});
