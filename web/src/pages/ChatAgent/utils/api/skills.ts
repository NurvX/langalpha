/**
 * Skills API — the merged platform + user tier behind /api/v1/skills.
 *
 * The default (enabled-only) list feeds the slash-command menu; the
 * management view passes `includeDisabled` to also render disabled rows.
 */
import { api } from '@/api/client';

export interface SkillInfo {
  name: string;
  description: string;
  tool_count: number;
  tools: string[];
  command: string | null;
  origin: 'platform' | 'user';
  enabled: boolean;
  editable: boolean;
  deletable: boolean;
  confirmed: boolean;
  plugin_id: string | null;
  size_bytes: number;
  updated_at: string | null;
}

export async function getSkills(opts?: {
  mode?: string | null;
  includeDisabled?: boolean;
}): Promise<SkillInfo[]> {
  const params: Record<string, string | boolean> = {};
  if (opts?.mode) params.mode = opts.mode;
  if (opts?.includeDisabled) params.include_disabled = true;
  const { data } = await api.get('/api/v1/skills', { params });
  return data.skills || [];
}

export async function uploadSkill(
  file: File,
  onProgress: ((percent: number) => void) | null = null,
): Promise<SkillInfo> {
  const formData = new FormData();
  formData.append('file', file);
  const { data } = await api.post<SkillInfo>('/api/v1/skills', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: onProgress
      ? (e) => {
          if (e.total) onProgress(Math.round((e.loaded / e.total) * 100));
        }
      : undefined,
  });
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
