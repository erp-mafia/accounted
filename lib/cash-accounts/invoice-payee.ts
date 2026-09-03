import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CashAccount,
  CashAccountPayeeFields,
  Currency,
  InvoicePayeeDefault,
  InvoicePaymentAccount,
} from '@/types'
import { createLogger } from '@/lib/logger'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { syncMappedAccounts } from '@/lib/import/account-sync'
import {
  hasUsableInvoicePaymentAccount,
  isInvoicePaymentAccountCurrency,
  normalizeInvoicePaymentAccount,
} from '@/lib/invoices/payment-accounts'
import { findFreeLedgerAccount } from '@/lib/cash-accounts/service'

const log = createLogger('cash-accounts/invoice-payee')

export const PAYEE_FIELDS: readonly (keyof CashAccountPayeeFields)[] = [
  'bank_name',
  'clearing_number',
  'account_number',
  'bankgiro',
  'plusgiro',
  'swish',
  'iban',
  'bic',
  'bank_code',
  'foreign_account_number',
]

/** A cash account's payee columns: the InvoicePaymentAccount keys, with the printed IBAN in payee_iban. */
export type CashAccountPayeeSource = Omit<CashAccountPayeeFields, 'iban'> & { payee_iban: string | null }

/**
 * The payee fields of a cash account in the shape the invoice renderers read.
 * The printed IBAN is payee_iban, never the bank-identity iban column.
 */
export function cashAccountPayee(account: CashAccountPayeeSource): InvoicePaymentAccount {
  return normalizeInvoicePaymentAccount({
    bank_name: account.bank_name,
    clearing_number: account.clearing_number,
    account_number: account.account_number,
    bankgiro: account.bankgiro,
    plusgiro: account.plusgiro,
    swish: account.swish,
    iban: account.payee_iban,
    bic: account.bic,
    bank_code: account.bank_code,
    foreign_account_number: account.foreign_account_number,
  })
}

/**
 * Whether the account can be printed on an invoice in `currency`: enabled,
 * flagged as a payee, and carrying the identifiers that currency needs (an
 * IBAN for anything but SEK, or the USD/GBP routing triple).
 */
export function isUsableInvoicePayee(account: CashAccount, currency: Currency): boolean {
  return account.enabled
    && account.invoice_payee
    && hasUsableInvoicePaymentAccount(cashAccountPayee(account), currency)
}

/**
 * Bank-type rows only: Stripe (1686), Woo (1680) and Shopify (1584) also live
 * in cash_accounts, and so may a till (1910 Kassa, 1911-1919). A customer is
 * paid to a giro or bank account (BAS 1920-1999), never to a cash till.
 */
export function isBankCashAccount(account: Pick<CashAccount, 'ledger_account'>): boolean {
  return /^19[2-9]\d$/.test(account.ledger_account)
}

export interface InvoicePayeeState {
  accounts: CashAccount[]
  defaults: InvoicePayeeDefault[]
}

/**
 * Every bank-type cash account of the company (payee or not: the settings
 * page lets the user promote one) plus the per-currency defaults.
 */
export async function loadInvoicePayeeState(
  supabase: SupabaseClient,
  companyId: string,
): Promise<InvoicePayeeState> {
  const [accountsRes, defaultsRes] = await Promise.all([
    supabase
      .from('cash_accounts')
      .select('*')
      .eq('company_id', companyId)
      .order('is_primary', { ascending: false })
      .order('ledger_account', { ascending: true }),
    supabase
      .from('invoice_payee_defaults')
      .select('*')
      .eq('company_id', companyId),
  ])
  if (accountsRes.error) {
    throw new Error(`invoice payee accounts lookup failed: ${accountsRes.error.message}`)
  }
  if (defaultsRes.error) {
    throw new Error(`invoice payee defaults lookup failed: ${defaultsRes.error.message}`)
  }
  return {
    accounts: ((accountsRes.data ?? []) as CashAccount[]).filter(isBankCashAccount),
    defaults: (defaultsRes.data ?? []) as InvoicePayeeDefault[],
  }
}

/** The default payee account for `currency`, or null when none is configured. */
export async function getDefaultInvoicePayee(
  supabase: SupabaseClient,
  companyId: string,
  currency: Currency,
): Promise<CashAccount | null> {
  const { data, error } = await supabase
    .from('invoice_payee_defaults')
    .select('cash_account:cash_accounts!invoice_payee_defaults_same_company(*)')
    .eq('company_id', companyId)
    .eq('currency', currency)
    .maybeSingle()
  if (error) {
    log.warn('getDefaultInvoicePayee failed', { companyId, currency, error: error.message })
    return null
  }
  const account = (data as { cash_account: CashAccount | CashAccount[] | null } | null)?.cash_account
  if (!account) return null
  return Array.isArray(account) ? account[0] ?? null : account
}

export type PayeeUpdate = Partial<CashAccountPayeeFields> & {
  name?: string | null
  invoice_payee?: boolean
}

/**
 * Update payee fields on one of the company's cash accounts. Only supplied
 * keys are written; explicit null clears. The mirror trigger rewrites
 * company_settings from this row when it is a default for some currency.
 */
export async function updateCashAccountPayee(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string,
  update: PayeeUpdate,
): Promise<CashAccount | null> {
  // Literal payload (the phantom-column guard reads literal keys): a key the
  // caller did not supply stays undefined and is dropped by supabase-js, so
  // only supplied fields are written and explicit null still clears.
  const has = (key: keyof PayeeUpdate) => key in update && update[key] !== undefined
  if (!(Object.keys(update) as (keyof PayeeUpdate)[]).some(has)) {
    const { data } = await supabase
      .from('cash_accounts')
      .select('*')
      .eq('company_id', companyId)
      .eq('id', cashAccountId)
      .maybeSingle()
    return (data as CashAccount | null) ?? null
  }
  const { data, error } = await supabase
    .from('cash_accounts')
    .update({
      bank_name: has('bank_name') ? clean(update.bank_name) : undefined,
      clearing_number: has('clearing_number') ? clean(update.clearing_number) : undefined,
      account_number: has('account_number') ? clean(update.account_number) : undefined,
      bankgiro: has('bankgiro') ? clean(update.bankgiro) : undefined,
      plusgiro: has('plusgiro') ? clean(update.plusgiro) : undefined,
      swish: has('swish') ? clean(update.swish) : undefined,
      payee_iban: has('iban') ? compact(clean(update.iban), true) : undefined,
      bic: has('bic') ? compact(clean(update.bic), true) : undefined,
      bank_code: has('bank_code') ? clean(update.bank_code) : undefined,
      foreign_account_number: has('foreign_account_number') ? clean(update.foreign_account_number) : undefined,
      name: has('name') ? clean(update.name) : undefined,
      invoice_payee: update.invoice_payee,
    })
    .eq('company_id', companyId)
    .eq('id', cashAccountId)
    .select('*')
    .maybeSingle()
  if (error) throw new Error(`cash_accounts payee update failed: ${error.message}`)
  return (data as CashAccount | null) ?? null
}

/**
 * Make `cashAccountId` the default payee for `currency`, or clear the
 * default when null. The account must belong to the company: the composite
 * FK rejects a foreign id and the caller sees the error.
 */
export async function setInvoicePayeeDefault(
  supabase: SupabaseClient,
  companyId: string,
  currency: Currency,
  cashAccountId: string | null,
): Promise<void> {
  if (cashAccountId === null) {
    const { error } = await supabase
      .from('invoice_payee_defaults')
      .delete()
      .eq('company_id', companyId)
      .eq('currency', currency)
    if (error) throw new Error(`invoice_payee_defaults delete failed: ${error.message}`)
    return
  }
  const { error } = await supabase
    .from('invoice_payee_defaults')
    .upsert(
      { company_id: companyId, currency, cash_account_id: cashAccountId },
      { onConflict: 'company_id,currency' },
    )
  if (error) throw new Error(`invoice_payee_defaults upsert failed: ${error.message}`)
}

export interface CreateManualBankAccountInput {
  name: string
  currency: string
  ledger_account?: string | null
  payee?: Partial<CashAccountPayeeFields>
  invoice_payee?: boolean
}

/**
 * A bank account the user types in (no PSD2 connection). Allocates the next
 * free 19xx slot for the currency unless one is given, and makes sure that
 * number exists in the chart so bookings and pickers can see it.
 */
export async function createManualBankAccount(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: CreateManualBankAccountInput,
): Promise<CashAccount> {
  const currency = input.currency.toUpperCase()
  // findFreeLedgerAccount treats a slot held by a manual row as free (the
  // PSD2 path promotes that row in place); this path INSERTS, so every slot
  // any row holds is taken.
  const { data: existing, error: existingError } = await supabase
    .from('cash_accounts')
    .select('ledger_account')
    .eq('company_id', companyId)
  if (existingError) throw new Error(`cash_accounts lookup failed: ${existingError.message}`)
  const taken = new Set(((existing ?? []) as { ledger_account: string }[]).map((r) => r.ledger_account))
  const requested = input.ledger_account?.trim()
  if (requested && taken.has(requested)) {
    throw new Error(`Ledger account ${requested} is already a cash account of this company`)
  }
  const ledger = requested || (await findFreeLedgerAccount(supabase, companyId, currency, taken))
  if (!ledger) {
    throw new Error('No free 19xx ledger account for a new bank account')
  }
  const chartName = getBASReference(ledger)?.account_name ?? `Bankkonto ${currency}`
  const sync = await syncMappedAccounts(
    supabase,
    companyId,
    userId,
    [{
      sourceAccount: ledger,
      sourceName: chartName,
      targetAccount: ledger,
      targetName: chartName,
      confidence: 1,
      matchType: 'exact',
      isOverride: false,
    }],
    false,
  )
  if (sync.error) {
    throw new Error(`chart sync failed for ${ledger}: ${sync.error}`)
  }

  const payee = input.payee ?? {}
  const { data, error } = await supabase
    .from('cash_accounts')
    .insert({
      company_id: companyId,
      ledger_account: ledger,
      currency,
      name: input.name.trim(),
      enabled: true,
      is_primary: false,
      source: 'manual',
      invoice_payee: input.invoice_payee ?? true,
      bank_name: clean(payee.bank_name),
      clearing_number: clean(payee.clearing_number),
      account_number: clean(payee.account_number),
      bankgiro: clean(payee.bankgiro),
      plusgiro: clean(payee.plusgiro),
      swish: clean(payee.swish),
      // A typed account: the printed IBAN is also the account's identity, so
      // a later bank connection with the same IBAN promotes this row in place.
      iban: compact(clean(payee.iban), true),
      payee_iban: compact(clean(payee.iban), true),
      bic: compact(clean(payee.bic), true),
      bank_code: clean(payee.bank_code),
      foreign_account_number: clean(payee.foreign_account_number),
    })
    .select('*')
    .single()
  if (error) throw new Error(`cash_accounts insert failed: ${error.message}`)
  return data as CashAccount
}

/**
 * Legacy writers (PUT /api/settings, v1 settings, MCP update_company_settings)
 * still send payment instructions as company_settings columns or as the
 * per-currency map. Write them through to the default cash account for each
 * currency so the account stays the truth; the mirror trigger then rewrites
 * the map and legacy columns from the account, which is what the caller
 * asked for. Currencies with no default account are left to the caller's
 * own company_settings write (the resolver's fallback).
 *
 * Returns the currencies that were written through, so callers can decide
 * whether their own company_settings write still needs those keys.
 */
export async function propagateLegacyPayeeWrite(
  supabase: SupabaseClient,
  companyId: string,
  changes: {
    invoice_payment_accounts?: Partial<Record<string, Partial<InvoicePaymentAccount> | null | undefined>>
  } & Partial<Record<keyof InvoicePaymentAccount, string | null | undefined>>,
): Promise<Currency[]> {
  const entries = new Map<Currency, Partial<InvoicePaymentAccount>>()
  const map = changes.invoice_payment_accounts
  if (map) {
    for (const [currency, account] of Object.entries(map)) {
      if (!isInvoicePaymentAccountCurrency(currency) || !account) continue
      entries.set(currency, account)
    }
  }
  const legacyKeys: (keyof InvoicePaymentAccount)[] = [
    'bank_name', 'clearing_number', 'account_number', 'bankgiro', 'plusgiro', 'swish', 'iban', 'bic',
  ]
  if (!entries.has('SEK') && legacyKeys.some((key) => changes[key] !== undefined)) {
    const partial: Partial<InvoicePaymentAccount> = {}
    for (const key of legacyKeys) {
      if (changes[key] !== undefined) partial[key] = changes[key] ?? null
    }
    entries.set('SEK', partial)
  }
  if (entries.size === 0) return []

  const { data: defaultsData, error: defaultsError } = await supabase
    .from('invoice_payee_defaults')
    .select('currency, cash_account_id')
    .eq('company_id', companyId)
  if (defaultsError) {
    throw new Error(`invoice_payee_defaults lookup failed: ${defaultsError.message}`)
  }
  const defaults = new Map(
    ((defaultsData ?? []) as { currency: string; cash_account_id: string }[])
      .map((row) => [row.currency, row.cash_account_id] as const),
  )

  const written: Currency[] = []
  for (const [currency, account] of entries) {
    let target = defaults.get(currency) ?? null
    let adopt = false
    if (!target && currency === 'SEK') {
      // Every company is seeded with a primary SEK account: adopt it as the
      // SEK payee so a first-time bank-details save lands on an account.
      const { data: primary } = await supabase
        .from('cash_accounts')
        .select('id, ledger_account')
        .eq('company_id', companyId)
        .eq('currency', 'SEK')
        .eq('enabled', true)
        .eq('is_primary', true)
        .maybeSingle()
      const row = primary as { id: string; ledger_account: string } | null
      if (row && isBankCashAccount(row)) {
        target = row.id
        adopt = true
      }
    }
    if (!target) continue
    // A full map entry replaces the account's payee (the settings form sends
    // every field); a partial legacy write only touches the supplied keys.
    const update: PayeeUpdate = { invoice_payee: true }
    const full = map?.[currency] !== undefined
    for (const field of PAYEE_FIELDS) {
      if (full || field in account) update[field] = account[field] ?? null
    }
    // Fields first, default second: the default insert fires the mirror, and
    // it must see the filled account, never an empty one.
    await updateCashAccountPayee(supabase, companyId, target, update)
    if (adopt) await setInvoicePayeeDefault(supabase, companyId, 'SEK', target)
    written.push(currency)
  }
  return written
}

function clean(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/** Strip inner whitespace (IBAN, BIC), optionally upper-casing. */
function compact(value: string | null, upper = false): string | null {
  if (value === null) return null
  const stripped = value.replace(/\s/g, '')
  return upper ? stripped.toUpperCase() : stripped
}
