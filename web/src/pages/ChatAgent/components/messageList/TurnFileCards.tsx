/**
 * The files a turn produced, as a card deck under its last bubble.
 *
 * A long turn buries its deliverables: the paths are named somewhere in the
 * prose, or only inside a tool call nobody expands. The deck collects them
 * where the reader finishes reading, and collapses to a single card with the
 * rest peeking behind, so a turn that wrote six files still ends on one object.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { fileIcon } from '../../utils/filePaths';
import type { OpenFileHandler } from '../../utils/fileLocation';
import type { TurnFile } from '../../utils/turnFiles';
import './TurnFileCards.css';

/** Deck geometry, kept in step with the sources deck (`SourcesPanel.tsx`). */
const CARD_HEIGHT = 52;
const CARD_GAP = 6;
const PEEK_STEP = 6;
const MAX_PEEK_LAYERS = 2;

/** Visuals only — position and height are set per card below. */
const CARD_CHROME =
  'group turn-file-card absolute left-0 right-0 flex items-center gap-2.5 rounded-lg border px-3 ' +
  'text-left outline-none cursor-pointer border-[var(--color-border-muted)] bg-[var(--color-bg-card)] ' +
  'hover:border-[var(--color-border-default)] hover:bg-[var(--color-bg-elevated)] focus-visible:ring-2 focus-visible:ring-ring';

const TERTIARY = { color: 'var(--color-text-tertiary)' as const };

interface TurnFileCardsProps {
  files: TurnFile[];
  onOpenFile: OpenFileHandler;
}

export function TurnFileCards({ files, onOpenFile }: TurnFileCardsProps): React.ReactElement | null {
  const { t } = useTranslation();
  const [fanned, setFanned] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const n = files.length;

  // Outside-click / Escape collapse while fanned, deferred one frame so the
  // click that fanned the deck cannot immediately re-collapse it.
  useEffect(() => {
    if (!fanned) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target || !document.body.contains(target)) return;
      if (rootRef.current?.contains(target)) return;
      setFanned(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFanned(false);
    };
    let attached = false;
    const raf = requestAnimationFrame(() => {
      document.addEventListener('mousedown', onDown);
      document.addEventListener('keydown', onKey);
      attached = true;
    });
    return () => {
      cancelAnimationFrame(raf);
      if (attached) {
        document.removeEventListener('mousedown', onDown);
        document.removeEventListener('keydown', onKey);
      }
    };
  }, [fanned]);

  if (n === 0) return null;

  const peekLayers = Math.min(n - 1, MAX_PEEK_LAYERS);
  const stackHeight = fanned
    ? n * (CARD_HEIGHT + CARD_GAP) - CARD_GAP
    : CARD_HEIGHT + peekLayers * PEEK_STEP;
  // Collapsed, only the front and a capped number of peek cards are rendered:
  // the true count rides the front badge, and capping the rendered set (not
  // just the height) keeps the deepest peek flush with the stack's bottom.
  const visible = fanned ? files : files.slice(0, peekLayers + 1);

  return (
    <div
      ref={rootRef}
      className="turn-files"
      data-testid="turn-files"
      data-fanned={fanned}
      style={{ height: stackHeight }}
    >
      {visible.map((file, i) => {
        const isTop = i === 0;
        const interactive = fanned || isTop;
        const collapsedFront = !fanned && isTop;
        const opensOnClick = fanned || n === 1;
        const name = file.path.split('/').pop() || file.path;
        const dir = file.path.split('/').slice(0, -1).join('/');
        const Icon = fileIcon(file.path);
        const stat = file.stats ? `+${file.stats.added} -${file.stats.removed}` : '';
        const where = [dir ? `${dir}/` : t('chat.turnFiles.rootDir'), stat].filter(Boolean).join(' · ');
        // Collapsed with more behind, the front card summarizes the deck; a
        // lone card and every fanned card carry the file's own folder.
        const subtitle = collapsedFront && n > 1 ? t('chat.turnFiles.fileCount', { count: n }) : where;

        return (
          <button
            key={`${file.workspaceId ?? ''}/${file.path}`}
            type="button"
            aria-hidden={interactive ? undefined : true}
            tabIndex={interactive ? undefined : -1}
            aria-label={opensOnClick
              ? t('chat.turnFiles.openTitle', { path: file.path })
              : t('chat.turnFiles.expand', { count: n })}
            onClick={() => (opensOnClick ? onOpenFile(file.path, file.workspaceId, file.location) : setFanned(true))}
            className={CARD_CHROME}
            style={{
              top: fanned ? i * (CARD_HEIGHT + CARD_GAP) : 0,
              height: CARD_HEIGHT,
              transform: `translateY(${fanned ? 0 : i * PEEK_STEP}px) scale(${fanned ? 1 : Math.max(1 - i * 0.03, 0.85)})`,
              opacity: fanned ? 1 : isTop ? 1 : Math.max(0.85 - (i - 1) * 0.2, 0.25),
              zIndex: n - i,
              pointerEvents: interactive ? 'auto' : 'none',
            }}
          >
            {/* A peek card behind the front renders as a blank surface: its
                name would bleed out below the front card as a garbled tail. */}
            {interactive && (
              <>
                <Icon className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--color-accent-primary)' }} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm" style={{ color: 'var(--color-text-primary)' }}>{name}</span>
                  <span className="truncate text-xs" style={TERTIARY} title={file.path}>{subtitle}</span>
                </span>
                {collapsedFront && n > 1 ? (
                  <span className="inline-flex flex-shrink-0 items-center gap-1">
                    <span
                      className="inline-flex items-center justify-center rounded-full px-1 text-[0.625rem] font-medium"
                      style={{ minWidth: 16, height: 16, backgroundColor: 'var(--color-border-muted)', color: 'var(--color-text-tertiary)' }}
                    >
                      {n}
                    </span>
                    <ChevronDown className="h-4 w-4 opacity-60" style={TERTIARY} />
                  </span>
                ) : (
                  <ChevronRight
                    className="h-4 w-4 flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-50"
                    style={TERTIARY}
                  />
                )}
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
