/**
 * Pure per-currency totalling for the "Bokför valda" underlag dialog.
 *
 * Lives outside BulkBookInboxDialog.tsx (a `'use client'` component) so the
 * rule below can be unit tested: this repo runs Vitest in the `node`
 * environment and never renders components, so logic embedded in JSX is
 * unverifiable by construction.
 *
 * # Why this exists
 *
 * The dialog used to reduce the whole selection to ONE scalar
 * (`bookable.reduce((s, it) => s + (it.extracted_data?.totals?.total ?? 0), 0)`)
 * and render it through `formatCurrency()`, which defaults to SEK. Both halves
 * of that are wrong the moment the underlag are not all SEK:
 *
 *   1. It adds 100 EUR to 100 SEK as if they were one unit, so the figure the
 *      user approves against corresponds to no real belopp (BFL 5 kap 7 §
 *      requires a verifikation to state the belopp of the affärshändelse; a
 *      cross-currency sum is not one).
 *   2. Even for a homogeneous non-SEK selection it stamped "kr" on a total
 *      denominated in something else, so three 1 000 EUR invoices read as
 *      "3 000 kr".
 *
 * # Why this is a display fix and NOT a submit block
 *
 * Unlike `components/transactions/BulkBookDialog.tsx`, this dialog does not
 * build a samlingsverifikation. `POST /items/bulk-book` runs
 * `bulkBookMatchedInboxItems`, which loops the selection and calls
 * `categorizeMatchedTransaction` per item: ONE verifikat per underlag, and the
 * booked belopp is read off that item's matched bank transaction, never off
 * `extracted_data.totals.total` (see the header of
 * `lib/transactions/categorize-core.ts`: "Booking is always in SEK off the bank
 * transaction's own amount"). A EUR invoice settled by the bank in SEK is
 * therefore booked correctly and legally, and a selection mixing SEK and EUR
 * underlag produces a set of individually correct SEK verifikat.
 *
 * So there is no BFL 4 kap 6 § redovisningsvaluta conflict to refuse here, and
 * blocking the submit would break a legitimate everyday flow (a batch of
 * receipts where some suppliers invoice in EUR). The honest fix is to stop
 * presenting the misleading scalar and show what is actually true: a subtotal
 * per currency, plus a note that the booking follows the bank amount.
 */
import type { InvoiceExtractionResult } from '@/types'

/** The subset of an inbox item this module needs. */
export interface UnderlagTotalsItem {
  extracted_data: InvoiceExtractionResult | null
}

export interface UnderlagCurrencyTotal {
  /** ISO 4217 code, uppercased. */
  currency: string
  total: number
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Resolve an underlag's currency to a code that is safe to both group by and
 * hand to `Intl.NumberFormat`.
 *
 * A missing/blank currency normalizes to 'SEK'. This matters for correctness,
 * not just tidiness: `extracted_data.invoice.currency` is produced by document
 * extraction and older rows predate the field, so an un-normalized
 * `new Set(items.map(i => i.extracted_data?.invoice?.currency))` would split a
 * legacy `null`/`undefined` underlag away from its SEK siblings and report a
 * currency mix that does not exist. `pickCurrency()` in
 * InvoiceInboxWorkspace.tsx and `emptyExtraction()` both already read a missing
 * currency as SEK, so this keeps the dialog consistent with the list behind it.
 *
 * Anything that is not a plausible 3-letter code also falls back to 'SEK':
 * `formatCurrency` throws a RangeError on a malformed code, and this value
 * comes from AI extraction of a PDF, so it cannot be trusted to be well formed.
 * Crashing the approval dialog on a junk code would be strictly worse than
 * grouping it with the default.
 */
export function normalizeUnderlagCurrency(currency: string | null | undefined): string {
  const code = currency?.trim().toUpperCase()
  return code && /^[A-Z]{3}$/.test(code) ? code : 'SEK'
}

/**
 * Subtotal the selection per currency, sorted by currency code.
 *
 * Items whose extraction produced no total contribute nothing (they are not
 * counted as a 0 in some currency), so a selection with no extracted amounts
 * yields an empty array and the caller renders nothing: the same "no figure to
 * show" outcome the old `totalSek > 0` gate produced.
 *
 * A result of length > 1 means the selection genuinely spans currencies and
 * the caller must not render a combined scalar.
 */
export function summarizeUnderlagTotals(items: UnderlagTotalsItem[]): UnderlagCurrencyTotal[] {
  const byCurrency = new Map<string, number>()
  for (const item of items) {
    const total = item.extracted_data?.totals?.total
    if (total == null || !Number.isFinite(total)) continue
    const currency = normalizeUnderlagCurrency(item.extracted_data?.invoice?.currency)
    byCurrency.set(currency, round2((byCurrency.get(currency) ?? 0) + total))
  }
  return Array.from(byCurrency.entries())
    .map(([currency, total]) => ({ currency, total }))
    .sort((a, b) => a.currency.localeCompare(b.currency))
}
