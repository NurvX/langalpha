/**
 * A file-operation event is classified by its workspace-relative path.
 *
 * On a shared machine the absolute spelling of a memory write is
 * `/home/workspace/<dir>/.agents/memory/x.md`. The classifier strips the
 * machine roots and nothing else, so that spelling is a plain file to it; the
 * wire therefore carries the relative form as `file_path` and the raw one
 * beside it.
 */
import { describe, expect, it } from 'vitest';

import { classifyAgentPath } from '../agentPaths';
import {
  fileArtifactPath,
  reportSharePermissionUpdate,
  reportSharePermissions,
  reportShareScopeIncludes,
} from '../fileArtifact';

describe('fileArtifactPath', () => {
  it('prefers the relative spelling, which the classifier reads as memory', () => {
    const payload = {
      operation: 'Write',
      file_path: '.agents/memory/notes.md',
      sandbox_path: '/home/workspace/acme-ab12/.agents/memory/notes.md',
    };
    const path = fileArtifactPath(payload);
    expect(path).toBe('.agents/memory/notes.md');
    expect(classifyAgentPath(path)).toMatchObject({ kind: 'memory', tier: 'workspace' });
    // The raw spelling alone is why the relative one has to travel.
    expect(classifyAgentPath(payload.sandbox_path).kind).toBe('file');
  });

  it('falls back to the raw spelling on an event that carries only that', () => {
    expect(fileArtifactPath({ sandbox_path: '/home/workspace/report.md' })).toBe('/home/workspace/report.md');
    expect(fileArtifactPath(undefined)).toBe('');
  });
});

describe('reportSharePermissions', () => {
  it('opens only the report task directory so relative assets remain reachable', () => {
    expect(reportSharePermissions('amd-analysis/report.html')).toEqual({
      allow_files: true,
      root_path: 'amd-analysis',
    });
  });

  it('scopes a root-level self-contained report to that file', () => {
    expect(reportSharePermissions('report.html')).toEqual({
      allow_files: true,
      root_path: 'report.html',
    });
  });

  it('preserves explicit download permission while narrowing the token', () => {
    expect(
      reportSharePermissions('task/report.html', {
        allow_files: false,
        allow_download: true,
        root_path: 'old-task',
      }),
    ).toEqual({
      allow_files: true,
      allow_download: true,
      root_path: 'task',
    });
  });
});

describe('reportShareScopeIncludes', () => {
  it('reuses whole-workspace and containing-directory scopes', () => {
    expect(reportShareScopeIncludes('task/report.html', {
      allow_files: true,
      root_path: '',
    })).toBe(true);
    expect(reportShareScopeIncludes('task/report.html', {
      allow_files: true,
      root_path: 'task',
    })).toBe(true);
  });

  it('rejects retargeting a token issued for another report', () => {
    expect(reportShareScopeIncludes('second/report.html', {
      allow_files: true,
      root_path: 'first',
    })).toBe(false);
    expect(reportShareScopeIncludes('second.html', {
      allow_files: false,
      root_path: '',
    })).toBe(false);
  });
});

describe('reportSharePermissionUpdate', () => {
  const status = (permissions: { allow_files?: boolean; root_path?: string }) => ({
    is_shared: true,
    share_token: 'token',
    share_url: '/s/token',
    permissions,
  });

  it('enables files on an existing thread token without replacing it', () => {
    expect(reportSharePermissionUpdate('task/report.html', status({
      allow_files: false,
    }))).toEqual({
      allow_files: true,
      root_path: 'task',
    });
  });

  it('reuses a compatible token and refuses an incompatible retarget', () => {
    expect(reportSharePermissionUpdate(
      'task/report.html',
      status({ allow_files: true, root_path: 'task' }),
    )).toBeNull();
    expect(() => reportSharePermissionUpdate(
      'second/report.html',
      status({ allow_files: true, root_path: 'first' }),
    )).toThrow('scoped to another report');
  });
});
