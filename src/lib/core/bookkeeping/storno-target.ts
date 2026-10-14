import type { SupabaseClient } from '@supabase/supabase-js'
import {
  EntryDateOutsideFiscalPeriodError,
  FiscalPeriodNotFoundError,
  TargetPeriodClosedError,
  TargetPeriodLockedError,
} from '@/lib/bookkeeping/errors'
import { resolvePeriodStatusForDate } from './period-service'

/**
 * Where a storno of a posted verifikat lands, checked before its voucher
 * number is drawn.
 *
 * The storno is numbered in the original's series and attributed to the
 * original's fiscal year (reverseEntry, correctEntry), so its date must lie
 * inside that year too: a rättelse is its own verifikation in a period whose
 * work is not closed, and verifikationsnummer run unbroken per series within
 * the räkenskapsår (BFL 5 kap 5 §, BFNAR 2013:2 p. 2.17-2.18). A date
 * outside it put a 2026 storno into the 2025 series: the trial balance (by
 * period) counted it in 2025, the VAT report (by date) in 2026.
 *
 * Returns the storno date (`date`, defaulting to the original's own date) or
 * throws:
 *   - EntryDateOutsideFiscalPeriodError (400): the date is outside the
 *     original's fiscal year;
 *   - TargetPeriodClosedError (409): that year is closed. A closed year stays
 *     as it is; correct it with a new verifikation in the open year;
 *   - TargetPeriodLockedError (409): the year is locked, or the date is on or
 *     before the company lock date (unlock first). Also when the lock lookup
 *     fails: resolvePeriodStatusForDate fails closed.
 *
 * Refusing here, before allocateVoucherNumber, is what keeps a refused storno
 * from burning a number: the period-lock trigger refused only the insert,
 * after the sequence had moved on, and left an undocumented gap.
 */
export async function assertStornoTarget(
  supabase: SupabaseClient,
  companyId: string,
  original: { fiscal_period_id: string; entry_date: string },
  date?: string,
): Promise<string> {
  const target = date ?? original.entry_date

  const { data: period, error } = await supabase
    .from('fiscal_periods')
    .select('name, period_start, period_end')
    .eq('id', original.fiscal_period_id)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error || !period) throw new FiscalPeriodNotFoundError()

  if (target < period.period_start || target > period.period_end) {
    throw new EntryDateOutsideFiscalPeriodError(target, period.name, period.period_start, period.period_end)
  }

  const status = await resolvePeriodStatusForDate(supabase, companyId, target)
  if (status.status === 'closed') throw new TargetPeriodClosedError(target)
  if (status.status === 'locked') throw new TargetPeriodLockedError(target, status.lock_date)

  return target
}
