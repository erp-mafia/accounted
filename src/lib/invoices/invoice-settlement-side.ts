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
 *               (20261031225028). The verifikat must also book the
 *               invoice's sale or receivable, not a private withdrawal or an
 *               owner's deposit: voucherBooksSale, the twin of
 *               invoice_voucher_books_sale() (#146).
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
import { fetchLinesByEntryIds } from '@/lib/bookkeeping/entry-lines'
import { SE_ENSKILD_FIRMA } from '@/lib/company/forms/se-enskild-firma'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

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

/** One line of a verifikat, as voucherBooksSale reads it. */
export interface SaleCheckLine {
  account_number: string | null
  debit_amount: number | string | null
  credit_amount: number | string | null
}

/** BAS class 3, rörelsens inkomster: a credit there books a sale. */
const SALE_ACCOUNT_PREFIX = '3'

/**
 * Whether a verifikat read on the bank_debit side books this invoice's sale
 * or its receivable (#146): the TypeScript twin of invoice_voucher_books_sale()
 * (20261109060100), which link_invoice_to_voucher reads. A pg-real parity
 * test pins the two together.
 *
 * Accepted: a credit on revenue (3xxx), on kundfordringar (151x, a receivable
 * booked elsewhere, such as a migrated year-end carry or a manual Dr 1510),
 * or on an account the invoice's own lines post to (`invoiceLineAccounts`,
 * invoice_items.revenue_account: an outlay, a deposit on 2420, interest on
 * 8xxx). Refused: a verifikat with none of those credits, such as a private
 * withdrawal (Dr 2013 / Cr 19xx) or an owner deposit (Dr 19xx / Cr 2018), and
 * any verifikat that debits 2013 while crediting 19xx: firm money moved to
 * the owner, which the 2013 debit would count as the customer's payment.
 *
 * Adding line accounts can only turn a refusal into an acceptance, so a
 * caller may ask with none first and read the invoice's lines only when that
 * answer is false.
 */
export function voucherBooksSale(
  lines: readonly SaleCheckLine[],
  invoiceLineAccounts: readonly string[],
): boolean {
  const booksSale = lines.some((line) =>
    !!line.account_number &&
    Number(line.credit_amount) > 0 &&
    (line.account_number.startsWith(SALE_ACCOUNT_PREFIX) ||
      line.account_number.startsWith(AR_CREDIT_SIDE.accountPrefix) ||
      invoiceLineAccounts.includes(line.account_number)))
  if (!booksSale) return false
  const ownerWithdrawal = lines.some((line) =>
    line.account_number === OWNER_PRIVATE_FUNDS_ACCOUNT && Number(line.debit_amount) > 0)
  const paidFromFunds = lines.some((line) =>
    !!line.account_number &&
    line.account_number.startsWith(BANK_DEBIT_SIDE.accountPrefix) &&
    Number(line.credit_amount) > 0)
  return !(ownerWithdrawal && paidFromFunds)
}

/**
 * The accounts the invoice's own lines post to (invoice_items.revenue_account),
 * as invoice_voucher_books_sale() is handed them. A line without one books a
 * class 3 account derived from its VAT treatment, which voucherBooksSale
 * accepts anyway. Throws on a failed read.
 */
export async function invoiceLinePostingAccounts(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<string[]> {
  const rows = await fetchAllRows<{ id: string; revenue_account: string | null }>(
    ({ from, to }) =>
      supabase
        .from('invoice_items')
        .select('id, revenue_account')
        .eq('invoice_id', invoiceId)
        .order('id', { ascending: true })
        .range(from, to),
    { dedupeBy: (row) => row.id },
  )
  return [...new Set(rows.map((row) => row.revenue_account).filter((a): a is string => !!a))]
}

/**
 * The vouchers among `entryIds` that book the sale or the receivable of
 * `invoiceId` (voucherBooksSale), for the bank_debit candidate search. Every
 * line of every voucher is read, chunked and paginated (fetchLinesByEntryIds),
 * so a wide window cannot drop a voucher at PostgREST's row cap. The invoice's
 * line accounts are read only when some voucher needs them. Throws on a
 * failed read.
 */
export async function vouchersBookingSale(
  supabase: SupabaseClient,
  invoiceId: string,
  entryIds: readonly string[],
): Promise<Set<string>> {
  if (entryIds.length === 0) return new Set()
  const lines = await fetchLinesByEntryIds<SaleCheckLine & { id: string; journal_entry_id: string }>(
    supabase,
    [...entryIds],
    'id, journal_entry_id, account_number, debit_amount, credit_amount',
  )
  const linesByEntry = new Map<string, SaleCheckLine[]>()
  for (const line of lines) {
    const list = linesByEntry.get(line.journal_entry_id) ?? []
    list.push(line)
    linesByEntry.set(line.journal_entry_id, list)
  }
  const sales = new Set<string>()
  const undecided: string[] = []
  for (const [entryId, entryLines] of linesByEntry) {
    if (voucherBooksSale(entryLines, [])) sales.add(entryId)
    else undecided.push(entryId)
  }
  if (undecided.length > 0) {
    const lineAccounts = await invoiceLinePostingAccounts(supabase, invoiceId)
    for (const entryId of undecided) {
      if (voucherBooksSale(linesByEntry.get(entryId) ?? [], lineAccounts)) sales.add(entryId)
    }
  }
  return sales
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
