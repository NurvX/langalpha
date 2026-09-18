import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, FolderOpen, PanelRight, RefreshCw, ScrollText, TextSelect } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ContextMenuData } from './types';

export type FileMenuAction = 'add-context' | 'add-to-memo' | 'open' | 'open-new-tab' | 'download' | 'download-many';

interface FileContextMenuProps {
  menu: ContextMenuData;
  onAction: (action: FileMenuAction, filePath: string) => void;
  canAddContext: boolean;
  /** Null where this file cannot go in the memo store at all. */
  memoState: 'absent' | 'present' | null;
  canDownload: boolean;
  /** How many files a bulk save would cover, counting only a selection this file is in. */
  selectedCount: number;
}

const ICON = { className: 'h-3.5 w-3.5', style: { color: 'var(--color-text-tertiary)' } } as const;

/** Keep the menu inside the window; a click near the right edge opens it leftward. */
const EDGE = 8;
function useClampedPosition(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = x + width > window.innerWidth - EDGE ? Math.max(EDGE, x - width) : x;
    const top = y + height > window.innerHeight - EDGE ? Math.max(EDGE, y - height) : y;
    setPos({ left, top });
  }, [x, y]);
  return { ref, pos };
}

/** The tree's right-click menu: what can be done with one file without opening it. */
export function FileContextMenu({
  menu, onAction, canAddContext, memoState, canDownload, selectedCount,
}: FileContextMenuProps): React.ReactElement {
  const { t } = useTranslation();
  const { ref, pos } = useClampedPosition(menu.x, menu.y);
  const item = (action: FileMenuAction, icon: React.ReactNode, label: string) => (
    <div className="file-panel-context-menu-item" onClick={() => onAction(action, menu.filePath)}>
      {icon}
      {label}
    </div>
  );

  // Portaled to the body: the tree column clips its overflow for the open and
  // close animation, and a menu that lives inside it is cut at the panel edge.
  return createPortal(
    <div
      ref={ref}
      className="file-panel-context-menu"
      style={pos}
      onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
    >
      {canAddContext && item('add-context', <TextSelect {...ICON} />, t('context.addToContext'))}
      {memoState === 'present' && item('add-to-memo', <RefreshCw {...ICON} />, t('context.syncWithMemo'))}
      {memoState === 'absent' && item('add-to-memo', <ScrollText {...ICON} />, t('context.addToMemo'))}
      {item('open', <FolderOpen {...ICON} />, t('context.openFile'))}
      {item('open-new-tab', <PanelRight {...ICON} />, t('filePanel.openInNewTab'))}
      {canDownload && item('download', <Download {...ICON} />, t('filePanel.download'))}
      {canDownload && selectedCount > 1
        && item('download-many', <Download {...ICON} />, t('filePanel.downloadCount', { count: selectedCount }))}
    </div>,
    document.body,
  );
}
