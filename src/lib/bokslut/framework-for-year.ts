import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccountingFramework } from '@/types'
import { resolveAccountingFramework } from '@/lib/company/accounting-framework'

/**
 * The accounting framework (K2 or K3) a fiscal year is reported under, for
 * the year-end code that branches on it (the K3 checklist steps, deferred
 * tax, the fond för utvecklingsutgifter, the transition to K3). The year's
 * own framework (fiscal_period_frameworks, BFNAR 2012:4), never
 * companies.accounting_framework: that column holds the LATEST year's, so a
 * company that elected K3 for its next year would read K3 for the K2 year
 * still open, and K3 entries would land on Ej K2 accounts in a K2 year.
 *
 * A year without a row reads the company setting, as before the per-year
 * value existed; a read error throws (resolveAccountingFramework).
 */
export async function frameworkForYear(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<AccountingFramework> {
  return resolveAccountingFramework(supabase, companyId, fiscalPeriodId)
}

// Lives with the per-year resolvers in the kernel, so the assets block can
// read it without importing year-end.
export { frameworkOnDate } from '@/lib/company/accounting-framework'
