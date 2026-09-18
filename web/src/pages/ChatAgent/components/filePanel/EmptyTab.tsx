import React from 'react';
import { FolderOpen, PanelRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface EmptyTabProps {
  /** Read-only panels have nothing to drop onto, so the invitation drops too. */
  canUpload: boolean;
  /** Whether the tree column is showing; the hint points at it only when it is there to point at. */
  treeOpen: boolean;
  /** Opens the tree column; null when the panel has no tree to show. */
  onShowTree: (() => void) | null;
}

/**
 * What an empty tab shows: where a file comes from, and that it takes a drop.
 * With the tree folded away there is nothing on the right to pick from, so the
 * tab offers to open it rather than describing a column that is not there.
 */
export function EmptyTab({ canUpload, treeOpen, onShowTree }: EmptyTabProps): React.ReactElement {
  const { t } = useTranslation();
  const offerTree = !treeOpen && !!onShowTree;
  return (
    <div className="file-panel-empty-tab">
      <FolderOpen className="h-8 w-8" style={{ color: 'var(--color-text-tertiary)' }} />
      <span className="file-panel-empty-tab-title">{t('filePanel.openFile')}</span>
      {offerTree && (
        <button type="button" className="file-panel-empty-tab-btn" onClick={onShowTree}>
          <PanelRight className="h-3.5 w-3.5" />
          {t('filePanel.showFileTree')}
        </button>
      )}
      <span className="file-panel-empty-tab-hint">
        {offerTree
          ? (canUpload ? t('filePanel.dropToUploadHint') : null)
          : (canUpload ? t('filePanel.openFileHintUpload') : t('filePanel.openFileHint'))}
      </span>
    </div>
  );
}
