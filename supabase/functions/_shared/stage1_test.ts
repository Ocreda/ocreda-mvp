import {
  contextualEmbeddingText,
  cosineSimilarity,
  deterministicSubset,
  isEmbeddingEligible,
  lengthBucket,
  scoreDistribution,
} from "./stage1.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

Deno.test("Q1 creates a deterministic 50-note subset containing every target", () => {
  const notes = Array.from({ length: 75 }, (_, index) => ({
    id: uuid(index + 1),
    raw_text: `Complete source note ${index + 1}\nSecond line stays unchanged.`,
  }));
  notes[60].raw_text =
    "Alaska taught me that isolation can sharpen a community's interdependence.\nComplete Alaska source note.";
  notes[68].raw_text =
    "Aprender en español cambia la forma en que conecto recuerdos e ideas.\nNota completa en español A.";
  notes[69].raw_text =
    "Las palabras de otro idioma pueden revelar asociaciones que antes no veía.\nNota completa en español B.";
  notes[73].raw_text =
    "Moving quickly is always the best way to learn from customers.\nContradiction source A.";
  notes[74].raw_text =
    "Slowing down is sometimes necessary to understand the real customer problem.\nContradiction source B.";
  const targets = [
    notes[60].id,
    notes[68].id,
    notes[69].id,
    notes[73].id,
    notes[74].id,
  ];
  const first = deterministicSubset(notes, targets, 50, "validated-entry-1");
  const second = deterministicSubset(notes, targets, 50, "validated-entry-1");

  assertEquals(
    first,
    second,
    "The same seed must reproduce the same Q1 packet",
  );
  assert(first.length === 50, "Q1 packet must contain exactly 50 notes");
  for (const target of targets) {
    assert(
      first.some((note) => note.id === target),
      `Missing target ${target}`,
    );
  }
  assert(
    first.find((note) => note.id === notes[60].id)?.raw_text ===
        notes[60].raw_text &&
      first.find((note) => note.id === notes[68].id)?.raw_text ===
        notes[68].raw_text &&
      first.find((note) => note.id === notes[74].id)?.raw_text ===
        notes[74].raw_text,
    "Q1 must return complete, unmodified Alaska, Spanish, and contradiction text",
  );
});

Deno.test("embedding lifecycle is idempotent and retries only explicit states", () => {
  const version = "google:gemini-embedding-2:768:v1";
  const now = Date.parse("2026-08-31T12:00:00Z");
  const recent = "2026-08-31T11:55:00Z";
  const stale = "2026-08-31T11:30:00Z";

  assert(
    isEmbeddingEligible({
      embedding_status: "pending",
      embedding_version: null,
      embedding_started_at: null,
    }, version),
    "Pending notes must be embedded",
  );
  assert(
    !isEmbeddingEligible({
      embedding_status: "ready",
      embedding_version: version,
      embedding_started_at: null,
    }, version),
    "Current ready notes must not be embedded twice",
  );
  assert(
    isEmbeddingEligible({
      embedding_status: "ready",
      embedding_version: "old-version",
      embedding_started_at: null,
    }, version),
    "Old embedding versions must be refreshed",
  );
  assert(
    !isEmbeddingEligible({
      embedding_status: "failed",
      embedding_version: version,
      embedding_started_at: null,
    }, version),
    "Failed notes must not retry implicitly",
  );
  assert(
    isEmbeddingEligible(
      {
        embedding_status: "failed",
        embedding_version: version,
        embedding_started_at: null,
      },
      version,
      { retryFailed: true },
    ),
    "Failed notes must support explicit retry",
  );
  assert(
    !isEmbeddingEligible(
      {
        embedding_status: "processing",
        embedding_version: null,
        embedding_started_at: recent,
      },
      version,
      { retryStaleProcessing: true },
      now,
    ),
    "Recent claims must remain owned",
  );
  assert(
    isEmbeddingEligible(
      {
        embedding_status: "processing",
        embedding_version: null,
        embedding_started_at: stale,
      },
      version,
      { retryStaleProcessing: true },
      now,
    ),
    "Stale claims must be recoverable",
  );
});

Deno.test("Q2 score helpers preserve semantic ordering and distributions", () => {
  const exact = cosineSimilarity([1, 0, 0], [1, 0, 0]);
  const related = cosineSimilarity([1, 0, 0], [0.8, 0.2, 0]);
  const unrelated = cosineSimilarity([1, 0, 0], [0, 1, 0]);
  assert(
    exact > related && related > unrelated,
    "Cosine ordering is incorrect",
  );

  const distribution = scoreDistribution([
    { similarity: 0.1 },
    { similarity: 0.3 },
    { similarity: 0.5 },
    { similarity: 0.7 },
    { similarity: 0.9 },
  ]);
  assert(
    distribution.count === 5,
    "Distribution must include every ranked note",
  );
  assert(distribution.min === 0.1, "Distribution minimum is incorrect");
  assert(distribution.median === 0.5, "Distribution median is incorrect");
  assert(distribution.max === 0.9, "Distribution maximum is incorrect");
});

Deno.test("Q5 buckets boundaries and contextual variants without mutating source", () => {
  assertEquals(
    [99, 100, 299, 300, 999, 1000].map(lengthBucket),
    ["<100", "100-299", "100-299", "300-999", "300-999", "1000+"],
    "Q5 length bucket boundaries are incorrect",
  );
  const source = "Sort tasks by priority.";
  const contextual = contextualEmbeddingText(source, [
    "Explicitly linked task-planning note",
    "Parent page: PawPal project",
  ]);
  assert(contextual.startsWith(source), "Context must not replace source text");
  assert(contextual.includes("Explicitly linked"), "Linked context is missing");
  assert(contextual.includes("Parent page"), "Parent/page context is missing");
  assert(source === "Sort tasks by priority.", "Source text was mutated");
});

Deno.test("Stage 0 and Stage 1 database contracts remain locked", async () => {
  const migration = await Deno.readTextFile(
    new URL(
      "../../migrations/20260830193000_add_stage1_semantic_retrieval.sql",
      import.meta.url,
    ),
  );
  assert(
    /semantic_embedding extensions\.vector\(768\)/.test(migration),
    "Semantic vector column is missing",
  );
  assert(
    !/add column[^;]*structural_embedding/i.test(migration),
    "Structural embedding must remain gated",
  );
  assert(
    migration.includes("where n.user_id = auth.uid()"),
    "Exact ranking must derive ownership from auth.uid()",
  );
  assert(
    migration.includes("result_offset integer default 0") &&
      migration.includes("result_limit integer default 500"),
    "Full-corpus ranking must be safely paginated",
  );
  assert(
    migration.includes("set weight = 1, feedback = p_feedback"),
    "Legacy multipliers must remain disabled",
  );
  assert(
    migration.includes("semantic_reasoning_benchmark_results"),
    "Q1 reasoning results must be persistable without choosing a model",
  );
});

Deno.test("backend endpoints use JWT ownership and source-only retrieval context", async () => {
  const paths = [
    "../embed-notes/index.ts",
    "../semantic-retrieval-experiment/index.ts",
    "../process-note/index.ts",
    "../handle-message/index.ts",
    "../chat-message/index.ts",
  ];
  for (const path of paths) {
    const source = await Deno.readTextFile(new URL(path, import.meta.url));
    assert(
      source.includes("authenticateRequest(req)"),
      `${path} does not verify the JWT`,
    );
    const requestInterfaces =
      source.match(/interface\s+\w+Request[^\{]*\{[\s\S]*?\n\}/g) ?? [];
    assert(
      requestInterfaces.every((block) => !/\buser_id\s*:/.test(block)),
      `${path} accepts a browser-supplied user_id`,
    );
  }

  const processNote = await Deno.readTextFile(
    new URL("../process-note/index.ts", import.meta.url),
  );
  const handleMessage = await Deno.readTextFile(
    new URL("../handle-message/index.ts", import.meta.url),
  );
  const chatMessage = await Deno.readTextFile(
    new URL("../chat-message/index.ts", import.meta.url),
  );
  assert(
    !processNote.includes("newNote.summary || newNote.raw_text") &&
      !processNote.includes("n.summary || n.raw_text"),
    "Connection reasoning must use raw source notes",
  );
  assert(
    handleMessage.includes("ID:${n.id}${dateInfo}\\n${n.raw_text}"),
    "Question retrieval must use raw source notes",
  );
  assert(
    !chatMessage.includes("question.answer") &&
      !chatMessage.includes('msg.role === "assistant"'),
    "Generated assistant output must not become later retrieval context",
  );
});
