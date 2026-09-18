import React, { useCallback, useEffect, useId, useMemo, useRef, useState, Suspense } from 'react';
import { TextSelect, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  memoMimeForName,
  useAddToMemo,
  useWorkspaceMemoIndex,
  useMemoStaleCheck,
  MemoStaleBanner,
  MemoDiffModal,
} from './FilePanelMemo';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useNarrowContainer } from '@/hooks/useNarrowContainer';
import { SandboxSettingsContent } from './SandboxSettingsPanel';
import {
  readWorkspaceFile, readWorkspaceFileFull, writeWorkspaceFile, downloadWorkspaceFileAsArrayBuffer,
  triggerFileDownload, resolveWorkspaceFile,
} from '../utils/api';
import { linkCandidates } from '../utils/fileRefResolver';
import { classifyAgentPath, parseAgentPath } from '../utils/agentPaths';
import { useStableHandler } from '@/hooks/useStableHandler';
import { parseFragment, type FileLocation, type OpenFileHandler } from '../utils/fileLocation';
import FileHeaderActions from './FileHeaderActions';
import './FilePanel.css';

const ExportPreviewModal = React.lazy(() => import('./ExportPreviewModal'));
const PreviewViewer = React.lazy(() => import('./viewers/PreviewViewer'));

import type { ApiAdapter, ContextPayload } from './filePanel/types';
import { EDITABLE_EXTENSIONS, getFileExtension, viewerFor } from './filePanel/fileMeta';
import { useFileUpload } from './filePanel/useFileUpload';
import { useFileEdit } from './filePanel/useFileEdit';
import { useSelectionContext } from './filePanel/useSelectionContext';
import { useFileSelection } from './filePanel/useFileSelection';
import { useFileBackup } from './filePanel/useFileBackup';
import { useFileFocus } from './filePanel/useFileFocus';
import { FocusChip } from './filePanel/FocusChip';
import { useFileTabs, type FileTab } from './filePanel/useFileTabs';
import { useTreeFilter } from './filePanel/useTreeFilter';
import { useTreeInteraction } from './filePanel/useTreeInteraction';
import { useFileRefOpen } from './filePanel/useFileRefOpen';
import { PanelNotices } from './filePanel/PanelNotices';
import { FileContextMenu, type FileMenuAction } from './filePanel/FileContextMenu';
import { useFileDownloads } from './filePanel/useFileDownloads';
import { useFileBodyCache, useFileBody } from './filePanel/useFileBody';
import { useChangedFiles } from './filePanel/useChangedFiles';
import { countLines } from '../utils/fileLocation';
import { TabStrip } from './filePanel/TabStrip';
import { AnimatePresence } from 'framer-motion';
import { TreeColumn } from './filePanel/TreeColumn';
import { FileCrumbs } from './filePanel/FileCrumbs';
import { FileViewer } from './filePanel/FileViewer';
import { EmptyTab } from './filePanel/EmptyTab';
import { PreviewCrumbs } from './filePanel/PreviewCrumbs';
import { usePreviews, type PreviewSpec } from './filePanel/usePreviews';

/** Below this the tree cannot be a column without starving the viewer. */
const TREE_OVERLAY_WIDTH = 720;

interface FilePanelProps {
  workspaceId: string;
  /** Scopes the tab strip; absent for a chat that has not sent its first message, or a share. */
  threadId?: string | null;
  onClose: () => void;
  targetFile?: string | null;
  /** Where in `targetFile` the reference pointed (a line, page or heading). */
  targetLocation?: FileLocation | null;
  /** Open the target in a tab of its own instead of the preview slot. */
  targetPin?: boolean;
  onTargetFileHandled?: () => void;
  targetDirectory?: string | null;
  /** Which folder request `targetDirectory` carries. It stays on screen as the
   *  tree's filter after the click that set it, so the string alone cannot say
   *  a new request arrived; the same folder asked for twice bumps this. */
  targetDirSeq?: number | null;
  onTargetDirHandled?: () => void;
  /** A running app the chat asked to show. `seq` counts the asks, so the same
   *  port opened twice re-mints its URL rather than reading as one request. */
  targetPreview?: (PreviewSpec & { seq?: number }) | null;
  onTargetPreviewHandled?: () => void;
  /** Opens a reference to another workspace (a `__wsref__` link inside a viewed file). */
  onOpenFile?: OpenFileHandler | null;
  /** This thread's Write/Edit paths, newest first, for resolving a reference by name. */
  getRecentWritePaths?: (() => string[]) | null;
  files?: string[];
  filesLoading?: boolean;
  filesError?: string | null;
  onRefreshFiles?: () => void;
  readOnly?: boolean;
  /** Whether this viewer may save a file's bytes. A copy-link share grants
   *  `allow_files` without `allow_download`, and the download endpoint refuses
   *  what `allow_files` alone opened, so an offered save fails after the click. */
  canDownload?: boolean;
  /** Lock to one file: no tree, and closing the last tab closes the panel. */
  singleFileMode?: boolean;
  apiAdapter?: ApiAdapter | null;
  onAddContext?: ((ctx: ContextPayload) => void) | null;
  showSystemFiles?: boolean;
  onToggleSystemFiles?: (() => void) | null;
  /** Hide the panel-close affordances when FilePanel is embedded inside a
   * tabbed wrapper that owns the close button. */
  hideClose?: boolean;
  onSwitchToMemoTab?: (() => void) | null;
  /** Copy a shareable link to an HTML report (authenticated app only). */
  onCopyShareLink?: ((filePath: string) => void) | null;
}

function FilePanel({
  workspaceId,
  threadId = null,
  onClose,
  targetFile,
  targetLocation = null,
  targetPin = false,
  onTargetFileHandled,
  targetDirectory,
  targetDirSeq = null,
  onTargetDirHandled,
  targetPreview = null,
  onTargetPreviewHandled,
  onOpenFile = null,
  getRecentWritePaths = null,
  files = [],
  filesLoading = false,
  filesError = null,
  onRefreshFiles,
  readOnly = false,
  canDownload = true,
  singleFileMode = false,
  apiAdapter = null,
  onAddContext = null,
  showSystemFiles = false,
  onToggleSystemFiles = null,
  hideClose = false,
  onSwitchToMemoTab = null,
  onCopyShareLink = null,
}: FilePanelProps): React.ReactElement {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const panelRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrowContainer(panelRef, TREE_OVERLAY_WIDTH);

  // A share reads through its own endpoints, which take no workspace id.
  // Memoised as one object: every hook below closes over these, and rebuilding
  // them per render would make each of those callbacks unstable in turn.
  const { readFileFn, readFileFullFn, downloadFileAsArrayBufferFn, triggerDownloadFn, writeFileFn, resolveFileFn } = useMemo(() => ({
    readFileFn: apiAdapter?.readFile ? (_: string, p: string) => apiAdapter.readFile!(p) : readWorkspaceFile,
    readFileFullFn: apiAdapter?.readFileFull ? (_: string, p: string) => apiAdapter.readFileFull!(p) : readWorkspaceFileFull,
    downloadFileAsArrayBufferFn: apiAdapter?.downloadFileAsArrayBuffer
      ? (_: string, p: string) => apiAdapter.downloadFileAsArrayBuffer!(p)
      : downloadWorkspaceFileAsArrayBuffer,
    triggerDownloadFn: apiAdapter?.triggerDownload ? (_: string, p: string) => apiAdapter.triggerDownload!(p) : triggerFileDownload,
    writeFileFn: apiAdapter?.writeFile ? (_: string, p: string, c: string) => apiAdapter.writeFile!(p, c) : writeWorkspaceFile,
    resolveFileFn: apiAdapter
      ? apiAdapter.resolveFile ?? null
      : (candidates: string[], recentWrites: string[]) => resolveWorkspaceFile(workspaceId, candidates, recentWrites),
  }), [apiAdapter, workspaceId]);

  const { data: wsData } = useWorkspace(workspaceId);
  const isFlashWorkspace = wsData?.status === 'flash';

  // A share has no workspace id of its own, so its bodies are scoped to this
  // mount — two shares open at once must not read each other's bytes.
  const mountId = useId();
  const scope = workspaceId || `adapter:${mountId}`;
  const readers = useMemo(
    () => ({ readFile: readFileFn, readFileFull: readFileFullFn, downloadFileAsArrayBuffer: downloadFileAsArrayBufferFn }),
    [readFileFn, readFileFullFn, downloadFileAsArrayBufferFn],
  );
  const cache = useFileBodyCache({ scope, workspaceId, readers });

  const tabs = useFileTabs(workspaceId, threadId);
  const activeTab = tabs.activeTab;
  const selectedFile = activeTab.path;
  const showSettings = activeTab.kind === 'settings';

  const previews = usePreviews(workspaceId);
  const previewTabs = useMemo(
    () => tabs.tabs.filter((t): t is FileTab & { port: number } => t.kind === 'preview' && t.port != null),
    [tabs.tabs],
  );
  const activePort = activeTab.kind === 'preview' ? activeTab.port ?? null : null;
  const activePreview = activePort != null ? previews.byPort.get(activePort) ?? null : null;

  // A tab strip restored from storage names ports nothing has resolved yet;
  // registering them is what puts them in the tree's list and gives the tab
  // something to mint against.
  const registerPreview = previews.register;
  useEffect(() => {
    previewTabs.forEach((tab) => registerPreview({
      port: tab.port, title: tab.title, path: tab.previewPath, command: tab.command,
    }));
  }, [previewTabs, registerPreview]);

  // A signed preview URL is short-lived, so arriving at the tab is when it is
  // minted — not when the tab was opened, and not for tabs nobody is looking at.
  // Keyed on the map as well as the port: a tab restored from storage is
  // registered and activated in the same commit, and the mint has nothing to
  // read until that registration lands.
  const ensurePreview = previews.ensure;
  const previewsByPort = previews.byPort;
  useEffect(() => {
    if (activePort != null) ensurePreview(activePort);
  }, [activePort, ensurePreview, previewsByPort]);
  const { body, loading: fileLoading, error: readError, updatedAt, refetch } = useFileBody({
    cache, path: selectedFile, workspaceStatus: wsData?.status,
  });
  const fileContent = body?.content ?? null;
  const fileMime = body?.mime ?? null;

  const changed = useChangedFiles(getRecentWritePaths);
  useEffect(() => {
    if (selectedFile && updatedAt) changed.markRead(selectedFile);
  }, [selectedFile, updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const downloads = useFileDownloads({ workspaceId, triggerDownloadFn, workspaceStatus: wsData?.status });
  const fileError = downloads.errorFor(selectedFile) ?? readError;

  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [pageCounts, setPageCounts] = useState<Record<string, number>>({});

  const { uploadProgress, uploadError, setUploadError, fileInputRef, isDragOver, handleFileInputChange, handleDragEnter, handleDragLeave, handleDragOver, handleDrop } =
    useFileUpload({ workspaceId, onRefreshFiles });

  const setFileContent = useCallback((next: React.SetStateAction<string | null>) => {
    if (!selectedFile) return;
    const value = typeof next === 'function' ? next(fileContent) : next;
    cache.patchBody(selectedFile, { content: value, truncated: false });
  }, [cache, selectedFile, fileContent]);

  const edit = useFileEdit({
    tabId: activeTab.id, workspaceId, selectedFile, fileContent, setFileContent, readFileFullFn, writeFileFn,
  });

  const { selectionTooltip, contentWrapperRef, contextMenu, setContextMenu, handleContentMouseUp, handleEditorTextSelect, handleAddSelectionContext } =
    useSelectionContext({ selectedFile, fileContent, onAddContext });

  const focus = useFileFocus({
    selectedFile,
    viewer: selectedFile ? viewerFor(selectedFile, fileMime, edit.isEditing) : 'other',
    ready: !fileLoading && !fileError,
    editing: edit.isEditing,
    content: fileContent,
    truncated: !!body?.truncated,
    pageCount: selectedFile ? pageCounts[selectedFile] ?? null : null,
    containerRef: contentWrapperRef,
  });

  // Replay the tab's own location whenever it comes back to the front.
  useEffect(() => {
    if (activeTab.path && activeTab.location) focus.focusAt(activeTab.path, activeTab.location);
  }, [activeTab.id, activeTab.locationSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAddToMemo = useAddToMemo({ workspaceId, downloadFileAsArrayBufferFn, readFileFullFn, onSwitchToMemoTab });
  const memoedMap = useWorkspaceMemoIndex(workspaceId);
  const memoEntry = selectedFile ? memoedMap.get(selectedFile) ?? null : null;
  const { status: memoStaleStatus, sandboxText: memoStaleSandboxText, refresh: refreshMemoStale } = useMemoStaleCheck({
    workspaceId, selectedFile, fileMime, memoSha256: memoEntry?.sha256 ?? null, readFileFullFn,
  });
  const [memoSyncing, setMemoSyncing] = useState(false);
  const [memoDiffOpen, setMemoDiffOpen] = useState(false);

  const filter = useTreeFilter({ workspaceId, files, scopeDir: targetDirectory, rootRef: panelRef });
  const selection = useFileSelection({ workspaceId, filteredSortedFiles: filter.filteredSortedFiles, targetDirectory, onRefreshFiles });
  const backup = useFileBackup({ workspaceId, files, readOnly });

  // `openFileAt` is defined below, so the tree reaches it through a handler
  // that stays the same object across renders.
  const openFromTree = useStableHandler((path: string) => { void openFileAt(path); });
  const tree = useTreeInteraction({
    workspaceId, rootRef: panelRef, selection, narrow, activePath: selectedFile, openFile: openFromTree,
  });
  const { open: treeOpen, setOpen: setTreeOpen } = tree;

  /** A breadcrumb segment points the tree at that directory. */
  const revealInTree = useCallback((dir: string) => {
    setTreeOpen(true);
    filter.revealDir(dir);
  }, [setTreeOpen, filter]);

  /** Nothing the panel is showing over the viewer survives a file landing in it. */
  const onBeforeOpen = useCallback(() => {
    downloads.clearError();
  }, [downloads]);

  /** A reference nothing could settle: the tree, filtered to the name it used. */
  const landOnSearch = useCallback((ref: string, name: string, matches: string[]) => {
    filter.showMatches(ref, name, matches);
    setTreeOpen(true);
    if (targetDirectory) onTargetDirHandled?.();
  }, [filter, setTreeOpen, targetDirectory, onTargetDirHandled]);

  const { openFileAt, openFileRef, retryOpen } = useFileRefOpen({
    tabs,
    cache,
    hasChanged: changed.hasChanged,
    files,
    workspaceStatus: wsData?.status,
    resolveFileFn,
    getRecentWritePaths,
    onBeforeOpen,
    clearSearch: filter.clearSearch,
    onLandOnSearch: landOnSearch,
    refetch,
  });

  useEffect(() => {
    if (!targetFile) return;
    void openFileRef(targetFile, { location: targetLocation, pin: targetPin });
    onTargetFileHandled?.();
  }, [targetFile]); // eslint-disable-line react-hooks/exhaustive-deps

  // The agent published an app: its tab, and a URL fresh enough to load.
  useEffect(() => {
    if (!targetPreview) return;
    tabs.openPreview({
      port: targetPreview.port, title: targetPreview.title, path: targetPreview.path, command: targetPreview.command,
    });
    previews.open(targetPreview);
    onTargetPreviewHandled?.();
  }, [targetPreview?.seq, targetPreview?.port]); // eslint-disable-line react-hooks/exhaustive-deps

  // A folder from chat points the tree, which now stays on screen beside the
  // open file — so nothing has to be closed to honour it.
  useEffect(() => {
    if (targetDirectory == null) return;
    filter.clearSearch();
    setTreeOpen(true);
  }, [targetDirSeq, targetDirectory]); // eslint-disable-line react-hooks/exhaustive-deps

  const retry = useCallback(() => {
    downloads.clearError();
    retryOpen();
  }, [downloads, retryOpen]);

  // --- file actions ---

  const handleDownloadSelected = canDownload && selectedFile ? () => downloads.download(selectedFile) : undefined;
  const handleDownloadInFallback = canDownload && selectedFile ? () => downloads.downloadQuietly(selectedFile) : undefined;

  const handleContextMenuAction = useCallback((action: FileMenuAction, filePath: string) => {
    setContextMenu(null);
    if (action === 'add-context' && onAddContext) {
      tabs.openFile(filePath, { pin: true });
      onAddContext({ path: filePath });
    } else if (action === 'add-to-memo') {
      handleAddToMemo(filePath);
    } else if (action === 'open') {
      void openFileAt(filePath);
    } else if (action === 'open-new-tab') {
      void openFileAt(filePath, { pin: true });
    } else if (action === 'download') {
      downloads.download(filePath);
    } else if (action === 'download-many') {
      void downloads.downloadMany([...selection.selectedPaths]);
    }
  }, [onAddContext, handleAddToMemo, openFileAt, downloads, selection.selectedPaths, setContextMenu, tabs]);

  /**
   * Coming back to a tab whose file the agent has rewritten re-reads it. The
   * amber dot is the notice; arriving at the tab is the moment the reader
   * wants the new bytes, and re-reading every open tab the instant a write
   * lands would fight whoever is reading one of them.
   */
  const activateTab = useCallback((id: string) => {
    const tab = tabs.tabs.find((x) => x.id === id);
    if (tab?.path && changed.hasChanged(tab.path)) cache.invalidate(tab.path);
    tabs.activate(id);
  }, [tabs, changed, cache]);

  const startEdit = useCallback(() => {
    tabs.pinTab(activeTab.id);
    void edit.handleStartEdit();
  }, [tabs, activeTab.id, edit]);

  const closeTab = useCallback((id: string) => {
    if (edit.tabHasUnsavedChanges(id) && !window.confirm(t('filePanel.discardUnsaved'))) return;
    edit.forgetTab(id);
    const tab = tabs.tabs.find((x) => x.id === id);
    if (tab?.path) changed.forget(tab.path);
    if (singleFileMode && tabs.tabs.length <= 1) return onClose();
    tabs.closeTab(id);
  }, [edit, tabs, changed, singleFileMode, onClose, t]);

  const handleViewerLink = useStableHandler((path: string, linkWorkspaceId?: string, location?: FileLocation, rooted?: boolean) => {
    const otherWorkspace = !!linkWorkspaceId && linkWorkspaceId !== workspaceId;
    const kind = classifyAgentPath(path).kind;
    const directory = parseAgentPath(path).directory;
    // A folder inside a viewed file is written relative to it, the same as a
    // file link, but the router takes the path as given, so the join happens here.
    const target = directory && kind === 'file' && !otherWorkspace
      ? linkCandidates(path, rooted ? null : selectedFile)[0]
      : path;
    if (otherWorkspace || kind !== 'file' || directory) {
      onOpenFile?.(target, linkWorkspaceId, location);
      return;
    }
    // A rooted reference named where it starts, so the open file's directory is
    // not a reading it invited.
    void openFileRef(path, { fromFile: rooted ? null : selectedFile, location });
  });

  const handleAnchorLink = useStableHandler((fragment: string) => {
    if (selectedFile) focus.focusAt(selectedFile, parseFragment(fragment));
  });

  const handleSyncMemo = useCallback(async () => {
    if (!selectedFile || memoSyncing) return;
    setMemoSyncing(true);
    try {
      await handleAddToMemo(selectedFile);
      refreshMemoStale();
    } finally {
      setMemoSyncing(false);
    }
  }, [selectedFile, memoSyncing, handleAddToMemo, refreshMemoStale]);

  // A write lands in the sandbox, so the copy the panel holds and the backup
  // verdict beside it are both a version behind until they are re-read.
  const handleSave = useCallback(async () => {
    await edit.handleSave();
    if (selectedFile) cache.invalidate(selectedFile);
    onRefreshFiles?.();
  }, [edit, cache, selectedFile, onRefreshFiles]);

  const selectedExt = selectedFile ? getFileExtension(selectedFile) : '';
  const canEdit = !!(selectedFile && !readOnly && !fileError
    && EDITABLE_EXTENSIONS.has(selectedExt)
    && fileMime !== 'image' && fileMime !== 'pdf' && fileMime !== 'excel'
    && !['html', 'htm'].includes(selectedExt)
    && !selectedFile.startsWith('/large_tool_results/'));

  const meta = useMemo(() => {
    if (!selectedFile || !body) return null;
    const pages = pageCounts[selectedFile];
    if (body.mime === 'pdf') return pages ? t('filePanel.metaPages', { count: pages }) : null;
    if (body.content == null) return null;
    const lines = countLines(body.content);
    return body.truncated ? t('filePanel.metaFirstLines', { count: lines }) : t('filePanel.metaLines', { count: lines });
  }, [selectedFile, body, pageCounts, t]);

  /** Opening a running app from the tree: the tab it already has, or a new one. */
  const openPreviewTab = useCallback((port: number) => {
    const entry = previews.byPort.get(port);
    tabs.openPreview({ port, title: entry?.title, path: entry?.path, command: entry?.command });
    previews.ensure(port);
  }, [previews, tabs]);

  // A preview is a frame, not a folder: nothing can be dropped into it, and
  // unlike settings it leaves the tree where it was.
  const canDropHere = !readOnly && !showSettings && activePort == null;

  return (
    <div className="file-panel" ref={panelRef} onKeyDown={tree.onEscape}>
      <TabStrip
        tabs={tabs.tabs}
        activeId={tabs.activeId}
        onActivate={activateTab}
        onClose={closeTab}
        onPin={tabs.pinTab}
        onNewTab={tabs.newTab}
        hasChanged={changed.hasChanged}
        treeOpen={treeOpen}
        onToggleTree={singleFileMode || showSettings ? null : () => setTreeOpen((v) => !v)}
        onPanelClose={hideClose ? null : onClose}
        backArrow={isMobile}
      />

      {activePort != null && (
        <PreviewCrumbs
          entry={activePreview ?? { port: activePort, url: '', loading: true, error: false, reloadToken: 0 }}
          onRefresh={() => previews.refresh(activePort)}
        />
      )}

      {selectedFile && !showSettings && (
        <FileCrumbs
          path={selectedFile}
          onOpenDir={revealInTree}
          meta={meta}
          unsaved={edit.hasUnsavedChanges}
          chip={focus.chip && (
            <FocusChip state={focus.chip} onJump={focus.jump} onDismiss={() => { focus.dismiss(); tabs.clearLocation(activeTab.id); }} />
          )}
          actions={(
            <FileHeaderActions
              selectedFile={selectedFile}
              isEditing={edit.isEditing}
              workspaceId={workspaceId}
              fileContent={fileContent}
              fileMime={fileMime}
              canEdit={canEdit}
              onStartEdit={startEdit}
              onOpenExportModal={() => setExportModalOpen(true)}
              triggerDownloadFn={triggerDownloadFn}
              canDownload={canDownload}
              readFileFullFn={readFileFullFn}
              htmlServedUrl={apiAdapter?.buildServedUrl?.(selectedFile)}
              editorRef={edit.editorRef}
              canUndo={edit.canUndo}
              canRedo={edit.canRedo}
              hasUnsavedChanges={edit.hasUnsavedChanges}
              showDiff={edit.showDiff}
              setShowDiff={edit.setShowDiff}
              isSaving={edit.isSaving}
              saveError={edit.saveError}
              onSave={handleSave}
              onCancelEdit={edit.handleCancelEdit}
            />
          )}
        />
      )}

      <PanelNotices
        uploadProgress={uploadProgress}
        error={uploadError || selection.deleteError}
        onDismissError={() => { setUploadError(null); selection.setDeleteError(null); }}
        busy={selection.deleteLoading || backup.backingUp}
        backupResult={backup.backupResult}
        onDismissBackupResult={() => backup.setBackupResult(null)}
        editing={edit.isEditing}
      />
      {memoEntry && selectedFile && !showSettings && (
        <MemoStaleBanner
          status={memoStaleStatus}
          syncing={memoSyncing}
          onSwitchToMemoTab={onSwitchToMemoTab}
          onSync={handleSyncMemo}
          onViewDiff={memoStaleSandboxText !== null ? () => setMemoDiffOpen(true) : null}
        />
      )}

        <div className="file-panel-body">
          <div
            className="file-panel-viewer"
            onDragEnter={canDropHere ? handleDragEnter : undefined}
            onDragLeave={canDropHere ? handleDragLeave : undefined}
            onDragOver={canDropHere ? handleDragOver : undefined}
            onDrop={canDropHere ? handleDrop : undefined}
          >
            {canDropHere && isDragOver && (
              <div className="file-panel-drag-overlay">
                <Upload className="h-8 w-8" style={{ color: 'var(--color-accent-primary)' }} />
                <span>{t('filePanel.dropToUpload')}</span>
              </div>
            )}
            {/* font-content only while reading a file: the tree stays on the UI font. */}
            <div className={`file-panel-content${selectedFile ? ' font-content' : ''}`} ref={contentWrapperRef}>
              {selectionTooltip && onAddContext && (
                <div
                  className="file-panel-selection-tooltip"
                  style={{ left: Math.max(8, selectionTooltip.x - 60), top: Math.max(4, selectionTooltip.y - 32) }}
                  onMouseDown={(e: React.MouseEvent) => {
                    e.preventDefault(); e.stopPropagation();
                    tabs.pinTab(activeTab.id);
                    handleAddSelectionContext();
                  }}
                >
                  <TextSelect className="h-3.5 w-3.5" style={{ color: 'var(--color-accent-primary)' }} />
                  {selectionTooltip.lineStart != null
                    ? (selectionTooltip.lineEnd !== selectionTooltip.lineStart
                        ? t('context.addLinesToContext', { start: selectionTooltip.lineStart, end: selectionTooltip.lineEnd })
                        : t('context.addLineToContext', { line: selectionTooltip.lineStart }))
                    : t('context.addToContext')}
                </div>
              )}
              {/* Every open app keeps its iframe mounted and only the active
                  one is shown: a tab switch must not reload a running server,
                  drop its scroll position or discard what was typed into it. */}
              {previewTabs.length > 0 && (
                <Suspense fallback={null}>
                  {previewTabs.map((tab) => {
                    const entry = previews.byPort.get(tab.port);
                    return (
                      <div key={tab.id} className="file-panel-preview-pane" hidden={tab.id !== activeTab.id}>
                        <PreviewViewer
                          chrome={false}
                          url={entry?.url ?? ''}
                          port={tab.port}
                          title={tab.title}
                          loading={entry?.loading ?? true}
                          error={entry?.error}
                          reloadToken={entry?.reloadToken}
                          onRefresh={() => previews.refresh(tab.port)}
                        />
                      </div>
                    );
                  })}
                </Suspense>
              )}
              {activePort != null ? null : showSettings ? (
                <div className="file-panel-settings">
                  <SandboxSettingsContent workspaceId={workspaceId} />
                </div>
              ) : selectedFile ? (
                <FileViewer
                  path={selectedFile}
                  body={body}
                  loading={fileLoading}
                  error={fileError}
                  onRetry={retry}
                  onDownload={handleDownloadSelected}
                  onDownloadInFallback={handleDownloadInFallback}
                  workspaceId={workspaceId}
                  focus={focus}
                  onPageCount={(pages) => setPageCounts((prev) => (prev[selectedFile] === pages ? prev : { ...prev, [selectedFile]: pages }))}
                  isEditing={edit.isEditing}
                  editContent={edit.editContent}
                  originalContent={edit.originalContent}
                  showDiff={edit.showDiff}
                  editorRef={edit.editorRef}
                  onEditorChange={edit.handleEditorChange}
                  onUndoRedoChange={edit.handleUndoRedoChange}
                  onEditorTextSelect={handleEditorTextSelect}
                  onAddContext={onAddContext}
                  onContentMouseUp={handleContentMouseUp}
                  onViewerLink={handleViewerLink}
                  onAnchorLink={handleAnchorLink}
                  servedUrl={apiAdapter?.buildServedUrl?.(selectedFile, { injectTheme: true })}
                  onCopyShareLink={onCopyShareLink}
                />
              ) : (
                <EmptyTab canUpload={!readOnly} treeOpen={treeOpen} onShowTree={singleFileMode ? null : () => setTreeOpen(true)} />
              )}
            </div>
          </div>

          <AnimatePresence initial={false}>
          {!singleFileMode && treeOpen && !showSettings && (
            <TreeColumn
              key="tree"
              filter={filter}
              selection={selection}
              backup={backup}
              filesLoading={filesLoading}
              filesError={filesError}
              onRefreshFiles={onRefreshFiles}
              showSystemFiles={showSystemFiles}
              onToggleSystemFiles={onToggleSystemFiles}
              scopeDir={targetDirectory ?? null}
              onClearScope={() => onTargetDirHandled?.()}
              openPaths={tabs.openPaths}
              activePath={selectedFile}
              onFileClick={tree.onOpen}
              onFileDoubleClick={(path) => { tabs.openFile(path, { pin: true }); void cache.fetchBody(path).catch(() => {}); }}
              onOpenFromKeyboard={tree.onOpen}
              onEscape={() => (selection.selectMode ? selection.exitSelectMode() : setTreeOpen(!narrow))}
              memoedMap={memoedMap}
              memoedTitle={t('context.inMemo')}
              onAddContext={onAddContext}
              setContextMenu={setContextMenu}
              activeContextPath={contextMenu?.filePath ?? null}
              readOnly={readOnly}
              uploadDisabled={uploadProgress !== null}
              onUpload={() => fileInputRef.current?.click()}
              previews={previews.previews}
              onOpenPreview={openPreviewTab}
              activePreviewPort={activePort}
              onOpenSettings={!readOnly && !isFlashWorkspace ? tabs.openSettings : null}
              workspaceName={wsData?.name}
              overlay={narrow}
              onDismissOverlay={() => setTreeOpen(false)}
            />
          )}
          </AnimatePresence>
        </div>

      <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileInputChange} />

      {contextMenu && (
        <FileContextMenu
          menu={contextMenu}
          onAction={handleContextMenuAction}
          canAddContext={!!onAddContext}
          memoState={memoMimeForName(contextMenu.filePath)
            ? (memoedMap.has(contextMenu.filePath) ? 'present' : 'absent')
            : null}
          canDownload={canDownload}
          selectedCount={selection.selectedPaths.has(contextMenu.filePath) ? selection.selectedPaths.size : 0}
        />
      )}

      {selectedFile && exportModalOpen && (
        <Suspense fallback={null}>
          <ExportPreviewModal
            open={exportModalOpen}
            onOpenChange={setExportModalOpen}
            content={fileContent ?? ''}
            fileName={selectedFile}
            workspaceId={workspaceId}
            readFileFullFn={readFileFullFn}
          />
        </Suspense>
      )}
      {selectedFile && memoEntry && memoStaleSandboxText !== null && (
        <MemoDiffModal
          open={memoDiffOpen}
          memoKey={memoEntry.key}
          fileName={selectedFile.split('/').pop() || selectedFile}
          sandboxText={memoStaleSandboxText}
          onClose={() => setMemoDiffOpen(false)}
        />
      )}
    </div>
  );
}

export default FilePanel;
export type { ContextPayload } from './filePanel/types';
export { SYSTEM_DIR_PREFIXES } from './filePanel/fileMeta';
// eslint-disable-next-line react-refresh/only-export-components
export { categorizeFileError } from './filePanel/fileErrors';
export { FileErrorDisplay } from './filePanel/fileErrors';
