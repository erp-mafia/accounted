import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { SupabaseClient } from '@supabase/supabase-js'
import { releaseDoubtfulReserveAfterChange } from '@/lib/customer-loss/doubtful'
import { eventBus } from '@/lib/events'
import { createCreditNoteJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { creditBooksOriginalFirst, creditNoteNeedsJournalEntry } from '@/lib/bookkeeping/booking-mode'
import { cancelSchedulesForSource } from '@/lib/bookkeeping/accruals/service'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { bookInvoice } from '@/lib/invoices/book-service'
import { getDeductionShareBookedByPayout } from '@/lib/invoices/rot-rut-payout-recognition'
import { linkBasisColumns } from '@/lib/links/stamp'
import type { Logger } from '@/lib/logger'
import type { OperationOutcome } from '@/lib/operations/types'
import type { AccountingMethod, CreditNote, EntityType } from '@/types'

export interface CreditNoteOriginalInvoice {
  id: string
  invoice_number: string | null
  status: string
  journal_entry_id?: string | null
  paid_at?: string | null
  paid_amount?: number | null
  total?: number | null
}

/**
 * Lives beside its supplier twin in lib/bookkeeping/booking-mode.ts; re-exported
 * here because the customer-side call sites import it from this module.
 */
export { creditNoteNeedsJournalEntry }

export interface CreditNoteIssueFailure {
  step: 'original_booking' | 'journal_entry' | 'journal_link' | 'accrual_schedules' | 'original_status'
  reason: string
  /** A registered error code the doors answer with instead of the generic issue code. */
  code?: string
  details?: Record<string, unknown>
}

interface IssueCreditNoteInput {
  supabase: SupabaseClient
  companyId: string
  userId: string
  creditNote: CreditNote & { customer?: { name?: string | null } | null }
  originalInvoice: CreditNoteOriginalInvoice
  entityType: EntityType
  accountingMethod: AccountingMethod
  /**
   * company_settings.defer_invoice_booking (#967). With it, an original that
   * was never booked is booked first (accounted#45, creditBooksOriginalFirst).
   */
  deferInvoiceBooking: boolean
  log: Logger
}

export interface IssueCreditNoteResult {
  complete: boolean
  journalEntryId: string | null
  journalEntryRequired: boolean
  repairRequired: boolean
  failures: CreditNoteIssueFailure[]
  /** The original's own verifikat when this call booked it first (accounted#45). */
  originalJournalEntryId?: string
}

/** The codes an incomplete credit issue is answered with. */
export type CreditIssueFailureCode =
  | 'INVOICE_CREDIT_REPAIR_REQUIRED'
  | 'INVOICE_CREDIT_ISSUE_INCOMPLETE'
  | 'INVOICE_CREDIT_ORIGINAL_PERIOD_LOCKED'
  | 'INVOICE_CREDIT_ORIGINAL_BOOK_FAILED'

/**
 * The code a door answers an incomplete issue with: a refusal that carries
 * its own registered code (the original could not be booked, accounted#45)
 * names the fix; anything else is the generic incomplete or repair code.
 */
export function creditIssueFailureCode(issue: {
  repairRequired: boolean
  failures: CreditNoteIssueFailure[]
}): { code: CreditIssueFailureCode; details: Record<string, unknown> } {
  const coded = issue.failures.find((failure) => failure.code)
  const failureSteps = issue.failures.map((failure) => failure.step)
  if (coded?.code === 'INVOICE_CREDIT_ORIGINAL_PERIOD_LOCKED' || coded?.code === 'INVOICE_CREDIT_ORIGINAL_BOOK_FAILED') {
    return { code: coded.code, details: { ...(coded.details ?? {}), failure_steps: failureSteps } }
  }
  return {
    code: issue.repairRequired ? 'INVOICE_CREDIT_REPAIR_REQUIRED' : 'INVOICE_CREDIT_ISSUE_INCOMPLETE',
    details: { failure_steps: failureSteps },
  }
}

type BookFailure = Extract<OperationOutcome<unknown>, { ok: false }>

/**
 * The credit refusal for an original the Bokför step would not book
 * (accounted#45). A lock on the original's invoice date gets its own code,
 * which names the fix; every other refusal (no fiscal year, a missing
 * account, a concurrent change) carries the Bokför step's own code in
 * details.original_booking_code. Shared by creditInvoice's dry-run preflight
 * and the issue step below so both doors answer the same way.
 */
export function originalBookingRefusal(
  originalInvoiceId: string,
  failure: BookFailure,
): { code: string; details: Record<string, unknown>; reason: string } {
  if (failure.code === 'PERIOD_LOCKED') {
    const code = 'INVOICE_CREDIT_ORIGINAL_PERIOD_LOCKED'
    return {
      code,
      details: { original_invoice_id: originalInvoiceId, ...(failure.details ?? {}) },
      reason: getErrorEntry(code)?.message_sv ?? code,
    }
  }
  const code = 'INVOICE_CREDIT_ORIGINAL_BOOK_FAILED'
  const errorCode = (failure.error as { code?: unknown } | null | undefined)?.code
  const bookingCode = typeof errorCode === 'string' ? errorCode : failure.code
  // A typed bookkeeping error names the concrete cause (a missing account,
  // an archived dimension); the registered message names the next step.
  const cause = failure.error ? getErrorMessage(failure.error, { context: 'invoice' }) : null
  const message = getErrorEntry(code)?.message_sv ?? code
  return {
    code,
    details: {
      original_invoice_id: originalInvoiceId,
      original_booking_code: bookingCode,
      ...(failure.details ?? {}),
    },
    reason: cause ? `${message} ${cause}` : message,
  }
}

/**
 * Book a deferred original before its credit (accounted#45) through the
 * explicit Bokför step (bookInvoice): the same guards, the invoice's own date,
 * PERIOD_LOCKED before anything is written. The credit note's own date is
 * checked first, so a lock there never leaves the original booked by a credit
 * that cannot post. Never throws.
 */
async function bookOriginalBeforeCredit(input: {
  supabase: SupabaseClient
  companyId: string
  userId: string
  creditNote: CreditNote
  originalInvoiceId: string
  log: Logger
}): Promise<{ ok: true; journalEntryId: string | null } | { ok: false; failure: CreditNoteIssueFailure }> {
  const { supabase, companyId, userId, creditNote, originalInvoiceId, log } = input
  try {
    const creditLock = await checkPeriodLock(supabase, companyId, creditNote.invoice_date)
    if (creditLock.locked || creditLock.reason === 'no_fiscal_period') {
      return {
        ok: false,
        failure: {
          step: 'journal_entry',
          reason: 'Kreditfakturans datum ligger i en låst eller stängd period, eller utanför räkenskapsåren.',
          details: { reason: creditLock.reason, invoice_date: creditNote.invoice_date },
        },
      }
    }

    const outcome = await bookInvoice({ supabase, companyId, userId, log }, originalInvoiceId)
    if (outcome.ok) {
      return { ok: true, journalEntryId: outcome.dryRun ? null : outcome.data.journal_entry_id }
    }
    if (outcome.code === 'INVOICE_BOOK_ALREADY_BOOKED') {
      // Booked by a concurrent Bokför since the original was read: reverse that verifikat.
      const { data } = await supabase
        .from('invoices')
        .select('journal_entry_id')
        .eq('id', originalInvoiceId)
        .eq('company_id', companyId)
        .maybeSingle()
      return { ok: true, journalEntryId: (data?.journal_entry_id as string | null | undefined) ?? null }
    }
    log.warn('original invoice could not be booked before its credit note', {
      originalInvoiceId,
      creditNoteId: creditNote.id,
      code: outcome.code,
    })
    const refusal = originalBookingRefusal(originalInvoiceId, outcome)
    return { ok: false, failure: { step: 'original_booking', ...refusal } }
  } catch (error) {
    log.error('booking the original invoice before its credit note failed', error, {
      originalInvoiceId,
      creditNoteId: creditNote.id,
    })
    const refusal = originalBookingRefusal(originalInvoiceId, { ok: false, code: 'INVOICE_BOOK_FAILED' })
    return { ok: false, failure: { step: 'original_booking', ...refusal } }
  }
}

/**
 * Failure reasons land in the `partial_failures` response field, which is
 * user-visible: map through getErrorMessage so typed engine errors translate
 * and untyped ones fall to the Swedish context fallback instead of leaking
 * the raw message (issue #337). The raw error is always logged at the call
 * site before this runs.
 */
function failureReason(error: unknown): string {
  return getErrorMessage(error, { context: 'invoice' })
}

async function getOriginalVoucherRef(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string | null | undefined,
  log: Logger,
): Promise<string | undefined> {
  if (!journalEntryId) return undefined

  const { data, error } = await supabase
    .from('journal_entries')
    .select('voucher_series, voucher_number')
    .eq('id', journalEntryId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) {
    log.warn('failed to load original voucher reference for credit note', error)
    return undefined
  }

  if (!data?.voucher_series || data.voucher_number == null) return undefined
  // Written into the credit note's verifikationstext ("avser verifikation
  // B-8"): ledger text keeps the hyphen every earlier credit note carries.
  return formatVoucher(data, { separator: '-' })
}

async function findExistingCreditJournalEntry(
  supabase: SupabaseClient,
  companyId: string,
  creditNote: CreditNote,
): Promise<string | null> {
  if (creditNote.journal_entry_id) return creditNote.journal_entry_id

  const { data, error } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('company_id', companyId)
    .eq('source_type', 'credit_note')
    .eq('source_id', creditNote.id)
    .eq('status', 'posted')
    .maybeSingle()

  if (error) throw error
  return data?.id ?? null
}

/**
 * Completes the accounting side of credit-note issuance after the caller has
 * won the draft-to-sent compare-and-set. Every step is idempotent so a sent
 * credit note with incomplete bookkeeping can be repaired without creating a
 * second immutable voucher.
 *
 * Order: the original's own verifikat when a deferred original was never
 * booked (accounted#45), then the credit's reversing verifikat, its link,
 * the original's periodiseringar, and last the original flipped to
 * 'credited'.
 */
export async function issueCreditNote(input: IssueCreditNoteInput): Promise<IssueCreditNoteResult> {
  const {
    supabase,
    companyId,
    userId,
    creditNote,
    originalInvoice,
    entityType,
    accountingMethod,
    deferInvoiceBooking,
    log,
  } = input
  const failures: CreditNoteIssueFailure[] = []
  const journalEntryRequired = creditNoteNeedsJournalEntry(accountingMethod, originalInvoice)
  const booksOriginalFirst = creditBooksOriginalFirst(
    { accounting_method: accountingMethod, defer_invoice_booking: deferInvoiceBooking },
    originalInvoice,
  )
  let journalEntryId: string | null = null
  let originalJournalEntryId = originalInvoice.journal_entry_id ?? null
  let bookedOriginalJournalEntryId: string | undefined
  const withOriginal = (result: IssueCreditNoteResult): IssueCreditNoteResult =>
    bookedOriginalJournalEntryId ? { ...result, originalJournalEntryId: bookedOriginalJournalEntryId } : result
  const issuedCreditNote = { ...creditNote, status: 'sent' as const }

  if (journalEntryRequired) {
    try {
      journalEntryId = await findExistingCreditJournalEntry(
        supabase,
        companyId,
        issuedCreditNote,
      )

      // accounted#45: the credit reverses the original's verifikat, so a
      // deferred original that was never booked is booked first, on its own
      // date. A refusal there refuses the credit: never a reversal of a sale
      // the books do not have. An existing credit verifikat (a repair) means
      // this already happened.
      if (!journalEntryId && booksOriginalFirst) {
        const booked = await bookOriginalBeforeCredit({
          supabase,
          companyId,
          userId,
          creditNote,
          originalInvoiceId: originalInvoice.id,
          log,
        })
        if (!booked.ok) {
          failures.push(booked.failure)
          return { complete: false, journalEntryId: null, journalEntryRequired, repairRequired: false, failures }
        }
        originalJournalEntryId = booked.journalEntryId
        if (booked.journalEntryId) bookedOriginalJournalEntryId = booked.journalEntryId
      }

      if (!journalEntryId) {
        const originalVoucherRef = await getOriginalVoucherRef(
          supabase,
          companyId,
          originalJournalEntryId,
          log,
        )
        // Kontantmetodens two steps: an original whose payment booked only
        // the customer's share is credited for that share and for what its
        // payout booked of Skatteverket's, nothing more (no revenue, moms or
        // 1513 that was never booked).
        let deductionBookedSek: number | null = null
        if (accountingMethod === 'cash' && (creditNote.items ?? []).some((item) => !!item.deduction_type)) {
          const state = await getDeductionShareBookedByPayout(
            supabase,
            companyId,
            { id: originalInvoice.id, journal_entry_id: originalJournalEntryId },
            creditNote.invoice_date,
          )
          if (!state.ok) {
            if ('code' in state) {
              failures.push({
                step: 'journal_entry',
                code: state.code,
                details: state.details,
                reason: getErrorEntry(state.code)?.message_sv ?? state.code,
              })
              return withOriginal({ complete: false, journalEntryId: null, journalEntryRequired, repairRequired: false, failures })
            }
            throw state.error
          }
          deductionBookedSek = state.bookedSek
        }
        const journalEntry = await createCreditNoteJournalEntry(
          supabase,
          companyId,
          userId,
          issuedCreditNote,
          entityType,
          creditNote.customer?.name ?? undefined,
          originalVoucherRef,
          // The posting port's event, while POSTING_EVENTS is on: the person
          // (or the approved operation) credited the invoice.
          () => ({ linkBasis: linkBasisColumns('user_created') }),
          { deductionBookedSek },
        )
        journalEntryId = journalEntry?.id ?? null
      }
    } catch (error) {
      // A concurrent issuer may have won the unique posted-source guard after
      // our initial lookup. Re-read and reuse that immutable voucher.
      try {
        journalEntryId = await findExistingCreditJournalEntry(
          supabase,
          companyId,
          issuedCreditNote,
        )
      } catch (recoveryError) {
        log.error('failed to recover credit note journal entry after create conflict', recoveryError, {
          creditNoteId: creditNote.id,
        })
      }
      if (!journalEntryId) {
        log.error('failed to create or recover credit note journal entry on issue', error, {
          creditNoteId: creditNote.id,
        })
        failures.push({ step: 'journal_entry', reason: failureReason(error) })
      }
    }

    if (!journalEntryId) {
      if (failures.length === 0) {
        failures.push({
          step: 'journal_entry',
          reason: 'Ingen öppen bokföringsperiod hittades för kreditfakturans datum.',
        })
      }
      if (bookedOriginalJournalEntryId) {
        // The original's verifikat stands (a sent invoice belongs in the
        // books either way); a retry finds it and posts only the credit.
        const last = failures[failures.length - 1]
        last.reason = `${last.reason} Originalfakturan har bokförts. Försök kreditera igen.`
      }
      return withOriginal({ complete: false, journalEntryId, journalEntryRequired, repairRequired: false, failures })
    }

    if (creditNote.journal_entry_id !== journalEntryId) {
      const { data: linkedRows, error: linkError } = await supabase
        .from('invoices')
        .update({ journal_entry_id: journalEntryId })
        .eq('id', creditNote.id)
        .eq('company_id', companyId)
        .eq('status', 'sent')
        .select('id')

      if (linkError || !linkedRows || linkedRows.length === 0) {
        log.error('failed to link credit note to journal entry', linkError ?? undefined, {
          creditNoteId: creditNote.id,
          journalEntryId,
        })
        failures.push({
          step: 'journal_link',
          reason: 'Kreditfakturan kunde inte kopplas till verifikatet.',
        })
        return withOriginal({ complete: false, journalEntryId, journalEntryRequired, repairRequired: true, failures })
      }
    }

    if (accountingMethod === 'accrual') {
      try {
        const cancelResult = await cancelSchedulesForSource(
          supabase,
          companyId,
          userId,
          { invoiceId: originalInvoice.id },
          { reversalDate: creditNote.invoice_date },
        )
        if (cancelResult.failedReversals > 0) {
          failures.push({
            step: 'accrual_schedules',
            reason:
              'En eller flera periodiseringsverifikat kunde inte vändas. ' +
              'Kontrollera Bokföring > Periodiseringar.',
          })
        }
      } catch (error) {
        log.warn('failed to cancel accrual schedules for credited invoice', error)
        failures.push({ step: 'accrual_schedules', reason: failureReason(error) })
      }

      if (failures.length > 0) {
        return withOriginal({ complete: false, journalEntryId, journalEntryRequired, repairRequired: true, failures })
      }
    }
  }

  let originalStatusChanged = false
  if (originalInvoice.status !== 'credited') {
    const { data: updatedOriginal, error: originalStatusError } = await supabase
      .from('invoices')
      .update({ status: 'credited' })
      .eq('id', originalInvoice.id)
      .eq('company_id', companyId)
      .in('status', ['sent', 'paid', 'overdue'])
      .select('id')

    if (originalStatusError || !updatedOriginal || updatedOriginal.length === 0) {
      log.error('failed to mark original invoice as credited', originalStatusError ?? undefined, {
        originalInvoiceId: originalInvoice.id,
        creditNoteId: creditNote.id,
      })
      failures.push({
        step: 'original_status',
        reason: 'Originalfakturan kunde inte markeras som krediterad.',
      })
      return withOriginal({
        complete: false,
        journalEntryId,
        journalEntryRequired,
        repairRequired: journalEntryRequired && !!journalEntryId,
        failures,
      })
    }
    originalStatusChanged = true
  }

  // A befarad kundförlust reserve on the credited invoice is no longer
  // needed (Dr 1519 / Cr 6352 in the credit note's period). Never throws.
  await releaseDoubtfulReserveAfterChange(supabase, companyId, userId, {
    invoiceId: originalInvoice.id,
    entryDate: creditNote.invoice_date,
    trigger: 'credit_note',
  })

  if (originalStatusChanged) {
    try {
      await eventBus.emit({
        type: 'credit_note.created',
        payload: { creditNote: issuedCreditNote, companyId, userId },
      })
    } catch (error) {
      log.warn('credit_note.created emit failed after completed issuance', error)
    }
  }

  return withOriginal({ complete: true, journalEntryId, journalEntryRequired, repairRequired: false, failures })
}
