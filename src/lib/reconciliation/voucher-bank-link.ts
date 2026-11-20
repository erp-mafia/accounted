/**
 * A verifikat someone typed by hand meets the bank rows that are already in.
 *
 * The bank matcher links a bank row to the verifikat that books it when the
 * row arrives (a bank sync, a bank file) or when the books do (a SIE import).
 * A verifikat typed afterwards on a bank account, for a row that was already
 * there, met nothing: the row stayed under Att bokföra with Bokför beside the
 * verifikat that books it, which invites booking the money twice (crm#1958:
 * a bank booking reversed and typed again by hand).
 *
 * So every door that posts a typed verifikat runs the same matcher for that
 * verifikat once it is posted. Nothing here decides what a match is:
 * tryReconcileTransaction does, with the unattended floor and the writes of
 * every other sweep (the link, its behandlingshistorik row, the event). Same
 * amount on the same date on the same account links the row; a date a few
 * days off leaves a suggestion on the row for a person to confirm.
 *
 * It never guesses. The run covers every open row and every unlinked
 * verifikat of the account inside the window (the verifikat's date, the reach
 * of the date rule to each side) and keeps this verifikat's match only when
 * nothing there rivals it: two open rows that fit equally, or another
 * unlinked verifikat that books the same row, leave everything as it was for
 * a person to pick (runReconciliation's onlyJournalEntryIds).
 *
 * Which accounts carry bank rows is cash_accounts' answer, never an account
 * range: a card or a payout account has rows too. A company with no
 * cash_accounts row is left as it was (the sweep never widens a named account
 * to the pooled 1930 run). A verifikat between two accounts that both carry
 * rows gets the first account's row only, as in every sweep: the candidate
 * read drops a verifikat once a row points at it.
 *
 * The other order, a typed verifikat for a row that is booked already, is the
 * warning the same doors give before posting (voucher-duplicate-check.ts,
 * BANK_MOVEMENT_ALREADY_BOOKED).
 *
 * Best-effort: the verifikat is posted whatever happens here. A failure is
 * logged and the row stays open for Matcha mot befintlig verifikation.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { addDaysIso } from '@/lib/dates/iso'
import { MATCH_DATE_RANGE_DAYS } from './bank-reconciliation'
import { runUnattendedReconciliationSweep } from './unattended-sweep'

export interface PostedTypedVoucher {
  journalEntryId: string
  entryDate: string
  lines: ReadonlyArray<{ account_number: string }>
}

export interface VoucherBankLinkResult {
  /** Open bank rows now linked to the verifikat. */
  linked: number
  /** Open bank rows that carry the verifikat as a suggestion. */
  suggested: number
}

export async function linkOpenBankRowsToVoucher(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  voucher: PostedTypedVoucher,
  log: Logger,
): Promise<VoucherBankLinkResult> {
  const ledgerAccounts = [...new Set(voucher.lines.map((line) => line.account_number))]
  if (ledgerAccounts.length === 0) return { linked: 0, suggested: 0 }
  try {
    const sweep = await runUnattendedReconciliationSweep(supabase, companyId, userId, {
      dateFrom: addDaysIso(voucher.entryDate, -MATCH_DATE_RANGE_DAYS),
      dateTo: addDaysIso(voucher.entryDate, MATCH_DATE_RANGE_DAYS),
      ledgerAccounts,
      journalEntryIds: [voucher.journalEntryId],
    })
    if (sweep.errors > 0) {
      log.warn('typed verifikat posted, the bank matcher ran with errors; a bank row may still be open', {
        companyId,
        journalEntryId: voucher.journalEntryId,
        errors: sweep.errors,
      })
    }
    if (sweep.applied > 0 || sweep.suggested > 0) {
      log.info('typed verifikat met its open bank rows', {
        companyId,
        journalEntryId: voucher.journalEntryId,
        linked: sweep.applied,
        suggested: sweep.suggested,
      })
    }
    return { linked: sweep.applied, suggested: sweep.suggested }
  } catch (err) {
    log.error('typed verifikat posted but the bank matcher failed; its bank row stays open', err as Error, {
      companyId,
      journalEntryId: voucher.journalEntryId,
    })
    return { linked: 0, suggested: 0 }
  }
}
