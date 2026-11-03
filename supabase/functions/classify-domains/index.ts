import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { authenticateRequest, isAuthenticationError } from '../_shared/auth.ts';
import { corsHeaders, extractJson, generateWithGemini, modelForTier, readModelTier } from '../_shared/gemini.ts';

type DomainInput = { title?: unknown; description?: unknown };
type RequestBody = { texts?: unknown; domains?: unknown; model_tier?: unknown };

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    await authenticateRequest(req);
    const body = await req.json().catch(() => ({})) as RequestBody;
    const texts = Array.isArray(body.texts)
      ? body.texts.filter((value): value is string => typeof value === 'string').slice(0, 100)
      : [];
    const domains = Array.isArray(body.domains)
      ? (body.domains as DomainInput[]).map((domain) => ({
        title: typeof domain.title === 'string' ? domain.title.trim().slice(0, 80) : '',
        description: typeof domain.description === 'string' ? domain.description.trim().slice(0, 600) : '',
      })).filter((domain) => domain.title && domain.description).slice(0, 100)
      : [];
    if (!texts.length || !domains.length) return json({ assignments: texts.map(() => null) });
    if (texts.some((text) => text.length > 200_000)) return json({ error: 'A note is too large' }, 413);

    const apiKey = Deno.env.get('OPENROUTER_API_KEY');
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not configured');
    const domainList = domains.map((domain) => `- ${domain.title}: ${domain.description}`).join('\n');
    const noteList = texts.map((text, index) => `<note index="${index}">\n${text}\n</note>`).join('\n\n');
    const raw = await generateWithGemini(
      'You organize personal notes into user-defined Domains. Return only valid JSON.',
      [{ role: 'user', content: `Assign each note to exactly one Domain only when its meaning clearly fits that Domain's stated purpose. Judge meaning and intent, not shared keywords. If no Domain is a confident fit, return null for that note. Preserve the note order and use Domain titles exactly.\n\nDOMAINS\n${domainList}\n\nNOTES\n${noteList}\n\nReturn {"assignments":[<Domain title or null for every note in order>]}.` }],
      apiKey,
      modelForTier(readModelTier(body.model_tier)),
      { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: Math.max(256, texts.length * 20) },
    );
    const parsed = JSON.parse(extractJson(raw) ?? '{}') as { assignments?: unknown };
    const allowed = new Set(domains.map((domain) => domain.title));
    const assignments = Array.isArray(parsed.assignments)
      ? parsed.assignments.slice(0, texts.length).map((value) => typeof value === 'string' && allowed.has(value) ? value : null)
      : [];
    while (assignments.length < texts.length) assignments.push(null);
    return json({ assignments });
  } catch (error) {
    if (isAuthenticationError(error)) return json({ error: 'Invalid or expired session' }, 401);
    return json({ error: error instanceof Error ? error.message : 'Classification failed' }, 500);
  }
});
