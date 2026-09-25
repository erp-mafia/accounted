/**
 * What a user can do to the company's bank and cash accounts (cash_accounts):
 * create one by hand, edit it (verifikationsserie, payee details, name,
 * enabled), make it the primary, and choose the default payee account per
 * invoice currency. One implementation behind the dashboard routes
 * (/api/cash-accounts/**), the v1 operations and the MCP tools
 * (lib/operations/cash-accounts.ts), so every door applies the same rules:
 *
 *   - owner/admin only for everything that decides where customers pay or
 *     where unrouted bookings land: creating an account, its payee fields,
 *     name and invoice_payee flag, the enabled toggle, the primary and the
 *     per-currency payee defaults. The verifikationsserie alone is any
 *     writer's. Checked here, not only in the dashboard wrapper, because the
 *     v1 and MCP doors run as the service role, where RLS and the RPC's own
 *     auth.uid() admin check do not apply.
 *   - payee details only on giro/bank rows (BAS 1920-1999), never a PSP
 *     clearing account or a till;
 *   - never the same IBAN on two rows (the Grönsinka 1938 case: one physical
 *     account twice means a second ledger for the same money);
 *   - enabled: never a connection-held row, never disable the primary or an
 *     account with unbooked transactions (setEnabled's UPDATE carries the
 *     first two, so a row that changes in between is still refused);
 *   - the primary moves only through make_cash_account_primary, which locks,
 *     checks eligibility and swaps the flag in one transaction.
 *
 * A dry run reads, checks and answers a preview; it writes nothing (it is
 * also the MCP staging preview).
 */
import type { z } from 'zod'
import type { CashAccount, Currency } from '@/types'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { CreateCashAccountSchema, UpdateCashAccountFieldsSchema } from '@/lib/api/schemas'
import { UUID_RE } from '@/lib/invariants/uuid'
import { hasOpenTransactions, setEnabled, setVoucherSeries } from '@/lib/cash-accounts/service'
import {
  insertManualBankAccount,
  isBankCashAccount,
  isUsableInvoicePayee,
  loadInvoicePayeeState,
  planManualBankAccount,
  setInvoicePayeeDefault,
  updateCashAccountPayee,
  type InvoicePayeeState,
  type PayeeUpdate,
} from '@/lib/cash-accounts/invoice-payee'
import { makePrimary, primaryIneligibleReason } from '@/lib/cash-accounts/primary'
import { requireCompanyAdmin } from '@/lib/operations/access'

const BANK_ADMIN_MESSAGE = 'Bara företagets ägare eller en administratör kan ändra bankkonton och betaluppgifter.'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

export type CreateCashAccountInput = z.infer<typeof CreateCashAccountSchema>
export type UpdateCashAccountInput = z.infer<typeof UpdateCashAccountFieldsSchema>

/** The keys of UpdateCashAccountSchema that are payee concerns (owner/admin). */
const PAYEE_KEYS = [
  'name',
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
  'invoice_payee',
] as const

const NOT_FOUND: Failure = { ok: false, code: 'CASH_ACCOUNT_NOT_FOUND' }

function failed(error: unknown): Failure {
  return { ok: false, code: 'UNKNOWN_ERROR', error }
}

/**
 * Owner/admin or nothing. Reads the caller's own membership row, which works
 * on the user's client (dashboard) and on the service client (v1, MCP)
 * alike; no membership fails closed.
 */

/** '' from a cleared form field clears the column: the same as null. */
function blankToNull<T extends Record<string, unknown>>(values: T): T {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value === '' ? null : value]),
  ) as T
}

function ibanKey(value: string | null | undefined): string | null {
  if (!value) return null
  const stripped = value.replace(/\s/g, '').toUpperCase()
  return stripped || null
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * A bank account typed in by hand (no bank connection). Gets the next free
 * 19xx slot for its currency unless one is given, and the chart row that
 * number needs. Owner/admin: it becomes a printable payee.
 */
export async function createCashAccount(
  ctx: OperationContext,
  input: CreateCashAccountInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<CashAccount>> {
  const { supabase, companyId, userId, log } = ctx
  const denied = await requireCompanyAdmin(ctx, BANK_ADMIN_MESSAGE)
  if (denied) return denied

  const payee = blankToNull((input.payee ?? {}) as Record<string, string | null | undefined>)
  const request = {
    name: input.name,
    currency: input.currency,
    ledger_account: input.ledger_account ?? null,
    invoice_payee: input.invoice_payee,
    payee,
  }

  let planned: Awaited<ReturnType<typeof planManualBankAccount>>
  try {
    planned = await planManualBankAccount(supabase, companyId, request)
  } catch (err) {
    log.error('cash account create plan failed', err as Error)
    return failed(err)
  }
  if (!planned.ok) {
    if (planned.reason === 'ledger_taken') {
      return { ok: false, code: 'CASH_ACCOUNT_LEDGER_TAKEN', details: { ledger_account: planned.ledger_account } }
    }
    if (planned.reason === 'iban_duplicate') {
      return { ok: false, code: 'CASH_ACCOUNT_IBAN_DUPLICATE', details: { existing_cash_account_id: planned.cash_account_id } }
    }
    return { ok: false, code: 'CASH_ACCOUNT_NO_FREE_LEDGER', details: { currency: input.currency } }
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        name: input.name.trim(),
        currency: planned.plan.currency,
        ledger_account: planned.plan.ledger_account,
        ledger_auto_picked: !input.ledger_account,
        invoice_payee: input.invoice_payee ?? true,
        source: 'manual',
        iban: planned.plan.iban,
      },
    }
  }

  try {
    const account = await insertManualBankAccount(supabase, companyId, userId, request, planned.plan)
    return { ok: true, data: account, created: true }
  } catch (err) {
    log.error('cash_accounts create failed', err as Error)
    return failed(err)
  }
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Three independent concerns on one of the company's accounts: the
 * verifikationsserie override (any writer), the payee fields + name +
 * invoice_payee (owner/admin, bank-type rows only) and enabled (owner/admin,
 * never a connection-held row, never disabling the primary or an account
 * with unbooked transactions). Ledger account and primary have their own
 * guarded flows.
 */
export async function updateCashAccount(
  ctx: OperationContext,
  cashAccountId: string,
  input: UpdateCashAccountInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<CashAccount>> {
  const { supabase, companyId, log } = ctx
  // A non-UUID id can never match a row; answer 404 instead of letting the
  // uuid cast surface as a 500 from Postgres.
  if (!UUID_RE.test(cashAccountId)) return NOT_FOUND

  const payeeUpdate: PayeeUpdate = {}
  for (const key of PAYEE_KEYS) {
    if (input[key] !== undefined) {
      ;(payeeUpdate as Record<string, unknown>)[key] = input[key] === '' ? null : input[key]
    }
  }
  const touchesPayee = Object.keys(payeeUpdate).length > 0

  // enabled rides the payee gate: it is one of the three conditions for an
  // account to print on invoices (isUsableInvoicePayee), so a member flipping
  // it would decide whether an approved payee shows.
  if (touchesPayee || input.enabled !== undefined) {
    const denied = await requireCompanyAdmin(ctx, BANK_ADMIN_MESSAGE)
    if (denied) return denied
  }

  let verified = false
  if (touchesPayee) {
    // Only giro/bank accounts (1920-1999) can be printed as payee. Stripe,
    // Woo and Shopify clearing rows live in the same table and must stay out.
    const { data: existing, error: existingError } = await supabase
      .from('cash_accounts')
      .select('id, ledger_account, iban, payee_iban')
      .eq('company_id', companyId)
      .eq('id', cashAccountId)
      .maybeSingle()
    if (existingError) return failed(existingError)
    if (!existing) return NOT_FOUND
    const row = existing as { ledger_account: string; iban?: string | null; payee_iban?: string | null }
    if (!isBankCashAccount(row)) {
      return {
        ok: false,
        code: 'INVOICE_PAYEE_ACCOUNT_INVALID',
        details: { cash_account_id: cashAccountId, reason: 'not_bank_account' },
      }
    }
    verified = true

    // A new printed IBAN must not be another row's account. Only checked when
    // the IBAN actually changes: a healed twin may still carry this row's own
    // IBAN, and re-saving the form must not trip over it.
    const newIban = ibanKey(payeeUpdate.iban)
    if (newIban && newIban !== ibanKey(row.iban) && newIban !== ibanKey(row.payee_iban)) {
      const { data: others, error: othersError } = await supabase
        .from('cash_accounts')
        .select('id, iban, payee_iban')
        .eq('company_id', companyId)
        .neq('id', cashAccountId)
      if (othersError) return failed(othersError)
      const twin = ((others ?? []) as { id: string; iban: string | null; payee_iban: string | null }[]).find(
        (other) => ibanKey(other.iban) === newIban || ibanKey(other.payee_iban) === newIban,
      )
      if (twin) {
        return { ok: false, code: 'CASH_ACCOUNT_IBAN_DUPLICATE', details: { existing_cash_account_id: twin.id } }
      }
    }
  }

  // Why setEnabled() would refuse this row; null when it would not. The rules
  // themselves live in setEnabled()'s UPDATE predicate: this read only turns
  // a refusal into the right code, so it runs up front and again if the
  // guarded UPDATE matched nothing (a bank connection claimed the row).
  const explainEnabledRefusal = async (): Promise<Failure | null> => {
    const { data: existing, error: existingError } = await supabase
      .from('cash_accounts')
      .select('id, is_primary, bank_connection_id')
      .eq('company_id', companyId)
      .eq('id', cashAccountId)
      .maybeSingle()
    if (existingError) return failed(existingError)
    if (!existing) return NOT_FOUND
    const row = existing as { is_primary: boolean; bank_connection_id: string | null }
    if (row.bank_connection_id !== null) {
      return { ok: false, code: 'CASH_ACCOUNT_ENABLED_BANK_MANAGED', details: { cash_account_id: cashAccountId } }
    }
    if (input.enabled === false && row.is_primary) {
      return { ok: false, code: 'CASH_ACCOUNT_DISABLE_PRIMARY', details: { cash_account_id: cashAccountId } }
    }
    return null
  }

  if (input.enabled !== undefined) {
    const refusal = await explainEnabledRefusal()
    if (refusal) return refusal
    verified = true
    try {
      if (input.enabled === false && (await hasOpenTransactions(supabase, companyId, cashAccountId))) {
        return { ok: false, code: 'CASH_ACCOUNT_DISABLE_UNRESOLVED', details: { cash_account_id: cashAccountId } }
      }
    } catch (err) {
      return failed(err)
    }
  }

  if (options.dryRun) {
    if (!verified) {
      const { data: existing, error: existingError } = await supabase
        .from('cash_accounts')
        .select('id')
        .eq('company_id', companyId)
        .eq('id', cashAccountId)
        .maybeSingle()
      if (existingError) return failed(existingError)
      if (!existing) return NOT_FOUND
    }
    const changes: Record<string, unknown> = { ...payeeUpdate }
    if (input.voucher_series !== undefined) changes.voucher_series = input.voucher_series
    if (input.enabled !== undefined) changes.enabled = input.enabled
    return { ok: true, dryRun: true, preview: { cash_account_id: cashAccountId, changes } }
  }

  let updated: CashAccount | null = null
  try {
    if (input.voucher_series !== undefined) {
      updated = await setVoucherSeries(supabase, companyId, cashAccountId, input.voucher_series)
      if (!updated) return NOT_FOUND
    }
    if (touchesPayee) {
      updated = await updateCashAccountPayee(supabase, companyId, cashAccountId, payeeUpdate)
    }
    if (input.enabled !== undefined) {
      updated = await setEnabled(supabase, companyId, cashAccountId, input.enabled)
      if (!updated) return (await explainEnabledRefusal()) ?? NOT_FOUND
    }
  } catch (err) {
    log.error('cash_accounts update failed', err as Error)
    return failed(err)
  }

  if (!updated) return NOT_FOUND
  return { ok: true, data: updated }
}

// ---------------------------------------------------------------------------
// Primary
// ---------------------------------------------------------------------------

/**
 * Make one of the company's accounts its primary: the skattekonto
 * __PRIMARY_SEK__ counter leg and the owner of transactions with no
 * cash_account_id. Only through make_cash_account_primary (never
 * set_cash_account_primary, which carries the flag for system merges and has
 * no eligibility rule). Only bookings made after the call follow the new
 * primary; nothing posted is read or written.
 */
export async function setPrimaryCashAccount(
  ctx: OperationContext,
  cashAccountId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<CashAccount>> {
  const { supabase, companyId, log } = ctx
  if (!UUID_RE.test(cashAccountId)) return NOT_FOUND
  const denied = await requireCompanyAdmin(ctx, BANK_ADMIN_MESSAGE)
  if (denied) return denied

  if (options.dryRun) {
    // The same rule the RPC enforces (primaryIneligibleReason mirrors it;
    // tests/pg/cash-accounts-routing-audit.pg.test.ts keeps them together).
    const { data: existing, error: existingError } = await supabase
      .from('cash_accounts')
      .select('id, ledger_account, currency, enabled, is_primary')
      .eq('company_id', companyId)
      .eq('id', cashAccountId)
      .maybeSingle()
    if (existingError) return failed(existingError)
    if (!existing) return NOT_FOUND
    const row = existing as Pick<CashAccount, 'ledger_account' | 'currency' | 'enabled' | 'is_primary'>
    const reason = primaryIneligibleReason(row)
    if (reason) {
      return { ok: false, code: 'CASH_ACCOUNT_PRIMARY_INELIGIBLE', details: { cash_account_id: cashAccountId, reason } }
    }
    return {
      ok: true,
      dryRun: true,
      preview: { cash_account_id: cashAccountId, ledger_account: row.ledger_account, already_primary: row.is_primary },
    }
  }

  try {
    const result = await makePrimary(supabase, companyId, cashAccountId)
    if (result.ok) return { ok: true, data: result.account }
    if (result.reason === 'not_found') return NOT_FOUND
    // The database's own owner/admin check: the membership changed between
    // the read above and the call.
    if (result.reason === 'forbidden') {
      return { ok: false, code: 'FORBIDDEN', details: { required_roles: ['owner', 'admin'] } }
    }
    return {
      ok: false,
      code: 'CASH_ACCOUNT_PRIMARY_INELIGIBLE',
      details: { cash_account_id: cashAccountId, reason: result.reason },
    }
  } catch (err) {
    log.error('cash_accounts make primary failed', err as Error)
    return failed(err)
  }
}

// ---------------------------------------------------------------------------
// Per-currency payee default
// ---------------------------------------------------------------------------

/**
 * Set (or clear with null) which account an invoice in `currency` prints as
 * payee when the invoice does not choose. The account must be printable for
 * the currency: bank-type, enabled, flagged as payee, with the identifiers
 * the currency needs. The mirror trigger rewrites the legacy company_settings
 * map from the chosen account.
 */
export async function setCashAccountPayeeDefault(
  ctx: OperationContext,
  input: { currency: Currency; cash_account_id: string | null },
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<InvoicePayeeState>> {
  const { supabase, companyId, log } = ctx
  const { currency, cash_account_id } = input
  const denied = await requireCompanyAdmin(ctx, BANK_ADMIN_MESSAGE)
  if (denied) return denied

  if (cash_account_id) {
    const { data: account, error } = await supabase
      .from('cash_accounts')
      .select('*')
      .eq('company_id', companyId)
      .eq('id', cash_account_id)
      .maybeSingle()
    if (error) {
      log.error('invoice payee default account lookup failed', error)
      return failed(error)
    }
    if (!account) return NOT_FOUND
    const typed = account as CashAccount
    if (!isBankCashAccount(typed) || !isUsableInvoicePayee(typed, currency)) {
      return {
        ok: false,
        code: 'INVOICE_PAYEE_ACCOUNT_INVALID',
        details: {
          cash_account_id,
          currency,
          reason: !isBankCashAccount(typed)
            ? 'not_bank_account'
            : !typed.enabled
              ? 'disabled'
              : !typed.invoice_payee
                ? 'not_payee'
                : 'unusable_for_currency',
        },
      }
    }
  }

  if (options.dryRun) {
    return { ok: true, dryRun: true, preview: { currency, cash_account_id, action: cash_account_id ? 'set' : 'clear' } }
  }

  try {
    await setInvoicePayeeDefault(supabase, companyId, currency, cash_account_id)
    const state = await loadInvoicePayeeState(supabase, companyId)
    return { ok: true, data: state }
  } catch (err) {
    log.error('invoice payee default set failed', err as Error)
    return failed(err)
  }
}
