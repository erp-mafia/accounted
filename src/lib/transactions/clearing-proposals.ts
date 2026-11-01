/**
 * Clearing proposals: the plug-in point through which a block that books
 * money onto a clearing account says which bank row is that money arriving.
 * The till's day voucher debits card and Swish to 1686; the acquirer's
 * payout and every Swish payment then reach the bank as ordinary rows, and
 * a row booked as sales a second time doubles the revenue. A proposer that
 * recognises such a row proposes booking it against the clearing account.
 *
 * The bank side owns which rows may be offered at all (incoming, open, no
 * stronger match: an invoice, a supplier invoice, a ROT/RUT payout, an
 * existing verifikat, a transfer between the company's own accounts) and
 * which rows are already booked against an account; the proposer owns what
 * its own records say. The static list proposeForTransactions runs is
 * lib/composition/clearing-proposals.ts.
 *
 * Proposals only: nothing here books, and booksWithoutReview never books a
 * clearing proposal from the row (lib/transactions/direct-booking.ts).
 *
 * The proposers depend on this file's types only.
 */
import { chunk as chunks } from '@/lib/utils'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BookingProposal } from '@/lib/bookkeeping/proposal'
import { fetchEntriesWithAccountLines, fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { addDaysIso } from '@/lib/dates/iso'
import type { Logger } from '@/lib/logger'
import type { ModuleId } from '@/lib/modules/manifest'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { Transaction, TransactionMethod } from '@/types'

/** A bank row as a proposer sees it. */
export interface ClearingBankRow {
  id: string
  date: string
  /** Positive: only incoming rows are offered. */
  amount: number
  currency: string | null
  /** The bank's own text when the row kept it, else the working title. */
  text: string
  merchant_name: string | null
  transaction_method: TransactionMethod | null
}

/** The bank rows a proposer may ask for beyond the ones it is asked about. */
export interface ClearingBankRows {
  /**
   * The rows dated from..to (inclusive) that may be offered as a clearing:
   * the same definition as the asked rows, so a proposer can see what
   * competes with them.
   */
  open(from: string, to: string): Promise<ClearingBankRow[]>
  /**
   * The incoming rows dated from..to that are booked against one of
   * `accounts` (a posted verifikat crediting it, through the row's pointer or
   * its bank-line link), each once.
   */
  cleared(accounts: readonly string[], from: string, to: string): Promise<ClearingBankRow[]>
}

export interface ClearingProposer {
  /** Stable, kebab-case: the log line names it. */
  readonly id: string
  /** The module that owns it. */
  readonly module: ModuleId
  /**
   * At most one proposal per asked row, keyed by transaction id; a row it
   * has nothing for is absent. May throw: the other proposals go on without
   * it. Must read nothing for a company it has no records for beyond the one
   * query that tells.
   */
  propose(
    supabase: SupabaseClient,
    companyId: string,
    asked: readonly ClearingBankRow[],
    bank: ClearingBankRows,
  ): Promise<Map<string, BookingProposal>>
}


/**
 * The columns `open` and `cleared` read, enough for clearingCandidate and
 * ClearingBankRow. Spelled out at each select so the phantom-column scanner
 * (tests/schema/no-phantom-columns.test.ts) can check them.
 */
type RowLike = Pick<
  Transaction,
  | 'id'
  | 'date'
  | 'amount'
  | 'currency'
  | 'description'
  | 'original_description'
  | 'merchant_name'
  | 'transaction_method'
  | 'counterparty_iban'
  | 'journal_entry_id'
  | 'is_ignored'
  | 'is_business'
  | 'invoice_id'
  | 'supplier_invoice_id'
  | 'potential_invoice_id'
  | 'potential_supplier_invoice_id'
  | 'potential_rot_rut_payout_request_id'
  | 'potential_journal_entry_id'
>

/**
 * Whether a row may be offered as a clearing, from the row alone: money in,
 * not booked, not ignored, not marked private, and no stronger match already
 * on it (a linked or suggested invoice or supplier invoice, a ROT/RUT
 * payout, a verifikat the reconciliation sweep found). A transfer between
 * the company's own accounts needs the cash accounts and is checked by the
 * runner (ownTransfer).
 */
export function clearingCandidate(tx: Partial<RowLike> & { amount: number }): boolean {
  if (!(Number(tx.amount) > 0)) return false
  if (tx.journal_entry_id) return false
  if (tx.is_ignored) return false
  if (tx.is_business === false) return false
  return !(
    tx.invoice_id ||
    tx.supplier_invoice_id ||
    tx.potential_invoice_id ||
    tx.potential_supplier_invoice_id ||
    tx.potential_rot_rut_payout_request_id ||
    tx.potential_journal_entry_id
  )
}

function bankRow(tx: Partial<RowLike> & { id: string; date: string; amount: number }): ClearingBankRow {
  return {
    id: tx.id,
    date: tx.date,
    amount: Number(tx.amount),
    currency: tx.currency ?? null,
    text: (tx.original_description ?? tx.description ?? '').trim(),
    merchant_name: tx.merchant_name ?? null,
    transaction_method: tx.transaction_method ?? null,
  }
}

const normalizeIban = (iban: string | null | undefined): string => (iban ?? '').replace(/\s+/g, '').toUpperCase()

/** The company's own IBANs, read once per run and only when a row names a counterparty IBAN. */
function ownIbanReader(supabase: SupabaseClient, companyId: string): () => Promise<ReadonlySet<string>> {
  let pending: Promise<ReadonlySet<string>> | null = null
  return () => {
    pending ??= (async () => {
      const { data, error } = await supabase.from('cash_accounts').select('iban').eq('company_id', companyId)
      if (error) throw new Error(`cash accounts read failed: ${error.message}`)
      return new Set(((data ?? []) as Array<{ iban: string | null }>).map((r) => normalizeIban(r.iban)).filter(Boolean))
    })()
    return pending
  }
}

/** PostgREST rejects very long URLs, so `.in()` lists are chunked. */
const IN_CHUNK = 100

/**
 * How far past the window a verifikat that clears it may be dated: a
 * samlingsverifikat for a month's Swish rows is often dated the month's last day.
 */
const CLEARED_ENTRY_SLACK_DAYS = 31

/**
 * The posted verifikat dated start..end that credit one of `accounts`: one
 * get_entries_with_account_lines call, or the paged read while the database
 * does not have it yet.
 */
async function creditingEntryIds(
  supabase: SupabaseClient,
  companyId: string,
  accounts: readonly string[],
  start: string,
  end: string,
): Promise<string[]> {
  const entries = await fetchEntriesWithAccountLines(supabase, companyId, {
    start,
    end,
    accounts,
    statuses: ['posted'],
    allLines: false,
  })
  if (entries) return entries.filter((e) => e.lines.some((l) => Number(l.credit_amount) > 0)).map((e) => e.id)
  const lines = await fetchEntryLines<{ journal_entry_id: string }>({
    supabase,
    lineColumns: 'journal_entry_id, credit_amount',
    filterEntries: (q: EntryLinesQuery) =>
      q.eq('company_id', companyId).eq('status', 'posted').gte('entry_date', start).lte('entry_date', end),
    filterLines: (q: EntryLinesQuery) => q.in('account_number', [...accounts]).gt('credit_amount', 0),
    attachEntriesAs: null,
  })
  return [...new Set(lines.map((l) => l.journal_entry_id))]
}

/** The bank side's answers to a proposer's questions, for one company and one run. */
export function clearingBankRows(supabase: SupabaseClient, companyId: string): ClearingBankRows {
  const ownIbans = ownIbanReader(supabase, companyId)

  const withoutOwnTransfers = async (rows: RowLike[]): Promise<RowLike[]> => {
    if (!rows.some((r) => normalizeIban(r.counterparty_iban))) return rows
    const own = await ownIbans()
    return rows.filter((r) => !own.has(normalizeIban(r.counterparty_iban)))
  }

  return {
    async open(from, to) {
      const rows = await fetchAllRows<RowLike>(({ from: start, to: end }) =>
        supabase
          .from('transactions')
          .select(
            'id, date, amount, currency, description, original_description, merchant_name, transaction_method, counterparty_iban, journal_entry_id, is_ignored, is_business, invoice_id, supplier_invoice_id, potential_invoice_id, potential_supplier_invoice_id, potential_rot_rut_payout_request_id, potential_journal_entry_id',
          )
          .eq('company_id', companyId)
          .gt('amount', 0)
          .eq('is_ignored', false)
          .eq('is_booked', false)
          .gte('date', from)
          .lte('date', to)
          .order('id', { ascending: true })
          .range(start, end),
      )
      return (await withoutOwnTransfers(rows.filter((r) => clearingCandidate(r)))).map(bankRow)
    },

    async cleared(accounts, from, to) {
      if (accounts.length === 0) return []
      const entryIds = await creditingEntryIds(supabase, companyId, accounts, from, addDaysIso(to, CLEARED_ENTRY_SLACK_DAYS))
      if (entryIds.length === 0) return []

      const byId = new Map<string, RowLike>()
      const linked = new Set<string>()
      for (const ids of chunks(entryIds, IN_CHUNK)) {
        const direct = await fetchAllRows<RowLike>(({ from: start, to: end }) =>
          supabase
            .from('transactions')
            .select(
              'id, date, amount, currency, description, original_description, merchant_name, transaction_method, counterparty_iban, journal_entry_id, is_ignored, is_business, invoice_id, supplier_invoice_id, potential_invoice_id, potential_supplier_invoice_id, potential_rot_rut_payout_request_id, potential_journal_entry_id',
            )
            .eq('company_id', companyId)
            .in('journal_entry_id', ids)
            .order('id', { ascending: true })
            .range(start, end),
        )
        for (const row of direct) byId.set(row.id, row)
        const links = await fetchAllRows<{ id: string; transaction_id: string }>(({ from: start, to: end }) =>
          supabase
            .from('transaction_voucher_links')
            .select('id, transaction_id')
            .eq('company_id', companyId)
            .eq('role', 'bank_line')
            .in('journal_entry_id', ids)
            .order('id', { ascending: true })
            .range(start, end),
        )
        for (const link of links) if (!byId.has(link.transaction_id)) linked.add(link.transaction_id)
      }
      for (const ids of chunks([...linked], IN_CHUNK)) {
        const { data, error } = await supabase
          .from('transactions')
          .select(
            'id, date, amount, currency, description, original_description, merchant_name, transaction_method, counterparty_iban, journal_entry_id, is_ignored, is_business, invoice_id, supplier_invoice_id, potential_invoice_id, potential_supplier_invoice_id, potential_rot_rut_payout_request_id, potential_journal_entry_id',
          )
          .eq('company_id', companyId)
          .in('id', ids)
        if (error) throw new Error(`linked transactions read failed: ${error.message}`)
        for (const row of (data ?? []) as RowLike[]) byId.set(row.id, row)
      }
      return [...byId.values()]
        .filter((r) => Number(r.amount) > 0 && r.date >= from && r.date <= to)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(bankRow)
    },
  }
}

/**
 * Every proposer's answer for the rows that may be offered a clearing, keyed
 * by transaction id; the first proposer in the list wins a row two answer
 * for. A proposer that throws is logged and skipped. A row that turns out to
 * be a transfer between the company's own accounts is dropped.
 */
export async function proposeClearings(
  supabase: SupabaseClient,
  companyId: string,
  transactions: readonly Transaction[],
  proposers: readonly ClearingProposer[],
  log?: Pick<Logger, 'warn'>,
): Promise<Map<string, BookingProposal>> {
  const out = new Map<string, BookingProposal>()
  const candidates = transactions.filter((tx) => clearingCandidate(tx))
  if (candidates.length === 0 || proposers.length === 0) return out

  const bank = clearingBankRows(supabase, companyId)
  const asked = candidates.map(bankRow)
  for (const proposer of proposers) {
    let answer: Map<string, BookingProposal>
    try {
      answer = await proposer.propose(supabase, companyId, asked, bank)
    } catch (err) {
      log?.warn('clearing proposer failed; the other proposals stand', {
        proposer: proposer.id,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    for (const [id, proposal] of answer) if (!out.has(id)) out.set(id, proposal)
  }
  if (out.size === 0) return out

  const named = candidates.filter((tx) => out.has(tx.id) && normalizeIban(tx.counterparty_iban))
  if (named.length > 0) {
    try {
      const own = await ownIbanReader(supabase, companyId)()
      for (const tx of named) if (own.has(normalizeIban(tx.counterparty_iban))) out.delete(tx.id)
    } catch (err) {
      // Unsure whether they are transfers: offer them nothing.
      for (const tx of named) out.delete(tx.id)
      log?.warn('own accounts read failed; clearing proposals withheld from rows naming an IBAN', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return out
}
