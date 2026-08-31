import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { authenticateRequest, isAuthenticationError } from "../_shared/auth.ts";
import {
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL,
  EMBEDDING_PROVIDER,
  EMBEDDING_VERSION,
  generateSemanticEmbedding,
  noteTitle,
  sha256,
} from "../_shared/embeddings.ts";
import { corsHeaders } from "../_shared/gemini.ts";
import { cleanIds, isEmbeddingEligible } from "../_shared/stage1.ts";

interface EmbedNotesRequest {
  note_ids?: string[];
  limit?: number;
  retry_failed?: boolean;
  retry_stale_processing?: boolean;
}

interface NoteEmbeddingRow {
  id: string;
  raw_text: string;
  embedding_status: "pending" | "processing" | "ready" | "failed";
  embedding_version: string | null;
  embedding_attempts: number;
  embedding_started_at: string | null;
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const { user } = await authenticateRequest(req);
    const body = await req.json().catch(() => ({})) as EmbedNotesRequest;
    const requestedIds = cleanIds(body.note_ids, 101);
    if (requestedIds.length > 100) {
      return json({ error: "At most 100 note IDs may be requested" }, 400);
    }

    const limit = Math.min(Math.max(Number(body.limit) || 25, 1), 50);
    const service = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    let query = service
      .from("notes")
      .select(
        "id, raw_text, embedding_status, embedding_version, embedding_attempts, embedding_started_at",
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .limit(requestedIds.length ? Math.min(requestedIds.length, 100) : limit);

    if (requestedIds.length) {
      query = query.in("id", requestedIds);
    } else {
      const statuses = ["pending"];
      if (body.retry_failed === true) statuses.push("failed");
      if (body.retry_stale_processing === true) statuses.push("processing");
      query = query.in("embedding_status", statuses);
    }
    const { data, error } = await query;
    if (error) throw error;

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

    const results: Array<Record<string, unknown>> = [];
    for (const note of (data ?? []) as NoteEmbeddingRow[]) {
      const eligible = isEmbeddingEligible(note, EMBEDDING_VERSION, {
        retryFailed: body.retry_failed,
        retryStaleProcessing: body.retry_stale_processing,
      });
      if (!eligible) {
        results.push({
          note_id: note.id,
          status: "skipped",
          embedding_status: note.embedding_status,
        });
        continue;
      }

      const startedAt = new Date().toISOString();
      let claimQuery = service
        .from("notes")
        .update({
          embedding_status: "processing",
          embedding_error: null,
          embedding_started_at: startedAt,
          embedding_attempts: (note.embedding_attempts ?? 0) + 1,
        })
        .eq("id", note.id)
        .eq("user_id", user.id)
        .eq("embedding_status", note.embedding_status);
      if (note.embedding_status === "processing") {
        claimQuery = note.embedding_started_at
          ? claimQuery.eq("embedding_started_at", note.embedding_started_at)
          : claimQuery.is("embedding_started_at", null);
      }
      const { data: claimed, error: claimError } = await claimQuery
        .select("id")
        .maybeSingle();
      if (claimError) throw claimError;
      if (!claimed) {
        results.push({
          note_id: note.id,
          status: "skipped",
          reason: "already claimed",
        });
        continue;
      }

      try {
        const sourceHash = await sha256(note.raw_text);
        const embedding = await generateSemanticEmbedding(
          note.raw_text,
          apiKey,
          "RETRIEVAL_DOCUMENT",
          noteTitle(note.raw_text),
        );
        const { data: saved, error: saveError } = await service
          .from("notes")
          .update({
            semantic_embedding: embedding,
            embedding_provider: EMBEDDING_PROVIDER,
            embedding_model: EMBEDDING_MODEL,
            embedding_dimension: EMBEDDING_DIMENSION,
            embedding_version: EMBEDDING_VERSION,
            embedding_status: "ready",
            embedding_error: null,
            embedding_started_at: null,
            embedded_at: new Date().toISOString(),
            embedding_source_hash: sourceHash,
          })
          .eq("id", note.id)
          .eq("user_id", user.id)
          .eq("raw_text", note.raw_text)
          .select("id")
          .maybeSingle();
        if (saveError) throw saveError;
        results.push(
          saved
            ? { note_id: note.id, status: "ready", version: EMBEDDING_VERSION }
            : {
              note_id: note.id,
              status: "stale",
              reason: "note changed while embedding",
            },
        );
      } catch (error) {
        const message = error instanceof Error
          ? error.message.slice(0, 1000)
          : "Embedding failed";
        const { data: failedNote } = await service
          .from("notes")
          .update({
            embedding_status: "failed",
            embedding_error: message,
            embedding_started_at: null,
            embedding_provider: EMBEDDING_PROVIDER,
            embedding_model: EMBEDDING_MODEL,
            embedding_dimension: EMBEDDING_DIMENSION,
            embedding_version: EMBEDDING_VERSION,
          })
          .eq("id", note.id)
          .eq("user_id", user.id)
          .eq("raw_text", note.raw_text)
          .select("id")
          .maybeSingle();
        results.push(
          failedNote
            ? { note_id: note.id, status: "failed", error: message }
            : {
              note_id: note.id,
              status: "stale",
              reason: "note changed while embedding",
            },
        );
      }
    }

    return json({
      success: true,
      embedding_version: EMBEDDING_VERSION,
      processed: results.filter((result) => result.status === "ready").length,
      failed: results.filter((result) => result.status === "failed").length,
      results,
    });
  } catch (error) {
    if (isAuthenticationError(error)) {
      return json({ error: "Invalid or expired session" }, 401);
    }
    const message = error instanceof Error
      ? error.message
      : "Embedding worker failed";
    return json({ error: message }, 500);
  }
});
