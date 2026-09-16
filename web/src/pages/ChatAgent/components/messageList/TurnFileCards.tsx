/**
 * The files a turn produced, as a card deck under its last bubble.
 *
 * A long turn buries its deliverables: the paths are named somewhere in the
 * prose, or only inside a tool call nobody expands. The deck collects them
 * where the reader finishes reading, and collapses to a single card carrying
 * the count, so a turn that wrote six files still ends on one object.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Download, PanelRight } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { fileExtension, fileKind, fileKindIcon } from '../../utils/filePaths';
import type { OpenFileHandler } from '../../utils/fileLocation';
import type { TurnFile } from '../../utils/turnFiles';
import './TurnFileCards.css';

/** Deck geometry. The fan motion is kept in step with the sources deck. */
const CARD_HEIGHT = 68;
const CARD_GAP = 8;
const PEEK_STEP = 6;
const MAX_PEEK_LAYERS = 2;

interface TurnFileCardsProps {
  files: TurnFile[];
  onOpenFile: OpenFileHandler;
  onDownloadFile?: (path: string, workspaceId?: string) => void;
}

export function TurnFileCards({ files, onOpenFile, onDownloadFile }: TurnFileCardsProps): React.ReactElement | null {
  const { t } = useTranslation();
  const [fanned, setFanned] = useState(false);
  // A card's menu portals outside the deck, so an open menu suspends the
  // outside-click and Escape collapse: otherwise choosing Download would fold
  // the deck shut under the pointer, and Escape would close both at once.
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const n = files.length;

  // Outside-click / Escape collapse while fanned, deferred one frame so the
  // click that fanned the deck cannot immediately re-collapse it.
  useEffect(() => {
    if (!fanned || menuOpen) return;
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
  }, [fanned, menuOpen]);

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
        const summarizing = !fanned && isTop && n > 1;
        const name = file.path.split('/').pop() || file.path;
        const kind = fileKind(file.path);
        const Icon = kind ? fileKindIcon(kind) : null;
        const ext = fileExtension(file.path);
        const stat = file.stats ? `+${file.stats.added} -${file.stats.removed}` : '';
        const kindLine = [kind ? t(`chat.turnFiles.kind.${kind}`) : '', ext.toUpperCase(), stat]
          .filter(Boolean)
          .join(' · ');
        const open = () => onOpenFile(file.path, file.workspaceId, file.location);

        return (
          <div
            key={`${file.workspaceId ?? ''}/${file.path}`}
            aria-hidden={interactive ? undefined : true}
            className="turn-file-card"
            style={{
              top: fanned ? i * (CARD_HEIGHT + CARD_GAP) : 0,
              height: CARD_HEIGHT,
              transform: `translateY(${fanned ? 0 : i * PEEK_STEP}px) scale(${fanned ? 1 : Math.max(1 - i * 0.03, 0.85)})`,
              opacity: fanned ? 1 : isTop ? 1 : Math.max(0.85 - (i - 1) * 0.2, 0.25),
              zIndex: n - i,
              pointerEvents: interactive ? 'auto' : 'none',
              animationDelay: fanned ? `${i * 45}ms` : undefined,
            }}
          >
            {/* A peek card behind the front renders as a blank sheet: its name
                would bleed out below the front card as a garbled tail. */}
            {interactive && (
              <>
                <span className="turn-file-thumb" aria-hidden="true">
                  <span className="turn-file-sheet" />
                  <span className="turn-file-page">
                    {Icon && <Icon className="turn-file-glyph" />}
                    <span className="turn-file-ext">{ext.toUpperCase()}</span>
                  </span>
                </span>
                {/* The whole stripe is the primary target: this button carries
                    the name for its accessible label and stretches over the
                    card, so the menu trigger is the only thing clicking it can
                    miss. */}
                <button
                  type="button"
                  className="turn-file-hit"
                  tabIndex={interactive ? undefined : -1}
                  aria-label={summarizing
                    ? t('chat.turnFiles.expand', { count: n })
                    : t('chat.turnFiles.openTitle', { path: file.path })}
                  title={summarizing ? undefined : file.path}
                  onClick={() => (summarizing ? setFanned(true) : open())}
                >
                  <span className="turn-file-name">{name}</span>
                  <span className="turn-file-meta">{kindLine}</span>
                </button>
                {summarizing ? (
                  <span className="turn-file-count" aria-hidden="true">
                    <span className="turn-file-badge">{n}</span>
                    <ChevronDown className="h-4 w-4" />
                  </span>
                ) : (
                  <span className="turn-file-actions">
                    <span className="turn-file-open" aria-hidden="true">
                      <PanelRight className="h-3.5 w-3.5" />
                      {t('chat.turnFiles.open')}
                    </span>
                    <DropdownMenu modal={false} onOpenChange={setMenuOpen}>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="turn-file-more"
                          aria-label={t('chat.turnFiles.moreActions')}
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" sideOffset={4}>
                        <DropdownMenuItem onSelect={open}>
                          <PanelRight className="h-3.5 w-3.5" />
                          {t('chat.turnFiles.open')}
                        </DropdownMenuItem>
                        {onDownloadFile && (
                          <DropdownMenuItem onSelect={() => onDownloadFile(file.path, file.workspaceId)}>
                            <Download className="h-3.5 w-3.5" />
                            {t('chat.turnFiles.download')}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </span>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
