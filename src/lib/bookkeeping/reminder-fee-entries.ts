/**
 * Journal entry generator for lagstadgad påminnelseavgift (statutory
 * reminder fee, default 60 kr per Lag 1981:739).
 *
 * Booking convention:
 *   Debit  1510 Kundfordringar                       (the customer now owes the fee)
 *   Credit 3990 Övriga ersättningar, bidrag och intäkter
 *
 * Account choice rationale:
 *   - 1510 is the existing AR account already debited when the invoice was
 *     issued. Adding the fee on the same account keeps the customer's
 *     open balance accurate and matches Skatteverket / Kronofogden practice
 *     (one accumulated claim per customer).
 *   - 3990 (Övriga ersättningar, bidrag och intäkter) is the BAS 2026
 *     "miscellaneous operating revenue" bucket. Skatteverket guidance:
 *     reminder fees are not interest income (8313) but administrative
 *     compensation, so they sit in the 39xx group, not 83xx.
 *
 * Notes:
 *   - We deliberately do NOT book the dröjsmålsränta (late-payment interest)
 *     on reminder send. Interest is recognised when the customer pays it
 *     (revenue should not be recognised on a contingent claim).
 *   - Source type is 'reminder_fee' (see migration
 *     20260526120300_drojsmalsranta_paminnelseavgift.sql which adds it
 *     to the journal_entries.source_type CHECK constraint).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createJournalEntry, findFiscalPeriod } from './engine'
import { createLogger } from '@/lib/logger'
import type { CreateJournalEntryInput, JournalEntry } from '@/types'

const log = createLogger('bookkeeping.reminder-fee')

export interface CreateReminderFeeEntryInput {
  /** Invoice the reminder relates to. Used for description and source_id linkage. */
  invoiceId: string
  /** Invoice number for the description (e.g. "F2026001"). */
  invoiceNumber: string
  /** Company that owns the invoice. */
  companyId: string
  /** User initiating the booking (for journal_entries.user_id audit trail). */
  userId: string
  /** Fee amount in SEK (≥ 0). Default per Lag 1981:739 is 60 kr. */
  feeAmount: number
  /** Date used as entry_date (typically the reminder send date). */
  asOfDate: string
}

export interface CreateReminderFeeEntryResult {
  journal_entry_id: string
}

/**
 * Book the statutory påminnelseavgift as a journal entry.
 *
 * Returns the new journal_entry_id on success. Returns `null` if no
 * open fiscal period exists for `asOfDate` (the caller should treat
 * this as "skip booking, log a warning, continue sending the email").
 *
 * Throws on hard failures (account missing from chart, period locked,
 * balance trigger rejection). Callers wrap in try/catch so a single
 * failed posting doesn't abort the cron batch.
 */
export async function createReminderFeeEntry(
  supabase: SupabaseClient,
  input: CreateReminderFeeEntryInput,
): Promise<CreateReminderFeeEntryResult | null> {
  const { invoiceId, invoiceNumber, companyId, userId, feeAmount, asOfDate } = input

  if (feeAmount <= 0) {
    log.info('skipping reminder fee booking: feeAmount is zero', {
      invoiceId,
      companyId,
    })
    return null
  }

  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, asOfDate)
  if (!fiscalPeriodId) {
    log.warn('no open fiscal period for reminder fee', {
      invoiceId,
      companyId,
      asOfDate,
    })
    return null
  }

  const rounded = Math.round(feeAmount * 100) / 100
  const description = `Påminnelseavgift faktura ${invoiceNumber}`

  const entryInput: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: asOfDate,
    description,
    source_type: 'reminder_fee',
    source_id: invoiceId,
    lines: [
      {
        account_number: '1510',
        debit_amount: rounded,
        credit_amount: 0,
        line_description: description,
      },
      {
        account_number: '3990',
        debit_amount: 0,
        credit_amount: rounded,
        line_description: description,
      },
    ],
  }

  const entry: JournalEntry = await createJournalEntry(supabase, companyId, userId, entryInput)
  return { journal_entry_id: entry.id }
}
