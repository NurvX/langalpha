import React, { useCallback, useRef } from 'react';
import { ArrowLeft, FolderOpen, Globe, PanelRight, Plus, Settings, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { fileGlyph } from './fileMeta';
import type { FileTab } from './useFileTabs';

interface TabStripProps {
  tabs: FileTab[];
  activeId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onPin: (id: string) => void;
  onNewTab: () => void;
  /** The file changed under this tab since it last read it — the amber dot. */
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
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onActivate(tab.id);
    }
  };

  return (
    <div className="file-panel-header file-panel-tabstrip">
      <TooltipProvider delayDuration={350} skipDelayDuration={600}>
      <div className="file-panel-tabs" role="tablist" aria-label={t('filePanel.openFiles')} ref={listRef}>
        {tabs.map((tab) => {
          // A running app with no title of its own is named by the port it
          // answers on, which is the only thing that tells two of them apart.
          const name = tab.kind === 'settings'
            ? t('chat.workspaceSettings')
            : tab.kind === 'preview'
              ? tab.title || `:${tab.port}`
              : tab.path ? tab.path.split('/').pop()! : t('filePanel.openFile');
          const Glyph = tab.kind === 'settings'
            ? Settings
            : tab.kind === 'preview' ? Globe : tab.path ? fileGlyph(tab.path) : FolderOpen;
          // The pill fades a long name; the hover gives it back whole, with the
          // one thing the pill leaves out — where the file lives, or which port
          // the app answers on — underneath in a quieter voice.
          const detail = tab.kind === 'preview'
            ? [`:${tab.port}`, tab.previewPath].filter(Boolean).join(' ')
            : tab.path && tab.path.includes('/') ? tab.path.slice(0, tab.path.lastIndexOf('/')) : null;
          const hasHint = tab.kind !== 'settings' && (tab.path || tab.kind === 'preview');
          const active = tab.id === activeId;
          const pill = (
            <div
              key={tab.id}
              role="tab"
              data-tab-id={tab.id}
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              className={`file-panel-tab${tab.preview ? ' is-preview' : ''}`}
              onClick={() => onActivate(tab.id)}
              onDoubleClick={() => onPin(tab.id)}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeFrom(tab.id, false); } }}
              onKeyDown={(e) => onKeyDown(e, tab)}
            >
              <Glyph className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="file-panel-tab-name">{name}</span>
              {tab.path && hasChanged(tab.path) && (
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
                <div className="file-panel-tab-hint-name">{tab.kind === 'preview' ? name : tab.path!.split('/').pop()}</div>
                {detail && <div className="file-panel-tab-hint-detail">{detail}</div>}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      </TooltipProvider>

      <button type="button" onClick={onNewTab} className="file-panel-icon-btn" title={t('filePanel.newTab')} aria-label={t('filePanel.newTab')}>
        <Plus className="h-4 w-4" />
      </button>

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
