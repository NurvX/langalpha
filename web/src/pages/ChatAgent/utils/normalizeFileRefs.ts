/**
 * Centralized file reference normalization.
 *
 * AI agents are inconsistent in how they format file references in markdown.
 * This function canonicalizes all known variants into clean relative paths
 * BEFORE markdown parsing, so downstream components only need to handle:
 *
 *   - Same-workspace relative:   results/report.md
 *   - Cross-workspace qualified: __wsref__/{uuid}/results/report.md
 *
 * Runs once per message render as a content-level pre-processing step.
 */

import { mapOutsideCode } from './markdownSegments';

/**
 * Step 1: Unwrap backtick-wrapped markdown links.
 *
 * Agents sometimes wrap file links in backticks, making them render as code
 * spans instead of clickable links:
 *   `[report.md](results/report.md)` → [report.md](results/report.md)
 *   `![chart](charts/fig.png)`       → ![chart](charts/fig.png)
 *
 * Only unwraps when the ENTIRE code span is a single markdown link.
 * Does not touch multi-backtick code blocks or inline code with other content.
 */
const BACKTICK_LINK_RE = /`(!?\[[^\]]*\]\([^)]+\))`/g;

/**
 * Step 2: Strip file:///home/(workspace|daytona)/ from markdown link hrefs.
 *
 * rehype-sanitize strips non-whitelisted protocols like file://,
 * so we normalize to a relative path before parsing.
 *   [report.md](file:///home/workspace/results/report.md) → [report.md](results/report.md)
 */
const FILE_PROTO_RE = /(!?\[[^\]]*\]\()file:\/\/\/home\/(?:workspace|daytona)\//g;

/**
 * Step 3: Strip bare /home/(workspace|daytona)/ absolute paths from hrefs.
 *
 * Handles agents that use absolute sandbox paths without the file:// protocol:
 *   [report.md](/home/workspace/results/report.md) → [report.md](results/report.md)
 */
const ABS_SANDBOX_RE = /(!?\[[^\]]*\]\()\/home\/(?:workspace|daytona)\//g;

/**
 * Step 4: Clean stale prefixes inside __wsref__ paths.
 *
 * Legacy stored messages may contain artifacts from before the backend fix:
 *   __wsref__/uuid/file:///home/workspace/x → __wsref__/uuid/x
 *   __wsref__/uuid//home/workspace/x        → __wsref__/uuid/x
 */
const WSREF_INNER_RE = /(__wsref__\/[0-9a-f-]+\/)(?:file:\/\/)?\/home\/(?:workspace|daytona)\//g;

/**
 * Step 5: Wrap link destinations that contain spaces in angle brackets.
 *
 * CommonMark ends a bare destination at the first space, so
 * `[deck](results/Q3 deck.pptx)` renders as plain text with nothing to click.
 * `<...>` is the destination form that allows spaces. Only file-like
 * destinations (ending in an extension, no scheme, no title) are rewritten.
 *   [deck](results/Q3 deck.pptx) → [deck](<results/Q3 deck.pptx>)
 */
const LINK_DEST_RE = /(!?\[[^\]\n]*\]\()((?:[^()<>"'\n]|\([^()\n]*\))+)\)/g;

function wrapSpacedDestination(match: string, open: string, dest: string): string {
  const trimmed = dest.trim();
  if (!/\s/.test(trimmed)) return match;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return match;
  // An extension holds a letter, so a parenthetical like `(up 2.5)` stays prose.
  // A fragment may hold spaces, because `findHeadingIndex` takes a heading as
  // written and not only its slug, so `report.md#Valuation Assumptions` is a
  // reference the panel can already open and the link has to survive to reach it.
  if (!/\.(?=[A-Za-z0-9]{0,7}[A-Za-z])[A-Za-z0-9]{1,8}(?:#[^<>\n]*|:\d+(?:-\d+|:\d+)?)?$/.test(trimmed)) return match;
  // Same reason as step 6: with no slash before the colon, `my model.py:` reads as a scheme.
  const anchored = /^[^/:#?]+:\d+(?:-\d+|:\d+)?$/.test(trimmed) ? `./${trimmed}` : trimmed;
  return `${open}<${anchored}>)`;
}

/**
 * Step 6: Anchor a bare `name.ext:42` destination with `./`.
 *
 * With no slash before the colon, the markdown URL filter reads `model.py:`
 * as a scheme and drops the href, so the link renders with nothing to click.
 *   [model](model.py:42) → [model](./model.py:42)
 */
const BARE_LINE_DEST_RE = /(!?\[[^\]\n]*\]\()([^\s()<>/:#?]+\.(?=[A-Za-z0-9]{0,7}[A-Za-z])[A-Za-z0-9]{1,8}:\d+(?:-\d+|:\d+)?)\)/g;

/**
 * Normalize all file references in a markdown string.
 *
 * Run this ONCE before markdown parsing. After normalization, all file hrefs
 * are either clean relative paths or __wsref__/{uuid}/relative paths.
 */
export function normalizeFileRefs(content: string): string {
  if (!content || typeof content !== 'string') return content;

  content = content.replace(BACKTICK_LINK_RE, '$1');     // step 1
  content = content.replace(FILE_PROTO_RE, '$1');         // step 2
  content = content.replace(ABS_SANDBOX_RE, '$1');        // step 3
  content = content.replace(WSREF_INNER_RE, '$1');        // step 4
  // Steps 5 and 6 rewrite a destination's text, which inside code would change
  // what the reader copies.
  content = mapOutsideCode(content, (prose) => prose
    .replace(LINK_DEST_RE, wrapSpacedDestination)          // step 5
    .replace(BARE_LINE_DEST_RE, '$1./$2)'));               // step 6

  return content;
}
