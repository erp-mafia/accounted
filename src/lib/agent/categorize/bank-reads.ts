/**
 * The agent's answer to the bank side's question about its stored reads
 * (contract: lib/transactions/assistant-reads.ts; wiring:
 * lib/composition/assistant-reads.ts). Each member calls the function the
 * proposals called directly before, with the same arguments.
 */
import type { AssistantReads } from '@/lib/transactions/assistant-reads'
import { assistantSuggestionFromRead, loadReads, readIsFresh } from './read'

export const bankAssistantReads: AssistantReads = Object.freeze<AssistantReads>({
  load: (supabase, companyId, transactionIds) => loadReads(supabase, companyId, transactionIds),
  isFresh: (read, tx) => readIsFresh(read, tx),
  proposal: (read, tx, entityType) => assistantSuggestionFromRead(read, tx, entityType),
})
