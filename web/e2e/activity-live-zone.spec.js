/**
 * The activity live zone must size to its rows after a fold is interrupted.
 *
 * Three tool rows complete together, fold into the accordion, and a fourth
 * call lands while the live zone is still collapsing. The zone must end up
 * as tall as the one row it now holds, not the three it held before.
 */
import { configureSSE, resetMockServer, mockAPI, test, expect } from './fixtures.js';
import { sseEvents, defaultResponses } from './helpers/mockResponses.js';
import { TH, chatViewOverrides } from './helpers/chatScenario.js';
import { MIN_LIVE_EXPOSURE_MS } from '../src/pages/ChatAgent/components/messageList/liveZoneTiming.ts';

// A completed row stays live for MIN_LIVE_EXPOSURE_MS after its call was
// created, then folds; the zone's collapse runs about 180 ms more, so a call
// landing 150 ms past the fold lands inside that collapse. The clock starts
// at the first event, and the four events before the delay each cost a gap,
// so the delay is measured from the first event, not from the last result.
// The tool must not be an inline-artifact tool (those skip the exposure
// window).
const EVENT_GAP_MS = 30;
const LAND_MID_COLLAPSE_MS = MIN_LIVE_EXPOSURE_MS + 150 - 4 * EVENT_GAP_MS;

test.describe('activity live zone', () => {
  test.beforeEach(async () => {
    await resetMockServer();
  });

  test('sizes to its rows after a call lands mid-fold', async ({ page }) => {
    await mockAPI(page, chatViewOverrides());
    await configureSSE({
      method: 'GET',
      path: `/api/v1/threads/${TH}/messages/replay`,
      events: [sseEvents.replayDone()],
      delay: 10,
    });

    const batch = ['toolu_a1', 'toolu_a2', 'toolu_a3'];
    await configureSSE({
      method: 'POST',
      path: `/api/v1/threads/${TH}/messages`,
      events: [
        sseEvents.toolCalls(batch.map((id, i) => ({ name: 'bash', args: { command: `echo ${i}` }, id }))),
        sseEvents.finishToolCalls(),
        sseEvents.toolCallResult('toolu_a1', '0'),
        sseEvents.toolCallResult('toolu_a2', '1'),
        { ...sseEvents.toolCallResult('toolu_a3', '2'), delayAfter: LAND_MID_COLLAPSE_MS },
        sseEvents.toolCalls([{ name: 'bash', args: { command: 'echo 3' }, id: 'toolu_b' }]),
        // Hold the fourth call in progress so it stays a live row while measured.
        { ...sseEvents.finishToolCalls(), delayAfter: 3000 },
        sseEvents.toolCallResult('toolu_b', '3'),
        sseEvents.messageChunk('done'),
        sseEvents.finishStop(),
        sseEvents.creditUsage(),
      ],
      delay: EVENT_GAP_MS,
    });

    await page.goto(`/chat/t/${TH}`);
    await page.waitForSelector('textarea', { timeout: 10000 });
    await page.locator('textarea').fill('run four commands');
    await page.locator('button[aria-label="Send message"]').click();

    // The precondition, read in one pass so it can actually fail: the three
    // rows must already be folded behind the accordion summary when the fourth
    // call goes live. If the fourth arrived first there is no interrupted fold
    // and the height below would be measured on a case that never regressed.
    const atFold = await page.waitForFunction(() => {
      if (!document.querySelector('[id^="activity-summary-"]')) return null;
      return { active: document.querySelectorAll('[data-testid="activity-live-zone"] .titem.running').length };
    }, null, { timeout: 15000 }).then((h) => h.jsonValue());
    expect(atFold.active, 'the fourth call went live before the first three folded').toBe(0);

    const zone = page.getByTestId('activity-live-zone');
    await expect(zone.locator('.titem.running')).toHaveCount(1, { timeout: 15000 });
    // Let the zone's own animations settle before measuring.
    await page.waitForTimeout(1000);

    const { zoneHeight, rowsHeight } = await zone.evaluate((el) => ({
      zoneHeight: el.getBoundingClientRect().height,
      rowsHeight: Array.from(el.children).reduce((sum, c) => sum + c.getBoundingClientRect().height, 0),
    }));
    expect(rowsHeight).toBeGreaterThan(0);
    expect(zoneHeight).toBeLessThanOrEqual(rowsHeight + 2);
  });

  test('keeps verbose reasoning open when the completed activity accordion is expanded', async ({ page }) => {
    const prefs = defaultResponses['GET /users/me/preferences'];
    await mockAPI(page, {
      ...chatViewOverrides(),
      'GET /users/me/preferences': { ...prefs, other_preference: { ...prefs.other_preference, turn_display: 'verbose' } },
    });
    await configureSSE({ method: 'GET', path: `/api/v1/threads/${TH}/messages/replay`, events: [sseEvents.replayDone()], delay: 10 });
    await configureSSE({ method: 'POST', path: `/api/v1/threads/${TH}/messages`, events: [
      sseEvents.toolCalls([{ name: 'bash', args: { command: 'echo ready' }, id: 'toolu_ready' }]),
      sseEvents.finishToolCalls(),
      { ...sseEvents.toolCallResult('toolu_ready', 'ready'), delayAfter: MIN_LIVE_EXPOSURE_MS + 300 },
      sseEvents.messageChunk('start', 'reasoning_signal'),
      { ...sseEvents.messageChunk('**Comparing inputs**\n\nChecking the supplied evidence.', 'reasoning'), delayAfter: 3500 },
      sseEvents.messageChunk('complete', 'reasoning_signal'),
      sseEvents.messageChunk('Comparison complete.'),
      sseEvents.finishStop(),
      sseEvents.creditUsage(),
    ], delay: 30 });
    await page.goto(`/chat/t/${TH}`);
    await page.locator('textarea').fill('Compare the inputs');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const thought = page.getByRole('button', { name: 'Comparing inputs', exact: true });
    await expect(thought).toHaveAttribute('aria-expanded', 'true');
    const body = page.locator('[data-activity-state="live"] .titem-reasoning-card');
    await expect(body).toBeVisible();
    await page.locator('[id^="activity-summary-"]').click();
    await expect(thought).toHaveAttribute('aria-expanded', 'true');
    await expect(body).toBeVisible();
    await expect(page.locator('[data-turn-fold]')).toHaveAttribute('data-turn-fold', 'collapsed', { timeout: 15000 });
    await page.locator('[data-turn-fold] button').click();
    await expect(thought).toHaveAttribute('aria-expanded', 'false');
  });

  test('keeps progress visible while the first paragraph is withheld', async ({ page }) => {
    const prefs = defaultResponses['GET /users/me/preferences'];
    await mockAPI(page, {
      ...chatViewOverrides(),
      'GET /users/me/preferences': { ...prefs, other_preference: { ...prefs.other_preference, response_streaming_mode: 'paragraph' } },
    });
    await configureSSE({ method: 'GET', path: `/api/v1/threads/${TH}/messages/replay`, events: [sseEvents.replayDone()], delay: 10 });
    await configureSSE({ method: 'POST', path: `/api/v1/threads/${TH}/messages`, events: [
      ...Array.from({ length: 40 }, () => sseEvents.messageChunk('Still writing. ')),
      sseEvents.finishStop(),
      sseEvents.creditUsage(),
    ], delay: 100 });
    await page.goto(`/chat/t/${TH}`);
    await page.locator('textarea').fill('Write one paragraph');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByTestId('streaming-indicator')).toBeAttached();
    // More than the 700ms arrival window, while chunks continue every 100ms.
    await page.waitForTimeout(1000);
    await expect(page.locator('[data-message-role="assistant"] .markdown-content')).toHaveCount(0);
    await expect(page.getByTestId('streaming-indicator')).toHaveCSS('opacity', '1', { timeout: 500 });
    await expect(page.getByTestId('streaming-indicator')).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator('[data-message-role="assistant"]')).toContainText('Still writing. '.repeat(40).trim());
  });

  for (const turnDisplay of ['lean', 'verbose']) {
    test(`respects ${turnDisplay} reasoning in a live subagent transcript`, async ({ page }) => {
      const prefs = defaultResponses['GET /users/me/preferences'];
      await mockAPI(page, {
        ...chatViewOverrides(),
        'GET /users/me/preferences': { ...prefs, other_preference: { ...prefs.other_preference, turn_display: turnDisplay } },
      });
      await configureSSE({ method: 'GET', path: `/api/v1/threads/${TH}/messages/replay`, events: [sseEvents.replayDone()], delay: 10 });
      const taskChunk = (content, type) => {
        const event = sseEvents.messageChunk(content, type);
        return { ...event, data: { ...event.data, agent: 'task:reasoning-check' } };
      };
      await configureSSE({ method: 'POST', path: `/api/v1/threads/${TH}/messages`, events: [
        sseEvents.toolCalls([{ name: 'Task', args: { description: 'Review the evidence', prompt: 'Review the evidence' }, id: 'toolu_task' }]),
        sseEvents.finishToolCalls(),
        { event: 'artifact', data: { thread_id: TH, artifact_type: 'task', tool_call_id: 'toolu_task', payload: { task_id: 'reasoning-check', action: 'spawned', description: 'Review the evidence', type: 'research' } } },
        taskChunk('start', 'reasoning_signal'),
        taskChunk('**Inspecting evidence**\n\nThe subagent is comparing source documents.', 'reasoning'),
        { ...sseEvents.messageChunk('Review underway.'), delayAfter: 8000 },
        taskChunk('complete', 'reasoning_signal'),
        sseEvents.messageChunk('Review complete.'),
        sseEvents.finishStop(),
      ], delay: 50 });
      await page.goto(`/chat/t/${TH}`);
      await page.locator('textarea').fill('Review the evidence');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(page.getByText('Review underway.', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: /general-purpose.*Review the evidence/ }).click();
      const thought = page.getByRole('button', { name: 'Inspecting evidence', exact: true });
      await expect(thought).toHaveAttribute('aria-expanded', String(turnDisplay === 'verbose'));
      const body = page.getByText('The subagent is comparing source documents.', { exact: true });
      if (turnDisplay === 'lean') {
        await expect(body).toBeHidden();
        await thought.click();
      }
      await expect(body).toBeVisible();
    });
  }

});
