import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccountingFramework, EntityType } from '@/types'
import { simplifiedYearEndRegelverk } from '@/lib/company/entity-type'

/**
 * When a periodisering may be left out, by the rules that apply to the
 * company and the räkenskapsår.
 *
 * - K2 (BFNAR 2016:10) 2.4/2.4A: inkomster and utgifter that each fall below
 *   the limit need not be accrued. 7 000 kr under BFNAR 2025:2, which
 *   applies to räkenskapsår beginning after 2025-12-31 and to a förlängt
 *   first year beginning after 2025-06-30 that ends 2026-12-31 or later
 *   (its transition rule 1); 5 000 kr before. BFN's kommentar to 2.4: the
 *   test is the amount on each faktura or avtal, never the computed
 *   periodiseringsbelopp. 2.4B still requires accruing when the left-out
 *   items together are material, which is why the result is advice only.
 * - K3 (BFNAR 2012:1): no blanket limit, only the general materiality rule
 *   (ÅRL 2:3 a). A K3 company is never told an item need not be accrued.
 * - Årsbokslut forms the product closes under förenklat årsbokslut (K1:
 *   enskild firma BFNAR 2006:1, ideell förening BFNAR 2010:1): 5 000 kr.
 *   BFNAR 2006:1 2.4 is 5 000 kr (its 2025 amendment changed 6.38 and 6.47
 *   only). BFNAR 2017:3 (fullt årsbokslut) moves to 7 000 kr through BFNAR
 *   2026:1 for räkenskapsår beginning after 2026-12-31, but nothing stored
 *   says which of the two a company closes under, so the lower limit
 *   stays: advice under it holds under either.
 */
export type AccrualRegelverk = 'K1' | 'K2' | 'K3'

export interface AccrualMateriality {
  regelverk: AccrualRegelverk
  /** SEK; null when the rules have no blanket limit (K3). */
  limitSek: number | null
}

/** K2 2.4 before BFNAR 2025:2, and K1 (BFNAR 2006:1, BFNAR 2010:1). */
export const ACCRUAL_LIMIT_SEK = 5000

/** K2 2.4/2.4A as amended by BFNAR 2025:2. */
export const ACCRUAL_LIMIT_FROM_BFNAR_2025_2_SEK = 7000

/** Whether BFNAR 2025:2 (and with it the 7 000 kr K2 limit) applies to the räkenskapsår. */
export function bfnar20252Applies(fiscalYear: { period_start: string; period_end: string }): boolean {
  if (fiscalYear.period_start > '2025-12-31') return true
  return fiscalYear.period_start > '2025-06-30' && fiscalYear.period_end >= '2026-12-31'
}

/**
 * The regelverk whose accrual relief applies. An årsbokslut form follows its
 * förenklat årsbokslut (by capability, not by form name); otherwise the
 * framework decides. An unknown framework is K2, the column's default.
 */
export function accrualRegelverk(input: {
  entityType: EntityType | null
  framework: AccountingFramework | null
}): AccrualRegelverk {
  if (input.entityType && simplifiedYearEndRegelverk(input.entityType) === 'K1') return 'K1'
  return input.framework === 'k3' ? 'K3' : 'K2'
}

export function accrualMateriality(input: {
  entityType: EntityType | null
  framework: AccountingFramework | null
  fiscalYear: { period_start: string; period_end: string }
}): AccrualMateriality {
  const regelverk = accrualRegelverk(input)
  if (regelverk === 'K3') return { regelverk, limitSek: null }
  if (regelverk === 'K1') return { regelverk, limitSek: ACCRUAL_LIMIT_SEK }
  return {
    regelverk,
    limitSek: bfnar20252Applies(input.fiscalYear) ? ACCRUAL_LIMIT_FROM_BFNAR_2025_2_SEK : ACCRUAL_LIMIT_SEK,
  }
}

/**
 * The company's accounting framework for the räkenskapsår: the one place the
 * accruals read it. Today the framework is stored per company
 * (companies.accounting_framework); once it is stored per räkenskapsår
 * (src/lib/company/accounting-framework.ts) this returns that resolver's
 * answer for `fiscalPeriodId`. Null when it cannot be read.
 */
export async function accountingFrameworkForYear(
  supabase: SupabaseClient,
  companyId: string,
  // Unused until the framework is stored per räkenskapsår.
  _fiscalPeriodId: string,
): Promise<AccountingFramework | null> {
  const { data, error } = await supabase
    .from('companies')
    .select('accounting_framework')
    .eq('id', companyId)
    .maybeSingle()
  if (error) return null
  const framework = (data as { accounting_framework?: string | null } | null)?.accounting_framework
  return framework === 'k2' || framework === 'k3' ? framework : null
}
