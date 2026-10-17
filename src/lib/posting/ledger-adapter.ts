import { createJournalEntry, reverseEntry } from '@/lib/bookkeeping/engine'
import type { PostingAdapter } from './types'

/**
 * The ledger adapter: the engine, called with the producer's own arguments.
 *
 * The input is passed through as the same object, never copied or rebuilt,
 * and an argument the producer did not pass is not passed either: with no
 * event link and no producer options the engine sees exactly the call the
 * producer made before the port existed (pinned by
 * lib/bookkeeping/__tests__/transaction-entries.engine-input.test.ts).
 */
export const ledgerAdapter: PostingAdapter = {
  id: 'ledger',

  createJournalEntry({ supabase, companyId, userId, input, commitMethod, rubricVersion, options, businessEvent }) {
    const engineOptions = businessEvent ? { ...options, businessEvent } : options
    return engineOptions === undefined
      ? createJournalEntry(supabase, companyId, userId, input, commitMethod, rubricVersion)
      : createJournalEntry(supabase, companyId, userId, input, commitMethod, rubricVersion, engineOptions)
  },

  reverseEntry({ supabase, companyId, userId, entryId, reversalDate, options, businessEvent }) {
    const engineOptions = businessEvent ? { ...options, businessEvent } : options
    return engineOptions === undefined
      ? reverseEntry(supabase, companyId, userId, entryId, reversalDate)
      : reverseEntry(supabase, companyId, userId, entryId, reversalDate, engineOptions)
  },
}
