type LegacyDomain = { title?: unknown; description?: unknown; createdAt?: unknown };
type LegacyPage = { id?: unknown; title?: unknown; content?: unknown; createdAt?: unknown; updatedAt?: unknown };
type LegacyProject = {
  id?: unknown; title?: unknown; description?: unknown; content?: unknown;
  pages?: unknown; createdAt?: unknown; updatedAt?: unknown;
};

export type LegacyWorkspacePayload = {
  projects: Array<Record<string, unknown>>;
  domains: Array<Record<string, unknown>>;
  note_domains: Array<Record<string, string>>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function cleanContent(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 2_000_000) : '';
}

function cleanDate(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function parseJson(value: string | null): unknown {
  try { return JSON.parse(value ?? 'null') as unknown; }
  catch { return null; }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function legacyId(value: unknown, prefix: string, index: number): string {
  const clean = cleanText(value, 200);
  return clean || `${prefix}-${index}`;
}

export function normalizeLegacyWorkspace(
  userId: string,
  readItem: (key: string) => string | null,
  migratedAt = new Date().toISOString(),
): LegacyWorkspacePayload {
  const storedDomains = asArray(parseJson(readItem(`ocreda-muses:${userId}`))) as LegacyDomain[];
  const oldDomains = asArray(parseJson(readItem(`ocreda-cortexes:${userId}`))) as LegacyDomain[];
  const domainSource = storedDomains.length ? storedDomains : oldDomains;
  const domainCandidates = domainSource.slice(0, 500).map((domain) => ({
    name: cleanText(domain?.title, 80),
    description: cleanText(domain?.description, 600),
    created_at: cleanDate(domain?.createdAt, migratedAt),
  })).filter((domain) => domain.name);
  const domains = Array.from(new Map(domainCandidates.map((domain) => [domain.name.toLowerCase(), domain])).values());

  let projectSource = asArray(parseJson(readItem(`ocreda-projects:${userId}`))) as LegacyProject[];
  if (!projectSource.length && oldDomains.length) {
    projectSource = oldDomains.map((domain, index) => ({
      id: `legacy-domain-project-${index}`, title: domain.title, description: domain.description,
      content: '', pages: [], createdAt: domain.createdAt, updatedAt: domain.createdAt,
    }));
  }
  const projects = projectSource.slice(0, 500).map((project, projectIndex) => {
    const projectLegacyId = legacyId(project?.id, 'legacy-project', projectIndex);
    const createdAt = cleanDate(project?.createdAt, migratedAt);
    const pages = (asArray(project?.pages) as LegacyPage[]).slice(0, 2_000).map((page, pageIndex) => ({
      legacy_id: legacyId(page?.id, `${projectLegacyId}-page`, pageIndex),
      title: cleanText(page?.title, 100) || 'Untitled page', content: cleanContent(page?.content),
      created_at: cleanDate(page?.createdAt, createdAt),
      updated_at: cleanDate(page?.updatedAt ?? project?.updatedAt, createdAt),
    }));
    const legacyContent = cleanContent(project?.content);
    if (!pages.length && legacyContent) {
      pages.push({
        legacy_id: `${projectLegacyId}-legacy-page`, title: cleanText(project?.title, 100) || 'Untitled page',
        content: legacyContent, created_at: createdAt, updated_at: cleanDate(project?.updatedAt, createdAt),
      });
    }
    return {
      legacy_id: projectLegacyId, title: cleanText(project?.title, 80),
      description: cleanText(project?.description, 500), created_at: createdAt,
      updated_at: cleanDate(project?.updatedAt, createdAt), pages,
    };
  }).filter((project) => project.title);

  const rawAssignments = parseJson(readItem(`ocreda-note-muses:${userId}`));
  const noteDomainCandidates = rawAssignments && typeof rawAssignments === 'object' && !Array.isArray(rawAssignments)
    ? Object.entries(rawAssignments as Record<string, unknown>)
      .filter((entry): entry is [string, string] => UUID_PATTERN.test(entry[0]) && typeof entry[1] === 'string' && !!cleanText(entry[1], 80))
      .slice(0, 10_000)
      .map(([noteId, domainName]) => ({ note_id: noteId, domain_name: cleanText(domainName, 80) }))
    : [];
  const noteDomains = Array.from(new Map(noteDomainCandidates.map((assignment) => [assignment.note_id, assignment])).values());
  return { projects, domains, note_domains: noteDomains };
}
