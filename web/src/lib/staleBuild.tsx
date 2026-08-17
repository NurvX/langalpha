import i18n from '@/i18n';
import { toast } from '@/components/ui/use-toast';
import { ToastAction } from '@/components/ui/toast';

/**
 * Detection and reporting for "this tab is running a build the server no longer
 * serves". The pre-boot half lives inline in index.html, because by the time
 * anything here could run, the bundle that failed to load is the bundle this
 * module is in. This half owns everything after the app has mounted, where a
 * surprise reload would destroy an agent turn in flight.
 */

declare global {
  interface Window {
    /** Set once React has mounted; index.html reads it to suppress auto-reload. */
    __LA_BOOTED__?: boolean;
    /** Set by index.html when it detects a dead build asset post-boot. */
    __LA_STALE_BUILD__?: string;
  }
}

/** Where the build writes content-hashed output. Keep in step with index.html. */
const BUILD_PREFIX = '/assets/';

const VERSION_URL = '/version.json';
const POLL_THROTTLE_MS = 60_000;

// The first three are Chrome/Edge, Firefox and Safari failing a dynamic import.
// Lowercased at comparison time.
//
// The fourth is Vite's own, and it only became reachable when the Worker started
// answering misses with a real 404: a route's stylesheet is preloaded through a
// <link>, which fires `load` for the SPA fallback's 200 text/html but `error` for
// a 404, and __vitePreload turns that into a throw. It names the dep as a bare
// path, not a URL, which is why mentionsBuildAsset has to match both forms.
const CHUNK_ERROR_PATTERNS = [
  'failed to fetch dynamically imported module',
  'error loading dynamically imported module',
  'importing a module script failed',
  'unable to preload css for',
];

let notified = false;
let lastChecked = 0;

export function markBooted(): void {
  window.__LA_BOOTED__ = true;
}

/** The entry chunk this document actually loaded, e.g. `index-ChLW29p_.js`. */
function currentBuild(): string | null {
  // Read from the DOM rather than a compile-time constant: the entry cannot know
  // its own content hash (the hash is computed from the bundle that would carry
  // the constant). index.html has exactly one module script, which is also what
  // scripts/check-critical-path.mjs relies on.
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
  if (!el?.src) return null;
  try {
    return new URL(el.src, window.location.href).pathname.split('/').pop() || null;
  } catch {
    return null;
  }
}

const ABSOLUTE_URL = /https?:\/\/[^\s'")]+/g;

function mentionsBuildAsset(message: string): boolean {
  const urls = message.match(ABSOLUTE_URL) ?? [];
  const sameOrigin = urls.some((raw) => {
    try {
      const u = new URL(raw);
      return u.origin === window.location.origin && u.pathname.startsWith(BUILD_PREFIX);
    } catch {
      return false;
    }
  });
  if (sameOrigin) return true;

  // Vite names a failed CSS dep as a path (`Unable to preload CSS for
  // /assets/Chat-a1b2.css`). A bare path is same-origin by definition, so it
  // needs no origin check — but absolute URLs are stripped first, or a
  // cross-origin CDN asset would match here through its pathname.
  return new RegExp(`(^|[\\s'"(])${BUILD_PREFIX}`).test(message.replace(ABSOLUTE_URL, ''));
}

/**
 * True only for a failed build-asset load. Everything else must stay a real
 * error: a boundary that swallows any exception and offers a Reload button
 * trains everyone to reload on every crash, and deterministic render bugs then
 * get filed as "stale build".
 */
export function isStaleBuildError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();
  if (!CHUNK_ERROR_PATTERNS.some((p) => lower.includes(p))) return false;
  // Pattern alone also matches a plain network outage, which is a different bug
  // with a different remedy, so a same-origin build URL is normally required.
  // index.html's flag stands in when the browser's message carries no URL
  // (Safari's does not) — but only here, after the message already looks like a
  // chunk failure. Checking it first would mean one flagged resource silently
  // reclassifies every later render error as a stale build, and the boundary
  // would swallow real bugs behind a reload prompt for the rest of the session.
  return mentionsBuildAsset(message) || !!window.__LA_STALE_BUILD__;
}

/**
 * Surface the stale build once. Never reloads on its own: a turn may have been
 * streaming for minutes, so the choice is the user's.
 */
export function reportStaleBuild(reason: string): void {
  if (notified) return;
  notified = true;
  // Logged even though this is the expected path. Without it a genuine
  // /assets/* 404 regression is absorbed into a friendly toast and never
  // investigated.
  console.error(`[staleBuild] running a build the server no longer serves (${reason})`);

  toast({
    title: i18n.t('common.staleBuild.title'),
    description: i18n.t('common.staleBuild.description'),
    // Overrides the Toaster's 3s default (spread onto the Radix Toast). A
    // notice that disappears before the user looks up is not a notice.
    duration: Infinity,
    action: (
      <ToastAction
        altText={i18n.t('common.staleBuild.reload')}
        onClick={() => window.location.reload()}
      >
        {i18n.t('common.staleBuild.reload')}
      </ToastAction>
    ),
  });
}

/**
 * Ask the server which build it is serving. Anything unclear (offline, a
 * proxy's HTML error page, a dev server with no version.json) resolves to
 * "unknown" and does nothing — never to "you are behind".
 */
export async function checkForNewBuild(): Promise<void> {
  const mine = currentBuild();
  if (!mine || notified) return;

  const now = Date.now();
  if (now - lastChecked < POLL_THROTTLE_MS) return;
  lastChecked = now;

  try {
    const res = await fetch(VERSION_URL, { cache: 'no-store' });
    if (!res.ok) return;
    // A miss that fell through to the SPA shell answers 200 text/html, and the
    // shell's own <script src> contains the entry name — so a body match would
    // pass on it. Require real JSON.
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) return;
    const data: unknown = await res.json();
    const build = (data as { build?: unknown } | null)?.build;
    if (typeof build !== 'string' || !build) return;
    if (build !== mine) reportStaleBuild('version');
  } catch {
    // Offline or blocked. Not evidence of anything.
  }
}

/**
 * Wire the post-boot signals: index.html's event for a chunk that already died,
 * and a version check when the tab comes back to the foreground. Returns a
 * cleanup for the caller's effect.
 */
export function watchStaleBuild(): () => void {
  const onStale = (e: Event) => {
    const detail = (e as CustomEvent<string>).detail;
    reportStaleBuild(typeof detail === 'string' ? detail : 'resource');
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') void checkForNewBuild();
  };

  window.addEventListener('la:stale-build', onStale);
  document.addEventListener('visibilitychange', onVisibility);

  // index.html may have fired before React mounted and the listener attached.
  if (window.__LA_STALE_BUILD__) reportStaleBuild(window.__LA_STALE_BUILD__);

  return () => {
    window.removeEventListener('la:stale-build', onStale);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/** Test seam — the module-level dedupe and throttle outlive a test file. */
export function __resetStaleBuildForTests(): void {
  notified = false;
  lastChecked = 0;
  delete window.__LA_STALE_BUILD__;
}
