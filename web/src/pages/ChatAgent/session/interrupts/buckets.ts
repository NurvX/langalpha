/**
 * Shared interrupt descriptors — the one place the HITL card vocabulary is
 * declared. Both projections (live stream and history replay) key off these
 * tables; the dedup rebuild in messageFinalizers walks INTERRUPT_CARD_BUCKETS.
 * A new interrupt type registers here first, then adds its projection branches.
 */

import type { AssistantMessage } from '@/types/chat';
import { updateMessage } from '../../hooks/utils/messageHelpers';
import type { HistoryInterruptInfo, MessageRecord, SetMessages } from '../types';

/** Interrupt types that map to proposal-based HITL cards (workspace, question, ptc, secretary). */
const PROPOSAL_INTERRUPT_TYPES = new Set([
  'create_workspace', 'start_question', 'ptc_agent',
  'delete_workspace', 'stop_workspace', 'delete_thread',
]);

/** Maps interrupt types to their proposal bucket key on AssistantMessage. */
const PROPOSAL_DATA_KEY_MAP: Record<string, string> = {
  create_workspace: 'workspaceProposals',
  start_question: 'questionProposals',
  ptc_agent: 'ptcAgentProposals',
  delete_workspace: 'secretaryActionProposals',
  stop_workspace: 'secretaryActionProposals',
  delete_thread: 'secretaryActionProposals',
};

/** Secretary action interrupt types (for type guard in handlers). */
const SECRETARY_ACTION_TYPES = new Set(['delete_workspace', 'stop_workspace', 'delete_thread']);

/**
 * Message-map buckets whose entries carry an `interruptId` (rendered HITL
 * cards). `satisfies keyof AssistantMessage` makes a renamed/added bucket a
 * compile error here instead of a silently-wrong dedup rebuild.
 */
const INTERRUPT_CARD_BUCKETS = [
  'planApprovals', 'userQuestions', 'workspaceProposals',
  'questionProposals', 'ptcAgentProposals', 'secretaryActionProposals',
  'creditPauses',
] as const satisfies readonly (keyof AssistantMessage)[];

/**
 * Flip one card's status wherever it lives. A deduped re-raise can put the card
 * on a bubble other than the one the answer came from, so every assistant
 * message is searched rather than the one that was clicked.
 */
function setCardStatus(
  messages: MessageRecord[],
  bucket: string,
  cardId: string,
  status: string,
): MessageRecord[] {
  return messages.map((m) => {
    if (m.role !== 'assistant') return m;
    const cards = (m as unknown as Record<string, Record<string, Record<string, unknown>>>)[bucket];
    if (!cards?.[cardId]) return m;
    return { ...(m as AssistantMessage), [bucket]: { ...cards, [cardId]: { ...cards[cardId], status } } };
  });
}

/** Which card a resolved history interrupt writes to, and what it writes. */
interface HistoryCardPatch {
  bucket: string;
  key: string;
  fields: Record<string, unknown>;
}

/**
 * Settle the first pending history interrupt `match` accepts: merge its patch
 * into the card and drop it from the pending list, so what remains at the end
 * of replay is exactly what the user still owes an answer.
 */
function resolvePendingHistoryInterrupt(
  pending: HistoryInterruptInfo[],
  match: (p: HistoryInterruptInfo) => boolean,
  toPatch: (matched: HistoryInterruptInfo) => HistoryCardPatch,
  setMessages: SetMessages,
): boolean {
  const idx = pending.findIndex(match);
  if (idx === -1) return false;
  const matched = pending[idx];
  const { bucket, key, fields } = toPatch(matched);
  setMessages((prev) =>
    updateMessage(prev, matched.assistantMessageId, (m) => {
      if (m.role !== 'assistant') return m;
      const msg = m as AssistantMessage;
      const cards = ((msg as unknown as Record<string, unknown>)[bucket] || {}) as Record<string, Record<string, unknown>>;
      return { ...msg, [bucket]: { ...cards, [key]: { ...(cards[key] || {}), ...fields } } };
    })
  );
  pending.splice(idx, 1);
  return true;
}

export {
  PROPOSAL_INTERRUPT_TYPES, PROPOSAL_DATA_KEY_MAP, SECRETARY_ACTION_TYPES,
  INTERRUPT_CARD_BUCKETS, setCardStatus, resolvePendingHistoryInterrupt,
};
