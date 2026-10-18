export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

/** "Best" mode, and the default everywhere: the production model. */
export const BEST_MODEL = "google/gemini-3.7-flash";
/** "Basic" mode: cheaper, for testing. Weaker on subtle relations. */
export const BASIC_MODEL = "deepseek/deepseek-v4.1-flash";
const DEFAULT_MODEL = BEST_MODEL;

/**
 * Models that must be served by the listed OpenRouter providers, tried in
 * order. OpenRouter otherwise picks among every host of a model, and hosts
 * differ in price, quantization, and how well they follow a JSON response
 * format. When every listed provider is down, the request fails rather than
 * quietly going to one not on the list.
 */
const PROVIDERS_FOR_MODEL: Record<string, string[]> = {
  // Morph first, Inference.net as the backup; both serve it at fp8.
  [BASIC_MODEL]: ["morph", "inference-net"],
};

/** The AI mode a person picks in the app. */
export type ModelTier = "basic" | "best";

/**
 * Callers send a tier, never a model id, so a request can only ever choose
 * between these two models. Anything unrecognised gets the default.
 */
export function readModelTier(value: unknown): ModelTier {
  return value === "basic" ? "basic" : "best";
}

export function modelForTier(tier: ModelTier): string {
  return tier === "basic" ? BASIC_MODEL : BEST_MODEL;
}

export interface GeminiMessage {
  role: "user" | "model";
  content: string;
}

/** The subset of Gemini's generationConfig this app uses. */
export interface GeminiGenerationConfig {
  responseMimeType?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

/**
 * Carries the HTTP status through so callers can tell a rate limit or a
 * transient upstream fault (worth retrying) from a malformed request (not).
 */
export class GeminiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
  }
}

/** 429 plus the 5xx family are transient; everything else is our own fault. */
export function isRetryableGeminiError(error: unknown): boolean {
  if (!(error instanceof GeminiError)) return false;
  return error.status === 429 || error.status >= 500;
}

export interface GeminiGeneration {
  text: string;
  /**
   * The model hit its token budget mid-answer. On OpenRouter that budget covers
   * a thinking model's reasoning as well as the words the user sees, so a reply
   * can arrive cut off rather than empty. Callers that would otherwise show a
   * half sentence check this and fall back.
   */
  truncated: boolean;
  /** Token counts OpenRouter reported for this call, or null if it sent none. */
  usage: TokenUsage | null;
}

/**
 * For operator cost tracking only. It is written to the function logs and must
 * never be returned to the client.
 */
export interface TokenUsage {
  calls: number;
  inputTokens: number;
  /** Includes reasoning tokens; they are billed as output. */
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  /** OpenRouter's own billed figure in USD, when it reports one. */
  costUsd: number;
  /** Calls per model that answered, as the provider named it. */
  models: Record<string, number>;
  /** Calls per provider that served them, e.g. "Morph"; empty where none is reported. */
  providers: Record<string, number>;
}

export function emptyTokenUsage(): TokenUsage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, costUsd: 0, models: {}, providers: {} };
}

export function addTokenUsage(total: TokenUsage, usage: TokenUsage | null): void {
  if (!usage) return;
  total.calls += usage.calls;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.reasoningTokens += usage.reasoningTokens;
  total.cachedInputTokens += usage.cachedInputTokens;
  total.costUsd += usage.costUsd;
  for (const [name, count] of Object.entries(usage.models)) total.models[name] = (total.models[name] ?? 0) + count;
  for (const [name, count] of Object.entries(usage.providers)) total.providers[name] = (total.providers[name] ?? 0) + count;
}

/** The sum of several usages, such as the steps of one search. */
export function sumTokenUsage(parts: TokenUsage[]): TokenUsage {
  const total = emptyTokenUsage();
  for (const part of parts) addTokenUsage(total, part);
  return total;
}

/**
 * One answered call. A reply with no usage block still counts as a call, so a
 * request is never recorded as costing nothing when it did not.
 */
function readUsage(raw: unknown, model: string, provider: unknown): TokenUsage {
  const usage = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const details = (key: string) => (usage[key] ?? {}) as Record<string, unknown>;
  return {
    calls: 1,
    inputTokens: num(usage.prompt_tokens),
    outputTokens: num(usage.completion_tokens),
    reasoningTokens: num(details("completion_tokens_details").reasoning_tokens),
    cachedInputTokens: num(details("prompt_tokens_details").cached_tokens),
    costUsd: num(usage.cost),
    models: { [model]: 1 },
    providers: typeof provider === "string" && provider ? { [provider]: 1 } : {},
  };
}

/**
 * Usage for a call to Google directly (documents, embeddings). Google reports
 * tokens but no price, so the cost stays 0 and the record says Google billed it.
 */
export function googleTokenUsage(model: string, inputTokens: number | null | undefined, outputTokens = 0, calls = 1): TokenUsage {
  return {
    ...emptyTokenUsage(),
    calls,
    inputTokens: inputTokens ?? 0,
    outputTokens,
    models: { [model]: calls },
    providers: { Google: calls },
  };
}

export async function generateWithGemini(
  systemPrompt: string,
  messages: GeminiMessage[],
  apiKey: string,
  model: string = DEFAULT_MODEL,
  generationConfig?: GeminiGenerationConfig,
  signal?: AbortSignal,
): Promise<string> {
  return (await generateWithGeminiResult(systemPrompt, messages, apiKey, model, generationConfig, signal)).text;
}

/**
 * `signal` drops the request when the search it belongs to is cancelled. A
 * call already running may still be billed, since OpenRouter only stops
 * generating for streamed requests, but nothing after it is sent.
 */
export async function generateWithGeminiResult(
  systemPrompt: string,
  messages: GeminiMessage[],
  apiKey: string,
  model: string = DEFAULT_MODEL,
  generationConfig?: GeminiGenerationConfig,
  signal?: AbortSignal,
): Promise<GeminiGeneration> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({ role: m.role === "model" ? "assistant" : m.role, content: m.content })),
      ],
      ...(generationConfig?.temperature !== undefined ? { temperature: generationConfig.temperature } : {}),
      ...(generationConfig?.maxOutputTokens !== undefined ? { max_tokens: generationConfig.maxOutputTokens } : {}),
      ...(generationConfig?.responseMimeType === "application/json"
        ? { response_format: { type: "json_object" } }
        : {}),
      // Asks OpenRouter to include the billed cost alongside the token counts.
      usage: { include: true },
      ...(PROVIDERS_FOR_MODEL[model] ? { provider: { order: PROVIDERS_FOR_MODEL[model], allow_fallbacks: false } } : {}),
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new GeminiError(res.status, `OpenRouter API error (${res.status}): ${err}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  return {
    text: choice?.message?.content ?? "",
    truncated: choice?.finish_reason === "length",
    usage: readUsage(data.usage, typeof data.model === "string" && data.model ? data.model : model, data.provider),
  };
}

/** Pulls a JSON object out of a Gemini response, tolerating a ```json fence around it. */
export function extractJson(raw: string): string | null {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/);
  if (fenced) return fenced[1];
  const bare = raw.match(/\{[\s\S]*\}/);
  return bare ? bare[0] : null;
}
