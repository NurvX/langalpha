import React, { useState } from 'react';
import { Check, ExternalLink, Globe, Link2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Loader } from '@/components/ui/loader';
import { toast } from '@/components/ui/use-toast';
import { queryKeys } from '@/lib/queryKeys';
import type { ShareLink } from '@/types/api';
import { useShareLink } from '@/hooks/useShareLink';
import { createShareLink, shareLinkHref } from '../../utils/api/shareLinks';
import type { PreviewEntry } from './usePreviews';

interface PreviewCrumbsProps {
  entry: PreviewEntry;
  onRefresh: () => void;
  /** The owner's workspace; null on a read-only panel, which offers no link. */
  workspaceId?: string | null;
}

/**
 * The crumb row a running app gets instead of a path: what it is, the port it
 * answers on, and the things that can be done with it. The viewer below
 * carries no chrome of its own — the tab's X is its close, and this row is
 * where everything else lives, so the panel keeps one header shape.
 */
export function PreviewCrumbs({ entry, onRefresh, workspaceId = null }: PreviewCrumbsProps): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const name = entry.title || t('filePanel.previewTab');

  // An app's link is private, so minting it on open costs nothing and
  // lets the copy land inside the click.
  const target = { kind: 'app' as const, port: entry.port };
  const { data: link } = useShareLink(workspaceId, target);

  const copyLink = async () => {
    if (!workspaceId) return;
    try {
      const resolved = link ?? (await queryClient.fetchQuery<ShareLink>({
        queryKey: queryKeys.shareLinks.link(workspaceId, 'app', String(entry.port)),
        queryFn: () => createShareLink(workspaceId, target),
      }));
      await navigator.clipboard.writeText(shareLinkHref(resolved.code));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('[PreviewCrumbs] Copy link failed:', err);
      toast({ description: t('filePanel.shareLinkFailed'), variant: 'destructive' });
    }
  };

  return (
    <div className="file-panel-crumbs">
      <Globe className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--color-icon-muted)' }} />
      <span className="file-panel-crumb is-file">{name}</span>
      <span className="file-panel-port-chip">:{entry.port}</span>
      <span className="file-panel-crumb-spacer" />
      {/* The path gives way before the buttons do: it shrinks to an
          ellipsis, and they keep their size at any length of it. */}
      {entry.path && (
        <span className="file-panel-crumb-meta file-panel-crumb-path font-mono" title={entry.path}>
          {entry.path}
        </span>
      )}
      {workspaceId && (
        <button
          type="button"
          onClick={() => void copyLink()}
          className="file-panel-icon-btn flex-shrink-0"
          title={t('filePanel.copyPrivateLink')}
          aria-label={t('filePanel.copyPrivateLink')}
        >
          {copied
            ? <Check className="h-3.5 w-3.5" style={{ color: 'var(--color-success)' }} />
            : <Link2 className="h-3.5 w-3.5" />}
        </button>
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
