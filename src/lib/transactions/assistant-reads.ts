/**
 * The assistant's stored reads of bank rows, as the proposals ask for them
 * (proposeForTransactions, ./propose.ts): the plug-in point through which the
 * agent block answers, so the bank side never imports it. The agent keeps one
 * read per row (transaction_assistant_reads) and says what it proposes; where
 * that proposal ranks among the row's others, and what it contests, stays
 * with the proposals (./propose.ts).
 *
 * The agent answers in lib/agent/categorize/bank-reads.ts; the static wiring
 * the proposals import is lib/composition/assistant-reads.ts.
 *
 * Imports nothing at runtime: the block that answers depends on this file's
 * types only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AssistantRead } from '@/lib/agent/categorize/read-shape'
import type { BookingProposal } from '@/lib/bookkeeping/proposal'
import type { EntityType, Transaction } from '@/types'

export interface AssistantReads {
  /** The stored reads for these rows, keyed by transaction id. */
  load(supabase: SupabaseClient, companyId: string, transactionIds: string[]): Promise<Map<string, AssistantRead>>
  /** Whether a read still stands for the row (it pins the document the read was made with). */
  isFresh(read: AssistantRead, tx: Transaction): boolean
  /** The read as a row proposal; null when the assistant found nothing that fits. */
  proposal(read: AssistantRead, tx: Transaction, entityType: EntityType | undefined): BookingProposal | null
}
