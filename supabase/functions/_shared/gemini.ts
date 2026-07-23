export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const DEFAULT_MODEL = "gemini-flash-lite-latest";

export interface GeminiMessage {
  role: "user" | "model";
  content: string;
}

export async function generateWithGemini(
  systemPrompt: string,
  messages: GeminiMessage[],
  apiKey: string,
  model: string = DEFAULT_MODEL
): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: messages.map((m) => ({ role: m.role, parts: [{ text: m.content }] })),
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${err}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p: { text?: string }) => p.text ?? "").join("");
}

/** Pulls a JSON object out of a Gemini response, tolerating a ```json fence around it. */
export function extractJson(raw: string): string | null {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/);
  if (fenced) return fenced[1];
  const bare = raw.match(/\{[\s\S]*\}/);
  return bare ? bare[0] : null;
}
