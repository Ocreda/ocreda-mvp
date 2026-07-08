import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface NoteRow {
  id: string;
  title: string | null;
  content: string;
  updated_at: string;
  category: string | null;
}

interface CategoryGroup {
  name: string;
  noteIds: string[];
}

const MAX_CATEGORIES = 8;
const BATCH_SIZE = 40;
const PARALLEL = 3;

const FORBIDDEN = /^(other|miscellaneous|uncategorized|general|various|misc|mixed|rest|leftovers?|additional|extra|assorted|random|unrelated|unsorted|remaining|catch.all|default|unknown)$/i;

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 HELPER: Fetch every note for a user via paginated range() calls
// ─────────────────────────────────────────────────────────────────────────────
async function fetchAllNotes(supabase: ReturnType<typeof createClient>, userId: string): Promise<NoteRow[]> {
  const PAGE = 1000;
  const all: NoteRow[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("notes")
      .select("id, title, content, updated_at, category")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);

    if (error) throw new Error(`DB fetch failed at range ${from}: ${error.message}`);
    if (!data || data.length === 0) break;

    all.push(...(data as NoteRow[]));
    console.log(`[fetch] range ${from}–${from + data.length - 1}: ${data.length} rows  |  running total: ${all.length}`);

    if (data.length < PAGE) break;
    from += PAGE;
  }

  console.log(`[fetch] COMPLETE — total rows fetched: ${all.length}`);
  return all;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 HELPER: Ask Claude to categorize a batch of notes
// Returns null on failure so caller can retry
// ─────────────────────────────────────────────────────────────────────────────
async function callClaude(
  notes: NoteRow[],
  existingCategories: string[],
  apiKey: string,
  totalCount: number
): Promise<CategoryGroup[] | null> {
  const notesText = notes
    .map((n) => `ID:${n.id}\nTitle: ${n.title || "(no title)"}\nContent: ${n.content.slice(0, 400)}`)
    .join("\n\n---\n\n");

  const categoryConstraint = existingCategories.length > 0
    ? `Assign every note to one of these EXACT existing categories (copy character-for-character): ${existingCategories.map((c) => `"${c}"`).join(", ")}. Create a new category ONLY if a note has zero thematic overlap with any listed category.`
    : `Create ${Math.min(MAX_CATEGORIES, totalCount)} meaningful, specific category names that cover all notes below. Avoid generic names.`;

  const prompt = `You are a strict categorization engine. Rules are absolute:
1. Every note ID below MUST appear in exactly one category. Omitting any ID is a fatal error.
2. ${categoryConstraint}
3. FORBIDDEN category names (any variant): Other, Miscellaneous, Uncategorized, General, Various, Misc, Catch-all, Assorted, Random, Unsorted, Remaining. Assign the closest thematic fit instead.
4. Max ${MAX_CATEGORIES} categories total.
5. Output ONLY a JSON array — no prose, no markdown fences.

FORMAT: [{"name":"Category Name","noteIds":["id1","id2"]}]

NOTES:
${notesText}

Return ONLY the JSON array.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      console.error(`[claude] HTTP ${res.status}: ${await res.text()}`);
      return null;
    }

    const body = await res.json();
    const text = (body.content?.[0]?.text ?? "").trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) { console.error("[claude] no JSON array in response"); return null; }

    const groups: CategoryGroup[] = JSON.parse(match[0]);
    if (!Array.isArray(groups)) return null;

    return groups.filter((g) => !FORBIDDEN.test(g.name.trim()));
  } catch (e) {
    console.error("[claude] exception:", e);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Force-assign leftover notes to the closest existing category (batched)
// ─────────────────────────────────────────────────────────────────────────────
async function forceAssign(
  notes: NoteRow[],
  categories: string[],
  apiKey: string
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const SUB = 20;

  for (let i = 0; i < notes.length; i += SUB) {
    const batch = notes.slice(i, i + SUB);
    const text = batch.map((n) => `ID:${n.id} | ${n.title || "(no title)"} | ${n.content.slice(0, 200)}`).join("\n");

    const prompt = `Pick the BEST category from [${categories.map((c) => `"${c}"`).join(", ")}] for each note.
Every note must be assigned. No new categories. No "Other".
Return ONLY: {"noteId":"Category Name", ...}

${text}`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 2048, messages: [{ role: "user", content: prompt }] }),
      });

      if (res.ok) {
        const body = await res.json();
        const raw = (body.content?.[0]?.text ?? "").trim();
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) {
          const obj: Record<string, string> = JSON.parse(m[0]);
          for (const n of batch) {
            const cat = obj[n.id];
            result.set(n.id, (cat && categories.includes(cat)) ? cat : categories[0]);
          }
          continue;
        }
      }
    } catch { /* fall through to fallback */ }

    for (const n of batch) result.set(n.id, categories[0]);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge a set of CategoryGroups into the shared mergedGroups map
// ─────────────────────────────────────────────────────────────────────────────
function mergeGroups(
  into: Map<string, { displayName: string; noteIds: string[] }>,
  groups: CategoryGroup[]
) {
  for (const g of groups) {
    const key = g.name.toLowerCase().trim();
    const existing = into.get(key);
    if (existing) {
      existing.noteIds.push(...g.noteIds);
    } else {
      into.set(key, { displayName: g.name, noteIds: [...g.noteIds] });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const apiKey = Deno.env.get("Claudebrain")!;

    const { user_id, last_categorized_at } = await req.json();
    if (!user_id) {
      return new Response(JSON.stringify({ error: "user_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── STEP 1: Fetch ALL notes ───────────────────────────────────────────────
    const allNotes = await fetchAllNotes(supabase, user_id);
    const dbTotal = allNotes.length;

    if (dbTotal === 0) {
      return new Response(JSON.stringify({ groups: [], db_total: 0, changed_count: 0, categorized_count: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[step1] DB total confirmed: ${dbTotal} notes`);

    // ── Split changed vs unchanged ────────────────────────────────────────────
    const lastTs = last_categorized_at ? new Date(last_categorized_at).getTime() : 0;

    const changedNotes = allNotes.filter((n) => {
      if (!lastTs) return true;
      if (!n.category || FORBIDDEN.test(n.category.trim())) return true;
      return new Date(n.updated_at).getTime() > lastTs;
    });

    const unchangedNotes = allNotes.filter((n) => {
      if (!lastTs || !n.category || FORBIDDEN.test(n.category.trim())) return false;
      return new Date(n.updated_at).getTime() <= lastTs;
    });

    console.log(`[split] changed: ${changedNotes.length} | unchanged: ${unchangedNotes.length} | sum: ${changedNotes.length + unchangedNotes.length}`);

    // ── Seed mergedGroups from unchanged notes ─────────────────────────────────
    const mergedGroups = new Map<string, { displayName: string; noteIds: string[] }>();
    for (const n of unchangedNotes) {
      if (!n.category) continue;
      const key = n.category.toLowerCase().trim();
      const g = mergedGroups.get(key);
      if (g) g.noteIds.push(n.id);
      else mergedGroups.set(key, { displayName: n.category, noteIds: [n.id] });
    }

    // ── STEP 2: Categorize changed notes in parallel windows of PARALLEL ───────
    if (changedNotes.length > 0) {
      const batches: NoteRow[][] = [];
      for (let i = 0; i < changedNotes.length; i += BATCH_SIZE) {
        batches.push(changedNotes.slice(i, i + BATCH_SIZE));
      }
      console.log(`[step2] ${batches.length} batches × up to ${BATCH_SIZE} notes, ${PARALLEL} parallel`);

      for (let w = 0; w < batches.length; w += PARALLEL) {
        const window = batches.slice(w, w + PARALLEL);
        // Snapshot current categories before this parallel window
        const existingNames = Array.from(mergedGroups.values()).map((g) => g.displayName);

        const windowResults = await Promise.all(
          window.map(async (batch, wi) => {
            // Attempt + one retry
            let result = await callClaude(batch, existingNames, apiKey, dbTotal);
            if (result === null) {
              console.warn(`[batch ${w + wi + 1}] failed — retrying`);
              result = await callClaude(batch, existingNames, apiKey, dbTotal);
            }
            if (result === null) {
              console.error(`[batch ${w + wi + 1}] BOTH ATTEMPTS FAILED — ${batch.length} notes go to verification pass`);
            }
            return result;
          })
        );

        for (const groups of windowResults) {
          if (groups) mergeGroups(mergedGroups, groups);
        }

        console.log(`[window ${Math.floor(w / PARALLEL) + 1}] mergedGroups size: ${mergedGroups.size}`);
      }

      // ── Verification pass: ensure every changed note is assigned ─────────────
      const assignedIds = new Set<string>();
      for (const g of mergedGroups.values()) g.noteIds.forEach((id) => assignedIds.add(id));
      const unassigned = changedNotes.filter((n) => !assignedIds.has(n.id));
      console.log(`[verify] unassigned: ${unassigned.length}`);

      if (unassigned.length > 0) {
        const catNames = Array.from(mergedGroups.values()).map((g) => g.displayName);
        if (catNames.length === 0) {
          mergedGroups.set("notes", { displayName: "Notes", noteIds: unassigned.map((n) => n.id) });
        } else {
          const assignments = await forceAssign(unassigned, catNames, apiKey);
          for (const [noteId, catName] of assignments) {
            const key = catName.toLowerCase().trim();
            const existing = mergedGroups.get(key) ?? Array.from(mergedGroups.values()).find((g) => g.displayName.toLowerCase() === catName.toLowerCase());
            if (existing) {
              existing.noteIds.push(noteId);
            } else {
              // ultimate fallback: largest group
              let largest = Array.from(mergedGroups.values()).sort((a, b) => b.noteIds.length - a.noteIds.length)[0];
              if (largest) largest.noteIds.push(noteId);
            }
          }
        }
      }

      // ── Enforce MAX_CATEGORIES limit ──────────────────────────────────────────
      if (mergedGroups.size > MAX_CATEGORIES) {
        const sorted = Array.from(mergedGroups.entries()).sort((a, b) => b[1].noteIds.length - a[1].noteIds.length);
        const keep = sorted.slice(0, MAX_CATEGORIES);
        const overflow = sorted.slice(MAX_CATEGORIES);

        mergedGroups.clear();
        for (const [k, v] of keep) mergedGroups.set(k, v);

        // Distribute overflow notes to the smallest kept category
        const keepArr = Array.from(mergedGroups.values());
        for (const [, v] of overflow) {
          for (const noteId of v.noteIds) {
            keepArr.sort((a, b) => a.noteIds.length - b.noteIds.length);
            keepArr[0].noteIds.push(noteId);
          }
        }
        console.log(`[limit] reduced to ${MAX_CATEGORIES} categories`);
      }
    }

    // ── Build final group list ─────────────────────────────────────────────────
    const displayGroups: CategoryGroup[] = Array.from(mergedGroups.values()).map(
      ({ displayName, noteIds }) => ({ name: displayName, noteIds })
    );

    const groupTotal = displayGroups.reduce((s, g) => s + g.noteIds.length, 0);
    console.log(`[sanity] db_total=${dbTotal} | group_total=${groupTotal} | diff=${dbTotal - groupTotal}`);

    // ── Write changed notes back to DB ─────────────────────────────────────────
    const changedIdSet = new Set(changedNotes.map((n) => n.id));
    const now = new Date().toISOString();
    const writes: Array<[string, string]> = [];
    for (const g of displayGroups) {
      for (const noteId of g.noteIds) {
        if (changedIdSet.has(noteId)) writes.push([noteId, g.name]);
      }
    }

    const CHUNK = 100;
    for (let i = 0; i < writes.length; i += CHUNK) {
      await Promise.all(
        writes.slice(i, i + CHUNK).map(([noteId, category]) =>
          supabase.from("notes").update({ category, category_updated_at: now }).eq("id", noteId).eq("user_id", user_id)
        )
      );
    }

    console.log(`[done] db_total=${dbTotal} changed=${changedNotes.length} written=${writes.length} groups=${displayGroups.length} group_total=${groupTotal}`);

    return new Response(
      JSON.stringify({
        groups: displayGroups,
        db_total: dbTotal,
        changed_count: changedNotes.length,
        categorized_count: groupTotal,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[error]", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
