import type { SupabaseClient } from '@supabase/supabase-js'
import type { CashAccount, Currency, Invoice, InvoicePaymentAccount } from '@/types'
import { cashAccountPayee, isBankCashAccount, isUsableInvoicePayee } from '@/lib/cash-accounts/invoice-payee'
import { invoiceRequiresPaymentAccount } from '@/lib/invoices/payment-accounts'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants'
import { createLogger } from '@/lib/logger'

const log = createLogger('invoices/payee')

export type InvoicePayeeFields = {
  payment_cash_account_id: string | null
  payment_details: InvoicePaymentAccount | null
}

export type InvoicePayeeChoiceResult =
  | { ok: true; fields: InvoicePayeeFields }
  | { ok: false; code: 'INVOICE_PAYEE_ACCOUNT_INVALID'; details: Record<string, unknown> }

async function loadPayeeAccount(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string,
): Promise<CashAccount | null> {
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', cashAccountId)
    .maybeSingle()
  if (error) throw new Error(`cash_accounts lookup failed: ${error.message}`)
  return (data as CashAccount | null) ?? null
}

/**
 * Validate a draft's choice of payee account and freeze its payee fields.
 * Used by every invoice create/update path (dashboard, v1, MCP) so the rule
 * cannot drift: the account must be the company's, flagged as a payee, and
 * usable for the invoice currency (an IBAN for anything but SEK).
 *
 * null/undefined = no choice: both columns are cleared and the invoice
 * resolves the company's default for its currency at render time.
 */
export async function resolveInvoicePayeeChoice(
  supabase: SupabaseClient,
  companyId: string,
  currency: Currency,
  cashAccountId: string | null | undefined,
): Promise<InvoicePayeeChoiceResult> {
  if (!cashAccountId) {
    return { ok: true, fields: { payment_cash_account_id: null, payment_details: null } }
  }
  const account = await loadPayeeAccount(supabase, companyId, cashAccountId)
  if (!account || !isBankCashAccount(account) || !isUsableInvoicePayee(account, currency)) {
    return {
      ok: false,
      code: 'INVOICE_PAYEE_ACCOUNT_INVALID',
      details: {
        cash_account_id: cashAccountId,
        currency,
        reason: !account ? 'not_found' : !isBankCashAccount(account) ? 'not_bank_account' : !account.enabled ? 'disabled' : !account.invoice_payee ? 'not_payee' : 'unusable_for_currency',
      },
    }
  }
  return {
    ok: true,
    fields: { payment_cash_account_id: account.id, payment_details: cashAccountPayee(account) },
  }
}

export type InvoicePayeeSnapshotResult =
  | { ok: true; payee: InvoicePaymentAccount | null }
  | { ok: false; code: 'INVOICE_SEND_PAYMENT_ACCOUNT_INVALID' | 'INVOICE_PAYEE_SNAPSHOT_FAILED'; details: Record<string, unknown> }

export interface SnapshotInvoicePayeeOptions {
  /** false = validate and return the payee without writing (dry runs). */
  persist?: boolean
}

/**
 * At issue (send, mark-sent, Peppol, recurring): refresh the frozen payee of
 * an invoice that chose a bank account from the account as it is now, and
 * persist it. From here on the invoice prints these fields whatever happens
 * to the account. An account that can no longer be used blocks issue with a
 * specific error instead of silently printing the company default.
 *
 * Invoices without a chosen account are left alone (payee null): they keep
 * resolving the per-currency default exactly as before this feature.
 */
export async function snapshotInvoicePayee(
  supabase: SupabaseClient,
  companyId: string,
  invoice: Pick<Invoice, 'id' | 'currency'>
    & Partial<Pick<Invoice, 'payment_cash_account_id' | 'payment_details' | 'document_type' | 'credited_invoice_id'>>,
  opts: SnapshotInvoicePayeeOptions = {},
): Promise<InvoicePayeeSnapshotResult> {
  const cashAccountId = invoice.payment_cash_account_id ?? null
  if (!cashAccountId) return { ok: true, payee: invoice.payment_details ?? null }
  // Credit notes, proformas, delivery notes and quotes print no payee: a
  // stale account on them must not block issue.
  if (!invoiceRequiresPaymentAccount({
    credited_invoice_id: invoice.credited_invoice_id ?? null,
    document_type: invoice.document_type ?? 'invoice',
  })) {
    return { ok: true, payee: invoice.payment_details ?? null }
  }

  const account = await loadPayeeAccount(supabase, companyId, cashAccountId)
  if (!account || !isBankCashAccount(account) || !isUsableInvoicePayee(account, invoice.currency)) {
    return {
      ok: false,
      code: 'INVOICE_SEND_PAYMENT_ACCOUNT_INVALID',
      details: { cash_account_id: cashAccountId, currency: invoice.currency },
    }
  }
  const payee = cashAccountPayee(account)
  const current = invoice.payment_details ?? null
  if (opts.persist !== false && JSON.stringify(current) !== JSON.stringify(payee)) {
    const { error } = await supabase
      .from('invoices')
      .update({ payment_details: payee })
      .eq('id', invoice.id)
      .eq('company_id', companyId)
    if (error) {
      // Issue must not continue: the document would print a payee the row
      // does not carry, and a later re-render would disagree with it.
      log.error('invoice payee snapshot write failed', { invoiceId: invoice.id, error: error.message })
      return {
        ok: false,
        code: 'INVOICE_PAYEE_SNAPSHOT_FAILED',
        details: { cash_account_id: cashAccountId, invoice_id: invoice.id, pgMessage: error.message },
      }
    }
  }
  return { ok: true, payee }
}

/**
 * The BAS account a manual "mark as paid" debits: the chosen payee account's
 * ledger account (1930, 1931, ...) when the invoice chose one and the row
 * still exists, else the 1930 default the generators have always used.
 * Bank-transaction matches never come here: they debit the account the
 * money actually landed on (resolveSettlementAccount on the transaction).
 */
export async function resolveInvoiceSettlementAccount(
  supabase: SupabaseClient,
  companyId: string,
  invoice: Partial<Pick<Invoice, 'payment_cash_account_id'>>,
): Promise<string> {
  const cashAccountId = invoice.payment_cash_account_id ?? null
  if (!cashAccountId) return '1930'
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('ledger_account, enabled')
    .eq('company_id', companyId)
    .eq('id', cashAccountId)
    .maybeSingle()
  if (error) {
    log.warn('settlement account lookup failed; defaulting to 1930', { cashAccountId, error: error.message })
    return '1930'
  }
  const row = data as { ledger_account?: string; enabled?: boolean } | null
  const ledger = row?.ledger_account
  // Only a live bank account (19xx) may take the debit: a PSP clearing
  // account (1686, 1680, 1584) cleared later by a payout must never receive
  // a bank transfer, and a disabled or deleted account is not where money
  // lands any more. Both fall back to 1930, and say so: the printed invoice
  // named another account, so the bookkeeper must know.
  if (!row || !ledger || !ACCOUNT_NUMBER_RE.test(ledger) || !isBankCashAccount({ ledger_account: ledger }) || row.enabled === false) {
    log.warn('chosen payee account is not a live bank account; debiting 1930 instead', {
      cashAccountId,
      ledger: ledger ?? null,
      enabled: row?.enabled ?? null,
      found: Boolean(row),
    })
    return '1930'
  }
  return ledger
}
