import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { cancelOrphanedEntry } from '@/lib/bookkeeping/engine'
import { EntryAlreadyReversedError, getUnusedVoucherAllocation } from '@/lib/bookkeeping/errors'
import { CASH_ACCOUNT_BUSY_RETRY, isCashAccountBusy, waitBeforeBusyRetry } from '@/lib/bookkeeping/cash-account-busy'
import { voucherStornoBusinessEvent } from '@/lib/bookkeeping/ledger-business-events'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'

const log = createLogger('cancel-orphaned-entry')

/**
 * Document a single voucher number as an explained break in the
 * verifikationsnummerserie (BFNAR 2013:2: the series must be unbroken, and any
 * break needs a documented reason; an undocumented one blocks year-end
 * closing in `checkYearEndReadiness`).
 *
 * A stranded voucher occupies exactly one number, so the gap is the closed
 * range [voucherNumber, voucherNumber]. Every reader keys explanations on
 * `voucher_series:gap_start:gap_end` (the /bookkeeping voucher-gaps view, the
 * `gnubok_list_voucher_gaps` MCP tool, the year-end readiness check), so a
 * single-number gap MUST be written with gap_start === gap_end or it is
 * invisible to all of them.
 *
 * Columns are exactly the table's: company_id, user_id, fiscal_period_id,
 * voucher_series, gap_start, gap_end, explanation. All are NOT NULL.
 *
 * Never throws. Every caller is already on a decided error path (the CAS
 * conflict response is correct for the client and must not be replaced by a
 * 500), so a failure is logged at error level with the full payload an
 * operator needs to file the row by hand. It is logged, never swallowed.
 *
 * @returns true when the gap is documented (or already was), false otherwise.
 */
export async function recordVoucherGapExplanation(
  supabase: SupabaseClient,
  params: {
    companyId: string
    userId: string
    fiscalPeriodId: string
    voucherSeries: string
    voucherNumber: number
    explanation: string
  },
): Promise<boolean> {
  const payload = {
    company_id: params.companyId,
    user_id: params.userId,
    fiscal_period_id: params.fiscalPeriodId,
    voucher_series: params.voucherSeries,
    gap_start: params.voucherNumber,
    gap_end: params.voucherNumber,
    explanation: params.explanation,
  }

  try {
    const { error } = await supabase.from('voucher_gap_explanations').insert(payload)

    if (error) {
      // 23505 = the exact gap is already documented (unique on
      // company_id, fiscal_period_id, voucher_series, gap_start, gap_end).
      // A retry hitting an existing row is the desired end state, and the
      // stored explanation (possibly a human's) wins.
      if ((error as { code?: string }).code === '23505') return true

      log.error('failed to record voucher gap explanation (gap stays undocumented)', error, payload)
      return false
    }
    return true
  } catch (err) {
    log.error(
      'unexpected failure recording voucher gap explanation (gap stays undocumented)',
      err as Error,
      payload,
    )
    return false
  }
}

/**
 * Storno a posted journal entry that could not be linked to its transaction.
 *
 * The bookkeeping engine posts entries before the transaction CAS runs. When
 * that CAS definitively fails, the entry is immutable and must be reversed,
 * never edited or cancelled in place. Compensation is best-effort so the
 * caller can preserve the original conflict response.
 *
 * The storno goes through the posting port: while POSTING_EVENTS is on, its
 * event is linked to the storno's draft before its number is drawn, and
 * under strict a failed event write stops the storno like any other failure
 * here. A door passes `stornoEvent` (step 2e: ledger.storno of the record it
 * could not link); without one (step 2i) the event is ledger.storno of the
 * verifikat reversed, system_derived: nobody chose this storno, the
 * compensation did. The engine gets the call it always did.
 *
 * A storno refused by the busy bank-account lock (cash-account-busy.ts: its
 * lines insert, or the compare-and-set that marks the original reversed,
 * which the engine reports as EntryAlreadyReversedError after cancelling its
 * own reversal) changed nothing, so it is tried again while the original
 * still stands: posted, with no posted storno pointing at it. Given up on the
 * first refusal, the verifikat stayed posted beside a bank row that still
 * read as unbooked, and the row was then booked a second time.
 */
export async function reverseOrphanedJournalEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  journalEntryId: string,
  gapExplanation: string,
  stornoEvent?: () => BusinessEventDraft,
): Promise<void> {
  const retryDelays = CASH_ACCOUNT_BUSY_RETRY.delaysMs
  for (let attempt = 0; ; attempt++) {
    let reverseError: unknown
    try {
      await postingPort.reverseJournalEntry({
        supabase,
        companyId,
        userId,
        entryId: journalEntryId,
        event:
          stornoEvent ??
          (() =>
            voucherStornoBusinessEvent({ entryId: journalEntryId, occurredOn: todayIsoStockholm(), linkBasis: linkBasisColumns('system_derived') })),
        role: 'reversal',
      })
      return
    } catch (err) {
      reverseError = err
    }

    const unusedVoucher = getUnusedVoucherAllocation(reverseError)
    // The original posted voucher is live accounting evidence, never a gap.
    // Only the engine can identify an exact reversal number that its durable
    // sequence allocated before a reversal row existed.
    if (unusedVoucher) {
      await recordVoucherGapExplanation(supabase, {
        companyId,
        userId,
        fiscalPeriodId: unusedVoucher.fiscalPeriodId,
        voucherSeries: unusedVoucher.voucherSeries,
        voucherNumber: unusedVoucher.voucherNumber,
        explanation: gapExplanation,
      })
    }

    const busyRefusal = isCashAccountBusy(reverseError) || reverseError instanceof EntryAlreadyReversedError
    const delayMs = retryDelays[attempt]
    if (busyRefusal && delayMs !== undefined && (await orphanStillStands(supabase, companyId, journalEntryId))) {
      log.warn('storno of orphaned journal entry refused by a busy bank-account lock; retrying', {
        companyId,
        journalEntryId,
        attempt: attempt + 1,
      })
      await waitBeforeBusyRetry(delayMs)
      continue
    }

    log.error('failed to storno orphaned journal entry', reverseError as Error, {
      companyId,
      journalEntryId,
      unusedVoucher,
    })
    return
  }
}

/**
 * The orphan still needs its storno: posted, and no posted storno points at
 * it. Anything else (reversed meanwhile, a storno that landed but whose
 * cleanup failed, an unreadable state) stops the retries: a second storno of
 * an entry already netted would reverse it twice. Never throws.
 */
async function orphanStillStands(supabase: SupabaseClient, companyId: string, journalEntryId: string): Promise<boolean> {
  try {
    const { data: entry, error } = await supabase
      .from('journal_entries')
      .select('status')
      .eq('company_id', companyId)
      .eq('id', journalEntryId)
      .maybeSingle()
    if (error || (entry as { status?: string } | null)?.status !== 'posted') return false
    const { data: stornos, error: stornoError } = await supabase
      .from('journal_entries')
      .select('id')
      .eq('company_id', companyId)
      .eq('reverses_id', journalEntryId)
      .eq('status', 'posted')
      .limit(1)
    if (stornoError) return false
    return (stornos ?? []).length === 0
  } catch (err) {
    log.warn('could not read whether the orphaned journal entry still stands; not retrying its storno', err as Error, {
      companyId,
      journalEntryId,
    })
    return false
  }
}

/**
 * Compensation for the payment-flow CAS guard: a payment voucher was posted,
 * but the invoice row was settled by a concurrent request between our read
 * and write, so the voucher belongs to no payment. Cancel it and document
 * the voucher-number gap (BFNAR 2013:2 requires gaps to be explained).
 *
 * Mirrors the inline compensation the mark-paid route has always had; the
 * match routes previously returned MATCH_SI_NOT_OPEN and left the voucher
 * orphaned in the ledger.
 *
 * The cancel and the gap explanation run in one database transaction through
 * the engine's gated cleanup door (cancel_orphaned_entry): a posted voucher
 * can only be cancelled there, and only as the fresh orphan of the acting
 * user's own workflow. The voucher keeps its lines.
 *
 * Best-effort by design: the CAS conflict response is already correct for
 * the caller, so failures here are logged loudly rather than thrown.
 */
export async function cancelOrphanedPaymentEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  journalEntryId: string,
  explanation: string,
): Promise<void> {
  try {
    const { error } = await cancelOrphanedEntry(supabase, companyId, userId, journalEntryId, {
      gapExplanation: explanation,
    })
    if (error) {
      // The voucher stays posted and visible; this line carries what an
      // operator needs to storno it and document the gap by hand.
      log.error('failed to cancel orphaned payment voucher (manual cleanup needed)', error, {
        companyId,
        journalEntryId,
        explanation,
      })
    }
  } catch (err) {
    // Hard never-throw guarantee: the caller is about to return the correct
    // CAS-conflict response, and an unexpected rejection here must not
    // replace it with a 500.
    log.error('unexpected failure while cancelling orphaned payment voucher', err as Error, {
      companyId,
      journalEntryId,
    })
  }
}
