import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SpendDimension, SpendMasterAccount, SpendMasterDataRequest } from '@accounted/connect-contract'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { VatRegistration } from '@/lib/bookkeeping/vat-registration'
import { spendVatCodesFor, toContractVatCode, vatCodeForTreatment } from './vat-codes'

/**
 * The company's coding vocabulary as the provider gets it: the accounts an
 * expense can be coded on, the VAT codes (lib/spend/vat-codes.ts) and the
 * dimensions with their values. Sent in full every time; Connect reconciles
 * the provider to it (creates, renames, archives, never deletes).
 *
 * Accounts: the active ones a card expense can land on. The result
 * classes 4-8, plus inventarier (12xx), lager (14xx) and förutbetalda
 * kostnader (17xx) for purchases that are not a cost yet, plus the kassa
 * and bank accounts (19xx) so the provider's wallet can be mapped to one.
 * Each carries its usual VAT code, from its VAT treatment.
 *
 * Dimensions: only when the company has switched dimensions on (otherwise
 * every code passes as free text and nothing should be offered as a choice),
 * active ones with their active values, in the registry's own order.
 */

export interface SpendCompanyContext {
  vatRegistered: VatRegistration
  dimensionsEnabled: boolean
}

export async function loadSpendCompanyContext(supabase: SupabaseClient, companyId: string): Promise<SpendCompanyContext> {
  const { data } = await supabase
    .from('company_settings')
    .select('vat_registered, dimensions_enabled')
    .eq('company_id', companyId)
    .maybeSingle()
  const row = (data ?? {}) as { vat_registered?: boolean | null; dimensions_enabled?: boolean | null }
  return { vatRegistered: row.vat_registered ?? null, dimensionsEnabled: row.dimensions_enabled === true }
}

const BALANCE_SHEET_PREFIXES = ['12', '14', '17', '19']

function isCodingAccount(accountNumber: string): boolean {
  const accountClass = Number(accountNumber.charAt(0))
  if (accountClass >= 4 && accountClass <= 8) return true
  return BALANCE_SHEET_PREFIXES.some((prefix) => accountNumber.startsWith(prefix))
}

export type SpendMasterDataBody = Omit<SpendMasterDataRequest, 'idempotencyKey'>

export async function buildSpendMasterData(
  supabase: SupabaseClient,
  companyId: string,
  context: SpendCompanyContext,
): Promise<{ body: SpendMasterDataBody; sha256: string }> {
  const accountRows = await fetchAllRows<{ account_number: string; account_name: string; default_vat_treatment: string | null }>(
    ({ from, to }) =>
      supabase
        .from('chart_of_accounts')
        .select('account_number, account_name, default_vat_treatment')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .order('account_number', { ascending: true })
        .range(from, to),
  )
  const accounts: SpendMasterAccount[] = accountRows
    .filter((row) => isCodingAccount(row.account_number))
    .map((row) => ({
      number: row.account_number,
      name: row.account_name.trim().slice(0, 200) || row.account_number,
      vatCode: vatCodeForTreatment(row.default_vat_treatment, context.vatRegistered),
    }))

  const dimensions: SpendDimension[] = []
  if (context.dimensionsEnabled) {
    const { data: dimensionRows } = await supabase
      .from('dimensions')
      .select('id, sie_dim_no, name, is_active, sort_order')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('sie_dim_no', { ascending: true })
    const valueRows = await fetchAllRows<{ dimension_id: string; code: string; name: string }>(({ from, to }) =>
      supabase
        .from('dimension_values')
        .select('dimension_id, code, name')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .order('code', { ascending: true })
        .range(from, to),
    )
    for (const dimension of (dimensionRows ?? []) as Array<{ id: string; sie_dim_no: number; name: string }>) {
      const values = valueRows
        .filter((value) => value.dimension_id === dimension.id)
        .map((value) => ({ code: value.code, name: (value.name || value.code).slice(0, 200) }))
      dimensions.push({ code: String(dimension.sie_dim_no), name: (dimension.name || String(dimension.sie_dim_no)).slice(0, 100), values })
    }
  }

  const body: SpendMasterDataBody = {
    accounts,
    vatCodes: spendVatCodesFor(context.vatRegistered).map(toContractVatCode),
    dimensions: dimensions.slice(0, 20),
  }
  const sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  return { body, sha256 }
}
