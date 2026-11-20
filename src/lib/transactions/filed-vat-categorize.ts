/**
 * The question before a bank row is booked by category into a momsperiod
 * whose declaration is already filed.
 *
 * A typed verifikat is asked by the confirm-before-posting guard
 * (lib/bookkeeping/voucher-warnings-guard.ts). A category booking has no
 * typed lines to guard: the lines are built from the category when the row
 * is booked. So the dashboard's categorize door builds them first, with the
 * booking's own dry run, and asks the VAT block's one check
 * (lib/vat/voucher-filed-period-warning.ts) about them: the same answer the
 * staged proposal of this booking carries over MCP
 * (lib/pending-operations/filed-vat-note.ts).
 *
 * The cheap question comes first: the row's date against the filing record.
 * Only a row dated in a filed period pays for the dry run, and only a
 * booking that moves a ruta of that period is asked about.
 *
 * Inkorgen's "Bokför valda" books each underlag against its bank row through
 * the same categorize core and asks the same question per underlag
 * (bulkBookMatchedInboxItems hands its own booking options in). A new
 * samlingsverifikat is asked in ./filed-vat-bulk-book.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { VoucherWarning } from '@/lib/bookkeeping/voucher-plausibility'
import type { Logger } from '@/lib/logger'
import { filedVatPeriodsOfDates } from '@/lib/vat/filed-period-for-date'
import { filedPeriodVoucherWarning, type FiledPeriodWarningSubject } from '@/lib/vat/voucher-filed-period-warning'
import { categorizeTransaction, type CategorizeInput, type CategorizeOptions } from './categorize-core'

/**
 * The warning the person has to confirm before the row is booked, or null:
 * the row is not dated in a filed period, the booking would post nothing or
 * be refused anyway (the booking itself then says why), or its lines move no
 * ruta of the filed period. A check that cannot be made is null too, logged:
 * it never stops a booking.
 *
 * `options` are the booking's own (the dry run must build the lines the
 * booking will post), plus what the text speaks of: a bank row by default.
 */
export async function filedPeriodCategorizeWarning(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  transactionId: string,
  booking: CategorizeInput,
  options: Omit<CategorizeOptions, 'dryRun' | 'log'> & { log: Logger; subject?: FiledPeriodWarningSubject },
): Promise<VoucherWarning | null> {
  const { log, subject = 'bank_row', ...bookingOptions } = options
  try {
    const { data: row, error } = await supabase
      .from('transactions')
      .select('date')
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    const date = (row as { date?: unknown } | null)?.date
    if (typeof date !== 'string') return null

    const filed = await filedVatPeriodsOfDates(supabase, companyId, [date])
    if (!filed.has(date)) return null

    const dry = await categorizeTransaction(supabase, userId, companyId, transactionId, booking, {
      ...bookingOptions,
      dryRun: true,
      log,
    })
    if (!dry.ok || !dry.dryRun || !dry.preview.would_create_journal_entry) return null

    return await filedPeriodVoucherWarning(
      supabase,
      companyId,
      {
        entry_date: date,
        lines: dry.preview.lines.map((line) => ({
          account_number: line.account_number,
          debit_amount: Number(line.debit_amount) || 0,
          credit_amount: Number(line.credit_amount) || 0,
        })),
      },
      subject,
    )
  } catch (err) {
    log.warn('filed VAT period check failed before a category booking (continuing)', {
      transactionId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
