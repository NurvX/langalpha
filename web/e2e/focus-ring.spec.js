/**
 * A focus ring is the mouse cursor for someone navigating by keyboard, so it
 * has to be there for them and absent for everyone else. Both halves break
 * silently and neither is visible from inside a component.
 *
 * The half that broke: Radix hands focus back to the trigger when an overlay
 * closes, and Chromium propagates :focus-visible across a programmatic focus
 * move. So a menu opened and dismissed entirely with the mouse left its trigger
 * ringed until the next click, on every dropdown in the app. Nothing about that
 * is expressible in CSS, and a screenshot of the ring looks identical whether
 * it was earned by a keystroke or not. This is the only place the difference
 * can be measured.
 *
 * The other half is the one an over-eager fix takes out. Suppressing the
 * restore unconditionally would pass every mouse assertion below and leave
 * keyboard users pressing Escape into nowhere, so the keyboard cases are not
 * balance: they are the thing most at risk.
 */
import { test, expect, mockAPI } from './fixtures.js';

// The account button in the sidebar footer, chosen because it is a plain
// DropdownMenu over the shared ui/ wrapper -- whatever is true here is true of
// the other call sites, which is the point of fixing it in the wrapper.
const ROW = '.sidebar-account-row';

// Somewhere in the page body with nothing interactive under it.
const EMPTY = { x: 760, y: 300 };

/** Is a focus indicator actually painted on the element that holds focus? */
async function ringed(page) {
  return page.evaluate((sel) => {
    const row = document.querySelector(sel);
    if (!row) throw new Error('the account row is not on the page');
    return document.activeElement === row && row.matches(':focus-visible');
  }, ROW);
}

test.beforeEach(async ({ page }) => {
  await mockAPI(page);
  await page.goto('/dashboard');
  await expect(page.locator(ROW)).toBeVisible();
});

test.describe('a flow driven entirely by the mouse', () => {
  test('leaves no ring after choosing a menu item', async ({ page }) => {
    await page.click(ROW);
    // The regression lived here: this close returns focus to the trigger.
    await page.locator('[role="menuitem"]').first().click();
    await expect.poll(() => ringed(page)).toBe(false);
  });

  test('leaves no ring after dismissing the menu', async ({ page }) => {
    await page.click(ROW);
    await page.mouse.click(EMPTY.x, EMPTY.y);
    await expect.poll(() => ringed(page)).toBe(false);
  });

  test('leaves no ring on the click that opened it', async ({ page }) => {
    await page.click(ROW);
    await page.click(ROW);
    await expect.poll(() => ringed(page)).toBe(false);
  });
});

test.describe('a keyboard user still gets an indicator', () => {
  test('when focus lands on the row', async ({ page }) => {
    await page.keyboard.press('Escape');
    await page.locator(ROW).evaluate((el) => el.focus());
    await expect.poll(() => ringed(page)).toBe(true);
  });

  test('when they open the menu and press Escape', async ({ page }) => {
    await page.locator(ROW).evaluate((el) => el.focus());
    await page.keyboard.press('Enter');
    await expect(page.locator('[role="menuitem"]').first()).toBeVisible();
    // Escape must put them back where they were, still able to see where.
    await page.keyboard.press('Escape');
    await expect.poll(() => ringed(page)).toBe(true);
  });
});
