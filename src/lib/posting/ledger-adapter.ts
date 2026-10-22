import type { SupabaseClient } from '@supabase/supabase-js'
import {
  commitAssetDepreciation,
  commitAssetDisposal,
  commitBulkBooking,
  commitCounterpartySetoff,
  commitEntry,
  commitExpensePayoutBatch,
  commitInvoiceVoucherLink,
  commitMatchBatchAllocation,
  commitSupplierInvoiceVoucherLink,
  createDraftEntry,
  createJournalEntry,
  replaceOpeningBalanceEntry,
  reverseEntry,
} from '@/lib/bookkeeping/engine'
import { createJournalEntries } from '@/lib/bookkeeping/journal-entry-batch'
import { correctEntry, recordateEntry } from '@/lib/core/bookkeeping/storno-service'
import type { PostingAdapter, SqlPostingDoors, SqlPostingFunction, SqlPostingResult } from './types'

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
 *
 * commitSqlPosting hands a SQL posting function's wrapper the producer's
 * arguments as they came, spread, so the function gets the request a direct
 * call sent (pinned by sql-posting-doors.rpc-input.test.ts).
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

  commitSqlPosting({ supabase, companyId, userId, fn, args }) {
    // The request ties fn to its wrapper's arguments; the call itself is generic.
    const door = sqlPostingDoor(fn) as (
      supabase: SupabaseClient,
      companyId: string,
      userId: string,
      ...rest: unknown[]
    ) => Promise<SqlPostingResult<typeof fn>>
    return door(supabase, companyId, userId, ...args)
  },
}

/**
 * The engine wrapper of a SQL posting function, looked up when it is called
 * (not captured when this module loads), as every other door here reads its
 * engine function.
 */
function sqlPostingDoor<F extends SqlPostingFunction>(fn: F): SqlPostingDoors[F]
function sqlPostingDoor(fn: SqlPostingFunction): SqlPostingDoors[SqlPostingFunction] {
  switch (fn) {
    case 'bulk_book_transactions':
      return commitBulkBooking
    case 'match_batch_allocate':
      return commitMatchBatchAllocation
    case 'link_invoice_to_voucher':
      return commitInvoiceVoucherLink
    case 'link_supplier_invoice_to_voucher':
      return commitSupplierInvoiceVoucherLink
    case 'create_expense_payout_batch':
      return commitExpensePayoutBatch
    case 'commit_opening_balance_replacement':
      return replaceOpeningBalanceEntry
    case 'commit_asset_depreciation':
      return commitAssetDepreciation
    case 'commit_asset_disposal':
      return commitAssetDisposal
    case 'book_counterparty_setoff':
      return commitCounterpartySetoff
    default: {
      const unknown: never = fn
      throw new Error(`no engine wrapper for SQL posting function ${String(unknown)}`)
    }
  }
}
