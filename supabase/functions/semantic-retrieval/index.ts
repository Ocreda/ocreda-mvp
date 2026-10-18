import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { authenticateRequest, isAuthenticationError } from '../_shared/auth.ts';
import { EMBEDDING_MODEL, generateSemanticEmbeddingResult } from '../_shared/embeddings.ts';
import { googleTokenUsage } from '../_shared/gemini.ts';
import { recordUsageInBackground } from '../_shared/usage.ts';
import { corsHeaders } from '../_shared/gemini.ts';
import { diversifyCandidates, parseVector, partitionNearDuplicates, type SemanticCandidate } from '../_shared/stage3.ts';

interface RetrievalRequest {
  page_text?: string;
  candidate_limit?: number;
  similarity_floor?: number;
  duplicate_threshold?: number;
  diversity_lambda?: number;
  /** Search the sample notes instead of the person's own; never both. */
  include_samples?: boolean;
}

interface RpcCandidate {
  note_id: string;
  similarity: number;
  raw_rank: number;
  note_length: number;
  token_count: number;
  raw_text: string;
  embedding_text: string;
  is_near_duplicate: boolean;
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(number, minimum), maximum) : fallback;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { user, userClient } = await authenticateRequest(req);
    const body = await req.json().catch(() => ({})) as RetrievalRequest;
    const pageText = typeof body.page_text === 'string' ? body.page_text.trim() : '';
    if (!pageText) return json({ error: 'page_text is required' }, 400);
    if (pageText.length > 200_000) return json({ error: 'page_text is too large' }, 413);

    const candidateLimit = Math.round(boundedNumber(body.candidate_limit, 60, 1, 60));
    // Zero is intentionally neutral until Q3 locks a score-distribution floor.
    const similarityFloor = boundedNumber(body.similarity_floor, 0, -1, 1);
    const duplicateThreshold = boundedNumber(body.duplicate_threshold, 0.95, 0.8, 1);
    const diversityLambda = boundedNumber(body.diversity_lambda, 0.72, 0, 1);
    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

    const startedAt = Date.now();
    const embedded = await generateSemanticEmbeddingResult(pageText, apiKey, 'RETRIEVAL_QUERY');
    recordUsageInBackground({ userId: user.id, feature: 'semantic-retrieval', billedBy: 'google', model: EMBEDDING_MODEL, steps: { query: googleTokenUsage(EMBEDDING_MODEL, embedded.tokenCount) }, status: 'ok', startedAt });
    const queryEmbedding = embedded.values;
    const { data, error } = await userClient.rpc('match_notes_semantic', {
      query_embedding: queryEmbedding,
      candidate_limit: candidateLimit,
      similarity_floor: similarityFloor,
      duplicate_threshold: duplicateThreshold,
      include_samples: body.include_samples === true,
    });
    if (error) throw error;

    const candidates: SemanticCandidate[] = ((data ?? []) as RpcCandidate[]).map((row) => ({
      note_id: row.note_id,
      similarity: Number(row.similarity),
      raw_rank: Number(row.raw_rank),
      note_length: Number(row.note_length),
      token_count: Number(row.token_count),
      raw_text: row.raw_text,
      embedding: parseVector(row.embedding_text),
    }));
    const partitioned = partitionNearDuplicates(candidates, duplicateThreshold);
    const diversified = diversifyCandidates(partitioned.candidates, candidateLimit, diversityLambda);
    const serialize = (candidate: SemanticCandidate & Partial<{ diversified_rank: number; mmr_score: number }>) => ({
      note_id: candidate.note_id,
      similarity: candidate.similarity,
      raw_rank: candidate.raw_rank,
      diversified_rank: candidate.diversified_rank ?? null,
      mmr_score: candidate.mmr_score ?? null,
      note_length: candidate.note_length,
      token_count: candidate.token_count,
      raw_text: candidate.raw_text,
    });

    return json({
      success: true,
      configuration: {
        candidate_limit: candidateLimit,
        similarity_floor: similarityFloor,
        duplicate_threshold: duplicateThreshold,
        diversity_lambda: diversityLambda,
        behavioral_weighting: false,
      },
      candidates: diversified.map(serialize),
      near_duplicates: partitioned.nearDuplicates.map(serialize),
      candidate_count: diversified.length,
    });
  } catch (error) {
    if (isAuthenticationError(error)) return json({ error: 'Invalid or expired session' }, 401);
    return json({ error: error instanceof Error ? error.message : 'Semantic retrieval failed' }, 500);
  }
});
