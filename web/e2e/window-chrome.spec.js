/**
 * The desktop shell hides the macOS titlebar and lets the window buttons float
 * over the top-left of the page. Two things have to stay true for that to work,
 * and neither is visible from inside a single component:
 *
 *   1. This build declares that it reserves. The shell reads that declaration
 *      to decide whether the next window opens frameless, so deleting the meta
 *      silently pins every install to a framed window forever, with no error.
 *   2. Nothing paints under the buttons. Inside the app shell the sidebar
 *      reserves the strip. Outside it — setup, legal, a shared chat — nothing
 *      does, and those screens are clear today only because of where their
 *      layouts happen to put content. That is worth holding still: a logo added
 *      to the top-left of the setup wizard would land under the close button.
 *
 * The bridge is injected rather than mocked at the module level, because the
 * decision is made by the inline script in index.html before the bundle runs.
 * Injecting it is therefore the only way to exercise the real path.
 */
import { test, expect, mockAPI } from './fixtures.js';

// Where the buttons sit in a hiddenInset window: three lights at x=13/33/53,
// plus the padding Electron leaves around them.
const BUTTON_RECT = { w: 78, h: 38 };

const SHELL_BRIDGE = { version: '0.0.0-e2e', platform: 'darwin', windowChrome: 'hidden' };

async function asDesktopShell(page, bridge = SHELL_BRIDGE) {
  await page.addInitScript((value) => {
    Object.defineProperty(window, 'langalphaDesktop', { value, configurable: true });
  }, bridge);
}

/**
 * What a user would see under the window buttons.
 *
 * Text nodes and controls, not "what element is at that point" — every page has
 * a full-bleed container in the corner and its ground is not a collision.
 * A bare `svg` is counted only at control scale: a page-scale decorative vector
 * is a backdrop, and one drawn deliberately in the corner would be inside a
 * link or a button, which this does catch.
 */
async function cornerOccupants(page) {
  return page.evaluate(({ w, h }) => {
    const overlaps = (r) =>
      r.width > 0 && r.height > 0 && r.left < w && r.top < h && r.right > 0 && r.bottom > 0;
    const found = [];

    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.nodeValue || !n.nodeValue.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      if (overlaps(range.getBoundingClientRect())) {
        found.push(`text "${n.nodeValue.trim().slice(0, 30)}"`);
      }
    }

    const controls = document.querySelectorAll(
      'a, button, input, select, textarea, img, svg, [role="button"], [role="tab"]',
    );
    for (const el of controls) {
      if (el.closest('#window-drag')) continue;
      const r = el.getBoundingClientRect();
      if (!overlaps(r)) continue;
      if (el.tagName.toLowerCase() === 'svg' && (r.width > 240 || r.height > 120)) continue;
      if (getComputedStyle(el).visibility === 'hidden') continue;
      found.push(el.tagName.toLowerCase() + (el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : ''));
    }
    return found;
  }, BUTTON_RECT);
}

test.describe('desktop window chrome', () => {
  test('index.html declares that this build reserves the button strip', async ({ page }) => {
    await page.goto('/');
    // Absence is not "no" to the shell, it is "unknown", and unknown keeps the
    // last answer — which on a fresh install is the framed default, forever.
    await expect(page.locator('meta[name="langalpha-window-chrome"]')).toHaveAttribute(
      'content',
      'reserves',
    );
  });

  test('the shell hides the strip until the desktop bridge says the titlebar is gone', async ({ page }) => {
    await mockAPI(page);
    await page.goto('/');
    await page.waitForSelector('.app-main', { timeout: 15_000 });

    // No bridge: a plain browser, and every reservation must collapse. This is
    // the mutation check for the gate — if `desktop-mac` were stamped here,
    // mobile web would carry a 38px band it has no window buttons for.
    expect(await page.evaluate(() => document.documentElement.classList.contains('desktop-mac'))).toBe(false);
    // Both strips are in the DOM unconditionally and gated in CSS, so the
    // property to assert is that neither takes any space, not that neither
    // exists. `boundingBox()` is null for a `display: none` element, which is
    // the same answer for a strip that was never rendered.
    expect(await page.locator('.sidebar-window-drag').boundingBox()).toBe(null);
    expect(
      await page.evaluate(() => getComputedStyle(document.querySelector('#window-drag')).display),
    ).toBe('none');
  });

  test('the app shell reserves the strip when the titlebar is hidden', async ({ page }) => {
    await asDesktopShell(page);
    await mockAPI(page);
    await page.goto('/');
    await page.waitForSelector('.app-main', { timeout: 15_000 });

    const strip = page.locator('.sidebar-window-drag');
    await expect(strip).toHaveCount(1);
    expect((await strip.boundingBox()).height).toBe(BUTTON_RECT.h);
    expect(await cornerOccupants(page)).toEqual([]);
  });

  // The fixed strip in index.html exists for the window whose bundle never ran.
  // It is `position: fixed` at z-index 9999 and 120px wide, so once the app IS
  // up it also covers 40px of the main column past the 80px collapsed sidebar —
  // and a control there cannot win its clicks back, because `no-drag` loses to a
  // drag region painted over it. So it has to stand down once the sidebar
  // renders the real one, and that handover is what this pins.
  test('the fallback drag strip stands down once the sidebar renders its own', async ({ page }) => {
    await asDesktopShell(page);
    await mockAPI(page);
    await page.goto('/');
    await page.waitForSelector('.app-main', { timeout: 15_000 });

    await expect(page.locator('.sidebar-window-drag')).toHaveCount(1);
    expect(
      await page.evaluate(() => getComputedStyle(document.querySelector('#window-drag')).display),
    ).toBe('none');

    // And the main column's top-left is genuinely reachable: whatever sits at
    // the first pixel past the sidebar must not be the overlay.
    const covering = await page.evaluate(() => {
      const x = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10);
      const el = document.elementFromPoint(x + 8, 19);
      return el ? el.closest('#window-drag') !== null : false;
    });
    expect(covering).toBe(false);
  });

  // Everything outside the app shell. None of these reserve anything, so this
  // asserts the property directly rather than the mechanism.
  for (const route of ['/setup/method', '/privacy', '/legal', '/s/no-such-token']) {
    test(`nothing paints under the window buttons on ${route}`, async ({ page }) => {
      await asDesktopShell(page);
      await mockAPI(page);
      await page.goto(route);
      // The settled page, and not a sleep. Both assertions below pass on an EMPTY
      // document — `cornerOccupants` finds nothing in a body with nothing in it,
      // and `desktop-mac` is stamped by the head script before the bundle has
      // run — so without a positive precondition these four tests reported that
      // nothing overlaps the window buttons on a page that never rendered. A
      // slow CI runner was the only thing between them and a vacuous green.
      //
      // `.page-loading` has to be gone specifically, not just "some text
      // present": these routes are lazy, and the loader's decorative quote wall
      // is itself full-bleed text, so it satisfies any weaker precondition while
      // standing exactly where the assertion is looking.
      await page.waitForFunction(
        () => !document.querySelector('.page-loading') && document.body?.innerText.trim().length > 0,
      );

      expect(await page.evaluate(() => document.documentElement.classList.contains('desktop-mac'))).toBe(true);
      expect(await cornerOccupants(page)).toEqual([]);
    });
  }

  test('a pre-0.1.1 shell still gets the strip from the platform guess', async ({ page }) => {
    // The bridge without `windowChrome` is what an already-installed older shell
    // injects. It cannot answer per window, so the page falls back to macOS,
    // which is what that shell always meant.
    await asDesktopShell(page, { version: '0.1.0', platform: 'darwin' });
    await mockAPI(page);
    await page.goto('/');
    await page.waitForSelector('.app-main', { timeout: 15_000 });
    expect(await page.evaluate(() => document.documentElement.classList.contains('desktop-mac'))).toBe(true);
  });
});
