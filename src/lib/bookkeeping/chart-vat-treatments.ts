import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chartVatTreatmentsOf, type ChartVatTreatments } from './vat-entries'

/**
 * The company's momskoder, with their momssatser, on the accounts that can
 * report a reverse-charge basis, for costAccountRcBasisRate: BAS class 4-6 is
 * the only range resolveVatTreatmentRuta gives a ruta 20-24 box, and an
 * account without a momskod is answered by its number, so only configured
 * class 4-6 rows are read (a few dozen per company at most). They are the
 * columns the momsdeklaration reads (fetchDynamicVatAccounts), so the
 * producers and the declaration agree on which cost lines report their own
 * basis, and at which sats.
 */
export async function fetchChartVatTreatments(
  supabase: SupabaseClient,
  companyId: string,
): Promise<ChartVatTreatments> {
  const rows = await fetchAllRows<{
    account_number: string
    default_vat_treatment: string | null
    default_vat_rate: number | string | null
  }>(
    ({ from, to }) =>
      supabase
        .from('chart_of_accounts')
        .select('account_number, default_vat_treatment, default_vat_rate')
        .eq('company_id', companyId)
        .in('account_class', [4, 5, 6])
        .not('default_vat_treatment', 'is', null)
        .order('account_number', { ascending: true })
        .range(from, to),
  )
  return chartVatTreatmentsOf(rows)
}

/** Resolves the company's ChartVatTreatments; see chartVatTreatmentsLoader. */
export type ChartVatTreatmentsLoader = () => Promise<ChartVatTreatments>

/**
 * The momskoder loaded on first use and reused after that: a booking that
 * carries no basis pair never queries, and a batch that shares one loader
 * queries at most once however many reverse-charge rows it books. A failed
 * load is not cached, so the next call tries again.
 */
export function chartVatTreatmentsLoader(
  supabase: SupabaseClient,
  companyId: string,
): ChartVatTreatmentsLoader {
  let pending: Promise<ChartVatTreatments> | null = null
  return () => {
    pending ??= fetchChartVatTreatments(supabase, companyId).catch((err: unknown) => {
      pending = null
      throw err
    })
    return pending
  }
}

/**
 * The kontoplan names of the accounts asked, for expandVoucherLineVatCodes'
 * renamed-basis check (crm#1453). One query, and only when a vat_code would
 * book a basis pair on an account without a momskod.
 */
export function chartAccountNamesLoader(
  supabase: SupabaseClient,
  companyId: string,
): (accounts: readonly string[]) => Promise<ReadonlyMap<string, string>> {
  return async (accounts) => {
    if (accounts.length === 0) return new Map()
    const { data, error } = await supabase
      .from('chart_of_accounts')
      .select('account_number, account_name')
      .eq('company_id', companyId)
      .in('account_number', [...accounts])
    if (error) throw error
    return new Map((data ?? []).map((row: { account_number: string; account_name: string }) => [row.account_number, row.account_name]))
  }
}
