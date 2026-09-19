import React, { useCallback, useRef } from 'react';
import { ArrowLeft, CandlestickChart, FolderOpen, Globe, PanelRight, Plus, Settings, X, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { fileGlyph } from './fileMeta';
import type { FileTab } from './useFileTabs';
import './TabStrip.css';

interface TabStripProps {
  tabs: FileTab[];
  activeId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onPin: (id: string) => void;
  /** Null where an empty tab would offer nothing: a read-only or single-file panel. */
  onNewTab: (() => void) | null;
  /** The file changed under this tab since it last read it: the amber dot. */
  hasChanged: (path: string) => boolean;
  treeOpen: boolean;
  /** Null where the panel is locked to one file and has no tree to show. */
  onToggleTree: (() => void) | null;
  /** The panel's own close, where the surface around it does not own one. */
  onPanelClose: (() => void) | null;
  /** Mobile leaves the panel by a back arrow rather than an X. */
  backArrow?: boolean;
}

/**
 * How a tab reads on the strip. `name` is the pill; `detail` is what the pill
 * leaves out and the hover card gives back underneath in a quieter voice:
 * where the file lives, which port the app answers on, which interval the
 * chart is on. A running app with no title is named by its port, the only
 * thing that tells two of them apart; a chart is named by its ticker.
 */
function describe(tab: FileTab, t: TFunction): { name: string; Glyph: LucideIcon; detail: string | null } {
  switch (tab.kind) {
    case 'empty':
      return { name: t('filePanel.openFile'), Glyph: FolderOpen, detail: null };
    case 'file': {
      const slash = tab.path.lastIndexOf('/');
      return { name: tab.path.slice(slash + 1), Glyph: fileGlyph(tab.path), detail: slash > 0 ? tab.path.slice(0, slash) : null };
    }
    case 'settings':
      return { name: t('chat.workspaceSettings'), Glyph: Settings, detail: null };
    case 'preview':
      return { name: tab.title || `:${tab.port}`, Glyph: Globe, detail: [`:${tab.port}`, tab.previewPath].filter(Boolean).join(' ') };
    case 'chart':
      return { name: tab.symbol, Glyph: CandlestickChart, detail: `${t('filePanel.chartTab')} · ${tab.timeframe}` };
  }
}

/**
 * The strip of open files at the top of the panel.
 *
 * It carries `file-panel-header` because the height of that row is the one the
 * ChatView header is aligned against (web/AGENTS.md); the tab shape lives
 * inside it rather than setting the row's height itself.
 */
export function TabStrip({
  tabs,
  activeId,
  onActivate,
  onClose,
  onPin,
  onNewTab,
  hasChanged,
  treeOpen,
  onToggleTree,
  onPanelClose,
  backArrow = false,
}: TabStripProps): React.ReactElement {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * A tab closed from the keyboard hands the focus to the tab that takes its
   * place; a tab closed with the mouse does not, because the pointer is where
   * the reader already is. Same rule the card deck follows.
   */
  const closeFrom = useCallback((id: string, keyboard: boolean) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    onClose(id);
    if (!keyboard) return;
    requestAnimationFrame(() => {
      const remaining = listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
      if (!remaining?.length) return;
      remaining[Math.min(index, remaining.length - 1)].focus();
    });
  }, [tabs, onClose]);

  const onKeyDown = (event: React.KeyboardEvent, tab: FileTab) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step) {
      event.preventDefault();
      const all = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
      const at = all.findIndex((el) => el.dataset.tabId === tab.id);
      all[(at + step + all.length) % all.length]?.focus();
      return;
    }
    // Enter or Space on the close button bubbles here; it means close, not activate.
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onActivate(tab.id);
    }
  };

  return (
    <div className="file-panel-header file-panel-tabstrip">
      <TooltipProvider delayDuration={350} skipDelayDuration={600}>
      <div className="file-panel-tabs clips-focus-ring" role="tablist" aria-label={t('filePanel.openFiles')} ref={listRef}>
        {tabs.map((tab) => {
          const { name, Glyph, detail } = describe(tab, t);
          const hasHint = detail != null || tab.kind === 'file';
          const active = tab.id === activeId;
          const onLoan = tab.kind === 'file' && tab.preview;
          const pill = (
            <div
              key={tab.id}
              role="tab"
              data-tab-id={tab.id}
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              className={`file-panel-tab${onLoan ? ' is-preview' : ''}`}
              onClick={() => onActivate(tab.id)}
              onDoubleClick={() => onPin(tab.id)}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeFrom(tab.id, false); } }}
              onKeyDown={(e) => onKeyDown(e, tab)}
            >
              <Glyph className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="file-panel-tab-name">{name}</span>
              {tab.kind === 'file' && hasChanged(tab.path) && (
                <span className="file-panel-tab-dot" title={t('filePanel.changedSinceRead')} aria-hidden="true" />
              )}
              <button
                type="button"
                className="file-panel-tab-close"
                aria-label={t('filePanel.closeTab', { name })}
                onClick={(e) => { e.stopPropagation(); closeFrom(tab.id, e.detail === 0); }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
          if (!hasHint) return pill;
          return (
            <Tooltip key={tab.id}>
              <TooltipTrigger asChild>{pill}</TooltipTrigger>
              <TooltipContent side="bottom" align="start" className="file-panel-tab-hint">
                <div className="file-panel-tab-hint-name">{name}</div>
                {detail && <div className="file-panel-tab-hint-detail">{detail}</div>}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      </TooltipProvider>

      {onNewTab && (
        <button type="button" onClick={onNewTab} className="file-panel-icon-btn" title={t('filePanel.newTab')} aria-label={t('filePanel.newTab')}>
          <Plus className="h-4 w-4" />
        </button>
      )}

      <div className="file-panel-strip-right">
        {onToggleTree && (
          <button
            type="button"
            onClick={onToggleTree}
            aria-pressed={treeOpen}
            className="file-panel-icon-btn"
            title={t('filePanel.toggleTree')}
            aria-label={t('filePanel.toggleTree')}
          >
            <PanelRight className="h-4 w-4" />
          </button>
        )}
        {onPanelClose && (
          <button type="button" onClick={onPanelClose} className="file-panel-icon-btn" title={t('filePanel.close')} aria-label={t('filePanel.close')}>
            {backArrow ? <ArrowLeft className="h-4 w-4" /> : <X className="h-4 w-4" />}
          </button>
        )}
      </div>
    </div>
  );
}
