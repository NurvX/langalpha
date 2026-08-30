/**
 * The credit-pause half of an HITL resume: which pause a resume is answering,
 * and what to put back when it is refused. Extracted from useChatMessages
 * (carve B).
 */

import type { MutableRefObject } from 'react';
import type { CreditPauseStatus } from '@/types/chat';
import type { SetMessages } from '../types';
import { setCardStatus } from './buckets';

type HitlDecisions = { decisions: Array<{ type: string; message?: string }> };

export interface CreditPauseResumeRefs {
  /** The pause the in-flight resume answers, null when it answers none. */
  pauseId: MutableRefObject<string | null>;
  pendingInterruptIds: MutableRefObject<Set<string>>;
  collectedHitlResponses: MutableRefObject<Record<string, HitlDecisions>>;
  /** Bumped on every new run and every thread switch, so a settler can tell
   *  whether the board it snapshotted is still the board on screen. */
  sessionEpoch: MutableRefObject<number>;
  setMessages: SetMessages;
}

/**
 * Move the in-flight pause card, once. The one unacceptable outcome is a card
 * left on `resuming` with no way left to answer the pause, so every exit from a
 * resume comes through here.
 */
export function settleCreditPause(refs: CreditPauseResumeRefs, status: CreditPauseStatus): void {
  const pauseId = refs.pauseId.current;
  if (!pauseId) return;
  refs.pauseId.current = null;
  refs.setMessages((prev) => setCardStatus(prev, 'creditPauses', pauseId, status));
}

/**
 * Snapshot the interrupt board for one resume attempt and return its settler.
 *
 * Clearing the board assumes the resume is admitted. It can be refused, and an
 * empty board then fails the `pending.size > 0` gate in
 * collectHitlResponseAndMaybeResume, so every later click is dropped and the
 * interrupt becomes unanswerable. The settler puts the snapshot back.
 */
export function beginResume(refs: CreditPauseResumeRefs): (admitted: boolean) => void {
  const priorPendingIds = new Set(refs.pendingInterruptIds.current);
  const priorCollected = { ...refs.collectedHitlResponses.current };
  // The board belongs to the thread that armed it. A thread switch clears the
  // board and bumps the epoch, but this settler runs later still, from the
  // aborted stream's `finally` — so unfenced, a refused resume on thread A
  // restores A's pending ids on top of thread B. Nothing on B will ever
  // collect them, and B's own interrupt then fails the `every(id => collected)`
  // batch gate for good. Refusal plus navigation is the ordinary path here,
  // not an exotic one: answering a credit pause means leaving to buy credits.
  const epoch = refs.sessionEpoch.current;
  return (admitted: boolean) => {
    if (refs.sessionEpoch.current !== epoch) return;
    if (!admitted) {
      refs.pendingInterruptIds.current = priorPendingIds;
      refs.collectedHitlResponses.current = priorCollected;
    }
    settleCreditPause(refs, admitted ? 'resumed' : 'pending');
  };
}
