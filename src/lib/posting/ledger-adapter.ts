import { commitEntry, createDraftEntry, createJournalEntry, reverseEntry } from '@/lib/bookkeeping/engine'
import { createJournalEntries } from '@/lib/bookkeeping/journal-entry-batch'
import { correctEntry, recordateEntry } from '@/lib/core/bookkeeping/storno-service'
import type { PostingAdapter } from './types'

/**
 * The ledger adapter: the engine, called with the producer's own arguments.
 *
 * The input is passed through as the same object, never copied or rebuilt,
 * and an argument the producer did not pass is not passed either: with no
 * event link and no producer options the engine sees exactly the call the
 * producer made before the port existed (pinned by the producers'
 * *.engine-input.test.ts fixtures). One exception, kept for the pilot's
 * fixture: createJournalEntry always passes the commitMethod and
 * rubricVersion positions (the pilot's own six-argument call), which a
 * four-argument producer receives as undefined, the value its omitted
 * optional parameters already had.
 */
export const ledgerAdapter: PostingAdapter = {
  id: 'ledger',

  createJournalEntry({ supabase, companyId, userId, input, commitMethod, rubricVersion, options, businessEvent }) {
    const engineOptions = businessEvent ? { ...options, businessEvent } : options
    return engineOptions === undefined
      ? createJournalEntry(supabase, companyId, userId, input, commitMethod, rubricVersion)
      : createJournalEntry(supabase, companyId, userId, input, commitMethod, rubricVersion, engineOptions)
  },

  createJournalEntries({ supabase, companyId, userId, inputs, businessEvent }) {
    return businessEvent
      ? createJournalEntries(supabase, companyId, userId, inputs, { businessEvent })
      : createJournalEntries(supabase, companyId, userId, inputs)
  },

  createDraftEntry({ supabase, companyId, userId, input, options, businessEvent }) {
    const engineOptions = businessEvent ? { ...options, businessEvent } : options
    return engineOptions === undefined
      ? createDraftEntry(supabase, companyId, userId, input)
      : createDraftEntry(supabase, companyId, userId, input, engineOptions)
  },

  commitEntry({ supabase, companyId, userId, entryId, commitMethod, rubricVersion }) {
    if (rubricVersion !== undefined) return commitEntry(supabase, companyId, userId, entryId, commitMethod, rubricVersion)
    return commitMethod === undefined
      ? commitEntry(supabase, companyId, userId, entryId)
      : commitEntry(supabase, companyId, userId, entryId, commitMethod)
  },

  reverseEntry({ supabase, companyId, userId, entryId, reversalDate, options, businessEvent }) {
    const engineOptions = businessEvent ? { ...options, businessEvent } : options
    if (engineOptions !== undefined) return reverseEntry(supabase, companyId, userId, entryId, reversalDate, engineOptions)
    return reversalDate === undefined
      ? reverseEntry(supabase, companyId, userId, entryId)
      : reverseEntry(supabase, companyId, userId, entryId, reversalDate)
  },

  correctEntry({ supabase, companyId, userId, entryId, correction, businessEvents }) {
    if ('newDate' in correction) {
      const options = businessEvents ? { ...correction.options, businessEvents } : correction.options
      return options === undefined
        ? recordateEntry(supabase, companyId, userId, entryId, correction.newDate)
        : recordateEntry(supabase, companyId, userId, entryId, correction.newDate, options)
    }
    const options = businessEvents ? { ...correction.options, businessEvents } : correction.options
    return options === undefined
      ? correctEntry(supabase, companyId, userId, entryId, correction.lines)
      : correctEntry(supabase, companyId, userId, entryId, correction.lines, options)
  },
}
