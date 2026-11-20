/**
 * Which line of a posted verifikat settles a supplier invoice.
 *
 * The rule is NOT written here. It lives once, in the SQL function
 * `supplier_invoice_settlement_side` (migration 20260921190300), and the
 * `link_supplier_invoice_to_voucher` RPC reads the very same function. The
 * candidate matcher and the pre-stage validator ask it through this module, so
 * what the screen offers and what the RPC accepts cannot drift apart again
 * (issue #2854: the supplier side stayed 244x-only for three months after the
 * customer side learned kontantmetoden, because each copy decided on its own).
 *
 *   ap_debit     the 244x debit. Faktureringsmetoden, and any invoice that
 *                carries a registration verifikat (its skuld sits on 244x).
 *   bank_credit  the 19xx credit. A kontantmetod company's invoice with no
 *                registration verifikat: the voucher that moved the money,
 *                Dr cost, Dr 2641 / Cr 19xx, IS the whole booking. The owner
 *                may have paid with private money instead (crm#1817): Dr
 *                cost, Dr 2641 / Cr 2018 Övriga egna insättningar (enskild
 *                firma) or Cr 2893 Skulder till närstående personer
 *                (aktiebolag), the verifikat the utlägg writer posts for an
 *                invoice registered as paid privately. That credit counts
 *                only on a verifikat that books a purchase, never on an
 *                owner's deposit or loan: settlesOnAccount and
 *                voucherBooksPurchase, the twins of
 *                supplier_invoice_settlement_line() and
 *                supplier_invoice_voucher_books_purchase() (20261114070000),
 *                pinned together by a pg-real parity test.
 *
 * The function takes the invoice id and reads the row itself, on purpose:
 * every caller builds its own narrow invoice projection, and a projection that
 * happened to leave out registration_journal_entry_id must not be able to flip
 * the side.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchLinesByEntryIds } from '@/lib/bookkeeping/entry-lines'
import { SE_AKTIEBOLAG } from '@/lib/company/forms/se-aktiebolag'
import { SE_ENSKILD_FIRMA } from '@/lib/company/forms/se-enskild-firma'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

const log = createLogger('supplier-settlement-side')

export type SupplierSettlementSideName = 'ap_debit' | 'bank_credit'

export interface SupplierSettlementSide {
  side: SupplierSettlementSideName
  /** BAS account prefix of the settlement line: '244' or '19'. */
  accountPrefix: string
  /** Which ledger column carries the settlement amount. */
  entrySide: 'debit' | 'credit'
}

/** The side every supplier invoice had before 20260921190300. Also the answer
 *  when the function cannot be read: the historical behaviour, never a guess
 *  at the weaker discriminator. */
export const AP_DEBIT_SIDE: SupplierSettlementSide = {
  side: 'ap_debit',
  accountPrefix: '244',
  entrySide: 'debit',
}

interface SettlementSideRow {
  settlement_side?: string | null
  account_prefix?: string | null
  entry_side?: string | null
}

export async function resolveSupplierSettlementSide(
  supabase: SupabaseClient,
  companyId: string,
  supplierInvoiceId: string,
): Promise<SupplierSettlementSide> {
  const { data, error } = await supabase
    .rpc('supplier_invoice_settlement_side', {
      p_supplier_invoice_id: supplierInvoiceId,
      p_company_id: companyId,
    })
    .maybeSingle()

  const row = data as SettlementSideRow | null
  const known =
    (row?.settlement_side === 'ap_debit' || row?.settlement_side === 'bank_credit') &&
    typeof row.account_prefix === 'string' &&
    row.account_prefix.length > 0 &&
    (row.entry_side === 'debit' || row.entry_side === 'credit')

  if (error || !row || !known) {
    // A kontantmetod company would silently get the 244x search and an empty
    // candidate list: make the fallback visible so it is diagnosable.
    log.warn('settlement side unavailable; falling back to the 244x debit', {
      companyId,
      supplierInvoiceId,
      message: error?.message,
    })
    return AP_DEBIT_SIDE
  }

  return {
    side: row.settlement_side as SupplierSettlementSideName,
    accountPrefix: row.account_prefix as string,
    entrySide: row.entry_side as 'debit' | 'credit',
  }
}

/** The account prefix the bank_credit side has always read. */
const BANK_CREDIT_PREFIX = '19'

/**
 * The owner's private funds on the bank_credit side: the account an owner's
 * utlägg is credited to, 2018 Övriga egna insättningar in an enskild firma and
 * 2893 Skulder till närstående personer in an aktiebolag (crm#1817).
 * supplier_invoice_settlement_line() names the same two. An employee's utlägg
 * (2820) and a förening's 2890 are deliberately not read.
 */
export const OWNER_PRIVATE_FUNDS_ACCOUNTS: readonly string[] = [
  SE_ENSKILD_FIRMA.equity.settlement.contribution,
  SE_AKTIEBOLAG.equity.settlement.contribution,
]

/** Accounts that can settle on a side besides its accountPrefix. */
export const SUPPLIER_SETTLEMENT_ACCOUNTS_BEYOND_PREFIX: Readonly<
  Record<SupplierSettlementSideName, readonly string[]>
> = {
  bank_credit: OWNER_PRIVATE_FUNDS_ACCOUNTS,
  ap_debit: [],
}

/**
 * Whether a verifikat line on `accountNumber` is on the settlement side: the
 * TypeScript twin of supplier_invoice_settlement_line() (20261114070000),
 * which the link_supplier_invoice_to_voucher RPC reads. 244x on ap_debit; on
 * bank_credit 19xx, or the owner's private funds when the verifikat books a
 * purchase (`booksPurchase`: voucherBooksPurchase).
 */
export function settlesOnAccount(
  side: SupplierSettlementSide,
  accountNumber: string | null | undefined,
  booksPurchase: boolean,
): boolean {
  if (!accountNumber) return false
  return accountNumber.startsWith(side.accountPrefix) ||
    (booksPurchase && SUPPLIER_SETTLEMENT_ACCOUNTS_BEYOND_PREFIX[side.side].includes(accountNumber))
}


/** One line of a verifikat, as voucherBooksPurchase reads it. */
export interface PurchaseCheckLine {
  account_number: string | null
  debit_amount: number | string | null
  credit_amount?: number | string | null
}

/** BAS classes 4 to 7, rörelsens kostnader: a debit there books a purchase. */
const COST_ACCOUNT_PREFIXES = ['4', '5', '6', '7'] as const

/**
 * Whether a verifikat books a purchase (crm#1817): the TypeScript twin of
 * supplier_invoice_voucher_books_purchase() (20261114070000), which
 * link_supplier_invoice_to_voucher reads on the bank_credit side to decide
 * whether a credit on the owner's private funds is a payment. A pg-real
 * parity test pins the two together.
 *
 * Accepted: a debit on a cost account (class 4 to 7), or on an account the
 * invoice's own lines post to (`invoiceLineAccounts`,
 * supplier_invoice_items.account_number: an inventarie on 12xx, a prepaid
 * cost on 17xx), never a 19xx one. Refused: a verifikat with none of those
 * debits, such as an owner's deposit or loan (Dr 19xx / Cr 2018 or 2893) or a
 * skuld the owner cleared (Dr 2440 / Cr 2893).
 *
 * Adding line accounts can only turn a refusal into an acceptance, so a
 * caller may ask with none first and read the invoice's lines only when that
 * answer is false.
 */
export function voucherBooksPurchase(
  lines: readonly PurchaseCheckLine[],
  invoiceLineAccounts: readonly string[],
): boolean {
  return lines.some((line) => {
    const account = line.account_number
    if (!account || !(Number(line.debit_amount) > 0)) return false
    return COST_ACCOUNT_PREFIXES.some((prefix) => account.startsWith(prefix)) ||
      (!account.startsWith(BANK_CREDIT_PREFIX) && invoiceLineAccounts.includes(account))
  })
}

/**
 * The accounts the supplier invoice's own lines post to
 * (supplier_invoice_items.account_number), as
 * supplier_invoice_voucher_books_purchase() is handed them. Throws on a
 * failed read.
 */
export async function supplierInvoiceLinePostingAccounts(
  supabase: SupabaseClient,
  supplierInvoiceId: string,
): Promise<string[]> {
  const rows = await fetchAllRows<{ id: string; account_number: string | null }>(
    ({ from, to }) =>
      supabase
        .from('supplier_invoice_items')
        .select('id, account_number')
        .eq('supplier_invoice_id', supplierInvoiceId)
        .order('id', { ascending: true })
        .range(from, to),
    { dedupeBy: (row) => row.id },
  )
  return [...new Set(rows.map((row) => row.account_number).filter((a): a is string => !!a))]
}

/**
 * The vouchers among `entryIds` that book a purchase for `supplierInvoiceId`
 * (voucherBooksPurchase), for the bank_credit candidate search. Every line of
 * every voucher is read, chunked and paginated (fetchLinesByEntryIds). The
 * invoice's line accounts are read only when some voucher needs them. Throws
 * on a failed read.
 */
export async function vouchersBookingPurchase(
  supabase: SupabaseClient,
  supplierInvoiceId: string,
  entryIds: readonly string[],
): Promise<Set<string>> {
  if (entryIds.length === 0) return new Set()
  const lines = await fetchLinesByEntryIds<PurchaseCheckLine & { id: string; journal_entry_id: string }>(
    supabase,
    [...entryIds],
    'id, journal_entry_id, account_number, debit_amount, credit_amount',
  )
  const linesByEntry = new Map<string, PurchaseCheckLine[]>()
  for (const line of lines) {
    const list = linesByEntry.get(line.journal_entry_id) ?? []
    list.push(line)
    linesByEntry.set(line.journal_entry_id, list)
  }
  const purchases = new Set<string>()
  const undecided: string[] = []
  for (const [entryId, entryLines] of linesByEntry) {
    if (voucherBooksPurchase(entryLines, [])) purchases.add(entryId)
    else undecided.push(entryId)
  }
  if (undecided.length > 0) {
    const lineAccounts = await supplierInvoiceLinePostingAccounts(supabase, supplierInvoiceId)
    for (const entryId of undecided) {
      if (voucherBooksPurchase(linesByEntry.get(entryId) ?? [], lineAccounts)) purchases.add(entryId)
    }
  }
  return purchases
}
