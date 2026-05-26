import type { SupabaseClient } from '@supabase/supabase-js'
import type { CashAccount, CashAccountSource } from '@/types'
import { createLogger } from '@/lib/logger'

const log = createLogger('cash-accounts')

/**
 * Canonical read/write surface for cash_accounts.
 *
 * Replaces ad-hoc reads of bank_connections.accounts_data for routing decisions.
 * UI panels that just display balances may still read accounts_data until the
 * follow-up migration drops that column.
 *
 * All methods accept an authenticated SupabaseClient and rely on RLS for tenancy
 * isolation. Defense-in-depth filter by company_id is applied regardless.
 */

export interface ListCashAccountsOptions {
  enabledOnly?: boolean
}

export interface UpsertFromPsd2Input {
  bank_connection_id: string
  external_uid: string
  currency: string
  ledger_account: string
  iban?: string | null
  name?: string | null
  balance?: number | null
  balance_updated_at?: string | null
  enabled?: boolean
}

export async function listForCompany(
  supabase: SupabaseClient,
  companyId: string,
  opts: ListCashAccountsOptions = {},
): Promise<CashAccount[]> {
  let q = supabase
    .from('cash_accounts')
    .select('*')
    .eq('company_id', companyId)
    .order('is_primary', { ascending: false })
    .order('ledger_account', { ascending: true })

  if (opts.enabledOnly) q = q.eq('enabled', true)

  const { data, error } = await q
  if (error) {
    log.error('listForCompany failed', { companyId, error: error.message })
    return []
  }
  return (data ?? []) as CashAccount[]
}

/**
 * Primary cash account for a company. Filters by currency when provided. Falls
 * back to the global primary (`is_primary = true`) when no currency-specific
 * match exists.
 *
 * Used by skattekonto-booking's __PRIMARY_SEK__ sentinel and by transfer-pairing
 * to identify the company's default settlement account.
 */
export async function getPrimary(
  supabase: SupabaseClient,
  companyId: string,
  currency?: string,
): Promise<CashAccount | null> {
  let q = supabase
    .from('cash_accounts')
    .select('*')
    .eq('company_id', companyId)
    .eq('is_primary', true)
    .limit(1)

  if (currency) q = q.eq('currency', currency.toUpperCase())

  const { data, error } = await q.maybeSingle()
  if (error) {
    log.warn('getPrimary failed', { companyId, currency, error: error.message })
  }
  if (data) return data as CashAccount

  if (currency) {
    // Fall back to any-currency primary so a company without a SEK account still
    // resolves the sentinel — rare but possible (manual cash-on-hand only).
    const { data: anyPrimary } = await supabase
      .from('cash_accounts')
      .select('*')
      .eq('company_id', companyId)
      .eq('is_primary', true)
      .maybeSingle()
    if (anyPrimary) return anyPrimary as CashAccount
  }

  return null
}

export async function findByIban(
  supabase: SupabaseClient,
  companyId: string,
  iban: string,
): Promise<CashAccount | null> {
  if (!iban) return null
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('*')
    .eq('company_id', companyId)
    .eq('iban', iban)
    .maybeSingle()
  if (error) {
    log.warn('findByIban failed', { companyId, iban, error: error.message })
    return null
  }
  return (data as CashAccount | null) ?? null
}

/**
 * Upsert a PSD2-sourced cash account during connection callback / sync. Keyed on
 * (company_id, bank_connection_id, external_uid). When the row exists, balance
 * and ledger_account are refreshed; the rest of the metadata stays put.
 *
 * Never sets is_primary — that's owned by the user via the AccountPicker or by
 * the initial-backfill migration.
 */
export async function upsertFromPsd2(
  supabase: SupabaseClient,
  companyId: string,
  input: UpsertFromPsd2Input,
): Promise<void> {
  const payload = {
    company_id: companyId,
    bank_connection_id: input.bank_connection_id,
    external_uid: input.external_uid,
    iban: input.iban ?? null,
    name: input.name ?? null,
    currency: input.currency.toUpperCase(),
    ledger_account: input.ledger_account,
    balance: input.balance ?? null,
    balance_updated_at: input.balance_updated_at ?? null,
    enabled: input.enabled ?? true,
    source: 'enable_banking' as CashAccountSource,
  }

  const { error } = await supabase
    .from('cash_accounts')
    .upsert(payload, { onConflict: 'company_id,bank_connection_id,external_uid' })

  if (error) {
    log.error('upsertFromPsd2 failed', {
      companyId,
      bankConnectionId: input.bank_connection_id,
      externalUid: input.external_uid,
      error: error.message,
    })
    throw new Error(`cash_accounts upsert failed: ${error.message}`)
  }
}

/**
 * Toggle a cash account's enabled flag. Used by the AccountPicker when a user
 * opts in or out of syncing a particular PSD2 account.
 */
export async function setEnabled(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string,
  enabled: boolean,
): Promise<void> {
  const { error } = await supabase
    .from('cash_accounts')
    .update({ enabled })
    .eq('company_id', companyId)
    .eq('id', cashAccountId)
  if (error) throw new Error(`cash_accounts setEnabled failed: ${error.message}`)
}

/**
 * Remap a cash account to a different BAS ledger account. Triggers RLS + the
 * (company_id, ledger_account) UNIQUE constraint — surface conflict errors so
 * the UI can prompt the user to resolve.
 */
export async function setLedgerAccount(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string,
  ledgerAccount: string,
): Promise<void> {
  const { error } = await supabase
    .from('cash_accounts')
    .update({ ledger_account: ledgerAccount })
    .eq('company_id', companyId)
    .eq('id', cashAccountId)
  if (error) throw new Error(`cash_accounts setLedgerAccount failed: ${error.message}`)
}

/**
 * Mark a cash account as the primary for its company. Delegates to the
 * `set_cash_account_primary` RPC so the clear-old-primary and set-new-primary
 * updates happen inside a single transaction. The intermediate "no primary"
 * state is never visible to concurrent readers — important because
 * skattekonto-booking's __PRIMARY_SEK__ resolver runs through getPrimary() and
 * would otherwise see null in the gap and mis-route the counter account.
 */
export async function setPrimary(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string,
): Promise<void> {
  const { error } = await supabase.rpc('set_cash_account_primary', {
    p_company_id: companyId,
    p_cash_account_id: cashAccountId,
  })
  if (error) {
    throw new Error(`cash_accounts setPrimary failed: ${error.message}`)
  }
}
