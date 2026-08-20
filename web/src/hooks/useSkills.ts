import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys';
import {
  deleteSkill,
  deleteWorkspaceSkill,
  getSkills,
  getWorkspaceSkills,
  moveSkill,
  setSkillEnabled,
  setWorkspaceSkillEnabled,
  uploadSkill,
  uploadWorkspaceSkill,
} from '../pages/ChatAgent/utils/api';

/**
 * React Query hooks for the merged skills tiers (platform + user +
 * workspace). Lives in hooks/ because chat-input's slash menu consumes the
 * list — the reason this is React Query at all: a mutation here must reach
 * that menu without a page reload. Every mutation invalidates the whole
 * `skills` prefix: a workspace change can alter the user view's shadowing
 * and vice versa, so per-scope invalidation would leave stale menus.
 */

export function useSkills(
  mode: string | null,
  opts: {
    includeDisabled?: boolean;
    workspaceId?: string | null;
    allScopes?: boolean;
  } = {},
) {
  const { includeDisabled = false, workspaceId = null, allScopes = false } = opts;
  return useQuery({
    queryKey: queryKeys.skills.list(mode, includeDisabled, workspaceId, allScopes),
    queryFn: () => getSkills({ mode, includeDisabled, workspaceId, allScopes }),
    staleTime: 60_000,
  });
}

/** Re-scope a skill (user tier ↔ one workspace). Whole-prefix invalidation:
 * a move changes the slash menu, the workspace views, and shadowing at once. */
export function useMoveSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      name,
      fromWorkspaceId,
      toWorkspaceId,
    }: {
      name: string;
      fromWorkspaceId: string | null;
      toWorkspaceId: string | null;
    }) => moveSkill(name, fromWorkspaceId, toWorkspaceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.skills.all });
    },
  });
}

/** Workspace-scoped toggle with the workspace id in the vars — for the
 * all-scopes Plugins view, where one list mixes rows from many workspaces
 * (the fixed-workspace variants below serve the single-workspace pages). */
export function useSetSkillEnabledInWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      workspaceId,
      name,
      enabled,
    }: {
      workspaceId: string;
      name: string;
      enabled: boolean;
    }) => setWorkspaceSkillEnabled(workspaceId, name, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.skills.all });
    },
  });
}

export function useDeleteSkillInWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, name }: { workspaceId: string; name: string }) =>
      deleteWorkspaceSkill(workspaceId, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.skills.all });
    },
  });
}

export function useUploadSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      file,
      onProgress,
    }: {
      file: File;
      onProgress?: (percent: number) => void;
    }) => uploadSkill(file, onProgress ?? null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.skills.all });
    },
  });
}

export function useToggleSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      setSkillEnabled(name, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.skills.all });
    },
  });
}

export function useDeleteSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteSkill(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.skills.all });
    },
  });
}

export function useWorkspaceSkills(workspaceId: string, includeDisabled = true) {
  return useQuery({
    queryKey: queryKeys.skills.list(null, includeDisabled, workspaceId),
    queryFn: () => getWorkspaceSkills(workspaceId, { includeDisabled }),
    staleTime: 60_000,
    enabled: !!workspaceId,
  });
}

export function useUploadWorkspaceSkill(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      file,
      onProgress,
    }: {
      file: File;
      onProgress?: (percent: number) => void;
    }) => uploadWorkspaceSkill(workspaceId, file, onProgress ?? null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.skills.all });
    },
  });
}

export function useToggleWorkspaceSkill(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      setWorkspaceSkillEnabled(workspaceId, name, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.skills.all });
    },
  });
}

export function useDeleteWorkspaceSkill(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteWorkspaceSkill(workspaceId, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.skills.all });
    },
  });
}
