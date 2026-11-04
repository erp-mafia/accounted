import type { SupabaseClient } from '@supabase/supabase-js'
import { buildSIEAccountRows } from '@/lib/import/account-sync'
import { bankLedgerName } from '@/lib/cash-accounts/ledger-slots'
import { hasErrorEntry } from '@/lib/errors/structured-errors'
import { userFacing } from '@/lib/errors/user-facing'
import { createServiceClient } from '@/lib/supabase/server'
import { bankAccountsSelectionRefusal } from '@/lib/usage/gate'
import { billedUsageKinds } from '@/lib/usage/kinds'
import { namedSelectionRefusal, parseSelectionRefusalDetail } from '@/lib/cash-accounts/selection-refusal'

export interface BankConfigurationSnapshot {
  token: string
  connection: {
    id: string
    status: string
    session_id: string | null
    bank_name: string | null
    accounts_data: unknown
    /** bank_connections.aggregator (lib/bank-sync/aggregator.ts). */
    aggregator?: string | null
    /** The bank an Open Payments consent is bound to; null for Enable Banking. */
    bic?: string | null
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
  // The jsonb answer is one object; a one-row array reads the same (as the
  // other jsonb RPC readers do, e.g. lib/customers/merge-customers.ts).
  const snapshot = Array.isArray(data) ? data[0] : data
  if (!snapshot?.token || !snapshot?.connection) throw new Error('Bank configuration snapshot missing')
  return snapshot as BankConfigurationSnapshot
}

/** An unused row of an unchecked account that gave its ledger up and was deleted (crm#224). */
export interface YieldedCashAccount {
  id: string
  ledger_account: string
  bank_connection_id: string
  is_primary: boolean
}

/** The first-sync window the user picked, saved with the activation. */
export interface InitialSyncWindow {
  /** YYYY-MM-DD, the first day the first import asks the bank for. */
  requestedFrom: string
  lookbackDays: number
}

/**
 * The caller prepares a selection without writing chart, route or cash rows.
 * `initialSync` is the window of the first import, saved on activation so the
 * cron takes it when the inline import is deferred or fails.
 */
/**
 * The stop at the live bank accounts the plan includes (lib/usage/gate.ts),
 * before the selection is saved: the connection's accounts with the
 * selection's choices applied (an account switched on is taken over here, so
 * another company's claim no longer counts) against the company's other live
 * accounts. A refusal is a sentence the picker shows. Only while bank
 * accounts are billed (USAGE_BILLING_KINDS).
 */
async function refuseAccountsAboveIncluded(companyId: string, connectionId: string, selections: BankAccountSelection[]): Promise<void> {
  if (!billedUsageKinds().has('bank_account')) return
  const service = createServiceClient()
  const { data, error } = await service.from('bank_connections').select('accounts_data').eq('id', connectionId).eq('company_id', companyId).maybeSingle()
  if (error) throw Object.assign(new Error(error.message), { code: error.code })
  const chosen = new Map(selections.map((s) => [s.uid, s.enabled]))
  const stored = (data as { accounts_data: unknown } | null)?.accounts_data
  const accounts = (Array.isArray(stored) ? stored : []).map((account: { uid?: string; enabled?: boolean | null; claimed_by_company_id?: string | null }) => {
    const enabled = (account.uid !== undefined ? chosen.get(account.uid) : undefined) ?? account.enabled === true
    return { ...account, enabled, claimed_by_company_id: enabled ? null : (account.claimed_by_company_id ?? null) }
  })
  const refusal = await bankAccountsSelectionRefusal(service, companyId, connectionId, accounts)
  if (refusal) throw userFacing(Object.assign(new Error(refusal.messageSv ?? ''), { code: refusal.code, details: refusal.details }), refusal.code)
}

export async function saveBankAccountSelection(
  supabase: SupabaseClient, companyId: string, userId: string, connectionId: string,
  expectedToken: string, selections: BankAccountSelection[], initialSync?: InitialSyncWindow,
): Promise<{ status: string; accounts: unknown[]; yielded?: YieldedCashAccount[] }> {
  await refuseAccountsAboveIncluded(companyId, connectionId, selections)
  const chartAccounts = buildBankChartAccounts(companyId, userId, selections)
  const args = {
    p_company_id: companyId, p_user_id: userId, p_connection_id: connectionId,
    p_expected_token: expectedToken, p_selections: selections, p_chart_accounts: chartAccounts,
  }
  let { data, error } = await supabase.rpc('save_bank_account_selection', initialSync
    ? { ...args, p_initial_sync: { requested_from: initialSync.requestedFrom, lookback_days: initialSync.lookbackDays } }
    : args)
  // Deploy window only: code can go live before migration 20261013120000
  // adds p_initial_sync, and PostgREST then finds no such function
  // (PGRST202). The selection is saved without the window, as before. Delete
  // this fallback 30 days after that migration reaches production.
  if (error?.code === 'PGRST202' && initialSync) {
    ({ data, error } = await supabase.rpc('save_bank_account_selection', args))
  }
  if (error) throw selectionError(error)
  if (!data?.status || !Array.isArray(data?.accounts)) throw new Error('Bank selection receipt missing')
  return data as { status: string; accounts: unknown[]; yielded?: YieldedCashAccount[] }
}

/**
 * The RPC raises its refusals by name under a generic SQLSTATE (23514, 23505,
 * PT409). A registered name becomes the code so the route answers with that
 * message instead of a generic validation or conflict error. A refusal about
 * a bank account carries a DETAIL naming it, and then the answer is a sentence
 * naming that account and what to do (lib/cash-accounts/selection-refusal.ts).
 */
function selectionError(error: { code?: string; message: string; details?: string | null }) {
  const code = hasErrorEntry(error.message) ? error.message : error.code
  const named = code && hasErrorEntry(code)
    ? namedSelectionRefusal(code, parseSelectionRefusalDetail(error.details))
    : null
  if (code && named) return userFacing(Object.assign(new Error(named), { code, pgCode: error.code }), code)
  return Object.assign(new Error(error.message), { code, pgCode: error.code })
}

/** Release the provider route without changing cash IDs or historical links. */
export async function disconnectBankConnection(
  supabase: SupabaseClient, companyId: string, userId: string, connectionId: string, expectedToken: string,
): Promise<{ connection_id: string; session_id: string | null; bank_name: string | null; released_cash_accounts: number }> {
  const { data, error } = await supabase.rpc('disconnect_bank_connection', {
    p_company_id: companyId, p_user_id: userId, p_connection_id: connectionId, p_expected_token: expectedToken,
  })
  if (error) throw Object.assign(new Error(error.message), { code: error.code })
  if (data?.connection_id !== connectionId || (data.session_id !== null && typeof data.session_id !== 'string')
    || (data.bank_name !== null && typeof data.bank_name !== 'string') || !Number.isInteger(data.released_cash_accounts)) {
    throw new Error('Bank disconnect receipt missing')
  }
  return data
}

/** Bank display names stay on cash rows; chart rows retain BAS names. */
export function buildBankChartAccounts(
  companyId: string, userId: string, selections: Array<{ currency: string; ledger_account?: string }>,
) {
  // Reuse the existing chart metadata builder. Bank display names stay on
  // cash_accounts; the chart keeps BAS names or the existing currency label.
  return buildSIEAccountRows(companyId, userId, selections.flatMap(selection => {
    const ledger = selection.ledger_account
    if (!ledger) return []
    return [{ sourceAccount: ledger, targetAccount: ledger,
      sourceName: bankLedgerName(selection.currency),
      targetName: bankLedgerName(selection.currency),
      confidence: 1, matchType: 'exact' as const, isOverride: false }]
  }))
}

export interface BankMirrorPlan {
  uid: string
  ledger_account: string
  reuse_cash_account_id: string | null
}

export interface BankCallbackReceipt<T> {
  connection: { id: string; company_id: string; user_id: string; bank_name: string | null }
  old_session_id: string | null
  accounts: T[]
  superseded: Array<{ id: string; session_id: string | null }>
}

/** Read the OAuth attempt before exchanging its single-use provider code. */
export async function readBankCallbackConfiguration(
  supabase: SupabaseClient, companyId: string, userId: string, connectionId: string, oauthState: string,
): Promise<BankConfigurationSnapshot> {
  const { data, error } = await supabase.rpc('read_bank_callback_configuration', {
    p_company_id: companyId, p_user_id: userId, p_connection_id: connectionId, p_oauth_state: oauthState,
  })
  if (error) throw Object.assign(new Error(error.message), { code: error.code })
  if (!data?.token || data?.connection?.id !== connectionId || (data.connection.accounts_data !== null && !Array.isArray(data.connection.accounts_data))) {
    throw new Error('Bank callback snapshot missing')
  }
  return { ...data, connection: { ...data.connection, accounts_data: data.connection.accounts_data ?? [] } } as BankConfigurationSnapshot
}

/** Commit consent, supersession and all intended mirrors in one transaction. */
export async function finalizeBankCallback<T extends { uid: string; currency: string }>(
  supabase: SupabaseClient,
  input: {
    companyId: string; userId: string; connectionId: string; oauthState: string; expectedToken: string
    sessionId: string; consentExpires: string | null; accounts: T[]; mirrors: BankMirrorPlan[]
    noIbanPairs: Record<string, string>
  },
): Promise<BankCallbackReceipt<T>> {
  const chartAccounts = buildBankChartAccounts(input.companyId, input.userId, input.mirrors.map(mirror => {
    const account = input.accounts.find(account => account.uid === mirror.uid)
    if (!account) throw new Error('Bank callback mirror account missing')
    return { currency: account.currency, ledger_account: mirror.ledger_account }
  }))
  const { data, error } = await supabase.rpc('finalize_bank_callback', {
    p_company_id: input.companyId, p_user_id: input.userId, p_connection_id: input.connectionId,
    p_oauth_state: input.oauthState, p_expected_token: input.expectedToken, p_session_id: input.sessionId,
    p_consent_expires: input.consentExpires, p_accounts: input.accounts, p_mirrors: input.mirrors,
    p_no_iban_pairs: input.noIbanPairs, p_chart_accounts: chartAccounts,
  })
  if (error) throw Object.assign(new Error(error.message), { code: error.code })
  if (data?.connection?.id !== input.connectionId || data.connection.company_id !== input.companyId
    || data.connection.user_id !== input.userId || !Array.isArray(data.accounts) || !Array.isArray(data.superseded)
    || (data.old_session_id !== null && typeof data.old_session_id !== 'string')
    || data.superseded.some((row: { id?: unknown; session_id?: unknown }) => typeof row?.id !== 'string'
      || (row.session_id !== null && typeof row.session_id !== 'string'))) {
    throw new Error('Bank callback receipt missing')
  }
  return data as BankCallbackReceipt<T>
}


/** Re-evaluate reusable consent and account claims inside the insertion. */
export async function attachSharedBankSession(
  supabase: SupabaseClient, companyId: string, userId: string, sourceConnectionId: string,
): Promise<{ connection_id: string; account_count: number; bank_name: string | null; consent_expires: string | null }> {
  const { data, error } = await supabase.rpc('attach_shared_bank_session', {
    p_company_id: companyId, p_user_id: userId, p_source_connection_id: sourceConnectionId,
  })
  if (error) throw Object.assign(new Error(error.message), { code: error.code })
  if (typeof data?.connection_id !== 'string' || !Number.isInteger(data.account_count) || data.account_count < 1
    || (data.bank_name !== null && typeof data.bank_name !== 'string')
    || (data.consent_expires !== null && typeof data.consent_expires !== 'string')) {
    throw new Error('Bank session attachment receipt missing')
  }
  return data
}
