import { supabase } from './supabase';
import { normalizeLegacyWorkspace } from './workspace-migration';

export type Domain = {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectPage = {
  id: string;
  title: string;
  content: string;
  sourceNoteIds: string[];
  createdAt: string;
  updatedAt: string;
  legacyClientId?: string | null;
};

export type CortexProject = {
  id: string;
  title: string;
  description: string;
  content: string;
  pages: ProjectPage[];
  createdAt: string;
  updatedAt: string;
  legacyClientId?: string | null;
};

export type WorkspaceSnapshot = {
  projects: CortexProject[];
  domains: Domain[];
  noteDomainNames: Record<string, string>;
};

const BROWSER_MIGRATION_KEY = 'projects-pages-domains-v1';

async function ownerId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error('Your session has expired. Sign in again to continue.');
  return data.user.id;
}

export async function getWorkspace(): Promise<WorkspaceSnapshot> {
  const userId = await ownerId();
  const [projectResult, pageResult, domainResult, assignmentResult] = await Promise.all([
    supabase.from('projects').select('id,title,description,legacy_client_id,created_at,updated_at').eq('user_id', userId).order('created_at'),
    supabase.from('project_pages').select('id,project_id,title,content,legacy_client_id,created_at,updated_at').eq('user_id', userId).order('created_at'),
    supabase.from('domains').select('id,name,description,created_at,updated_at').eq('user_id', userId).order('created_at'),
    supabase.from('note_domains').select('note_id,domain_id,created_at'),
  ]);
  const firstError = projectResult.error ?? pageResult.error ?? domainResult.error ?? assignmentResult.error;
  if (firstError) throw firstError;

  const pagesByProject = new Map<string, ProjectPage[]>();
  for (const row of pageResult.data ?? []) {
    const page: ProjectPage = {
      id: row.id, title: row.title, content: row.content, sourceNoteIds: [],
      createdAt: row.created_at, updatedAt: row.updated_at, legacyClientId: row.legacy_client_id,
    };
    pagesByProject.set(row.project_id, [...(pagesByProject.get(row.project_id) ?? []), page]);
  }
  const projects: CortexProject[] = (projectResult.data ?? []).map((row) => ({
    id: row.id, title: row.title, description: row.description, content: '',
    pages: pagesByProject.get(row.id) ?? [], createdAt: row.created_at, updatedAt: row.updated_at,
    legacyClientId: row.legacy_client_id,
  }));
  const domains: Domain[] = (domainResult.data ?? []).map((row) => ({
    id: row.id, title: row.name, description: row.description, createdAt: row.created_at, updatedAt: row.updated_at,
  }));
  const domainNames = new Map(domains.map((domain) => [domain.id, domain.title]));
  const noteDomainNames: Record<string, string> = {};
  for (const row of assignmentResult.data ?? []) {
    const name = domainNames.get(row.domain_id);
    if (name && !noteDomainNames[row.note_id]) noteDomainNames[row.note_id] = name;
  }
  return { projects, domains, noteDomainNames };
}

export async function migrateBrowserWorkspace(userId: string): Promise<WorkspaceSnapshot> {
  const authenticatedId = await ownerId();
  if (authenticatedId !== userId) throw new Error('The signed-in user changed during browser migration.');
  const { data: marker, error: markerError } = await supabase.from('browser_storage_migrations')
    .select('completed_at').eq('user_id', authenticatedId).eq('migration_key', BROWSER_MIGRATION_KEY).maybeSingle();
  if (markerError) throw markerError;
  if (marker) return getWorkspace();

  const payload = normalizeLegacyWorkspace(userId, (key) => localStorage.getItem(key));
  const { data: importCounts, error: importError } = await supabase.rpc('import_legacy_workspace', { payload });
  if (importError) throw importError;
  const snapshot = await getWorkspace();

  const serverProjectKeys = new Set(snapshot.projects.map((project) => project.legacyClientId).filter(Boolean));
  const serverPageKeys = new Set(snapshot.projects.flatMap((project) => project.pages.map((page) => page.legacyClientId)).filter(Boolean));
  const serverDomainNames = new Set(snapshot.domains.map((domain) => domain.title.toLowerCase()));
  const projectsVerified = payload.projects.every((project) => serverProjectKeys.has(String(project.legacy_id)));
  const pagesVerified = payload.projects.every((project) => (project.pages as Array<Record<string, unknown>>).every((page) => serverPageKeys.has(String(page.legacy_id))));
  const domainsVerified = payload.domains.every((domain) => serverDomainNames.has(String(domain.name).toLowerCase()));
  const importedAssignmentCount = Number((importCounts as Record<string, unknown> | null)?.note_domains ?? 0);
  const verifiedAssignmentCount = payload.note_domains.filter((assignment) =>
    snapshot.noteDomainNames[assignment.note_id]?.toLowerCase() === assignment.domain_name.toLowerCase()
  ).length;
  const assignmentsVerified = verifiedAssignmentCount === importedAssignmentCount;
  if (!projectsVerified || !pagesVerified || !domainsVerified || !assignmentsVerified) {
    throw new Error('Browser data was copied but could not be fully verified. The local recovery copy was preserved.');
  }

  const { error: completeError } = await supabase.from('browser_storage_migrations').upsert({
    user_id: authenticatedId,
    migration_key: BROWSER_MIGRATION_KEY,
    details: { source: 'localStorage', imported: importCounts, recovery_copy_retained: true },
    completed_at: new Date().toISOString(),
  }, { onConflict: 'user_id,migration_key' });
  if (completeError) throw completeError;
  return snapshot;
}

export async function createDomain(title: string, description = ''): Promise<Domain> {
  const userId = await ownerId();
  const { data, error } = await supabase.from('domains').insert({ user_id: userId, name: title.trim(), description: description.trim() })
    .select('id,name,description,created_at,updated_at').single();
  if (error) throw error;
  return { id: data.id, title: data.name, description: data.description, createdAt: data.created_at, updatedAt: data.updated_at };
}

export async function updateDomain(id: string, title: string, description: string): Promise<Domain> {
  const userId = await ownerId();
  const { data, error } = await supabase.from('domains').update({ name: title.trim(), description: description.trim() })
    .eq('id', id).eq('user_id', userId).select('id,name,description,created_at,updated_at').single();
  if (error) throw error;
  return { id: data.id, title: data.name, description: data.description, createdAt: data.created_at, updatedAt: data.updated_at };
}

export async function deleteDomain(id: string): Promise<void> {
  const { error } = await supabase.from('domains').delete().eq('id', id);
  if (error) throw error;
}

export async function setNotesDomain(noteIds: string[], domainId: string | null): Promise<void> {
  if (!noteIds.length) return;
  const { error } = await supabase.rpc('set_note_domain', { note_ids: noteIds, selected_domain_id: domainId });
  if (error) throw error;
}

export async function createProject(title: string, description = ''): Promise<CortexProject> {
  const userId = await ownerId();
  const { data, error } = await supabase.from('projects').insert({ user_id: userId, title: title.trim(), description: description.trim() })
    .select('id,title,description,created_at,updated_at').single();
  if (error) throw error;
  return { id: data.id, title: data.title, description: data.description, content: '', pages: [], createdAt: data.created_at, updatedAt: data.updated_at };
}

export async function updateProject(id: string, title: string, description: string): Promise<CortexProject> {
  const userId = await ownerId();
  const { data, error } = await supabase.from('projects').update({ title: title.trim(), description: description.trim() })
    .eq('id', id).eq('user_id', userId).select('id,title,description,created_at,updated_at').single();
  if (error) throw error;
  return { id: data.id, title: data.title, description: data.description, content: '', pages: [], createdAt: data.created_at, updatedAt: data.updated_at };
}

export async function deleteProject(id: string): Promise<void> {
  const { error } = await supabase.from('projects').delete().eq('id', id);
  if (error) throw error;
}

export async function createProjectPage(projectId: string, title = 'Untitled page', content = ''): Promise<ProjectPage> {
  const userId = await ownerId();
  const { data, error } = await supabase.from('project_pages').insert({ project_id: projectId, user_id: userId, title, content })
    .select('id,title,content,created_at,updated_at').single();
  if (error) throw error;
  return { id: data.id, title: data.title, content: data.content, sourceNoteIds: [], createdAt: data.created_at, updatedAt: data.updated_at };
}

export async function updateProjectPage(projectId: string, page: ProjectPage): Promise<ProjectPage> {
  const userId = await ownerId();
  const { data, error } = await supabase.from('project_pages').update({ title: page.title.trim() || 'Untitled page', content: page.content })
    .eq('id', page.id).eq('project_id', projectId).eq('user_id', userId)
    .select('id,title,content,created_at,updated_at').single();
  if (error) throw error;
  return { ...page, id: data.id, title: data.title, content: data.content, createdAt: data.created_at, updatedAt: data.updated_at };
}

export async function deleteProjectPage(id: string): Promise<void> {
  const { error } = await supabase.from('project_pages').delete().eq('id', id);
  if (error) throw error;
}
