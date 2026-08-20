import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys';
import {
  deleteSkill,
  getSkills,
  setSkillEnabled,
  uploadSkill,
} from '../pages/ChatAgent/utils/api';

/**
 * React Query hooks for the merged skills tier (platform + user). Lives in
 * hooks/ because chat-input's slash menu consumes the list — the reason this
 * is React Query at all: a mutation here must reach that menu without a page
 * reload.
 */

export function useSkills(mode: string | null, includeDisabled = false) {
  return useQuery({
    queryKey: queryKeys.skills.list(mode, includeDisabled),
    queryFn: () => getSkills({ mode, includeDisabled }),
    staleTime: 60_000,
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
