import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { sumTokenUsage, type TokenUsage } from "./gemini.ts";

/**
 * One row per AI request in public.ai_usage, written with the service role so
 * people cannot see or alter it; only the admin page reads it. It holds who
 * asked, what for, which models and providers answered, the tokens, and what
 * it cost. It never holds note text.
 */

export type UsageStatus = "ok" | "cancelled" | "failed";

/** OpenRouter reports a price for every call; Google, called directly, reports only tokens. */
export type BilledBy = "openrouter" | "google";

export interface UsageRecord {
  /** The verified signed-in user, or null when the request carried none. */
  userId: string | null;
  /** The function that made the request, e.g. "find-relevant-notes". */
  feature: string;
  billedBy: BilledBy;
  /** The model asked for; the models that actually answered are in the usage. */
  model: string | null;
  /** "basic" or "best", for features that let the person choose. */
  tier?: string | null;
  /** Usage per step, such as the agents and the insight of one search. Summed for the totals. */
  steps: Record<string, TokenUsage>;
  status: UsageStatus;
  startedAt: number;
}

let serviceClient: SupabaseClient | null = null;

function client(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  serviceClient ??= createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return serviceClient;
}


function countsRecord(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).filter(([name, count]) => name && count > 0));
}

/**
 * Writes the request's row. Never throws, so tracking can never break the
 * feature it measures. A request that made no AI call costs nothing and is
 * not recorded.
 */
export async function recordUsage(record: UsageRecord): Promise<void> {
  const total = sumTokenUsage(Object.values(record.steps));
  if (total.calls === 0) return;
  const service = client();
  if (!service) {
    console.error("ai_usage not recorded: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing");
    return;
  }
  const steps = Object.fromEntries(Object.entries(record.steps)
    .filter(([, usage]) => usage.calls > 0)
    .map(([name, usage]) => [name, {
      calls: usage.calls,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cost_usd: record.billedBy === "openrouter" ? Number(usage.costUsd.toFixed(6)) : null,
    }]));
  const row = {
    user_id: record.userId,
    feature: record.feature,
    billed_by: record.billedBy,
    model: record.model,
    tier: record.tier ?? null,
    models: countsRecord(total.models),
    providers: countsRecord(total.providers),
    steps,
    calls: total.calls,
    input_tokens: total.inputTokens,
    cached_input_tokens: total.cachedInputTokens,
    output_tokens: total.outputTokens,
    reasoning_tokens: total.reasoningTokens,
    // Google does not report a price, so its cost is unknown rather than zero.
    cost_usd: record.billedBy === "openrouter" ? Number(total.costUsd.toFixed(6)) : null,
    status: record.status,
    duration_ms: Math.max(0, Date.now() - record.startedAt),
  };
  try {
    let { error } = await service.from("ai_usage").insert(row);
    // The account may have been deleted mid-request; keep the cost anyway.
    if (error?.code === "23503" && row.user_id) ({ error } = await service.from("ai_usage").insert({ ...row, user_id: null }));
    if (error) console.error("ai_usage insert failed:", error.message);
  } catch (error) {
    console.error("ai_usage insert failed:", error instanceof Error ? error.message : error);
  }
}

/**
 * Lets the row be written after the response has gone out, where the runtime
 * supports it, so recording never adds to the person's wait.
 */
export function recordUsageInBackground(record: UsageRecord): void {
  const pending = recordUsage(record);
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(pending);
}
