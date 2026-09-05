import { cosineSimilarity } from './stage1.ts';

export interface SemanticCandidate {
  note_id: string;
  similarity: number;
  raw_rank: number;
  note_length: number;
  token_count: number;
  raw_text: string;
  embedding: number[];
}

export interface RankedSemanticCandidate extends SemanticCandidate {
  diversified_rank: number;
  mmr_score: number;
}

export function parseVector(value: unknown): number[] {
  if (Array.isArray(value)) {
    const numbers = value.map(Number);
    if (numbers.length && numbers.every(Number.isFinite)) return numbers;
  }
  if (typeof value !== 'string') throw new Error('Candidate embedding is missing');
  const clean = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!clean) throw new Error('Candidate embedding is empty');
  const numbers = clean.split(',').map((part) => Number(part.trim()));
  if (!numbers.length || numbers.some((number) => !Number.isFinite(number))) {
    throw new Error('Candidate embedding is invalid');
  }
  return numbers;
}

export function partitionNearDuplicates<T extends SemanticCandidate>(
  candidates: T[],
  threshold: number,
): { candidates: T[]; nearDuplicates: T[] } {
  const kept: T[] = [];
  const nearDuplicates: T[] = [];
  for (const candidate of candidates) {
    (candidate.similarity >= threshold ? nearDuplicates : kept).push(candidate);
  }
  return { candidates: kept, nearDuplicates };
}

export function diversifyCandidates<T extends SemanticCandidate>(
  candidates: T[],
  limit: number,
  lambda = 0.72,
): Array<T & RankedSemanticCandidate> {
  if (!candidates.length || limit <= 0) return [];
  const boundedLambda = Math.min(Math.max(lambda, 0), 1);
  const remaining = [...candidates];
  const selected: Array<T & RankedSemanticCandidate> = [];

  while (remaining.length && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const redundancy = selected.length
        ? Math.max(...selected.map((chosen) => cosineSimilarity(candidate.embedding, chosen.embedding)))
        : 0;
      const score = boundedLambda * candidate.similarity - (1 - boundedLambda) * redundancy;
      if (score > bestScore || (score === bestScore && candidate.raw_rank < remaining[bestIndex].raw_rank)) {
        bestIndex = index;
        bestScore = score;
      }
    }
    const [winner] = remaining.splice(bestIndex, 1);
    selected.push({ ...winner, diversified_rank: selected.length + 1, mmr_score: bestScore });
  }
  return selected;
}
