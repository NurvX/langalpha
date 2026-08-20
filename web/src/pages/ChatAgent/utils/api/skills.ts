/**
 * Skills API — the merged platform + user + workspace tiers.
 *
 * The default (enabled-only) list feeds the slash-command menu; the
 * management view passes `includeDisabled` to also render disabled rows.
 * A `workspaceId` selects the workspace-effective view (workspace rows
 * shadow same-named user skills there); the workspace CRUD lives under
 * /api/v1/workspaces/{id}/skills, mirroring workspace MCP servers.
 */
import { api } from '@/api/client';

export interface SkillInfo {
  name: string;
  description: string;
  tool_count: number;
  tools: string[];
  command: string | null;
  origin: 'platform' | 'user' | 'workspace';
  enabled: boolean;
  editable: boolean;
  deletable: boolean;
  confirmed: boolean;
  plugin_id: string | null;
  size_bytes: number;
  updated_at: string | null;
  disabled_scope: 'user' | 'workspace' | null;
  shadows_inherited: boolean;
}

function uploadConfig(onProgress: ((percent: number) => void) | null) {
  return {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: onProgress
      ? (e: { loaded: number; total?: number }) => {
          if (e.total) onProgress(Math.round((e.loaded / e.total) * 100));
        }
      : undefined,
  };
}

export async function getSkills(opts?: {
  mode?: string | null;
  includeDisabled?: boolean;
  workspaceId?: string | null;
}): Promise<SkillInfo[]> {
  const params: Record<string, string | boolean> = {};
  if (opts?.mode) params.mode = opts.mode;
  if (opts?.includeDisabled) params.include_disabled = true;
  if (opts?.workspaceId) params.workspace_id = opts.workspaceId;
  const { data } = await api.get('/api/v1/skills', { params });
  return data.skills || [];
}

export async function uploadSkill(
  file: File,
  onProgress: ((percent: number) => void) | null = null,
): Promise<SkillInfo> {
  const formData = new FormData();
  formData.append('file', file);
  const { data } = await api.post<SkillInfo>(
    '/api/v1/skills',
    formData,
    uploadConfig(onProgress),
  );
  return data;
}

/** Toggles either tier by name: user rows flip in place, builtin names write
 * the per-user disable. */
export async function setSkillEnabled(name: string, enabled: boolean): Promise<SkillInfo> {
  const { data } = await api.patch<SkillInfo>(
    `/api/v1/skills/${encodeURIComponent(name)}`,
    { enabled },
  );
  return data;
}

export async function deleteSkill(name: string): Promise<void> {
  await api.delete(`/api/v1/skills/${encodeURIComponent(name)}`);
}

export async function getWorkspaceSkills(
  workspaceId: string,
  opts?: { mode?: string | null; includeDisabled?: boolean },
): Promise<SkillInfo[]> {
  const params: Record<string, string | boolean> = {};
  if (opts?.mode) params.mode = opts.mode;
  if (opts?.includeDisabled) params.include_disabled = true;
  const { data } = await api.get(
    `/api/v1/workspaces/${workspaceId}/skills`,
    { params },
  );
  return data.skills || [];
}

export async function uploadWorkspaceSkill(
  workspaceId: string,
  file: File,
  onProgress: ((percent: number) => void) | null = null,
): Promise<SkillInfo> {
  const formData = new FormData();
  formData.append('file', file);
  const { data } = await api.post<SkillInfo>(
    `/api/v1/workspaces/${workspaceId}/skills`,
    formData,
    uploadConfig(onProgress),
  );
  return data;
}

/** Workspace rows flip in place; inherited names (platform or user tier)
 * write a workspace-level disable. */
export async function setWorkspaceSkillEnabled(
  workspaceId: string,
  name: string,
  enabled: boolean,
): Promise<SkillInfo> {
  const { data } = await api.patch<SkillInfo>(
    `/api/v1/workspaces/${workspaceId}/skills/${encodeURIComponent(name)}`,
    { enabled },
  );
  return data;
}

export async function deleteWorkspaceSkill(
  workspaceId: string,
  name: string,
): Promise<void> {
  await api.delete(
    `/api/v1/workspaces/${workspaceId}/skills/${encodeURIComponent(name)}`,
  );
}
