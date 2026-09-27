export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const DEFAULT_MODEL = "google/gemini-3.7-flash"; //Prod mode
// const DEFAULT_MODEL = "google/gemini-2.5-flash-lite"; //Dev Mode

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
}

export function emptyTokenUsage(): TokenUsage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, costUsd: 0 };
}

export function addTokenUsage(total: TokenUsage, usage: TokenUsage | null): void {
  if (!usage) return;
  total.calls += usage.calls;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.reasoningTokens += usage.reasoningTokens;
  total.cachedInputTokens += usage.cachedInputTokens;
  total.costUsd += usage.costUsd;
}

function readUsage(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const details = (key: string) => (usage[key] ?? {}) as Record<string, unknown>;
  return {
    calls: 1,
    inputTokens: num(usage.prompt_tokens),
    outputTokens: num(usage.completion_tokens),
    reasoningTokens: num(details("completion_tokens_details").reasoning_tokens),
    cachedInputTokens: num(details("prompt_tokens_details").cached_tokens),
    costUsd: num(usage.cost),
  };
}

export async function generateWithGemini(
  systemPrompt: string,
  messages: GeminiMessage[],
  apiKey: string,
  model: string = DEFAULT_MODEL,
  generationConfig?: GeminiGenerationConfig
): Promise<string> {
  return (await generateWithGeminiResult(systemPrompt, messages, apiKey, model, generationConfig)).text;
}

export async function generateWithGeminiResult(
  systemPrompt: string,
  messages: GeminiMessage[],
  apiKey: string,
  model: string = DEFAULT_MODEL,
  generationConfig?: GeminiGenerationConfig
): Promise<GeminiGeneration> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
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
    usage: readUsage(data.usage),
  };
}

/** Pulls a JSON object out of a Gemini response, tolerating a ```json fence around it. */
export function extractJson(raw: string): string | null {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/);
  if (fenced) return fenced[1];
  const bare = raw.match(/\{[\s\S]*\}/);
  return bare ? bare[0] : null;
}
