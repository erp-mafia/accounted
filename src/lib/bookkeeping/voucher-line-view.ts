/**
 * The one shape a posting line takes on its way to the screen.
 *
 * Every surface that shows the rows a booking posts or posted renders them
 * through VoucherLinesTable (components/bookkeeping/VoucherLinesTable.tsx).
 * Each used to map its own line shape to the table by hand: engine input,
 * posted rows, editor rows, staged payloads and preview answers, each with
 * its own copy of the foreign-amount text, and some surfaces skipped the
 * table and drew their own. voucherLineView is that mapping, once: it reads
 * every line shape the app hands a posting view and answers the table's row.
 */
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { formatAmount } from '@/lib/utils'

/** A posting line as a posting view shows it. Amounts are SEK, the bookkeeping home currency. */
export interface VoucherLineView {
  /** Row key; the table falls back to the index. */
  key?: string | number
  account_number: string
  /** The account's name when the caller knows it; else the table reads the chart's or BAS's. */
  account_name?: string | null
  /** The line's own text. */
  description?: string | null
  debit_amount: number | string | null | undefined
  credit_amount: number | string | null | undefined
  /** The original amount of a foreign-currency line, e.g. "100,00 EUR". */
  foreignAmount?: string | null
  /** Struck by an inline rättelse. */
  struck?: boolean
  /** The line's dimension bag ({sie_dim_no: code}). */
  dimensions?: Readonly<Record<string, string>> | null
  tax_code?: string | null
}

/**
 * Every line shape a posting view is handed: CreateJournalEntryLineInput,
 * posted journal_entry_lines, the editors' string-typed rows, staged MCP
 * payloads (account/debit/credit), preview answers (description) and
 * side-plus-amount rows (ProposalLine, the payment editor's working copy).
 */
export interface PostingLineLike {
  id?: string | null
  account_number?: string | null
  account?: string | null
  account_name?: string | null
  line_description?: string | null
  description?: string | null
  debit_amount?: number | string | null
  credit_amount?: number | string | null
  debit?: number | string | null
  credit?: number | string | null
  side?: 'debet' | 'kredit' | 'debit' | 'credit' | 'D' | 'K'
  amount?: number | string | null
  currency?: string | null
  amount_in_currency?: number | string | null
  dimensions?: Readonly<Record<string, string>> | null
  tax_code?: string | null
  struck?: boolean
}

const DEBIT_SIDES = new Set(['debet', 'debit', 'D'])

/** "100,00 EUR" for a line booked in another currency than the ledger's, else null. */
export function foreignAmountText(
  currency: string | null | undefined,
  amountInCurrency: number | string | null | undefined,
): string | null {
  if (isLedgerCurrency(currency) || amountInCurrency == null || amountInCurrency === '') return null
  const amount = Number(amountInCurrency)
  return Number.isFinite(amount) ? `${formatAmount(amount)} ${currency}` : null
}

/** The posting view's row for `line`, whatever shape it came in. */
export function voucherLineView(line: PostingLineLike): VoucherLineView {
  let debit = line.debit_amount ?? line.debit ?? null
  let credit = line.credit_amount ?? line.credit ?? null
  if (line.side && line.amount != null && debit == null && credit == null) {
    const isDebit = DEBIT_SIDES.has(line.side)
    debit = isDebit ? line.amount : 0
    credit = isDebit ? 0 : line.amount
  }
  return {
    ...(line.id ? { key: line.id } : {}),
    account_number: String(line.account_number ?? line.account ?? '?'),
    account_name: line.account_name ?? null,
    description: line.line_description ?? line.description ?? null,
    debit_amount: debit,
    credit_amount: credit,
    foreignAmount: foreignAmountText(line.currency, line.amount_in_currency),
    ...(line.struck ? { struck: true } : {}),
    ...(line.dimensions ? { dimensions: line.dimensions } : {}),
    ...(line.tax_code ? { tax_code: line.tax_code } : {}),
  }
}

/** voucherLineView for every line. */
export function voucherLineViews(lines: readonly PostingLineLike[]): VoucherLineView[] {
  return lines.map(voucherLineView)
}
