import type { SupabaseClient } from '@supabase/supabase-js'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { dbError } from '@/lib/errors/db-error'

/**
 * The day a reconciliation reads the reskontra as of: the fiscal year's last
 * day, the day the account's UB belongs to. Null while the year runs, or for
 * a period that is not there: both read the live register.
 */
export async function reskontraBalanceDate(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('period_end')
    .eq('id', periodId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw dbError(error, 'reskontra balance date: fiscal period read failed')
  const periodEnd = (data as { period_end: string } | null)?.period_end
  return periodEnd && periodEnd < todayIsoStockholm() ? periodEnd : null
}
