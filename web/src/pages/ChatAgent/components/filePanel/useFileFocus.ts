import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  countLines,
  findHeadingIndex,
  headingIndexAbove,
  markdownLineProbe,
  type FileLocation,
} from '../../utils/fileLocation';

/** Which viewer is showing the selected file, as far as a location can reach into it. */
export type FocusViewer = 'code' | 'markdown' | 'pdf' | 'html' | 'other';

interface FileFocus {
  path: string;
  location: FileLocation;
  /** Bumped on every visit so a repeat click scrolls and plays the highlight again. */
  seq: number;
}

export interface FocusChipState {
  kind: 'line' | 'page' | 'section';
  line?: number;
  lineEnd?: number;
  page?: number;
  anchor?: string;
  title?: string;
  missing: boolean;
}

interface UseFileFocusArgs {
  selectedFile: string | null;
  viewer: FocusViewer;
  /** The viewer has rendered the file: not loading, no error, not editing. */
  ready: boolean;
  editing: boolean;
  content: string | null;
  /** The read stopped short of the end, so a line past it may still exist. */
  truncated: boolean;
  pageCount: number | null;
  containerRef: RefObject<HTMLElement | null>;
}

const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6';
const BLOCK_SELECTOR = `${HEADING_SELECTOR},p,li,td,th,pre,blockquote,dt,dd`;
const BLOCK_CLASS = 'file-focus-block';
const ENTER_CLASS = 'file-focus-enter';
const MAX_ANIMATED_LINES = 200;
const MAX_WAIT_FRAMES = 30;

const normalizeText = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();

interface MarkdownTarget {
  el: HTMLElement;
  title?: string;
}

function findMarkdownTarget(root: HTMLElement, location: FileLocation, source: string): MarkdownTarget | null {
  const headings = Array.from(root.querySelectorAll<HTMLElement>(HEADING_SELECTOR));
  if (location.anchor) {
    const i = findHeadingIndex(headings.map((h) => h.textContent ?? ''), location.anchor);
    if (i >= 0) return { el: headings[i], title: normalizeText(headings[i].textContent) };
    // Raw HTML anchors keep their id behind rehype-sanitize's prefix.
    const id = `user-content-${location.anchor}`;
    const raw = Array.from(root.querySelectorAll<HTMLElement>('[id],[name]'))
      .find((el) => el.id === id || el.getAttribute('name') === id);
    return raw ? { el: raw } : null;
  }
  if (location.line) {
    // The rendered view has no line numbers, so find the smallest block whose
    // text contains the source line, and fall back to the section it sits in.
    const probe = markdownLineProbe(source, location.line);
    if (probe) {
      let best: HTMLElement | null = null;
      let bestLength = Infinity;
      for (const el of root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) {
        const text = normalizeText(el.textContent);
        if (text.length < bestLength && text.includes(probe)) {
          best = el;
          bestLength = text.length;
        }
      }
      if (best) return { el: best.closest<HTMLElement>('tr') ?? best };
    }
    const heading = headings[headingIndexAbove(source, location.line)];
    if (heading) return { el: heading };
  }
  return null;
}

/** Put a target near the top of the panel with a little context above it. */
function scrollIntoPanel(container: HTMLElement, el: HTMLElement) {
  const offset = el.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollTop += offset - Math.min(72, container.clientHeight / 4);
}

function playEnter(elements: HTMLElement[]) {
  for (const el of elements) {
    el.classList.remove(ENTER_CLASS);
    void el.offsetWidth; // restart the animation on a repeat visit
    el.classList.add(ENTER_CLASS);
    el.addEventListener('animationend', () => el.classList.remove(ENTER_CLASS), { once: true });
  }
}

/** Retry a DOM lookup across frames, since lazy viewers commit after the effect runs. */
function whenPresent<T>(find: () => T | null, onFound: (found: T) => void, onGiveUp: () => void): () => void {
  let frame = 0;
  let raf = 0;
  const tick = () => {
    const found = find();
    if (found) return onFound(found);
    if (++frame > MAX_WAIT_FRAMES) return onGiveUp();
    raf = requestAnimationFrame(tick);
  };
  tick();
  return () => cancelAnimationFrame(raf);
}

/**
 * The spot inside the open file that a reference pointed at: scrolled to and
 * highlighted on arrival, kept until dismissed or another file opens.
 */
export function useFileFocus({
  selectedFile,
  viewer,
  ready,
  editing,
  content,
  truncated,
  pageCount,
  containerRef,
}: UseFileFocusArgs) {
  const [focus, setFocus] = useState<FileFocus | null>(null);
  const [section, setSection] = useState<{ seq: number; title?: string; found: boolean } | null>(null);
  const seqRef = useRef(0);

  const focusAt = useCallback((path: string, location: FileLocation | null | undefined) => {
    setFocus(location ? { path, location, seq: ++seqRef.current } : null);
  }, []);
  const jump = useCallback(() => setFocus((f) => f && { ...f, seq: ++seqRef.current }), []);
  const dismiss = useCallback(() => setFocus(null), []);

  useEffect(() => {
    if (focus && (focus.path !== selectedFile || editing)) setFocus(null);
  }, [focus, selectedFile, editing]);

  const active = focus && focus.path === selectedFile && ready ? focus : null;
  const loc = active?.location;
  const lineCount = content != null ? countLines(content) : 0;

  let chip: FocusChipState | null = null;
  let lineRange: [number, number] | null = null;
  if (active && loc) {
    if (loc.line && (viewer === 'code' || viewer === 'markdown')) {
      const missing = !truncated && loc.line > lineCount;
      chip = { kind: 'line', line: loc.line, lineEnd: loc.lineEnd, missing };
      if (!missing && viewer === 'code') {
        const end = loc.lineEnd ?? loc.line;
        lineRange = [loc.line, truncated ? end : Math.min(end, lineCount)];
      }
    } else if (loc.page && viewer === 'pdf') {
      chip = { kind: 'page', page: loc.page, missing: pageCount != null && loc.page > pageCount };
    } else if (loc.anchor && viewer === 'markdown') {
      const result = section?.seq === active.seq ? section : null;
      chip = { kind: 'section', anchor: loc.anchor, title: result?.title, missing: result ? !result.found : false };
    }
  }

  const activeSeq = active?.seq ?? null;
  const rangeStart = lineRange?.[0] ?? null;
  const rangeEnd = lineRange?.[1] ?? null;
  const lineMissing = chip?.kind === 'line' && chip.missing;

  useEffect(() => {
    const container = containerRef.current;
    if (!active || !container) return;
    const location = active.location;

    if (viewer === 'code' && rangeStart != null && rangeEnd != null) {
      return whenPresent(
        () => container.querySelector<HTMLElement>(`[data-line="${rangeStart}"]`),
        (first) => {
          scrollIntoPanel(container, first);
          const lines: HTMLElement[] = [];
          for (let n = rangeStart; n <= Math.min(rangeEnd, rangeStart + MAX_ANIMATED_LINES); n++) {
            const el = container.querySelector<HTMLElement>(`[data-line="${n}"]`);
            if (el) lines.push(el);
          }
          playEnter(lines);
        },
        () => {},
      );
    }

    if (viewer === 'markdown' && (location.anchor || (location.line && !lineMissing))) {
      let target: HTMLElement | null = null;
      const seq = active.seq;
      const cancel = whenPresent(
        () => findMarkdownTarget(container, location, content ?? ''),
        (found) => {
          target = found.el;
          found.el.classList.add(BLOCK_CLASS);
          scrollIntoPanel(container, found.el);
          playEnter([found.el]);
          if (location.anchor) setSection({ seq, title: found.title, found: true });
        },
        () => {
          if (location.anchor) setSection({ seq, found: false });
        },
      );
      return () => {
        cancel();
        target?.classList.remove(BLOCK_CLASS, ENTER_CLASS);
      };
    }
  }, [activeSeq, viewer, rangeStart, rangeEnd, lineMissing, content]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    focusAt,
    jump,
    dismiss,
    chip,
    lineRange,
    focusPage: loc?.page && viewer === 'pdf' ? loc.page : null,
    htmlAnchor: loc?.anchor && viewer === 'html' ? loc.anchor : null,
    seq: activeSeq,
  };
}
