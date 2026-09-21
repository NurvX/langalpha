import type {
  FileOperationArtifactPayload,
  ThreadSharePermissions,
  ThreadShareStatus,
} from '@/types/api';

/**
 * The path a file-operation event should be classified by.
 *
 * `file_path` is workspace relative on the current wire. An older event carries
 * only the raw spelling, and one that names a machine root still classifies
 * because `classifyAgentPath` strips those roots itself; only the folder
 * qualifier is opaque to it, which is why the relative form comes first.
 */
export function fileArtifactPath(payload: Partial<FileOperationArtifactPayload> | undefined): string {
  if (!payload) return '';
  return payload.file_path || payload.sandbox_path || '';
}

/** Scope a public report token to the task folder that holds its assets. */
export function reportSharePermissions(
  filePath: string,
  existing: ThreadSharePermissions = {},
): ThreadSharePermissions {
  const lastSlash = filePath.lastIndexOf('/');
  const rootPath = lastSlash > 0 ? filePath.slice(0, lastSlash) : filePath;
  return { ...existing, allow_files: true, root_path: rootPath };
}

/** Whether an existing public file scope already contains this report. */
export function reportShareScopeIncludes(
  filePath: string,
  permissions: ThreadSharePermissions | undefined,
): boolean {
  if (!permissions?.allow_files) return false;
  const rootPath = permissions.root_path || '';
  return !rootPath || filePath === rootPath || filePath.startsWith(`${rootPath}/`);
}

/** Return the permission update needed for a report, or null to reuse the token. */
export function reportSharePermissionUpdate(
  filePath: string,
  status: ThreadShareStatus | null | undefined,
): ThreadSharePermissions | null {
  const permissions = reportSharePermissions(filePath, status?.permissions);
  const hasLiveToken = !!status?.is_shared && !!status.share_token;
  if (!hasLiveToken || !status.permissions?.allow_files) return permissions;
  if (!reportShareScopeIncludes(filePath, status.permissions)) {
    throw new Error('The existing share link is scoped to another report');
  }
  return null;
}
