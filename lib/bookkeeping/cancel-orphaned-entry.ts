import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { getUnusedVoucherAllocation } from '@/lib/bookkeeping/errors'

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
 */
export async function reverseOrphanedJournalEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  journalEntryId: string,
  gapExplanation: string,
): Promise<void> {
  let unusedVoucher: ReturnType<typeof getUnusedVoucherAllocation> = null
  try {
    await reverseEntry(supabase, companyId, userId, journalEntryId)
    return
  } catch (reverseError) {
    unusedVoucher = getUnusedVoucherAllocation(reverseError)
    log.error('failed to storno orphaned journal entry', reverseError as Error, {
      companyId,
      journalEntryId,
      unusedVoucher,
    })
  }

  // The original posted voucher is live accounting evidence, never a gap.
  // Only the engine can identify an exact reversal number that its durable
  // sequence allocated before a reversal row existed.
  if (!unusedVoucher) return

  await recordVoucherGapExplanation(supabase, {
    companyId,
    userId,
    fiscalPeriodId: unusedVoucher.fiscalPeriodId,
    voucherSeries: unusedVoucher.voucherSeries,
    voucherNumber: unusedVoucher.voucherNumber,
    explanation: gapExplanation,
  })
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
    const { data: orphan, error: fetchError } = await supabase
      .from('journal_entries')
      .select('fiscal_period_id, voucher_series, voucher_number')
      .eq('id', journalEntryId)
      .eq('company_id', companyId)
      .single()

    if (fetchError) {
      log.error('failed to load orphaned payment voucher for cancellation', fetchError, {
        companyId,
        journalEntryId,
      })
    }

    // Recovery breadcrumb BEFORE mutating: the cancel and the gap insert are
    // separate statements, so a crash between them would leave a cancelled
    // voucher with no gap explanation (BFNAR 2013:2 requires one). This line
    // carries everything an operator needs to write it manually.
    if (orphan) {
      log.info('cancelling orphaned payment voucher', {
        companyId,
        journalEntryId,
        voucherSeries: orphan.voucher_series || 'A',
        voucherNumber: orphan.voucher_number,
        fiscalPeriodId: orphan.fiscal_period_id,
        explanation,
      })
    }

    const { error: cancelError } = await supabase
      .from('journal_entries')
      .update({ status: 'cancelled' })
      .eq('id', journalEntryId)
      .eq('company_id', companyId)

    if (cancelError) {
      log.error('failed to cancel orphaned payment voucher (manual cleanup needed)', cancelError, {
        companyId,
        journalEntryId,
      })
      return
    }

    if (orphan) {
      await recordVoucherGapExplanation(supabase, {
        companyId,
        userId,
        fiscalPeriodId: orphan.fiscal_period_id,
        voucherSeries: orphan.voucher_series || 'A',
        voucherNumber: orphan.voucher_number,
        explanation,
      })
    }
  } catch (err) {
    // Hard never-throw guarantee: the caller is about to return the correct
    // CAS-conflict response, and an unexpected rejection here (network blip,
    // driver error) must not replace it with a 500. The orphan stays posted
    // and visible; the breadcrumb above covers manual recovery.
    log.error('unexpected failure while cancelling orphaned payment voucher', err as Error, {
      companyId,
      journalEntryId,
    })
  }
}
