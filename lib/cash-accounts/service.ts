import type { SupabaseClient } from '@supabase/supabase-js'
import type { CashAccount, CashAccountSource } from '@/types'
import { createLogger } from '@/lib/logger'
import { syncMappedAccounts } from '@/lib/import/account-sync'

const log = createLogger('cash-accounts')

/**
 * Suggested BAS account per currency. Single source — the enable-banking
 * callback and the AccountPickerDialog both key off these.
 */
export const CURRENCY_LEDGER_DEFAULTS: Record<string, string> = {
  SEK: '1930',
  EUR: '1932',
  USD: '1933',
  GBP: '1934',
}

export function defaultLedgerForCurrency(currency: string): string {
  return CURRENCY_LEDGER_DEFAULTS[currency.toUpperCase()] ?? '1930'
}

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
    // resolves the sentinel: rare but possible (manual cash-on-hand only).
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
 * Find a free BAS class-19 slot for a new PSD2 cash account, respecting the
 * UNIQUE (company_id, ledger_account) constraint. A bank returning N
 * same-currency accounts must not map them all to the currency default —
 * that's exactly the collision this prevents.
 *
 * Rules:
 *   - The currency default (1930/1932/1933/1934) is available when no
 *     PSD2-backed row holds it. A manual holder (the seeded 1930 row) does
 *     not block it — upsertFromPsd2 promotes that row in place.
 *   - Overflow walks the free-use 1931–1959 sub-account slots, skipping the
 *     four currency defaults (reserved as suggestions for their currencies)
 *     and any slot held by ANY existing row — promoting an unrelated manual
 *     account (SIE-imported, kassa) would silently steal it.
 *   - `exclude` carries slots already assigned earlier in the caller's loop
 *     but not yet visible in the table.
 *
 * Returns null when no slot is free (or the lookup fails) — callers fall back
 * to their previous behavior and surface the error.
 */
export async function findFreeLedgerAccount(
  supabase: SupabaseClient,
  companyId: string,
  currency: string,
  exclude: ReadonlySet<string> = new Set(),
): Promise<string | null> {
  const preferred = defaultLedgerForCurrency(currency)

  const { data: rows, error } = await supabase
    .from('cash_accounts')
    .select('ledger_account, bank_connection_id')
    .eq('company_id', companyId)

  if (error) {
    log.error('findFreeLedgerAccount lookup failed', { companyId, error: error.message })
    return null
  }

  const anyTaken = new Set<string>()
  const connectedTaken = new Set<string>()
  for (const row of (rows ?? []) as Array<{ ledger_account: string; bank_connection_id: string | null }>) {
    anyTaken.add(row.ledger_account)
    if (row.bank_connection_id !== null) connectedTaken.add(row.ledger_account)
  }

  if (!exclude.has(preferred) && !connectedTaken.has(preferred)) return preferred

  const reserved = new Set(Object.values(CURRENCY_LEDGER_DEFAULTS))
  for (let n = 1931; n <= 1959; n++) {
    const candidate = String(n)
    if (reserved.has(candidate)) continue
    if (exclude.has(candidate) || anyTaken.has(candidate)) continue
    return candidate
  }

  log.warn('findFreeLedgerAccount exhausted 1931–1959', { companyId, currency })
  return null
}

/**
 * Allocate a ledger slot for a new PSD2 account AND make sure that account
 * number exists in the company's chart of accounts — cash_accounts has no FK
 * to the chart, but booking (and the AccountPicker, which only lists chart
 * accounts) breaks on numbers the chart doesn't know. Sub-accounts outside
 * the BAS reference (1931, …) are created with metadata derived from the
 * account number; standard numbers get their BAS name.
 */
export async function allocatePsd2LedgerAccount(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: { currency: string; accountName?: string | null; exclude?: ReadonlySet<string> },
): Promise<string | null> {
  const ledger = await findFreeLedgerAccount(supabase, companyId, input.currency, input.exclude ?? new Set())
  if (!ledger) return null

  const name = input.accountName?.trim() || `Bankkonto ${input.currency.toUpperCase()}`
  const sync = await syncMappedAccounts(
    supabase,
    companyId,
    userId,
    [
      {
        sourceAccount: ledger,
        sourceName: name,
        targetAccount: ledger,
        targetName: name,
        confidence: 1,
        matchType: 'exact',
        isOverride: false,
      },
    ],
    false,
  )
  if (sync.error) {
    log.error('allocatePsd2LedgerAccount chart sync failed', {
      companyId,
      ledger,
      error: sync.error,
    })
    return null
  }
  return ledger
}

/**
 * Upsert a PSD2-sourced cash account during connection callback / sync. Keyed on
 * (company_id, bank_connection_id, external_uid). When the row exists, balance
 * and ledger_account are refreshed; the rest of the metadata stays put.
 *
 * Never sets is_primary: that's owned by the user via the AccountPicker or by
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

  // create_company_with_owner and the seed_default_cash_account migration plant
  // a manual (bank_connection_id IS NULL) row on the same ledger_account so
  // reconciliation routes work before any PSD2 connection exists. The first
  // PSD2 sync for that BAS slot has to promote that row in place: a plain
  // upsert on (company_id, bank_connection_id, external_uid) wouldn't match it
  // (NULL ≠ NULL) and the INSERT path then trips the (company_id,
  // ledger_account) UNIQUE constraint.
  const { data: seedRow, error: seedLookupError } = await supabase
    .from('cash_accounts')
    .select('id')
    .eq('company_id', companyId)
    .eq('ledger_account', input.ledger_account)
    .is('bank_connection_id', null)
    .maybeSingle()

  if (seedLookupError) {
    log.error('upsertFromPsd2 seed lookup failed', {
      companyId,
      bankConnectionId: input.bank_connection_id,
      externalUid: input.external_uid,
      error: seedLookupError.message,
    })
    throw new Error(`cash_accounts upsert failed: ${seedLookupError.message}`)
  }

  if (seedRow) {
    // .select() so we can detect a 0-row UPDATE: Supabase's update().eq() returns
    // { error: null, data: [] } if the row was deleted between the SELECT above
    // and this UPDATE (rare but theoretically possible under concurrent ops).
    // If that happens, fall through to the normal upsert path instead of
    // silently returning success without persisting anything.
    const { data: promoted, error: promoteError } = await supabase
      .from('cash_accounts')
      .update(payload)
      .eq('id', seedRow.id)
      .select('id')
    if (promoteError) {
      log.error('upsertFromPsd2 promote-seed failed', {
        companyId,
        bankConnectionId: input.bank_connection_id,
        externalUid: input.external_uid,
        error: promoteError.message,
      })
      throw new Error(`cash_accounts upsert failed: ${promoteError.message}`)
    }
    if (promoted && promoted.length > 0) {
      return
    }
    // Seed row vanished between SELECT and UPDATE: fall through to upsert.
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
 * (company_id, ledger_account) UNIQUE constraint: surface conflict errors so
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
 * state is never visible to concurrent readers: important because
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
