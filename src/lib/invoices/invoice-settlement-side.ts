/**
 * Which line of a posted verifikat settles a customer invoice.
 *
 * The rule lives once, in the SQL function `invoice_settlement_side`
 * (migration 20261018131110), and the `link_invoice_to_voucher` RPC reads the
 * very same function. The candidate matcher and the pre-stage validator
 * (./voucher-matching.ts) ask it through this module, so what the dialog
 * offers and what the RPC accepts cannot drift apart. The supplier side has
 * had the same shape since 20260921190300 (./supplier-settlement-side.ts).
 *
 *   bank_debit  the debit where the money landed. A kontantmetod company's
 *               invoice with no booking verifikat (journal_entry_id IS NULL):
 *               the voucher that received the payment, Dr 19xx / Cr 30xx +
 *               26xx, IS the whole booking. The money may also have reached
 *               the owner privately (a private account or wallet, crm#1580):
 *               Dr 2013 Övriga egna uttag / Cr 30xx + 26xx, the verifikat the
 *               mark-paid dialog books for such a payment. Which lines count
 *               is settlesOnAccount, the twin of invoice_settlement_line()
 *               (20261031225028).
 *   ar_credit   the 151x credit. Every other invoice: faktureringsmetoden,
 *               an invoice booked at issue before a switch to kontantmetoden,
 *               and a kontantmetod invoice carried over the year end
 *               (årsomföring, #3440), whose receivable sits on 1510.
 *
 * Before #3440 the customer side chose by the company's method alone, so a
 * carried invoice accepted a revenue-and-moms cash voucher (the moms a second
 * time) and refused the correct Dr 19xx / Cr 1510 clearing.
 *
 * The function takes the invoice id and reads the row itself, on purpose:
 * the routes and MCP tools hand the matcher a narrow invoice projection that
 * does not contain journal_entry_id, and a projection must not be able to
 * flip the side. `invoiceSettlementSideFor` is the TypeScript twin of the SQL
 * rule, used only when the function cannot be read; a pg-real parity test
 * (__tests__/invoice-settlement-side.pg.test.ts) pins the two together.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { SE_ENSKILD_FIRMA } from '@/lib/company/forms/se-enskild-firma'
import { createLogger } from '@/lib/logger'

const log = createLogger('invoice-settlement-side')

export type InvoiceSettlementSideName = 'bank_debit' | 'ar_credit'

export interface InvoiceSettlementSide {
  side: InvoiceSettlementSideName
  /** BAS account prefix of the settlement line: '19' or '151'. */
  accountPrefix: string
  /** Which ledger column carries the settlement amount. */
  entrySide: 'debit' | 'credit'
}

export const AR_CREDIT_SIDE: InvoiceSettlementSide = {
  side: 'ar_credit',
  accountPrefix: '151',
  entrySide: 'credit',
}

export const BANK_DEBIT_SIDE: InvoiceSettlementSide = {
  side: 'bank_debit',
  accountPrefix: '19',
  entrySide: 'debit',
}

/**
 * The enskild firma's uttag account (BAS 2026 2013 Övriga egna uttag): under
 * kontantmetoden a customer who paid the owner privately settles the invoice
 * on this debit (crm#1580). invoice_settlement_line() names the same account.
 */
export const OWNER_PRIVATE_FUNDS_ACCOUNT = SE_ENSKILD_FIRMA.equity.settlement.withdrawal

/**
 * Accounts that settle on a side besides its accountPrefix: the owner's
 * private funds on the bank_debit side.
 */
export const SETTLEMENT_ACCOUNTS_BEYOND_PREFIX: Readonly<Record<InvoiceSettlementSideName, readonly string[]>> = {
  bank_debit: [OWNER_PRIVATE_FUNDS_ACCOUNT],
  ar_credit: [],
}

/**
 * Whether a verifikat line on `accountNumber` is on the settlement side: the
 * TypeScript twin of invoice_settlement_line() (20261031225028), which the
 * link_invoice_to_voucher RPC reads. 19xx or 2013 on bank_debit, 151x on
 * ar_credit.
 */
export function settlesOnAccount(
  side: InvoiceSettlementSide,
  accountNumber: string | null | undefined,
): boolean {
  if (!accountNumber) return false
  return accountNumber.startsWith(side.accountPrefix) ||
    SETTLEMENT_ACCOUNTS_BEYOND_PREFIX[side.side].includes(accountNumber)
}

/**
 * The TypeScript twin of invoice_settlement_side(): the 19xx debit for a
 * kontantmetod company's invoice that was never booked, the 151x credit for
 * every other invoice. A missing settings row is faktureringsmetoden, as in
 * the SQL COALESCE.
 */
export function invoiceSettlementSideFor(
  accountingMethod: string | null | undefined,
  journalEntryId: string | null | undefined,
): InvoiceSettlementSide {
  return (accountingMethod ?? 'accrual') === 'cash' && !journalEntryId
    ? BANK_DEBIT_SIDE
    : AR_CREDIT_SIDE
}

interface SettlementSideRow {
  settlement_side?: string | null
  account_prefix?: string | null
  entry_side?: string | null
}

/**
 * Ask the database which side settles `invoiceId`. When the function cannot
 * be read (a deploy that reaches the app before the migration, a transient
 * error), the twin answers from a direct read of the same two facts. When
 * even that read fails, the 151x credit: the side the RPC itself defaults
 * to, and a candidate list the RPC would never contradict with a moms-bearing
 * cash voucher.
 */
export async function resolveInvoiceSettlementSide(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
): Promise<InvoiceSettlementSide> {
  const { data, error } = await supabase
    .rpc('invoice_settlement_side', {
      p_invoice_id: invoiceId,
      p_company_id: companyId,
    })
    .maybeSingle()

  const row = data as SettlementSideRow | null
  if (!error && row) {
    if (row.settlement_side === 'bank_debit') return BANK_DEBIT_SIDE
    if (row.settlement_side === 'ar_credit') return AR_CREDIT_SIDE
  }

  log.warn('invoice_settlement_side unavailable; deciding with the TypeScript twin', {
    companyId,
    invoiceId,
    message: error?.message,
  })

  const [{ data: settings, error: settingsError }, { data: invoice, error: invoiceError }] =
    await Promise.all([
      supabase
        .from('company_settings')
        .select('accounting_method')
        .eq('company_id', companyId)
        .maybeSingle(),
      supabase
        .from('invoices')
        .select('id, journal_entry_id')
        .eq('id', invoiceId)
        .eq('company_id', companyId)
        .maybeSingle(),
    ])
  if (settingsError || invoiceError || !invoice) {
    log.warn('settlement side fallback read failed; using the 151x credit', {
      companyId,
      invoiceId,
      message: settingsError?.message ?? invoiceError?.message,
    })
    return AR_CREDIT_SIDE
  }
  return invoiceSettlementSideFor(
    (settings as { accounting_method?: string | null } | null)?.accounting_method,
    (invoice as { journal_entry_id?: string | null }).journal_entry_id,
  )
}
