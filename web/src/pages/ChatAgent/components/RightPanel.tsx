import React, { Suspense, useCallback, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AnimatedTabs } from '@/components/ui/animated-tabs';
import { isFilesPanelKind, type ChartTabSpec, type ContextPayload, type FilesPanelKind, type PanelTarget } from './filePanel/types';
import type { OpenFileHandler } from '../utils/fileLocation';
import type { WriteEvent } from '../utils/fileRefResolver';
import type { MarketWatchState } from '../hooks/utils/streamEventHandlers';
import type { ProvenanceRecord } from '@/types/chat';

const FilePanel = React.lazy(() => import('./FilePanel'));
const MemoryPanel = React.lazy(() => import('./MemoryPanel'));
const MemoPanel = React.lazy(() => import('./MemoPanel'));
const SourcesPanel = React.lazy(() => import('./SourcesPanel'));
const StatusPanel = React.lazy(() => import('./StatusPanel'));

export type { PanelTarget };

export type RightPanelTab = 'files' | 'memory' | 'memo' | 'sources' | 'status';

/** The tab that owns each kind the Files panel does not; `FILES_PANEL_KINDS` covers the rest. */
const OTHER_KIND_TO_TAB: Record<Exclude<PanelTarget['kind'], FilesPanelKind>, RightPanelTab> = {
  memory: 'memory',
  memo: 'memo',
  sources: 'sources',
  status: 'status',
};

/** The tab that owns a target kind; a null target leaves the tab where it is. */
function tabForKind(kind: PanelTarget['kind']): RightPanelTab {
  return isFilesPanelKind(kind) ? 'files' : OTHER_KIND_TO_TAB[kind];
}

interface RightPanelProps {
  workspaceId: string;
  /** The open conversation, which owns the file panel's tab strip. */
  threadId?: string | null;
  onClose: () => void;
  /** Mirrors the Files panel's unsaved state up to whoever can unmount this panel. */
  onDirtyChange?: ((dirty: boolean) => void) | null;
  /** The panel's current target (file/preview/chart/memory/memo/sources/status), or null. */
  panelTarget?: PanelTarget | null;
  /** The Files panel consumed a file, preview or chart target. */
  onTargetHandled?: () => void;
  onTargetMemoryHandled?: () => void;
  onTargetMemoHandled?: () => void;
  /** Leaves the panel for the full MarketView page on a chart tab's symbol. */
  onOpenInMarketView?: ((spec: ChartTabSpec) => void) | null;
  /** Live provenance records for the targeted message (keyed by record id). */
  sourcesRecords?: Record<string, ProvenanceRecord>;
  /** Provenance records merged across every turn in the thread (keyed by record
   * id). Powers the Sources panel's "All sources" scope. */
  allSourcesRecords?: Record<string, ProvenanceRecord>;
  /** Live market-watch snapshot rendered by the Status tab. */
  marketWatch?: MarketWatchState | null;
  /** Routes a clicked file/memory/memo path through ChatView's path-aware
   * router. Lets in-panel markdown links (e.g., a sibling memory entry
   * referenced from memory.md) jump to the right tab + entry. */
  onOpenFile?: OpenFileHandler;
  /** This thread's Write/Edit paths, newest first; read when a file reference
   * has to be resolved. */
  getRecentWritePaths?: () => string[];
  /** Every Write/Edit in the thread, newest first; what marks an open tab changed. */
  getWriteLog?: () => WriteEvent[];
  files?: string[];
  filesLoading?: boolean;
  filesError?: string | null;
  onRefreshFiles?: () => void;
  onAddContext?: ((ctx: ContextPayload) => void) | null;
  showSystemFiles?: boolean;
  onToggleSystemFiles?: (() => void) | null;
  readOnly?: boolean;
  singleFileMode?: boolean;
  /** False for a panel that browses on the side of a conversation, so what it
   *  opens is never written over the workspace's own tab strip. */
  persistTabs?: boolean;
  /** Initial tab — callers can deep-link into the Memory tab once it stabilizes. */
  initialTab?: RightPanelTab;
  /** Copy a shareable link to an HTML report (authenticated app only). */
  onCopyShareLink?: ((filePath: string) => void) | null;
}

export default function RightPanel({
  workspaceId,
  threadId = null,
  onClose,
  onDirtyChange,
  panelTarget = null,
  onTargetHandled,
  onTargetMemoryHandled,
  onTargetMemoHandled,
  onOpenInMarketView = null,
  sourcesRecords,
  allSourcesRecords,
  marketWatch,
  onOpenFile,
  getRecentWritePaths,
  getWriteLog,
  files,
  filesLoading,
  filesError,
  onRefreshFiles,
  onAddContext,
  showSystemFiles,
  onToggleSystemFiles,
  readOnly,
  singleFileMode,
  persistTabs = true,
  initialTab = 'files',
  onCopyShareLink,
}: RightPanelProps): React.ReactElement {
  const { t } = useTranslation();
  const [tab, setTab] = useState<RightPanelTab>(initialTab);
  const watchSymbolCount = marketWatch?.symbols?.length ?? 0;

  // The Files panel holds its drafts in memory, so closing the panel or
  // leaving for another tab throws away an unsaved edit the same way closing
  // one file tab does, and asks the same question. It goes back to false when
  // the panel unmounts, so only a live Files tab can raise it.
  const [filesDirty, setFilesDirty] = useState(false);
  const handleDirtyChange = useCallback((dirty: boolean) => {
    setFilesDirty(dirty);
    onDirtyChange?.(dirty);
  }, [onDirtyChange]);
  const mayLeaveFiles = useCallback(
    () => !filesDirty || window.confirm(t('filePanel.discardUnsaved')),
    [filesDirty, t],
  );

  const handleClose = useCallback(() => {
    if (mayLeaveFiles()) onClose();
  }, [mayLeaveFiles, onClose]);

  const handleTabChange = useCallback((id: RightPanelTab) => {
    if (id === tab) return;
    if (tab === 'files' && !mayLeaveFiles()) return;
    setTab(id);
  }, [tab, mayLeaveFiles]);

  // The Files panel reads the target itself; Memory and Memo take their keys.
  // Exactly one kind is ever set, so these are mutually exclusive by construction.
  const kind = panelTarget?.kind;
  const targetMemoryKey = panelTarget?.kind === 'memory' ? panelTarget.key : null;
  const targetMemoryTier = panelTarget?.kind === 'memory' ? panelTarget.tier : null;
  const targetMemoKey = panelTarget?.kind === 'memo' ? panelTarget.key : null;

  const tabs = useMemo<{ id: RightPanelTab; label: string }[]>(
    () => {
      const base: { id: RightPanelTab; label: string }[] = [
        { id: 'files', label: t('rightPanel.tabs.files') },
        { id: 'memory', label: t('rightPanel.tabs.memory') },
        { id: 'memo', label: t('rightPanel.tabs.memo') },
      ];
      // The Status tab surfaces the live market watch. Unlike Sources it also
      // shows whenever a watch is active (symbols present) — so a user who
      // opened Files by hand can still reach it — as well as on an explicit
      // chip click (a 'status' target).
      if (kind === 'status' || watchSymbolCount > 0) {
        base.push({ id: 'status', label: t('rightPanel.tabs.status') });
      }
      // The Sources tab is per-turn — only surface it when a turn's provenance
      // is being shown, so the chrome stays unchanged for file/memory/memo flows.
      if (kind === 'sources') {
        base.push({ id: 'sources', label: t('rightPanel.tabs.sources') });
      }
      return base;
    },
    [t, kind, watchSymbolCount],
  );

  // Snap to the tab that owns the current target. Keyed on the target object,
  // not just its kind, so re-asking for the same kind snaps back too. Leaving
  // Files asks the same question a tab click does; a declined one-shot target
  // is consumed, or the next visit to its tab would land it unasked.
  React.useEffect(() => {
    if (!kind) return;
    const next = tabForKind(kind);
    if (next !== 'files' && tab === 'files' && !mayLeaveFiles()) {
      if (kind === 'memory') onTargetMemoryHandled?.();
      else if (kind === 'memo') onTargetMemoHandled?.();
      return;
    }
    setTab(next);
  }, [panelTarget, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // The Status/Sources tabs are conditional (see `tabs`). If the current tab
  // disappears — Status when its target clears with no active watch, Sources
  // when its target clears — fall back to Files so `tab` always resolves.
  React.useEffect(() => {
    if (tab === 'status' && kind !== 'status' && watchSymbolCount === 0) setTab('files');
    else if (tab === 'sources' && kind !== 'sources') setTab('files');
  }, [tab, kind, watchSymbolCount]);

  return (
    <div
      className="flex flex-col h-full"
      style={{
        backgroundColor: 'var(--color-bg-page)',
        borderLeft: '1px solid var(--color-border-muted)',
      }}
    >
      {/* Tab chrome — shared across all three panels */}
      <div
        className="flex items-center justify-between px-3 py-2 border-b flex-shrink-0"
        style={{ borderColor: 'var(--color-border-muted)' }}
      >
        <AnimatedTabs
          tabs={tabs}
          value={tab}
          onChange={(id) => handleTabChange(id as RightPanelTab)}
          layoutId="right-panel-tabs"
        />
        <button
          onClick={handleClose}
          className="file-panel-icon-btn"
          title={t('rightPanel.close')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Tab body */}
      <div className="flex-1 min-h-0">
        <Suspense fallback={null}>
          {tab === 'files' && (
            <FilePanel
              workspaceId={workspaceId}
              threadId={threadId}
              onClose={onClose}
              onDirtyChange={handleDirtyChange}
              target={panelTarget}
              onTargetHandled={onTargetHandled}
              onOpenInMarketView={onOpenInMarketView}
              onOpenFile={onOpenFile}
              getRecentWritePaths={getRecentWritePaths}
              getWriteLog={getWriteLog}
              files={files}
              filesLoading={filesLoading}
              filesError={filesError}
              onRefreshFiles={onRefreshFiles}
              onAddContext={onAddContext}
              showSystemFiles={showSystemFiles}
              onToggleSystemFiles={onToggleSystemFiles}
              readOnly={readOnly}
              singleFileMode={singleFileMode}
              persistTabs={persistTabs}
              hideClose
              onSwitchToMemoTab={() => handleTabChange('memo')}
              onCopyShareLink={onCopyShareLink}
            />
          )}
          {tab === 'memory' && (
            <MemoryPanel
              workspaceId={workspaceId}
              targetKey={targetMemoryKey ?? null}
              targetTier={targetMemoryTier ?? null}
              onTargetHandled={onTargetMemoryHandled}
              onOpenFile={onOpenFile}
            />
          )}
          {tab === 'memo' && (
            <MemoPanel
              targetKey={targetMemoKey ?? null}
              onTargetHandled={onTargetMemoHandled}
              onOpenFile={onOpenFile}
            />
          )}
          {tab === 'status' && <StatusPanel marketWatch={marketWatch} />}
          {tab === 'sources' && (
            <SourcesPanel
              provenanceRecords={sourcesRecords}
              allRecords={allSourcesRecords}
              onOpenFile={onOpenFile}
            />
          )}
        </Suspense>
      </div>
    </div>
  );
}
