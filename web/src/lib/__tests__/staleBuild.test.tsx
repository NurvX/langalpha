import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  isStaleBuildError,
  checkForNewBuild,
  __resetStaleBuildForTests,
} from '../staleBuild';
import { StaleBuildBoundary } from '@/components/StaleBuildBoundary';

// The contract these lock is the one that is easy to get wrong in both
// directions: too loose and every crash becomes a "reload" prompt that hides a
// real bug; too tight and the blank page it exists to fix comes back.

const CHUNK_MSG = 'Failed to fetch dynamically imported module: ';

function setEntryScript(name: string) {
  document.head.querySelectorAll('script[type="module"]').forEach((n) => n.remove());
  const s = document.createElement('script');
  s.type = 'module';
  s.src = `${window.location.origin}/assets/${name}`;
  document.head.appendChild(s);
}

beforeEach(() => {
  __resetStaleBuildForTests();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('isStaleBuildError', () => {
  it('matches a chunk failure naming a same-origin build asset', () => {
    const err = new Error(`${CHUNK_MSG}${window.location.origin}/assets/Dashboard-a1b2c3d4.js`);
    expect(isStaleBuildError(err)).toBe(true);
  });

  it('rejects the same message pointing at another origin', () => {
    // A third-party script failing to import is not our deploy.
    const err = new Error(`${CHUNK_MSG}https://cdn.example.com/assets/x.js`);
    expect(isStaleBuildError(err)).toBe(false);
  });

  it('rejects the same message with no URL at all', () => {
    // Bare pattern matching also fires on a plain network outage, which needs a
    // different remedy than reloading.
    expect(isStaleBuildError(new Error('error loading dynamically imported module'))).toBe(false);
  });

  it("matches Vite's CSS preload failure, which names the dep as a bare path", () => {
    // Only reachable once the edge answers a miss with a real 404: the SPA
    // fallback's 200 text/html makes the <link> fire `load`, so it never threw
    // before. The message carries no URL, only a path.
    const err = new Error('Unable to preload CSS for /assets/ChatAgent-Cx0714-u.css');
    expect(isStaleBuildError(err)).toBe(true);
  });

  it('rejects a CSS preload failure pointing at another origin', () => {
    const err = new Error('Unable to preload CSS for https://cdn.example.com/assets/x.css');
    expect(isStaleBuildError(err)).toBe(false);
  });

  it('rejects an ordinary render error', () => {
    expect(isStaleBuildError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isStaleBuildError(new TypeError('x is not a function'))).toBe(false);
    expect(isStaleBuildError(null)).toBe(false);
  });

  it('accepts a URL-less chunk message when index.html flagged the build', () => {
    // Safari's message carries no URL, so the flag is the only signal there.
    window.__LA_STALE_BUILD__ = 'preload';
    expect(isStaleBuildError(new Error('Importing a module script failed.'))).toBe(true);
  });

  it('does not let the flag reclassify an unrelated error', () => {
    // The flag is sticky and set from a resource error. If it were checked
    // before the message, one flagged resource would turn every render bug for
    // the rest of the session into a "stale build" the boundary swallows.
    window.__LA_STALE_BUILD__ = 'resource';
    expect(isStaleBuildError(new TypeError('x is not a function'))).toBe(false);
    expect(isStaleBuildError(new Error('Cannot read properties of undefined'))).toBe(false);
  });
});

describe('checkForNewBuild', () => {
  beforeEach(() => setEntryScript('index-CURRENT.js'));

  const respond = (body: unknown, init: { ok?: boolean; type?: string } = {}) =>
    vi.fn().mockResolvedValue({
      ok: init.ok ?? true,
      headers: new Headers({ 'content-type': init.type ?? 'application/json' }),
      json: async () => body,
    });

  it('reports when the server serves a different build', async () => {
    vi.stubGlobal('fetch', respond({ build: 'index-NEWER.js' }));
    await checkForNewBuild();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('staleBuild'));
  });

  it('stays quiet when the build matches', async () => {
    vi.stubGlobal('fetch', respond({ build: 'index-CURRENT.js' }));
    await checkForNewBuild();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('stays quiet on an HTML answer even when its body parses as JSON', async () => {
    // A miss that fell through to the SPA shell answers 200 text/html. The
    // body deliberately parses here: a version.json that only checked the
    // parsed shape would be satisfied by any proxy, error page or dev server
    // that happens to return JSON-ish HTML, and would then tell every user they
    // are behind. Only the content-type check rejects this.
    vi.stubGlobal('fetch', respond({ build: 'index-NEWER.js' }, { type: 'text/html' }));
    await checkForNewBuild();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('stays quiet when the body is not JSON at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => {
          throw new SyntaxError('Unexpected token <');
        },
      }),
    );
    await checkForNewBuild();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('stays quiet on a non-OK response or a network failure', async () => {
    vi.stubGlobal('fetch', respond({ build: 'index-NEWER.js' }, { ok: false }));
    await checkForNewBuild();
    __resetStaleBuildForTests();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await checkForNewBuild();
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe('StaleBuildBoundary', () => {
  const Boom = ({ error }: { error: Error }) => {
    throw error;
  };

  it('renders the recovery fallback for a chunk failure', () => {
    const err = new Error(`${CHUNK_MSG}${window.location.origin}/assets/x-1234abcd.js`);
    render(
      <StaleBuildBoundary>
        <Boom error={err} />
      </StaleBuildBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('rethrows an ordinary error instead of swallowing it', () => {
    // The whole point of the classification: a boundary that catches everything
    // turns deterministic bugs into "stale build" reports.
    class Catcher extends React.Component<{ children: React.ReactNode }, { hit: boolean }> {
      state = { hit: false };
      static getDerivedStateFromError() {
        return { hit: true };
      }
      render() {
        return this.state.hit ? <div data-testid="outer" /> : this.props.children;
      }
    }

    render(
      <Catcher>
        <StaleBuildBoundary>
          <Boom error={new Error('ordinary bug')} />
        </StaleBuildBoundary>
      </Catcher>,
    );
    expect(screen.getByTestId('outer')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
