/**
 * The question before bank rows are booked into a new samlingsverifikat
 * dated in a momsperiod whose declaration is already filed.
 *
 * A samlingsverifikat's lines are built from a template or typed in the
 * dialog, and its date is the rows' own: the confirm-before-posting guard of
 * a typed verifikat (lib/bookkeeping/voucher-warnings-guard.ts) never sees
 * it. So the dashboard's door builds the lines first, with the booking's own
 * dry run, and asks the VAT block's one check
 * (lib/vat/voucher-filed-period-warning.ts) about them, as the categorize
 * door does for one row (./filed-vat-categorize.ts). Staged over MCP or v1
 * the same booking carries the answer as a note on the proposal
 * (lib/pending-operations/filed-vat-note.ts).
 *
 * The cheap question comes first: the rows' date against the filing record.
 * Only rows dated in a filed period pay for the dry run, and only a
 * samlingsverifikat that moves a ruta of that period is asked about. A date
 * the books are locked on is not asked about either: the dry run does not
 * read the lock (the RPC does), and a question about a booking that is then
 * refused is one question too many.
 */
import type { VoucherWarning } from '@/lib/bookkeeping/voucher-plausibility'
import type { OperationContext } from '@/lib/operations/types'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { filedVatPeriodsOfDates } from '@/lib/vat/filed-period-for-date'
import { filedPeriodVoucherWarning } from '@/lib/vat/voucher-filed-period-warning'
import { bulkBookTransactions, type BulkBookInput } from './bulk-book'

/**
 * The warning the person has to confirm before the samlingsverifikat is
 * booked, or null: the rows are linked to a verifikat already posted (which
 * posts nothing), they are not dated in a filed period, the date is locked
 * or the booking would be refused anyway (the booking itself then says
 * why), or its lines move no ruta of the filed period. A check that cannot be made is null too, logged:
 * it never stops a booking.
 */
export async function filedPeriodBulkBookWarning(
  ctx: OperationContext,
  body: BulkBookInput,
): Promise<VoucherWarning | null> {
  if (body.existing_journal_entry_id) return null
  const { supabase, companyId, log } = ctx
  try {
    const { data: rows, error } = await supabase
      .from('transactions')
      .select('date')
      .in('id', body.tx_ids)
      .eq('company_id', companyId)
    if (error) throw new Error(error.message)
    const dates = [
      ...new Set(
        ((rows ?? []) as Array<{ date?: unknown }>)
          .map((row) => row.date)
          .filter((date): date is string => typeof date === 'string'),
      ),
    ]
    // A new samlingsverifikat has one date, the rows': several dates are the
    // booking's own refusal.
    if (dates.length !== 1) return null
    const [date] = dates

    const filed = await filedVatPeriodsOfDates(supabase, companyId, [date])
    if (!filed.has(date)) return null

    // Filed and locked: the lock refuses the booking, and says so.
    if ((await checkPeriodLock(supabase, companyId, date)).locked) return null

    const dry = await bulkBookTransactions(ctx, body, { dryRun: true })
    if (!dry.ok) {
      // A refusal the booking repeats in its own words. A read that failed
      // only here would let the booking through unasked: that one is logged.
      if (dry.code === 'UNKNOWN_ERROR') {
        log.warn('filed VAT period check: the dry run of a samlingsverifikat failed (continuing)', {
          txCount: body.tx_ids.length,
          error: dry.error instanceof Error ? dry.error.message : String(dry.error ?? ''),
        })
      }
      return null
    }
    if (!dry.dryRun) return null
    const lines = Array.isArray(dry.preview.lines) ? (dry.preview.lines as Array<Record<string, unknown>>) : []
    if (dry.preview.mode !== 'create_new' || lines.length === 0) return null

    return await filedPeriodVoucherWarning(
      supabase,
      companyId,
      {
        entry_date: date,
        lines: lines.map((line) => ({
          account_number: String(line.account_number),
          debit_amount: Number(line.debit_amount) || 0,
          credit_amount: Number(line.credit_amount) || 0,
        })),
      },
      'booking',
    )
  } catch (err) {
    log.warn('filed VAT period check failed before a samlingsverifikat (continuing)', {
      txCount: body.tx_ids.length,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
