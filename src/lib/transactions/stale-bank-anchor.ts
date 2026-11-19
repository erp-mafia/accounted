/**
 * A hand-made bank row whose verifikat books no bank line (PH 214).
 *
 * Before the bank-anchor guard (20260921183218, assert_bank_anchor_journal) a
 * row could be booked with a verifikat that has no line on the row's bank
 * account in the bank's direction: a webshop sale typed in as a transaction
 * and booked on the payment provider's clearing account (1580) instead of the
 * bank. The verifikat is right, and the clearing account is settled later by
 * the payout that really reaches the bank. The row is the wrong part: it is
 * no movement on the bank at all, yet the bank reconciliation counts it on
 * the bank side while nothing on the ledger answers it, so it sits in the
 * unexplained difference.
 *
 * Such a row could not be unlinked (the link is its booking, PH 194),
 * ignored or deleted (booked), and storno would void a correct verifikat.
 * Ignoring it is the honest way out: the link goes, the verifikat stays as it
 * is, and the row leaves the bank side. Only rows the user created qualify:
 * a feed or bank-file row is money that moved, so its verifikat is the part
 * to correct, never the row to drop (lib/transactions/origin.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { createLogger } from '@/lib/logger'
import { isImportedTransaction } from '@/lib/transactions/origin'

const log = createLogger('transactions.stale-bank-anchor')

/** The transactions columns the check reads; callers select them literally. */
export interface StaleAnchorRow {
  id: string
  journal_entry_id: string | null
  cash_account_id?: string | null
  currency?: string | null
  amount: number | string
  bank_connection_id?: string | null
  import_source?: string | null
  invoice_id?: string | null
  supplier_invoice_id?: string | null
}

/**
 * The ids among `rows` whose pointer names a posted verifikat with no line on
 * the row's settlement account in the bank's direction (the shape
 * assert_bank_anchor_journal refuses today), on a row the user created, with
 * no other anchor: no invoice on the row, no voucher link, no payment
 * allocation. Any read that fails leaves its rows out: a row that is not
 * offered the way out keeps today's refusal.
 */
export async function findStaleBankAnchors(
  supabase: SupabaseClient,
  companyId: string,
  rows: ReadonlyArray<StaleAnchorRow>,
): Promise<Set<string>> {
  const stale = new Set<string>()
  const candidates = rows.filter(
    (row) => row.journal_entry_id && !row.invoice_id && !row.supplier_invoice_id && !isImportedTransaction(row),
  )
  if (candidates.length === 0) return stale

  // The settlement account the guard checks: the row's cash account, else the
  // only enabled account in its currency, else 1930.
  const settlementByKey = new Map<string, string | null>()
  for (const row of candidates) {
    const key = `${row.cash_account_id ?? ''}|${row.currency ?? 'SEK'}`
    if (settlementByKey.has(key)) continue
    try {
      settlementByKey.set(
        key,
        await resolveSettlementAccount(supabase, companyId, row.cash_account_id ?? null, log, row.currency ?? 'SEK'),
      )
    } catch {
      settlementByKey.set(key, null)
    }
  }
  const settlementOf = (row: StaleAnchorRow) =>
    settlementByKey.get(`${row.cash_account_id ?? ''}|${row.currency ?? 'SEK'}`) ?? null

  const entryIds = [...new Set(candidates.map((row) => row.journal_entry_id as string))]
  const { data: entries, error: entriesError } = await supabase
    .from('journal_entries')
    .select('id, status')
    .eq('company_id', companyId)
    .in('id', entryIds)
  if (entriesError || !entries) return stale
  const posted = new Set(
    (entries as Array<{ id: string; status: string }>).filter((e) => e.status === 'posted').map((e) => e.id),
  )
  if (posted.size === 0) return stale

  const accounts = [...new Set([...settlementByKey.values()].filter((a): a is string => !!a))]
  if (accounts.length === 0) return stale
  const { data: lines, error: linesError } = await supabase
    .from('journal_entry_lines')
    .select('journal_entry_id, account_number, debit_amount, credit_amount')
    .in('journal_entry_id', [...posted])
    .in('account_number', accounts)
  if (linesError || !lines) return stale
  const typedLines = lines as Array<{
    journal_entry_id: string
    account_number: string
    debit_amount: number | string | null
    credit_amount: number | string | null
  }>

  const found: string[] = []
  for (const row of candidates) {
    const account = settlementOf(row)
    if (!account || !posted.has(row.journal_entry_id as string)) continue
    const amount = Number(row.amount)
    const booksBankLine = typedLines.some(
      (l) =>
        l.journal_entry_id === row.journal_entry_id &&
        l.account_number === account &&
        (amount < 0
          ? Number(l.credit_amount ?? 0) > 0
          : amount > 0
            ? Number(l.debit_amount ?? 0) > 0
            : Number(l.credit_amount ?? 0) > 0 || Number(l.debit_amount ?? 0) > 0),
    )
    if (!booksBankLine) found.push(row.id)
  }
  if (found.length === 0) return stale

  // A row also anchored elsewhere is not this shape: its other anchor keeps it.
  const [voucherLinks, invoicePayments, supplierPayments] = await Promise.all([
    supabase.from('transaction_voucher_links').select('transaction_id').eq('company_id', companyId).in('transaction_id', found),
    supabase.from('invoice_payments').select('transaction_id').in('transaction_id', found),
    supabase.from('supplier_invoice_payments').select('transaction_id').in('transaction_id', found),
  ])
  if (voucherLinks.error || invoicePayments.error || supplierPayments.error) return stale
  const anchored = new Set(
    [...(voucherLinks.data ?? []), ...(invoicePayments.data ?? []), ...(supplierPayments.data ?? [])].map(
      (r) => (r as { transaction_id: string }).transaction_id,
    ),
  )
  for (const id of found) if (!anchored.has(id)) stale.add(id)
  return stale
}
