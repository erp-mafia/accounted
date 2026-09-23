/**
 * The single definition of "what amount does this journal_entry_line carry,
 * expressed in currency X".
 *
 * THE ONE THING TO KNOW: `journal_entry_lines.debit_amount` /
 * `credit_amount` are ALWAYS SEK. `lib/bookkeeping/currency-utils.ts`
 * (`resolveSekAmount` + `buildCurrencyMetadata`) converts a foreign amount to
 * SEK for those columns and then stamps `currency` + `amount_in_currency` onto
 * the SAME line as metadata about the underlying DOCUMENT. So `line.currency`
 * is a LABEL, never evidence that the debit/credit figure is in that currency.
 *
 * Any guard shaped like "the currencies match, so these amounts are
 * comparable" therefore passes on exactly the FX rows it exists to catch, and
 * then compares a SEK ledger amount against a foreign figure. Every site that
 * needs a ledger line's amount in some currency must go through this module
 * instead of reading the raw column.
 *
 * Extracted from lib/reconciliation/bank-reconciliation.ts (which re-exports
 * `ledgerLineAmountIn` unchanged for its existing importers) so the invoice /
 * supplier-invoice voucher matchers share one rule with bank reconciliation.
 */

/**
 * The columns any site needs off a journal entry line to answer "how much, in
 * which unit". Numerics arrive as strings over PostgREST on some paths, hence
 * the unions.
 */
export interface LedgerLineAmount {
  debit_amount: number | string | null
  credit_amount: number | string | null
  /** Labels the DOCUMENT the line came from. NOT the unit of debit/credit. */
  currency?: string | null
  /** The line's amount expressed in `currency`: the only non-SEK figure here. */
  amount_in_currency?: number | string | null
}

/**
 * The unit a DOCUMENT's amounts are quoted in, for use as the `currency`
 * argument below.
 *
 * `invoices.currency` is `text default 'SEK'` and therefore NULLABLE in
 * Postgres, even though `Invoice['currency']` is a non-null `Currency` union:
 * the type lies about legacy rows. A missing code has always meant kronor
 * (that is what the column default encodes), so it must resolve to 'SEK'.
 *
 * Without this, a NULL tests `!== 'SEK'` and a plain domestic invoice is
 * classified FOREIGN: it would be sent down the `amount_in_currency` path,
 * where no line can be expressed in `null` and every candidate disappears.
 * Deliberately NOT upper-cased: the comparison downstream is against the
 * ledger's own `currency` label, and the two must be compared exactly as
 * stored rather than through a normalisation only one side goes through.
 */
export function documentCurrency(code: string | null | undefined): string {
  return code || 'SEK'
}

/**
 * A ledger line's contribution to a reconciliation carried out in `currency`,
 * signed like a bank movement (+ money in, - money out), or `null` when the
 * line simply cannot be expressed in that currency.
 *
 *   currency === 'SEK': debit - credit, full stop. The ledger columns already
 *     hold SEK, so the label is irrelevant (a EUR supplier invoice paid from a
 *     SEK account is a SEK movement on that account). This is the 95% path and
 *     it never returns null: SEK-only companies are untouched by any of this.
 *   currency === anything else: only `amount_in_currency` can answer, and only
 *     when the line is actually labelled with that same currency. The MAGNITUDE
 *     comes from that column; the DIRECTION comes from the debit/credit side,
 *     because a handful of production rows carry a negatively-signed
 *     amount_in_currency while the debit/credit side is always authoritative.
 *     No amount_in_currency, or a different label, means the row carries no
 *     rate: null. Never a guess, never the SEK figure as a stand-in.
 */
export function ledgerLineAmountIn(line: LedgerLineAmount, currency: string): number | null {
  const debit = Number(line.debit_amount) || 0
  const credit = Number(line.credit_amount) || 0

  if (currency === 'SEK') return debit - credit

  if (line.currency !== currency) return null
  if (line.amount_in_currency == null) return null
  const foreign = Number(line.amount_in_currency)
  if (!Number.isFinite(foreign)) return null

  const magnitude = Math.abs(foreign)
  if (debit > 0) return magnitude
  if (credit > 0) return -magnitude
  return 0
}

/**
 * The same rule, but returning the POSITIVE magnitude booked on one specific
 * side, which is what the sub-ledger matchers want: an AR credit (151x), an AP
 * debit (244x) or a liquid-funds debit (19xx) is always quoted as a positive
 * "how much of the invoice did this voucher settle".
 *
 * Returns `null` when the line carries no amount in `currency` (see
 * {@link ledgerLineAmountIn}); a value <= 0 means the line moves the OTHER way
 * and is not a settlement on the requested side.
 *
 * SEK reads the requested column directly and gross, exactly as every call
 * site did before this module existed: `currency === 'SEK'` never returns null
 * and never nets the two columns, so SEK-only companies see byte-identical
 * behaviour.
 */
export function ledgerLineSideAmountIn(
  line: LedgerLineAmount,
  currency: string,
  side: 'debit' | 'credit'
): number | null {
  if (currency === 'SEK') {
    return Number(side === 'debit' ? line.debit_amount : line.credit_amount) || 0
  }

  const signed = ledgerLineAmountIn(line, currency)
  if (signed === null) return null
  return side === 'debit' ? signed : -signed
}
