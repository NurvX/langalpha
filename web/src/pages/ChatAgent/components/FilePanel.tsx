import React, { useState, useEffect, useCallback, useRef, useMemo, Suspense } from 'react';
import { ArrowLeft, X, RefreshCw, Upload, ArrowUpDown, Trash2, CheckSquare, HardDrive, Pencil, TextSelect, FolderOpen, Settings, ScrollText, Search } from 'lucide-react';
import {
  memoMimeForName,
  useAddToMemo,
  useWorkspaceMemoIndex,
  useMemoStaleCheck,
  MemoStaleBanner,
  MemoDiffModal,
} from './FilePanelMemo';
import { Loader } from '@/components/ui/loader';
import { useWorkspace } from '@/hooks/useWorkspace';
import { SandboxSettingsContent } from './SandboxSettingsPanel';
import { useIsMobile } from '@/hooks/useIsMobile';
import SyntaxHighlighter, { oneDark, oneLight } from './SyntaxHighlighter';
import { useTranslation } from 'react-i18next';
import { readWorkspaceFile, readWorkspaceFileFull, writeWorkspaceFile, downloadWorkspaceFile, downloadWorkspaceFileAsArrayBuffer, triggerFileDownload, resolveWorkspaceFile } from '../utils/api';
import { basename, isSystemPath, linkCandidates, normalizeRefPath, resolveExact } from '../utils/fileRefResolver';
import { classifyAgentPath } from '../utils/agentPaths';
import { useStableHandler } from '@/hooks/useStableHandler';
import { parseFragment, type FileLocation, type OpenFileHandler } from '../utils/fileLocation';
import { stripLineNumbers } from './toolDisplayConfig';
import Markdown from './Markdown';
import ImageLightbox from './ImageLightbox';
import DocumentErrorBoundary from './viewers/DocumentErrorBoundary';
import FileHeaderActions from './FileHeaderActions';
import './FilePanel.css';

const PdfViewer = React.lazy(() => import('./viewers/PdfViewer'));
const ExcelViewer = React.lazy(() => import('./viewers/ExcelViewer'));
const CsvViewer = React.lazy(() => import('./viewers/CsvViewer'));
const HtmlViewer = React.lazy(() => import('./viewers/HtmlViewer'));
const CodeEditor = React.lazy(() => import('./viewers/CodeEditor'));
const ExportPreviewModal = React.lazy(() => import('./ExportPreviewModal'));

import type { ApiAdapter, ContextPayload, FileRefResolution } from './filePanel/types';
import type { FileError } from './filePanel/fileErrors';
import { categorizeFileError, FileErrorDisplay } from './filePanel/fileErrors';
import { DOWNLOAD_ONLY_EXTENSIONS, EDITABLE_EXTENSIONS, EXT_TO_LANG, getAvailableTypes, getFileExtension, getFileType, SORT_OPTIONS, sortFiles } from './filePanel/fileMeta';
import { buildFileTree } from './filePanel/fileTree';
import type { TreeNode } from './filePanel/types';
import { DirectoryNode } from './filePanel/DirectoryNode';
import { DocumentErrorFallback, DocumentLoadingFallback } from './filePanel/fallbacks';
import { useFileUpload } from './filePanel/useFileUpload';
import { useFileEdit } from './filePanel/useFileEdit';
import { useSelectionContext } from './filePanel/useSelectionContext';
import { useFileSelection } from './filePanel/useFileSelection';
import { useFileBackup } from './filePanel/useFileBackup';
import { useFileFocus, type FocusViewer } from './filePanel/useFileFocus';
import { FocusChip } from './filePanel/FocusChip';

// --- FilePanel ---

interface FilePanelProps {
  workspaceId: string;
  onClose: () => void;
  targetFile?: string | null;
  /** Where in `targetFile` the reference pointed (a line, page or heading). */
  targetLocation?: FileLocation | null;
  onTargetFileHandled?: () => void;
  targetDirectory?: string | null;
  onTargetDirHandled?: () => void;
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
  /** Lock to a single file — back button closes the panel instead of returning to the file tree. */
  singleFileMode?: boolean;
  apiAdapter?: ApiAdapter | null;
  onAddContext?: ((ctx: ContextPayload) => void) | null;
  showSystemFiles?: boolean;
  onToggleSystemFiles?: (() => void) | null;
  /** Hide the panel-close affordances (the mobile back arrow and the trailing X)
   * when FilePanel is embedded inside a tabbed wrapper that owns the close button. */
  hideClose?: boolean;
  onSwitchToMemoTab?: (() => void) | null;
  /** Copy a shareable link to an HTML report (authenticated app only). Enables
   *  sharing if needed, then copies a direct full-tab link to the served file
   *  (`${origin}/api/v1/public/shared/{token}/files/serve/<path>`). */
  onCopyShareLink?: ((filePath: string) => void) | null;
}

function FilePanel({
  workspaceId,
  onClose,
  targetFile,
  targetLocation = null,
  onTargetFileHandled,
  targetDirectory,
  onTargetDirHandled,
  onOpenFile = null,
  getRecentWritePaths = null,
  // Shared file list from useWorkspaceFiles hook
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
  // Resolve API functions -- use adapter overrides if provided, otherwise fall back to authenticated imports
  const readFileFn = apiAdapter?.readFile
    ? (_: string, path: string) => apiAdapter.readFile!(path)
    : readWorkspaceFile;
  const downloadFileFn = apiAdapter?.downloadFile
    ? (_: string, path: string) => apiAdapter.downloadFile!(path)
    : downloadWorkspaceFile;
  const downloadFileAsArrayBufferFn = apiAdapter?.downloadFileAsArrayBuffer
    ? (_: string, path: string) => apiAdapter.downloadFileAsArrayBuffer!(path)
    : downloadWorkspaceFileAsArrayBuffer;
  const triggerDownloadFn = apiAdapter?.triggerDownload
    ? (_: string, path: string) => apiAdapter.triggerDownload!(path)
    : triggerFileDownload;
  const writeFileFn = apiAdapter?.writeFile
    ? (_: string, path: string, content: string) => apiAdapter.writeFile!(path, content)
    : writeWorkspaceFile;
  const readFileFullFn = apiAdapter?.readFileFull
    ? (_: string, path: string) => apiAdapter.readFileFull!(path)
    : readWorkspaceFileFull;
  // The server settles a reference against the real workspace (or a share's listing).
  const resolveFileFn = apiAdapter
    ? apiAdapter.resolveFile ?? null
    : (candidates: string[], recentWrites: string[]) => resolveWorkspaceFile(workspaceId, candidates, recentWrites);

  // Workspace settings inline view
  const [showSettings, setShowSettings] = useState(false);
  const { data: wsData } = useWorkspace(workspaceId);
  const isFlashWorkspace = wsData?.status === 'flash';
  const workspaceName = wsData?.name;

  // File detail view state
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileArrayBuffer, setFileArrayBuffer] = useState<ArrayBuffer | null>(null);
  const [fileMime, setFileMime] = useState<string | null>(null);
  const [imageLightboxOpen, setImageLightboxOpen] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<FileError | null>(null);
  const [fileTruncated, setFileTruncated] = useState(false);
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null);

  // Tree search, and the landing a reference that did not resolve opens on:
  // the query is its file name, `missedRef` names what was asked for, and
  // `extraMatches` carries hits the loaded list hides (system directories).
  const [searchQuery, setSearchQuery] = useState('');
  const [missedRef, setMissedRef] = useState<string | null>(null);
  const [extraMatches, setExtraMatches] = useState<string[]>([]);
  // Bumped by every reference open, so a slow name search cannot land after
  // the user has already clicked something else.
  const openSeqRef = useRef(0);

  // Upload + drag-and-drop (filePanel/useFileUpload).
  const {
    uploadProgress,
    uploadError,
    setUploadError,
    fileInputRef,
    isDragOver,
    handleFileInputChange,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
  } = useFileUpload({ workspaceId, onRefreshFiles });

  // Edit mode (filePanel/useFileEdit).
  const {
    isEditing,
    setIsEditing,
    editContent,
    setEditContent,
    isSaving,
    saveError,
    setSaveError,
    showDiff,
    setShowDiff,
    originalContent,
    setOriginalContent,
    editorRef,
    canUndo,
    setCanUndo,
    canRedo,
    setCanRedo,
    handleUndoRedoChange,
    hasUnsavedChanges,
    handleStartEdit,
    handleEditorChange,
    handleSave,
    handleCancelEdit,
  } = useFileEdit({ workspaceId, selectedFile, fileContent, setFileContent, readFileFullFn, writeFileFn });

  // Selection tooltip + right-click context menu (filePanel/useSelectionContext).
  const {
    selectionTooltip,
    contentWrapperRef,
    contextMenu,
    setContextMenu,
    handleContentMouseUp,
    handleEditorTextSelect,
    handleAddSelectionContext,
  } = useSelectionContext({ selectedFile, fileContent, onAddContext });

  // Mirrors the viewer branches in the render below.
  const focusViewer: FocusViewer = (() => {
    if (!selectedFile || isEditing) return 'other';
    const ext = getFileExtension(selectedFile);
    if (fileMime === 'pdf') return 'pdf';
    if (fileMime === 'excel' || fileMime === 'image' || ext === 'csv') return 'other';
    if (ext === 'html' || ext === 'htm') return 'html';
    if (selectedFile.startsWith('/large_tool_results/')) return 'other';
    if (fileMime?.includes('markdown') || ext === 'md') return 'markdown';
    return 'code';
  })();
  const fileFocus = useFileFocus({
    selectedFile,
    viewer: focusViewer,
    ready: !fileLoading && !fileError,
    editing: isEditing,
    content: fileContent,
    truncated: fileTruncated,
    pageCount: pdfPageCount,
    containerRef: contentWrapperRef,
  });

  const handleAddToMemo = useAddToMemo({
    workspaceId,
    downloadFileAsArrayBufferFn,
    readFileFullFn,
    onSwitchToMemoTab,
  });

  const handleContextMenuAction = useCallback((action: string, filePath: string) => {
    setContextMenu(null);
    if (action === 'add-context' && onAddContext) {
      onAddContext({ path: filePath });
    } else if (action === 'add-to-memo') {
      handleAddToMemo(filePath);
    } else if (action === 'open') {
      handleFileClick(filePath);
    }
  }, [onAddContext, handleAddToMemo]); // eslint-disable-line react-hooks/exhaustive-deps

  // Export modal state
  const [exportModalOpen, setExportModalOpen] = useState(false);

  // Filter and sort state
  const [filterType, setFilterType] = useState('All');
  const [sortBy, setSortBy] = useState('name-asc');
  const [showSortMenu, setShowSortMenu] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement>(null);

  // Memo'd lookup + stale-check verdict — see FilePanelMemo.tsx.
  const memoedMap = useWorkspaceMemoIndex(workspaceId);
  const memoedTitle = t('context.inMemo');
  const memoEntryForSelected = selectedFile ? memoedMap.get(selectedFile) ?? null : null;
  const {
    status: memoStaleStatus,
    sandboxText: memoStaleSandboxText,
    refresh: refreshMemoStale,
  } = useMemoStaleCheck({
    workspaceId,
    selectedFile,
    fileMime,
    memoSha256: memoEntryForSelected?.sha256 ?? null,
    readFileFullFn,
  });
  const [memoSyncing, setMemoSyncing] = useState(false);
  const [memoDiffOpen, setMemoDiffOpen] = useState(false);

  const handleSyncMemo = useCallback(async () => {
    if (!selectedFile || memoSyncing) return;
    setMemoSyncing(true);
    try {
      await handleAddToMemo(selectedFile);
      // Re-run the stale check even if memoListData is still revalidating.
      refreshMemoStale();
    } finally {
      setMemoSyncing(false);
    }
  }, [selectedFile, memoSyncing, handleAddToMemo, refreshMemoStale]);

  const handleViewMemoDiff = useCallback(() => {
    setMemoDiffOpen(true);
  }, []);

  const listedFiles = useMemo(
    // Search hits outside the listing belong to the reference search that found them.
    () => (extraMatches.length && searchQuery ? [...new Set([...files, ...extraMatches])] : files),
    [files, extraMatches, searchQuery],
  );
  const availableTypes = useMemo(() => getAvailableTypes(listedFiles), [listedFiles]);
  const trimmedQuery = searchQuery.trim().toLowerCase();

  // Apply directory filter, search, type filter, sort, then group
  const filteredSortedFiles = useMemo(() => {
    let result = listedFiles;
    if (trimmedQuery) {
      result = result.filter((fp) => fp.toLowerCase().includes(trimmedQuery));
    }
    if (targetDirectory) {
      const prefix = targetDirectory.endsWith('/') ? targetDirectory : targetDirectory + '/';
      result = result.filter((fp) => fp.startsWith(prefix));
    }
    if (filterType !== 'All') {
      result = result.filter((fp) => getFileType(fp) === filterType);
    }
    return sortFiles(result, sortBy);
  }, [listedFiles, trimmedQuery, filterType, sortBy, targetDirectory]);

  // Multi-select + delete (filePanel/useFileSelection).
  const {
    selectMode,
    setSelectMode,
    selectedPaths,
    deleteLoading,
    deleteError,
    setDeleteError,
    deleteConfirm,
    toggleSelect,
    toggleSelectAll,
    toggleDirSelect,
    exitSelectMode,
    handleDelete,
  } = useFileSelection({ workspaceId, filteredSortedFiles, targetDirectory, onRefreshFiles });

  // COS backup status + trigger (filePanel/useFileBackup).
  const {
    backedUpSet,
    modifiedSet,
    backingUp,
    backupResult,
    setBackupResult,
    handleBackup,
  } = useFileBackup({ workspaceId, files, readOnly });

  // Directory expand state
  const storageKey = `filePanel.expandedDirs.${workspaceId}`;
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved ? new Set(JSON.parse(saved) as string[]) : new Set();
    } catch { return new Set(); }
  });
  const fileTree = useMemo(() => buildFileTree(filteredSortedFiles), [filteredSortedFiles]);
  // A search shows every hit, so it opens every directory on the way to one.
  const visibleExpandedDirs = useMemo(() => {
    if (!trimmedQuery) return expandedDirs;
    const all = new Set<string>();
    const walk = (node: TreeNode) => {
      all.add(node.fullPath);
      node.children.forEach(walk);
    };
    fileTree.forEach(walk);
    return all;
  }, [trimmedQuery, expandedDirs, fileTree]);

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify([...expandedDirs]));
  }, [expandedDirs, storageKey]);

  const toggleDir = useCallback((dir: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!showSortMenu) return;
    const handler = (e: MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) {
        setShowSortMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSortMenu]);

  useEffect(() => {
    return () => {
      if (fileMime === 'image' && fileContent) {
        URL.revokeObjectURL(fileContent);
      }
    };
  }, [fileContent, fileMime]);

  useEffect(() => {
    if (targetFile) {
      void openFileRef(targetFile, { location: targetLocation });
      onTargetFileHandled?.();
    }
  }, [targetFile]); // eslint-disable-line react-hooks/exhaustive-deps

  // A folder opened from chat supersedes a reference still being searched for.
  useEffect(() => {
    if (!targetDirectory) return;
    openSeqRef.current += 1;
    dropLanding();
  }, [targetDirectory]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Leave edit mode without saving, so the next file never opens in the last one's editor. */
  const resetEdit = () => {
    setIsEditing(false);
    setEditContent(null);
    setShowDiff(false);
    setOriginalContent(null);
    editorRef.current = null;
    setCanUndo(false);
    setCanRedo(false);
    setSaveError(null);
  };

  /** Clear the tree filter a missed reference set, so it does not outlive the miss. */
  const dropLanding = () => {
    if (!missedRef) return;
    setSearchQuery('');
    setExtraMatches([]);
    setMissedRef(null);
  };

  /**
   * Open a file in the viewer. Resolves to the read's error, or null once it
   * loaded or a later open took over; a read that finishes after a later open
   * started is dropped, so a slow file never lands under another file's name.
   */
  const handleFileClick = async (filePath: string): Promise<FileError | null> => {
    const seq = ++openSeqRef.current;
    const current = () => seq === openSeqRef.current;
    const ext = getFileExtension(filePath);
    setFileError(null);
    resetEdit();

    if (DOWNLOAD_ONLY_EXTENSIONS.has(ext)) {
      setSelectedFile(filePath);
      setFileContent(null);
      setFileArrayBuffer(null);
      setFileMime(null);
      setFileLoading(false);
      setFileError({ category: 'binary_file' });
      return null;
    }

    const load = async (read: () => Promise<void>, label: string, onError?: () => void): Promise<FileError | null> => {
      setSelectedFile(filePath);
      setFileLoading(true);
      try {
        await read();
        return null;
      } catch (err) {
        if (!current()) return null;
        console.error(`[FilePanel] Failed to load ${label}:`, err);
        const error = categorizeFileError(err, wsData?.status);
        setFileError(error);
        onError?.();
        return error;
      } finally {
        if (current()) setFileLoading(false);
      }
    };

    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(ext)) {
      if (fileMime === 'image' && fileContent) {
        URL.revokeObjectURL(fileContent);
      }
      setFileMime('image');
      return load(async () => {
        const blobUrl = await downloadFileFn(workspaceId, filePath);
        if (!current()) return URL.revokeObjectURL(blobUrl);
        setFileContent(blobUrl);
      }, 'image', () => { setFileContent(null); setFileMime(null); });
    }

    if (ext === 'pdf' || ext === 'xlsx' || ext === 'xlsm' || ext === 'xls') {
      setFileMime(ext === 'pdf' ? 'pdf' : 'excel');
      if (ext === 'pdf') setPdfPageCount(null);
      return load(async () => {
        const buf = await downloadFileAsArrayBufferFn(workspaceId, filePath);
        if (current()) setFileArrayBuffer(buf);
      }, ext === 'pdf' ? 'PDF' : 'Excel file', () => setFileMime(null));
    }

    // HTML files: read the full source (the viewer renders via the served URL,
    // but the Source tab needs untruncated content — the paginated read caps at 20k lines).
    if (['html', 'htm'].includes(ext)) {
      return load(async () => {
        const data = await readFileFullFn(workspaceId, filePath);
        if (!current()) return;
        setFileContent(data.content || '');
        setFileMime('text/html');
      }, 'HTML file', () => { setFileContent(null); setFileMime(null); });
    }

    // Text files - read content
    return load(async () => {
      const data = await readFileFn(workspaceId, filePath);
      if (!current()) return;
      setFileContent(data.content || '');
      setFileMime(data.mime || 'text/plain');
      setFileTruncated(!!data.truncated);
    }, 'file', () => { setFileContent(null); setFileMime(null); });
  };

  /** Leave any open file and show the tree filtered to a reference's name. */
  const landOnSearch = (ref: string, matches: string[]) => {
    if (fileMime === 'image' && fileContent) URL.revokeObjectURL(fileContent);
    setSelectedFile(null);
    setFileContent(null);
    setFileArrayBuffer(null);
    setFileMime(null);
    setFileError(null);
    setFileLoading(false);
    resetEdit();
    setShowSettings(false);
    setFilterType('All');
    setSearchQuery(basename(ref));
    setExtraMatches(matches);
    setMissedRef(ref);
    if (targetDirectory) onTargetDirHandled?.();
  };

  /**
   * Open a file reference that may not name a real path. Certain matches
   * open at once; otherwise the server's lookup decides between opening the
   * file it names and landing on the tree filtered to the name.
   */
  const openFileRef = async (
    rawRef: string,
    { fromFile = null, location = null }: { fromFile?: string | null; location?: FileLocation | null } = {},
  ) => {
    const candidates = fromFile ? linkCandidates(rawRef, fromFile) : [normalizeRefPath(rawRef)];
    const primary = candidates[0];
    if (!primary) return;
    if (hasUnsavedChanges && !window.confirm(t('filePanel.discardUnsaved'))) return;
    resetEdit();
    dropLanding();
    const openAt = (path: string) => {
      fileFocus.focusAt(path, location);
      return handleFileClick(path);
    };
    const tried = new Set<string>();
    // Resolves true once the path opened (or failed for a reason a search cannot fix).
    // A stopped workspace reports a missing path as not backed up.
    const landed = async (path: string) => {
      // A download-only file opens with no read, so opening one proves nothing
      // about the path: a moved .docx would sit behind a download card built on
      // a name the listing still remembers. Only the lookup settles it.
      if (resolveFileFn && DOWNLOAD_ONLY_EXTENSIONS.has(getFileExtension(path))) return false;
      tried.add(path);
      const category = (await openAt(path))?.category;
      return category !== 'not_found' && category !== 'not_backed_up';
    };
    const writes = getRecentWritePaths?.() ?? [];

    // A known path can still be stale (the agent moved it), so a miss falls through to the lookup.
    const exact = resolveExact(candidates, files, writes);
    if (exact && await landed(exact)) return;
    // Absolute and system paths are not in the default listing, and the agent
    // names them exactly (tool rows, skill files), so read them first. A
    // system-looking path can still be a folder inside the work tree.
    const direct = candidates.find((c) => c.startsWith('/') || isSystemPath(c));
    if (direct && !tried.has(direct) && await landed(direct)) return;
    if (!resolveFileFn) {
      if (!tried.has(primary)) void openAt(primary);
      return;
    }

    const seq = ++openSeqRef.current;
    setSelectedFile(primary);
    setFileContent(null);
    setFileArrayBuffer(null);
    setFileMime(null);
    setFileError(null);
    setFileLoading(true);
    let result: FileRefResolution | null = null;
    try {
      result = await resolveFileFn(candidates, writes);
    } catch (err) {
      console.error('[FilePanel] File reference lookup failed:', err);
    }
    if (seq !== openSeqRef.current) return;

    // With no answer (sandbox starting, request failed), reading the path as
    // written shows why, with a retry.
    if (!result || result.status === 'unavailable') return void openAt(primary);
    if (result.status === 'resolved' && result.path) return void openAt(result.path);
    // Name the reference as written; the joined reading is only our guess.
    landOnSearch(candidates[candidates.length - 1], result.matches);
  };

  // Links inside a viewed file resolve against that file's directory first.
  // Stable identity: Markdown memoizes its renderers on this handler.
  const handleViewerLink = useStableHandler((path: string, linkWorkspaceId?: string, location?: FileLocation) => {
    const otherWorkspace = !!linkWorkspaceId && linkWorkspaceId !== workspaceId;
    // Memory and memo entries live outside the sandbox and open in their own tabs.
    if (otherWorkspace || classifyAgentPath(path).kind !== 'file') {
      // Resolving here would open a namesake from the wrong place.
      onOpenFile?.(path, linkWorkspaceId, location);
      return;
    }
    void openFileRef(path, { fromFile: selectedFile, location });
  });

  // `[Valuation](#valuation)` inside the open file moves within it, no reload.
  const handleAnchorLink = useStableHandler((fragment: string) => {
    if (selectedFile) fileFocus.focusAt(selectedFile, parseFragment(fragment));
  });

  // Every save this panel offers comes from one of the two handlers below, and
  // both are undefined when the share forbids saving. Reading the permission
  // once here is what stops the next affordance from shipping without it: the
  // menu, the binary-file error, four viewer error boundaries and the HTML
  // fullscreen bar were nine copies of the same call before.
  const handleDownloadSelected = canDownload
    ? () => {
        if (!selectedFile) return;
        triggerDownloadFn(workspaceId, selectedFile).catch((err: unknown) => {
          console.error('[FilePanel] Download failed:', err);
          setFileError(categorizeFileError(err, wsData?.status));
        });
      }
    : undefined;

  // The same save from inside a viewer's error boundary. That fallback is
  // already reporting a failure, so this one only logs: raising `fileError`
  // would replace the thing the reader is looking at with a second error.
  const handleDownloadInFallback = canDownload
    ? () => {
        if (!selectedFile) return;
        void triggerDownloadFn(workspaceId, selectedFile).catch((err: unknown) =>
          console.error('[FilePanel] Download failed:', err));
      }
    : undefined;

  const clearSearch = () => {
    setSearchQuery('');
    setMissedRef(null);
    setExtraMatches([]);
  };

  const selectedExt = selectedFile ? getFileExtension(selectedFile.split('/').pop() || '') : '';
  const canEdit = !!(selectedFile
    && !readOnly
    && !fileError
    && EDITABLE_EXTENSIONS.has(selectedExt)
    && fileMime !== 'image'
    && fileMime !== 'pdf'
    && fileMime !== 'excel'
    && !['html', 'htm'].includes(selectedExt)
    && !selectedFile.startsWith('/large_tool_results/'));

  const handleBack = () => {
    // In single-file mode, back closes the panel instead of returning to file tree
    if (singleFileMode) {
      onClose();
      return;
    }
    if (hasUnsavedChanges) {
      if (!window.confirm(t('filePanel.discardUnsaved'))) return;
    }
    // A reference search still pending must not reopen the file just left.
    openSeqRef.current += 1;
    if (fileMime === 'image' && fileContent) {
      URL.revokeObjectURL(fileContent);
    }
    setSelectedFile(null);
    setFileContent(null);
    setFileArrayBuffer(null);
    setFileMime(null);
    setFileError(null);
    setExportModalOpen(false);
    resetEdit();
  };

  const fileName = selectedFile?.split('/').pop() || '';

  // The JSX return is very large. Due to its size and the fact that it is
  // purely template code with no logic changes, we keep it identical to the
  // original JS version. TypeScript inference handles the JSX elements.
  return (
    <div className="file-panel">
      {/* Header */}
      <div className="file-panel-header">
        <div className="flex items-center gap-2 min-w-0">
          {showSettings ? (
            <button onClick={() => setShowSettings(false)} className="file-panel-icon-btn" title={t('filePanel.backToFileList')}>
              <ArrowLeft className="h-4 w-4" />
            </button>
          ) : selectedFile ? (
            <button onClick={handleBack} className="file-panel-icon-btn" title={t('filePanel.backToFileList')}>
              <ArrowLeft className="h-4 w-4" />
            </button>
          ) : targetDirectory ? (
            <button onClick={() => onTargetDirHandled?.()} className="file-panel-icon-btn" title={t('filePanel.backToAllFiles')}>
              <ArrowLeft className="h-4 w-4" />
            </button>
          ) : isMobile && !hideClose ? (
            <button onClick={onClose} className="file-panel-icon-btn" title={t('filePanel.close')}>
              <ArrowLeft className="h-4 w-4" />
            </button>
          ) : null}
          <span className="text-sm font-semibold truncate" style={{ color: 'var(--color-text-primary)' }}>
            {showSettings ? t('chat.workspaceSettings') : selectedFile ? (<>{fileName}{hasUnsavedChanges && <span style={{ color: 'var(--color-text-tertiary)' }}> *</span>}</>) : targetDirectory ? `${targetDirectory}/` : t('chat.workspaceFiles')}
          </span>
          {!showSettings && fileFocus.chip && (
            <FocusChip state={fileFocus.chip} onJump={fileFocus.jump} onDismiss={fileFocus.dismiss} />
          )}
        </div>
        <div className="flex items-center gap-1">
          {!showSettings && !selectedFile && !selectMode && (
            <>
              {!readOnly && files.length > 0 && (
                <button
                  onClick={() => setSelectMode(true)}
                  className="file-panel-icon-btn"
                  title={t('filePanel.selectFiles')}
                >
                  <CheckSquare className="h-4 w-4" />
                </button>
              )}
              {!readOnly && (
                <>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="file-panel-icon-btn"
                    title={t('filePanel.uploadFile')}
                    disabled={uploadProgress !== null}
                  >
                    <Upload className="h-4 w-4" />
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    onChange={handleFileInputChange}
                  />
                  <button
                    onClick={handleBackup}
                    className="file-panel-icon-btn"
                    title={t('filePanel.backupFiles')}
                    disabled={backingUp}
                  >
                    <HardDrive className={`h-4 w-4 ${backingUp ? 'animate-pulse' : ''}`} />
                  </button>
                </>
              )}
              {!readOnly && (
                <button
                  onClick={onRefreshFiles}
                  className="file-panel-icon-btn"
                  title={t('filePanel.refresh')}
                >
                  {filesLoading
                    ? <Loader size={16} className="text-current" />
                    : <RefreshCw className="h-4 w-4" />}
                </button>
              )}
            </>
          )}
          {!readOnly && !selectedFile && selectMode && (
            <>
              <span className="text-xs" style={{ color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                {selectedPaths.size} selected
              </span>
              <button
                onClick={toggleSelectAll}
                className="file-panel-chip"
                style={{ marginLeft: 2, fontSize: '0.625rem', padding: '1px 6px' }}
              >
                {selectedPaths.size === filteredSortedFiles.length ? 'Deselect All' : 'Select All'}
              </button>
              {deleteConfirm ? (
                <button
                  onClick={handleDelete}
                  className="file-panel-delete-confirm-btn"
                  disabled={deleteLoading}
                >
                  Delete {selectedPaths.size}?
                </button>
              ) : (
                <button
                  onClick={handleDelete}
                  className="file-panel-icon-btn"
                  title={t('filePanel.deleteSelected')}
                  disabled={selectedPaths.size === 0 || deleteLoading}
                  style={selectedPaths.size > 0 ? { color: 'var(--color-icon-danger)' } : undefined}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
              <button onClick={exitSelectMode} className="file-panel-icon-btn" title={t('filePanel.cancelSelection')}>
                <X className="h-4 w-4" />
              </button>
            </>
          )}
          <FileHeaderActions
            selectedFile={selectedFile}
            isEditing={isEditing}
            workspaceId={workspaceId}
            fileContent={fileContent}
            fileMime={fileMime}
            canEdit={canEdit}
            onStartEdit={handleStartEdit}
            onOpenExportModal={() => setExportModalOpen(true)}
            triggerDownloadFn={triggerDownloadFn}
            canDownload={canDownload}
            readFileFullFn={readFileFullFn}
            htmlServedUrl={selectedFile ? apiAdapter?.buildServedUrl?.(selectedFile) : undefined}
            editorRef={editorRef}
            canUndo={canUndo}
            canRedo={canRedo}
            hasUnsavedChanges={hasUnsavedChanges}
            showDiff={showDiff}
            setShowDiff={setShowDiff}
            isSaving={isSaving}
            saveError={saveError}
            onSave={handleSave}
            onCancelEdit={handleCancelEdit}
          />
          {!selectMode && !isEditing && !hideClose && (
            <button onClick={onClose} className="file-panel-icon-btn" title={t('filePanel.close')}>
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Upload progress bar */}
      {uploadProgress !== null && (
        <div className="file-panel-upload-progress">
          <div className="file-panel-upload-progress-bar" style={{ width: `${uploadProgress}%` }} />
        </div>
      )}

      {uploadError && (
        <div className="file-panel-upload-error">
          <span>{uploadError}</span>
          <button onClick={() => setUploadError(null)} className="file-panel-icon-btn">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {deleteLoading && <div className="file-panel-progress-indeterminate" />}

      {deleteError && (
        <div className="file-panel-upload-error">
          <span>{deleteError}</span>
          <button onClick={() => setDeleteError(null)} className="file-panel-icon-btn">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {backupResult && (
        <div className={`file-panel-backup-result ${backupResult.error ? 'error' : ''}`}>
          <span>
            {backupResult.error
              ? backupResult.error
              : `Backed up ${backupResult.synced} file${backupResult.synced !== 1 ? 's' : ''}${backupResult.skipped ? `, ${backupResult.skipped} unchanged` : ''}`}
          </span>
          <button onClick={() => setBackupResult(null)} className="file-panel-icon-btn" style={{ padding: 2 }}>
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {backingUp && <div className="file-panel-progress-indeterminate" />}

      {isEditing && (
        <div className="file-panel-edit-hint">
          <Pencil className="h-3 w-3" style={{ flexShrink: 0 }} />
          <span>{t('filePanel.editingHint')}</span>
        </div>
      )}


      {/* Search + the note a missed reference lands with */}
      {!showSettings && !selectedFile && !selectMode && (listedFiles.length > 0 || missedRef) && (
        <div className="file-panel-search">
          {/* The pill answers for the field inside it, twice over: `rings-within`
              draws the keyboard ring on its behalf, and `owns-its-edge` moves
              the focused-field accent edge onto the pill's own border. Without
              the second, the borderless input keeps the edge rule's 1px halo
              and paints a faint rectangle inside a box already lit. Both rules
              live in tokens.css. */}
          <div
            className="rings-within owns-its-edge flex items-center gap-1.5 h-8 px-2 rounded-md border"
            style={{ backgroundColor: 'var(--color-bg-input)', borderColor: 'var(--color-border-muted)' }}
          >
            <Search className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--color-text-tertiary)' }} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setMissedRef(null); }}
              onKeyDown={(e) => { if (e.key === 'Escape' && searchQuery) { e.stopPropagation(); clearSearch(); } }}
              placeholder={t('filePanel.searchFiles')}
              aria-label={t('filePanel.searchFiles')}
              className="flex-1 min-w-0 text-base sm:text-xs bg-transparent border-none"
              style={{ color: 'var(--color-text-primary)' }}
            />
            {searchQuery && (
              <button type="button" onClick={clearSearch} className="file-panel-icon-btn" title={t('filePanel.clearSearch')} aria-label={t('filePanel.clearSearch')} style={{ margin: '-0.25rem' }}>
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          {missedRef && (
            <p className="mt-1.5 text-xs break-all" style={{ color: 'var(--color-text-secondary)' }}>
              {extraMatches.length > 1
                ? t('filePanel.refAmbiguous', { path: missedRef })
                : t('filePanel.refNotFound', { path: missedRef })}
            </p>
          )}
        </div>
      )}

      {/* Filter & Sort toolbar */}
      {!showSettings && !selectedFile && !filesLoading && !filesError && listedFiles.length > 0 && (
        <div className="file-panel-toolbar">
          <div className="file-panel-filter-chips">
            <button className={`file-panel-chip ${filterType === 'All' ? 'active' : ''}`} onClick={() => setFilterType('All')}>
              All
            </button>
            {availableTypes.map((tp) => (
              <button
                key={tp}
                className={`file-panel-chip ${filterType === tp ? 'active' : ''}`}
                onClick={() => setFilterType(filterType === tp ? 'All' : tp)}
              >
                {tp}
              </button>
            ))}
          </div>
          {onToggleSystemFiles && (
            <button
              className={`file-panel-chip ${showSystemFiles ? 'active' : ''}`}
              onClick={onToggleSystemFiles}
              title="Show system directories (.agents/, .system/, tools/, etc.)"
            >
              System
            </button>
          )}
          <div className="file-panel-sort-wrapper" ref={sortMenuRef}>
            <button className="file-panel-icon-btn" title={t('filePanel.sortFiles')} onClick={() => setShowSortMenu((v) => !v)}>
              <ArrowUpDown className="h-3.5 w-3.5" />
            </button>
            {showSortMenu && (
              <div className="file-panel-sort-menu">
                {SORT_OPTIONS.map((opt) => (
                  <div
                    key={opt.value}
                    className={`file-panel-sort-item ${sortBy === opt.value ? 'active' : ''}`}
                    onClick={() => { setSortBy(opt.value); setShowSortMenu(false); }}
                  >
                    {opt.label}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Workspace settings card */}
      {!showSettings && !selectedFile && !readOnly && !isFlashWorkspace && !selectMode && (
        <div
          className="flex items-center justify-between mx-3 mt-2 mb-1 px-3 py-2 rounded-lg cursor-pointer transition-colors hover:opacity-80"
          style={{ backgroundColor: 'var(--color-bg-card)', border: '1px solid var(--color-border-muted)' }}
          onClick={() => setShowSettings(true)}
        >
          <span className="text-xs truncate" style={{ color: 'var(--color-text-secondary)' }}>
            {workspaceName || t('thread.workspace')}
          </span>
          <Settings className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--color-text-tertiary)' }} />
        </div>
      )}

      {/* Inline settings view */}
      {showSettings ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: '0 12px 12px' }}>
          <SandboxSettingsContent workspaceId={workspaceId} />
        </div>
      ) : (
      /* Content */
      <div
        className="file-panel-content-wrapper"
        onDragEnter={!readOnly && !selectedFile ? handleDragEnter : undefined}
        onDragLeave={!readOnly && !selectedFile ? handleDragLeave : undefined}
        onDragOver={!readOnly && !selectedFile ? handleDragOver : undefined}
        onDrop={!readOnly && !selectedFile ? handleDrop : undefined}
        style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' }}
      >
        {!readOnly && isDragOver && !selectedFile && (
          <div className="file-panel-drag-overlay">
            <Upload className="h-8 w-8" style={{ color: 'var(--color-accent-primary)' }} />
            <span>Drop file to upload</span>
          </div>
        )}

        {/* font-content only while viewing a file: the reading surface gets the
            content face, the file tree stays on the UI font. */}
        <div className={`file-panel-content${selectedFile ? ' font-content' : ''}`} ref={contentWrapperRef}>
          {selectionTooltip && onAddContext && (
            <div
              className="file-panel-selection-tooltip"
              style={{ left: Math.max(8, selectionTooltip.x - 60), top: Math.max(4, selectionTooltip.y - 32) }}
              onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); handleAddSelectionContext(); }}
            >
              <TextSelect className="h-3.5 w-3.5" style={{ color: 'var(--color-accent-primary)' }} />
              {selectionTooltip.lineStart != null
                ? (selectionTooltip.lineEnd !== selectionTooltip.lineStart
                    ? t('context.addLinesToContext', { start: selectionTooltip.lineStart, end: selectionTooltip.lineEnd })
                    : t('context.addLineToContext', { line: selectionTooltip.lineStart }))
                : t('context.addToContext')}
            </div>
          )}

          {contextMenu && (
            <div
              className="file-panel-context-menu"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
            >
              {onAddContext && (
                <div className="file-panel-context-menu-item" onClick={() => handleContextMenuAction('add-context', contextMenu.filePath)}>
                  <TextSelect className="h-3.5 w-3.5" style={{ color: 'var(--color-text-tertiary)' }} />
                  {t('context.addToContext')}
                </div>
              )}
              {memoMimeForName(contextMenu.filePath) && (
                <div className="file-panel-context-menu-item" onClick={() => handleContextMenuAction('add-to-memo', contextMenu.filePath)}>
                  {memoedMap.has(contextMenu.filePath) ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5" style={{ color: 'var(--color-text-tertiary)' }} />
                      {t('context.syncWithMemo')}
                    </>
                  ) : (
                    <>
                      <ScrollText className="h-3.5 w-3.5" style={{ color: 'var(--color-text-tertiary)' }} />
                      {t('context.addToMemo')}
                    </>
                  )}
                </div>
              )}
              <div className="file-panel-context-menu-item" onClick={() => handleContextMenuAction('open', contextMenu.filePath)}>
                <FolderOpen className="h-3.5 w-3.5" style={{ color: 'var(--color-text-tertiary)' }} />
                {t('context.openFile')}
              </div>
            </div>
          )}

          {selectedFile ? (
            <>
              {memoEntryForSelected && (
                <MemoStaleBanner
                  status={memoStaleStatus}
                  syncing={memoSyncing}
                  onSwitchToMemoTab={onSwitchToMemoTab}
                  onSync={handleSyncMemo}
                  onViewDiff={memoStaleSandboxText !== null ? handleViewMemoDiff : null}
                />
              )}
              {fileLoading ? (
              <div className="p-4">
                <div className="flex items-center justify-center py-12">
                  <Loader size={20} className="text-[color:var(--color-text-tertiary)]" />
                </div>
              </div>
            ) : fileError ? (
              <FileErrorDisplay
                error={fileError}
                onRetry={() => handleFileClick(selectedFile)}
                onDownload={handleDownloadSelected}
              />
            ) : fileMime === 'pdf' ? (
              <Suspense fallback={<DocumentLoadingFallback />}>
                <DocumentErrorBoundary fallback={<DocumentErrorFallback onDownload={handleDownloadInFallback} />}>
                  <PdfViewer data={fileArrayBuffer!} focusPage={fileFocus.focusPage} focusSeq={fileFocus.seq} onPageCount={setPdfPageCount} />
                </DocumentErrorBoundary>
              </Suspense>
            ) : fileMime === 'excel' ? (
              <Suspense fallback={<DocumentLoadingFallback />}>
                <DocumentErrorBoundary fallback={<DocumentErrorFallback onDownload={handleDownloadInFallback} />}>
                  <ExcelViewer data={fileArrayBuffer!} />
                </DocumentErrorBoundary>
              </Suspense>
            ) : getFileExtension(selectedFile) === 'csv' ? (
              isEditing ? (
                <div className="file-panel-editor-container">
                  <Suspense fallback={<DocumentLoadingFallback />}>
                    <CodeEditor value={editContent ?? undefined} onChange={handleEditorChange} fileName={selectedFile} diffMode={showDiff} originalValue={originalContent ?? undefined} editorRef={editorRef} onUndoRedoChange={handleUndoRedoChange} onTextSelect={onAddContext ? handleEditorTextSelect : undefined} />
                  </Suspense>
                </div>
              ) : (
                <Suspense fallback={<DocumentLoadingFallback />}>
                  <DocumentErrorBoundary fallback={<DocumentErrorFallback onDownload={handleDownloadInFallback} />}>
                    <CsvViewer content={fileContent ?? ''} />
                  </DocumentErrorBoundary>
                </Suspense>
              )
            ) : ['html', 'htm'].includes(getFileExtension(selectedFile)) ? (
              <Suspense fallback={<DocumentLoadingFallback />}>
                <DocumentErrorBoundary fallback={<DocumentErrorFallback onDownload={handleDownloadInFallback} />}>
                  <HtmlViewer
                    content={fileContent ?? ''}
                    fileName={fileName}
                    workspaceId={workspaceId}
                    filePath={selectedFile}
                    servedUrlOverride={apiAdapter?.buildServedUrl?.(selectedFile, { injectTheme: true })}
                    anchor={fileFocus.htmlAnchor}
                    anchorSeq={fileFocus.seq}
                    onCopyShareLink={onCopyShareLink ?? undefined}
                    onTriggerDownload={handleDownloadInFallback}
                  />
                </DocumentErrorBoundary>
              </Suspense>
            ) : isEditing ? (
              <div className="file-panel-editor-container">
                <Suspense fallback={<DocumentLoadingFallback />}>
                  <CodeEditor value={editContent ?? undefined} onChange={handleEditorChange} fileName={selectedFile} diffMode={showDiff} originalValue={originalContent ?? undefined} editorRef={editorRef} onUndoRedoChange={handleUndoRedoChange} onTextSelect={onAddContext ? handleEditorTextSelect : undefined} />
                </Suspense>
              </div>
            ) : (
              <div className="p-4" onMouseUp={handleContentMouseUp}>
                {fileMime === 'image' ? (
                  <>
                    <img src={fileContent!} alt={fileName} className="max-w-full rounded cursor-pointer" onClick={() => setImageLightboxOpen(true)} />
                    <ImageLightbox src={fileContent!} alt={fileName} open={imageLightboxOpen} onClose={() => setImageLightboxOpen(false)} />
                  </>
                ) : selectedFile?.startsWith('/large_tool_results/') ? (
                  <div className="markdown-print-content">
                    <Markdown variant="panel" content={stripLineNumbers(fileContent) ?? ''} className="text-sm" />
                  </div>
                ) : fileMime?.includes('markdown') || getFileExtension(selectedFile) === 'md' ? (
                  <div className="markdown-print-content">
                    <Markdown variant="panel" content={fileContent ?? ''} className="text-sm" onOpenFile={handleViewerLink} onAnchorLink={handleAnchorLink} />
                  </div>
                ) : (
                  <SyntaxHighlighter
                    language={EXT_TO_LANG[getFileExtension(selectedFile)] || 'text'}
                    style={typeof window !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light' ? oneLight : oneDark}
                    customStyle={{ margin: 0, padding: 0, backgroundColor: 'transparent', fontSize: '0.75rem', lineHeight: '1.6' }}
                    codeTagProps={{ style: { backgroundColor: 'transparent' } }}
                    showLineNumbers
                    lineNumberStyle={{ minWidth: '2.5em', paddingRight: '1em', color: 'var(--color-text-tertiary)', userSelect: 'none', fontSize: '0.6875rem', opacity: 0.5 }}
                    wrapLines
                    lineProps={(lineNumber: number) => {
                      const range = fileFocus.lineRange;
                      const focused = !!range && lineNumber >= range[0] && lineNumber <= range[1];
                      return { 'data-line': lineNumber, ...(focused ? { className: 'file-focus-line' } : {}) } as React.HTMLProps<HTMLElement>;
                    }}
                    wrapLongLines
                  >
                    {fileContent!}
                  </SyntaxHighlighter>
                )}
              </div>
            )}
            </>
          ) : (
            <div className="py-1 file-tree-root">
              {filesLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="file-panel-item animate-pulse">
                    <div className="h-4 w-4 rounded" style={{ backgroundColor: 'var(--color-border-muted)' }} />
                    <div className="h-4 flex-1 rounded" style={{ backgroundColor: 'var(--color-border-muted)', width: `${50 + i * 10}%` }} />
                  </div>
                ))
              ) : filesError ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-sm" style={{ color: 'var(--color-text-tertiary)' }}>{filesError}</p>
                </div>
              ) : listedFiles.length === 0 && !trimmedQuery ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-sm" style={{ color: 'var(--color-text-tertiary)' }}>No files yet</p>
                </div>
              ) : filteredSortedFiles.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-sm" style={{ color: 'var(--color-text-tertiary)' }}>
                    {trimmedQuery ? t('filePanel.noSearchMatches') : `No ${filterType.toLowerCase()} files`}
                  </p>
                </div>
              ) : (
                fileTree.map((node) => (
                  <DirectoryNode
                    key={node.fullPath}
                    node={node}
                    depth={0}
                    showHeader={node.name !== '/'}
                    expandedDirs={visibleExpandedDirs}
                    toggleDir={toggleDir}
                    selectMode={selectMode}
                    selectedPaths={selectedPaths}
                    toggleSelect={toggleSelect}
                    toggleDirSelect={toggleDirSelect}
                    handleFileClick={handleFileClick}
                    readOnly={readOnly}
                    backedUpSet={backedUpSet}
                    modifiedSet={modifiedSet}
                    memoedMap={memoedMap}
                    memoedTitle={memoedTitle}
                    onAddContext={onAddContext}
                    setContextMenu={setContextMenu}
                    activeContextPath={contextMenu?.filePath ?? null}
                  />
                ))
              )}
            </div>
          )}
        </div>
      </div>
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
      {selectedFile && memoEntryForSelected && memoStaleSandboxText !== null && (
        <MemoDiffModal
          open={memoDiffOpen}
          memoKey={memoEntryForSelected.key}
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
