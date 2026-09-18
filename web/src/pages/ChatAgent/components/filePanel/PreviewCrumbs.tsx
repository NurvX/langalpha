import React from 'react';
import { ExternalLink, Globe, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Loader } from '@/components/ui/loader';
import type { PreviewEntry } from './usePreviews';

interface PreviewCrumbsProps {
  entry: PreviewEntry;
  onRefresh: () => void;
}

/**
 * The crumb row a running app gets instead of a path: what it is, the port it
 * answers on, and the two things that can be done with it. The viewer below
 * carries no chrome of its own — the tab's X is its close, and this row is
 * where everything else lives, so the panel keeps one header shape.
 */
export function PreviewCrumbs({ entry, onRefresh }: PreviewCrumbsProps): React.ReactElement {
  const { t } = useTranslation();
  const name = entry.title || t('filePanel.previewTab');
  return (
    <div className="file-panel-crumbs">
      <Globe className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--color-icon-muted)' }} />
      <span className="file-panel-crumb is-file">{name}</span>
      <span className="file-panel-port-chip">:{entry.port}</span>
      <span className="file-panel-crumb-spacer" />
      {/* The path gives way before the two buttons do: it shrinks to an
          ellipsis, and they keep their size at any length of it. */}
      {entry.path && (
        <span className="file-panel-crumb-meta file-panel-crumb-path font-mono" title={entry.path}>
          {entry.path}
        </span>
      )}
      <button
        type="button"
        onClick={onRefresh}
        className="file-panel-icon-btn flex-shrink-0"
        title={t('filePanel.reloadApp')}
        aria-label={t('filePanel.reloadApp')}
        disabled={entry.loading}
      >
        {entry.loading ? <Loader size={14} className="text-current" /> : <RefreshCw className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        onClick={() => window.open(entry.url, '_blank', 'noopener,noreferrer')}
        className="file-panel-icon-btn flex-shrink-0"
        title={t('filePanel.openInBrowser')}
        aria-label={t('filePanel.openInBrowser')}
        disabled={!entry.url}
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
