/**
 * The files a turn produced, as cards under its last bubble.
 *
 * A long turn buries its deliverables: the paths are named somewhere in the
 * prose, or only in a tool call nobody expands. The strip collects them in one
 * place at the end of the turn, where the reader is already looking.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fileIcon } from '../../utils/filePaths';
import type { OpenFileHandler } from '../../utils/fileLocation';
import type { TurnFile } from '../../utils/turnFiles';
import './TurnFileCards.css';

/** Past this many the strip is taller than the reply it belongs to. */
const COLLAPSED_COUNT = 5;

interface TurnFileCardsProps {
  files: TurnFile[];
  onOpenFile: OpenFileHandler;
}

export function TurnFileCards({ files, onOpenFile }: TurnFileCardsProps): React.ReactElement | null {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) return null;

  const shown = expanded ? files : files.slice(0, COLLAPSED_COUNT);
  const hidden = files.length - shown.length;

  return (
    <div className="turn-files">
      {shown.map((file) => {
        const name = file.path.split('/').pop() || file.path;
        const dir = file.path.split('/').slice(0, -1).join('/');
        const Icon = fileIcon(file.path);
        return (
          <button
            key={`${file.workspaceId ?? ''}/${file.path}`}
            className="turn-file"
            onClick={() => onOpenFile(file.path, file.workspaceId, file.location)}
            title={t('chat.turnFiles.openTitle', { path: file.path })}
          >
            <Icon className="turn-file-icon" />
            <span className="turn-file-info">
              <span className="turn-file-name">{name}</span>
              <span className="turn-file-meta">
                {dir ? `${dir}/` : t('chat.turnFiles.rootDir')}
                {file.stats && (
                  <span className="turn-file-stat">
                    {' '}+{file.stats.added} -{file.stats.removed}
                  </span>
                )}
              </span>
            </span>
            <span className="turn-file-open">{t('chat.turnFiles.open')}</span>
          </button>
        );
      })}
      {(hidden > 0 || expanded) && (
        <button className="turn-files-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? t('chat.turnFiles.less') : t('chat.turnFiles.more', { count: hidden })}
        </button>
      )}
    </div>
  );
}
