import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  authenticateRequest,
  isAuthenticationError,
  type UntypedSupabaseClient,
} from "../_shared/auth.ts";
import {
  EMBEDDING_VERSION,
  generateSemanticEmbedding,
} from "../_shared/embeddings.ts";
import { corsHeaders } from "../_shared/gemini.ts";
import {
  cleanIds,
  contextualEmbeddingText,
  cosineSimilarity,
  deterministicSubset,
  isUuid,
  lengthBucket,
  scoreDistribution,
} from "../_shared/stage1.ts";

type ExperimentType = "q1_subset" | "q2_full_rank" | "q5_short_note";
type ExperimentAction = ExperimentType | "q1_record_result";

interface BaseRequest {
  experiment: ExperimentAction;
}

interface Q1Request extends BaseRequest {
  experiment: "q1_subset";
  entry_text: string;
  target_note_ids: string[];
  subset_size?: number;
  seed?: string;
}

interface Q2Request extends BaseRequest {
  experiment: "q2_full_rank";
  entry_text: string;
  target_note_ids?: string[];
}

interface ContextVariant {
  name: string;
  context_note_ids?: string[];
  context_text?: string;
}

interface Q5Request extends BaseRequest {
  experiment: "q5_short_note";
  note_id: string;
  entry_texts: string[];
  variants?: ContextVariant[];
}

interface Q1ResultRequest extends BaseRequest {
  experiment: "q1_record_result";
  experiment_id: string;
  provider: string;
  model: string;
  run_label?: string;
  response_text: string;
  selected_note_ids?: string[];
  metrics?: Record<string, unknown>;
}

type ExperimentRequest = Q1Request | Q2Request | Q5Request | Q1ResultRequest;

interface RankingRow {
  note_id: string;
  rank: number;
  similarity: number;
  character_count: number;
  token_count: number;
}

interface NoteRow {
  id: string;
  raw_text: string;
  character_count: number;
  token_count: number;
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function createExperiment(
  userClient: UntypedSupabaseClient,
  userId: string,
  experimentType: ExperimentType,
  entryText: string | null,
  configuration: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await userClient
    .from("semantic_retrieval_experiments")
    .insert({
      user_id: userId,
      experiment_type: experimentType,
      entry_text: entryText,
      configuration,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

async function exactRanking(
  userClient: UntypedSupabaseClient,
  embedding: number[],
): Promise<RankingRow[]> {
  const rows: RankingRow[] = [];
  const pageSize = 500;
  for (let offset = 0;; offset += pageSize) {
    const { data, error } = await userClient.rpc(
      "rank_notes_semantically_exact",
      {
        query_embedding: embedding,
        result_offset: offset,
        result_limit: pageSize,
      },
    );
    if (error) throw error;
    const page = ((data ?? []) as RankingRow[]).map((row) => ({
      ...row,
      rank: Number(row.rank),
      similarity: Number(row.similarity),
      character_count: Number(row.character_count),
      token_count: Number(row.token_count),
    }));
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function allOwnedNotes(
  userClient: UntypedSupabaseClient,
  userId: string,
): Promise<NoteRow[]> {
  const notes: NoteRow[] = [];
  const pageSize = 1000;
  for (let offset = 0;; offset += pageSize) {
    const { data, error } = await userClient
      .from("notes")
      .select("id, raw_text, character_count, token_count")
      .eq("user_id", userId)
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    const page = (data ?? []) as NoteRow[];
    notes.push(...page);
    if (page.length < pageSize) break;
  }
  return notes;
}

async function storeRanking(
  userClient: UntypedSupabaseClient,
  experimentId: string,
  variant: string,
  rows: RankingRow[],
): Promise<void> {
  if (!rows.length) return;
  for (let start = 0; start < rows.length; start += 500) {
    const batch = rows.slice(start, start + 500).map((row) => ({
      experiment_id: experimentId,
      variant,
      note_id: row.note_id,
      rank: row.rank,
      similarity: row.similarity,
      character_count: row.character_count,
      token_count: row.token_count,
    }));
    const { error } = await userClient.from(
      "semantic_retrieval_experiment_results",
    ).insert(batch);
    if (error) throw error;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const { user, userClient } = await authenticateRequest(req);
    const body = await req.json() as ExperimentRequest;
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

    if (body.experiment === "q1_subset") {
      const entryText = typeof body.entry_text === "string"
        ? body.entry_text.trim()
        : "";
      const targetIds = cleanIds(body.target_note_ids);
      const subsetSize = Math.min(
        Math.max(Number(body.subset_size) || 50, targetIds.length, 2),
        100,
      );
      const seed = typeof body.seed === "string" && body.seed.trim()
        ? body.seed.trim().slice(0, 100)
        : "q1";
      if (!entryText || !targetIds.length) {
        return json(
          { error: "Q1 requires entry_text and target_note_ids" },
          400,
        );
      }

      const notes = await allOwnedNotes(userClient, user.id);
      const byId = new Map(notes.map((note) => [note.id, note]));
      const missingTargets = targetIds.filter((id) => !byId.has(id));
      if (missingTargets.length) {
        return json({ error: "One or more target notes are unavailable" }, 404);
      }
      if (notes.length < subsetSize) {
        return json(
          { error: `The corpus contains only ${notes.length} notes` },
          400,
        );
      }

      const subset = deterministicSubset(
        notes,
        targetIds,
        subsetSize,
        seed,
      );
      const experimentId = await createExperiment(
        userClient,
        user.id,
        "q1_subset",
        entryText,
        {
          seed,
          subset_size: subsetSize,
          target_note_ids: targetIds,
          subset_note_ids: subset.map((note) => note.id),
          embedding_version: EMBEDDING_VERSION,
        },
      );
      return json({
        success: true,
        experiment_id: experimentId,
        experiment: "q1_subset",
        entry_text: entryText,
        target_note_ids: targetIds,
        notes: subset,
      });
    }

    if (body.experiment === "q1_record_result") {
      const experimentId = typeof body.experiment_id === "string" &&
          isUuid(body.experiment_id)
        ? body.experiment_id
        : "";
      const provider = typeof body.provider === "string"
        ? body.provider.trim().slice(0, 100)
        : "";
      const model = typeof body.model === "string"
        ? body.model.trim().slice(0, 200)
        : "";
      const runLabel = typeof body.run_label === "string" &&
          body.run_label.trim()
        ? body.run_label.trim().slice(0, 100)
        : "default";
      const responseText = typeof body.response_text === "string"
        ? body.response_text.trim().slice(0, 200_000)
        : "";
      const selectedIds = cleanIds(body.selected_note_ids, 100);
      if (!experimentId || !provider || !model || !responseText) {
        return json(
          {
            error:
              "Q1 result requires experiment_id, provider, model, and response_text",
          },
          400,
        );
      }

      const { data: experiment, error: experimentError } = await userClient
        .from("semantic_retrieval_experiments")
        .select("id, experiment_type, configuration")
        .eq("id", experimentId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (experimentError) throw experimentError;
      if (!experiment || experiment.experiment_type !== "q1_subset") {
        return json({ error: "Q1 subset experiment not found" }, 404);
      }
      if (selectedIds.length) {
        const { count, error } = await userClient
          .from("notes")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .in("id", selectedIds);
        if (error) throw error;
        if (count !== selectedIds.length) {
          return json(
            { error: "One or more selected notes are unavailable" },
            404,
          );
        }
      }

      const configuration = experiment.configuration &&
          typeof experiment.configuration === "object"
        ? experiment.configuration as Record<string, unknown>
        : {};
      const targetIds = cleanIds(configuration.target_note_ids, 100);
      const selectedSet = new Set(selectedIds);
      const targetHits = targetIds.filter((id) => selectedSet.has(id));
      const metrics = body.metrics && typeof body.metrics === "object"
        ? body.metrics
        : {};
      const { data: benchmark, error: benchmarkError } = await userClient
        .from("semantic_reasoning_benchmark_results")
        .insert({
          experiment_id: experimentId,
          provider,
          model,
          run_label: runLabel,
          response_text: responseText,
          selected_note_ids: selectedIds,
          metrics: {
            ...metrics,
            target_note_count: targetIds.length,
            target_hit_count: targetHits.length,
            target_note_ids: targetIds,
            target_hit_ids: targetHits,
          },
        })
        .select("id, created_at")
        .single();
      if (benchmarkError) throw benchmarkError;
      return json({
        success: true,
        experiment: "q1_record_result",
        benchmark_id: benchmark.id,
        created_at: benchmark.created_at,
        target_note_count: targetIds.length,
        target_hit_count: targetHits.length,
        target_hit_ids: targetHits,
      });
    }

    if (body.experiment === "q2_full_rank") {
      const entryText = typeof body.entry_text === "string"
        ? body.entry_text.trim()
        : "";
      const targetIds = cleanIds(body.target_note_ids);
      if (!entryText) return json({ error: "Q2 requires entry_text" }, 400);
      if (targetIds.length) {
        const { count, error } = await userClient
          .from("notes")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .in("id", targetIds);
        if (error) throw error;
        if (count !== targetIds.length) {
          return json(
            { error: "One or more target notes are unavailable" },
            404,
          );
        }
      }

      const queryEmbedding = await generateSemanticEmbedding(
        entryText,
        apiKey,
        "RETRIEVAL_QUERY",
      );
      const ranking = await exactRanking(userClient, queryEmbedding);
      const experimentId = await createExperiment(
        userClient,
        user.id,
        "q2_full_rank",
        entryText,
        {
          target_note_ids: targetIds,
          embedding_version: EMBEDDING_VERSION,
          exact_full_corpus: true,
        },
      );
      await storeRanking(userClient, experimentId, "semantic", ranking);
      const targetSet = new Set(targetIds);
      return json({
        success: true,
        experiment_id: experimentId,
        experiment: "q2_full_rank",
        embedding_version: EMBEDDING_VERSION,
        distribution: scoreDistribution(ranking),
        target_ranks: ranking.filter((row) => targetSet.has(row.note_id)),
        ranking,
      });
    }

    if (body.experiment === "q5_short_note") {
      const noteId = typeof body.note_id === "string" && isUuid(body.note_id)
        ? body.note_id
        : "";
      const entryTexts = Array.isArray(body.entry_texts)
        ? body.entry_texts.filter((entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0
        ).map((entry) => entry.trim()).slice(0, 10)
        : [];
      if (!noteId || !entryTexts.length) {
        return json({ error: "Q5 requires note_id and entry_texts" }, 400);
      }

      const requestedVariants = Array.isArray(body.variants)
        ? body.variants.slice(0, 6)
        : [];
      const contextIds = cleanIds(
        requestedVariants.flatMap((variant) => variant.context_note_ids ?? []),
        100,
      );
      const { data: note, error: noteError } = await userClient
        .from("notes")
        .select("id, raw_text, character_count, token_count")
        .eq("user_id", user.id)
        .eq("id", noteId)
        .maybeSingle();
      if (noteError) throw noteError;
      if (!note) return json({ error: "Short note not found" }, 404);

      const { data: contextRows, error: contextError } = contextIds.length
        ? await userClient.from("notes").select("id, raw_text").eq(
          "user_id",
          user.id,
        ).in("id", contextIds)
        : { data: [], error: null };
      if (contextError) throw contextError;
      const contextById = new Map(
        (contextRows ?? []).map((
          row,
        ) => [row.id as string, row.raw_text as string]),
      );
      if (contextIds.some((id) => !contextById.has(id))) {
        return json(
          { error: "One or more context notes are unavailable" },
          404,
        );
      }

      const variants = [{ name: "isolated", text: note.raw_text as string }];
      const variantNames = new Set(["isolated"]);
      for (const variant of requestedVariants) {
        const name = typeof variant.name === "string"
          ? variant.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-")
            .slice(0, 40)
          : "";
        if (!name || variantNames.has(name)) continue;
        const ids = cleanIds(variant.context_note_ids, 30);
        const contextText = typeof variant.context_text === "string"
          ? variant.context_text.trim().slice(0, 50_000)
          : "";
        const contextParts = [
          ...ids.map((id) => contextById.get(id)!),
          contextText,
        ].filter(Boolean);
        if (contextParts.length) {
          variantNames.add(name);
          variants.push({
            name,
            text: contextualEmbeddingText(note.raw_text, contextParts),
          });
        }
      }

      const documentEmbeddings = await Promise.all(
        variants.map(async (variant) => ({
          ...variant,
          embedding: await generateSemanticEmbedding(
            variant.text,
            apiKey,
            "RETRIEVAL_DOCUMENT",
          ),
        })),
      );
      const experimentId = await createExperiment(
        userClient,
        user.id,
        "q5_short_note",
        null,
        {
          note_id: noteId,
          entry_texts: entryTexts,
          variants: variants.map((variant) => variant.name),
          length_bucket: lengthBucket(Number(note.character_count)),
          embedding_version: EMBEDDING_VERSION,
        },
      );

      const comparisons: Array<Record<string, unknown>> = [];
      for (
        let queryIndex = 0;
        queryIndex < entryTexts.length;
        queryIndex += 1
      ) {
        const queryEmbedding = await generateSemanticEmbedding(
          entryTexts[queryIndex],
          apiKey,
          "RETRIEVAL_QUERY",
        );
        const baseline = await exactRanking(userClient, queryEmbedding);
        const withoutSubject = baseline.filter((row) => row.note_id !== noteId);
        for (const variant of documentEmbeddings) {
          const similarity = cosineSimilarity(
            queryEmbedding,
            variant.embedding,
          );
          const rank = 1 +
            withoutSubject.filter((row) => row.similarity > similarity).length;
          const key = `${variant.name}:query-${queryIndex + 1}`;
          const row: RankingRow = {
            note_id: noteId,
            rank,
            similarity,
            character_count: Number(note.character_count),
            token_count: Number(note.token_count),
          };
          await storeRanking(userClient, experimentId, key, [row]);
          comparisons.push({
            query_index: queryIndex + 1,
            entry_text: entryTexts[queryIndex],
            variant: variant.name,
            rank,
            similarity,
          });
        }
      }

      return json({
        success: true,
        experiment_id: experimentId,
        experiment: "q5_short_note",
        embedding_version: EMBEDDING_VERSION,
        note: {
          id: note.id,
          character_count: note.character_count,
          token_count: note.token_count,
          length_bucket: lengthBucket(Number(note.character_count)),
        },
        comparisons,
      });
    }

    return json({ error: "Unknown experiment type" }, 400);
  } catch (error) {
    if (isAuthenticationError(error)) {
      return json({ error: "Invalid or expired session" }, 401);
    }
    const message = error instanceof Error
      ? error.message
      : "Experiment failed";
    return json({ error: message }, 500);
  }
});
