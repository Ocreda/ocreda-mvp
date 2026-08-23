import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/gemini.ts";

interface ExtractDocumentRequest {
  file_name: string;
  mime_type: string;
  data: string;
}

interface GeminiFile {
  name: string;
  uri: string;
  mimeType?: string;
  state?: string;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const INLINE_MIME_TYPES = new Set([
  "application/pdf",
  "image/bmp",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const FILE_API_MIME_TYPES = new Set([
  "application/msword",
  "application/rtf",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/rtf",
]);

const transcriptionPrompt = `Transcribe every readable piece of note text from this file.

Rules:
- Return only the transcription. Do not add an introduction or explanation.
- Preserve the author's wording, spelling, capitalization, punctuation, and paragraph order.
- Do not summarize, correct, translate, rewrite, or complete unfinished thoughts.
- Preserve headings, bullets, numbered lists, table cells, and meaningful line breaks in plain text.
- Include handwritten text as well as typed text.
- If handwriting is genuinely unreadable, write [illegible] at that exact location. Never guess.
- Ignore decorative page numbers and repeated headers or footers unless they are part of the note.`;

function response(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function cleanTranscription(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:text|markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

async function generateTranscription(
  apiKey: string,
  parts: Array<Record<string, unknown>>
): Promise<string> {
  const model = Deno.env.get("GEMINI_DOCUMENT_MODEL") || "gemini-3.6-flash";
  const result = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: "You are a faithful document transcription engine." }],
        },
        contents: [{ role: "user", parts: [...parts, { text: transcriptionPrompt }] }],
        generationConfig: { maxOutputTokens: 65536 },
      }),
    },
  );

  if (!result.ok) {
    throw new Error(`The transcription service could not read this document (${result.status}).`);
  }

  const payload = await result.json();
  const candidate = payload.candidates?.[0];
  if (candidate?.finishReason === "MAX_TOKENS") {
    throw new Error("This document contains too much text to import as one note. Split it into smaller files and try again.");
  }
  const text = cleanTranscription(
    (candidate?.content?.parts ?? []).map((part: { text?: string }) => part.text ?? "").join(""),
  );
  if (!text) throw new Error("No readable note text was found in this file.");
  return text;
}

async function uploadGeminiFile(
  apiKey: string,
  fileName: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<GeminiFile> {
  const start = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
        "X-Goog-Upload-Header-Content-Type": mimeType,
      },
      body: JSON.stringify({ file: { display_name: fileName } }),
    },
  );
  if (!start.ok) throw new Error(`Could not prepare document upload (${start.status}).`);

  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini did not return a document upload URL.");

  const upload = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes,
  });
  if (!upload.ok) throw new Error(`Document upload failed (${upload.status}).`);

  const payload = await upload.json();
  const file = (payload.file ?? payload) as GeminiFile;
  if (!file.name || !file.uri) throw new Error("Gemini did not confirm the uploaded document.");
  return file;
}

async function waitForFile(apiKey: string, initialFile: GeminiFile): Promise<GeminiFile> {
  let file = initialFile;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!file.state || file.state === "ACTIVE") return file;
    if (file.state === "FAILED") throw new Error("Gemini could not read this document format.");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const result = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${file.name}?key=${apiKey}`,
    );
    if (!result.ok) throw new Error(`Could not check document processing status (${result.status}).`);
    file = await result.json() as GeminiFile;
  }
  throw new Error("Document extraction timed out. Try a smaller file.");
}

async function deleteGeminiFile(apiKey: string, fileName: string): Promise<void> {
  await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`,
    { method: "DELETE" },
  ).catch(() => undefined);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);

  try {
    const authorization = req.headers.get("Authorization");
    const token = authorization?.replace(/^Bearer\s+/i, "");
    if (!token) return response({ error: "Authentication required" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: `Bearer ${token}` } } },
    );
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData.user) return response({ error: "Invalid or expired session" }, 401);

    const { file_name, mime_type, data } = await req.json() as ExtractDocumentRequest;
    if (!file_name || !mime_type || !data) return response({ error: "File name, type, and data are required" }, 400);
    if (!INLINE_MIME_TYPES.has(mime_type) && !FILE_API_MIME_TYPES.has(mime_type)) {
      return response({ error: `Unsupported document type: ${mime_type}` }, 415);
    }

    const estimatedBytes = Math.floor((data.length * 3) / 4);
    if (estimatedBytes > MAX_FILE_BYTES) return response({ error: "Files must be 10 MB or smaller" }, 413);
    const bytes = decodeBase64(data);
    if (bytes.byteLength === 0) return response({ error: "The selected file is empty" }, 400);

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

    let text: string;
    if (INLINE_MIME_TYPES.has(mime_type)) {
      text = await generateTranscription(apiKey, [{
        inline_data: { mime_type, data },
      }]);
    } else {
      const uploaded = await uploadGeminiFile(apiKey, file_name, mime_type, bytes);
      try {
        const activeFile = await waitForFile(apiKey, uploaded);
        text = await generateTranscription(apiKey, [{
          file_data: {
            mime_type: activeFile.mimeType || mime_type,
            file_uri: activeFile.uri,
          },
        }]);
      } finally {
        await deleteGeminiFile(apiKey, uploaded.name);
      }
    }

    return response({
      text,
      extraction_method: mime_type.startsWith("image/") || mime_type === "application/pdf" ? "ocr" : "document",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Document extraction failed";
    return response({ error: message }, 500);
  }
});
