/**
 * The assistant's stored reads as the bank rows' proposals ask for them
 * (contract: lib/transactions/assistant-reads.ts). Written out by hand and
 * imported statically by proposeForTransactions: no lazy registration, no
 * lib/init, no event bus. The answer lives with the agent block.
 */
import type { AssistantReads } from '@/lib/transactions/assistant-reads'
import { bankAssistantReads } from '@/lib/agent/categorize/bank-reads'

export const ASSISTANT_READS: AssistantReads = bankAssistantReads
