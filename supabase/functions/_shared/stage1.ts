export type EmbeddingStatus = "pending" | "processing" | "ready" | "failed";

export interface EmbeddingState {
  embedding_status: EmbeddingStatus;
  embedding_version: string | null;
  embedding_started_at: string | null;
}

export interface RankingLike {
  similarity: number;
}

export interface IdentifiedNote {
  id: string;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

export function cleanIds(value: unknown, maximum = 50): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter((id): id is string => typeof id === "string" && isUuid(id)),
    ),
  ).slice(0, maximum);
}

export function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function deterministicSubset<T extends IdentifiedNote>(
  notes: T[],
  targetIds: string[],
  subsetSize: number,
  seed: string,
): T[] {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const targetSet = new Set(targetIds);
  const remainder = notes
    .filter((note) => !targetSet.has(note.id))
    .sort((left, right) =>
      stableHash(`${seed}:${left.id}`) - stableHash(`${seed}:${right.id}`)
    );
  return [
    ...targetIds.map((id) => byId.get(id)).filter((note): note is T => !!note),
    ...remainder.slice(0, Math.max(0, subsetSize - targetIds.length)),
  ].sort((left, right) =>
    stableHash(`${seed}:order:${left.id}`) -
    stableHash(`${seed}:order:${right.id}`)
  );
}

export function isStaleProcessing(
  startedAt: string | null,
  now = Date.now(),
  staleAfterMs = 15 * 60 * 1000,
): boolean {
  if (!startedAt) return true;
  const timestamp = new Date(startedAt).getTime();
  return !Number.isFinite(timestamp) || now - timestamp > staleAfterMs;
}

export function isEmbeddingEligible(
  note: EmbeddingState,
  currentVersion: string,
  options: { retryFailed?: boolean; retryStaleProcessing?: boolean } = {},
  now = Date.now(),
): boolean {
  return note.embedding_status === "pending" ||
    (note.embedding_status === "failed" && options.retryFailed === true) ||
    (note.embedding_status === "processing" &&
      options.retryStaleProcessing === true &&
      isStaleProcessing(note.embedding_started_at, now)) ||
    (note.embedding_status === "ready" &&
      note.embedding_version !== currentVersion);
}

function percentile(sorted: number[], ratio: number): number | null {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function scoreDistribution(
  rows: RankingLike[],
): Record<string, number | null> {
  const scores = rows.map((row) => Number(row.similarity)).sort((left, right) =>
    left - right
  );
  return {
    count: scores.length,
    min: scores[0] ?? null,
    p10: percentile(scores, 0.10),
    p25: percentile(scores, 0.25),
    median: percentile(scores, 0.50),
    p75: percentile(scores, 0.75),
    p90: percentile(scores, 0.90),
    p95: percentile(scores, 0.95),
    p99: percentile(scores, 0.99),
    max: scores[scores.length - 1] ?? null,
  };
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) {
    throw new Error("Embedding dimensions do not match");
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

export function lengthBucket(characterCount: number): string {
  if (characterCount < 100) return "<100";
  if (characterCount < 300) return "100-299";
  if (characterCount < 1000) return "300-999";
  return "1000+";
}

export function contextualEmbeddingText(
  sourceText: string,
  contextParts: string[],
): string {
  const context = contextParts.map((part) => part.trim()).filter(Boolean).join(
    "\n\n---\n\n",
  );
  return context ? `${sourceText}\n\nContext:\n${context}` : sourceText;
}
