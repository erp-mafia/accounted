import type { SupabaseClient } from '@supabase/supabase-js'
import { buildSIEAccountRows } from '@/lib/import/account-sync'

export interface BankConfigurationSnapshot {
  token: string
  connection: {
    id: string
    status: string
    session_id: string | null
    bank_name: string | null
    accounts_data: unknown
  }
}

export interface BankAccountSelection {
  uid: string
  enabled: boolean
  currency: string
  ledger_account?: string
  reuse_cash_account_id?: string | null
}

export async function readBankConfiguration(
  supabase: SupabaseClient, companyId: string, connectionId: string,
): Promise<BankConfigurationSnapshot> {
  const { data, error } = await supabase.rpc('read_bank_configuration', {
    p_company_id: companyId, p_connection_id: connectionId,
  })
  if (error) throw Object.assign(new Error(error.message), { code: error.code })
  if (!data?.token || !data?.connection) throw new Error('Bank configuration snapshot missing')
  return data as BankConfigurationSnapshot
}

/** The caller prepares a selection without writing chart, route or cash rows. */
export async function saveBankAccountSelection(
  supabase: SupabaseClient, companyId: string, userId: string, connectionId: string,
  expectedToken: string, selections: BankAccountSelection[],
): Promise<{ status: string; accounts: unknown[] }> {
  // Reuse the existing chart metadata builder. Bank display names stay on
  // cash_accounts; the chart keeps BAS names or the existing currency label.
  const chartAccounts = buildSIEAccountRows(companyId, userId, selections.flatMap(selection => {
    const ledger = selection.ledger_account
    if (!ledger) return []
    return [{ sourceAccount: ledger, targetAccount: ledger,
      sourceName: `Bankkonto ${selection.currency.toUpperCase()}`,
      targetName: `Bankkonto ${selection.currency.toUpperCase()}`,
      confidence: 1, matchType: 'exact' as const, isOverride: false }]
  }))
  const { data, error } = await supabase.rpc('save_bank_account_selection', {
    p_company_id: companyId, p_user_id: userId, p_connection_id: connectionId,
    p_expected_token: expectedToken, p_selections: selections, p_chart_accounts: chartAccounts,
  })
  if (error) throw Object.assign(new Error(error.message), { code: error.code })
  if (!data?.status || !Array.isArray(data?.accounts)) throw new Error('Bank selection receipt missing')
  return data as { status: string; accounts: unknown[] }
}
