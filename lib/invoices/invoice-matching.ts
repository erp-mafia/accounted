/**
 * Invoice Matching: auto-match income transactions to unpaid customer invoices.
 *
 * Amounts are only ever compared inside one currency: same currency → raw
 * magnitudes, different currencies → the invoice's STORED SEK conversion
 * against a SEK bank row. An invoice with no usable SEK value is not offered
 * at all, because comparing a raw EUR total against a kronor bank row is what
 * makes a 1 000 EUR invoice "exactly match" a 1 000 kr receipt. OCR/reference
 * matching is deliberately exempt: the reference identifies the invoice on its
 * own and no amount is involved.
 *
 * That guard is silent by design, which is its own problem: the user never
 * learns why the EUR invoice that obviously matches is missing from the
 * suggestions. `findInvoiceMatchCandidates()` therefore returns the dropped
 * invoices alongside the matches (same shape as `unconverted_fx_count` in
 * lib/reports/supplier-ledger.ts), so a caller can name them and point at the
 * repair: POST /api/invoices/{id}/refresh-exchange-rate.
 *
 * The supplier-side twin is lib/invoices/supplier-invoice-matching.ts. Keep the
 * two guards in step.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { normalizeCurrencyCode, invoiceAmountSek } from './duplicate-guard-currency'
import type { Invoice, Transaction, Customer } from '@/types'

export interface InvoiceMatch {
  invoice: Invoice & { customer?: Customer }
  confidence: number
  matchReason: string
}

/**
 * An invoice dropped before scoring, with the reason, so callers can tell the
 * user why an obvious invoice is not among the suggestions.
 */
export interface InvoiceMatchExclusion {
  invoiceId: string
  invoiceNumber: string | null
  /** The invoice's own currency, e.g. 'EUR'. */
  currency: string
  /**
   * `unconverted_fx`: foreign-currency invoice with no stored SEK conversion
   * (`total_sek`), compared against a SEK bank row. Remedy:
   * POST /api/invoices/{id}/refresh-exchange-rate, which fetches the
   * taxable-event rate from Riksbanken and fills in `total_sek`. It refuses
   * once the invoice is booked (INVOICE_FX_REFRESH_BOOKED); from there the
   * correction is a storno or an inline rättelse.
   */
  reason: 'unconverted_fx'
}

export interface InvoiceMatchResult {
  matches: InvoiceMatch[]
  /**
   * Number of foreign-currency invoices excluded from candidacy because they
   * had no usable SEK value. Offering them would mean comparing currencies;
   * surfacing the count lets the caller tell the user a candidate was withheld
   * and what to do about it, instead of the invoice just never showing up.
   */
  unconvertedFxCount: number
  /** The excluded invoices themselves, so a caller can name the repair target. */
  unconvertedFxInvoices: InvoiceMatchExclusion[]
}

/**
 * Confidence thresholds for invoice matching. Shared with voucher-matching.ts
 * so the two flows (transaction→invoice and existing-verifikat→invoice) rank
 * candidates on the same scale.
 */
export const CONFIDENCE = {
  OCR_REFERENCE_MATCH: 0.99,
  EXACT_AMOUNT_CUSTOMER: 0.95,
  EXACT_AMOUNT_ONLY: 0.80,
  FUZZY_AMOUNT_CUSTOMER: 0.70,
  FUZZY_AMOUNT_ONLY: 0.50,
  MIN_THRESHOLD: 0.50,
}

/**
 * Fuzzy amount tolerance (±1% for FX fees)
 */
const FUZZY_TOLERANCE = 0.01

/**
 * Check if two amounts match exactly (within rounding)
 */
export function amountsMatchExact(transactionAmount: number, invoiceTotal: number): boolean {
  // Round to 2 decimal places for comparison
  const txRounded = Math.round(transactionAmount * 100) / 100
  const invRounded = Math.round(invoiceTotal * 100) / 100
  return txRounded === invRounded
}

/**
 * Check if two amounts match within fuzzy tolerance (±1%)
 */
export function amountsMatchFuzzy(transactionAmount: number, invoiceTotal: number): boolean {
  if (invoiceTotal === 0) return false
  const diff = Math.abs(transactionAmount - invoiceTotal)
  // Cap fuzzy tolerance at 500 SEK to prevent false positives on large invoices
  const tolerance = Math.min(invoiceTotal * FUZZY_TOLERANCE, 500)
  return diff <= tolerance
}

/**
 * Check if customer name appears in transaction counterparty
 */
export function customerNameMatches(
  customerName: string | undefined,
  transactionDescription: string,
  merchantName: string | null
): boolean {
  if (!customerName) return false

  const searchTerms = customerName.toLowerCase().split(/\s+/).filter(term => term.length > 2)
  const searchText = `${transactionDescription} ${merchantName || ''}`.toLowerCase()

  // Check if any significant word from customer name appears in transaction
  return searchTerms.some(term => searchText.includes(term))
}

/**
 * Calculate confidence score and match reason for an invoice match
 */
export function calculateMatchScore(
  transaction: Transaction,
  invoice: Invoice & { customer?: Customer }
): { confidence: number; matchReason: string } {
  const transactionAmount = transaction.amount
  const invoiceTotal = invoice.total

  const exactAmount = amountsMatchExact(transactionAmount, invoiceTotal)
  const fuzzyAmount = !exactAmount && amountsMatchFuzzy(transactionAmount, invoiceTotal)
  const customerMatch = customerNameMatches(
    invoice.customer?.name,
    transaction.description,
    transaction.merchant_name
  )

  if (exactAmount && customerMatch) {
    return {
      confidence: CONFIDENCE.EXACT_AMOUNT_CUSTOMER,
      matchReason: `Exakt belopp (${invoiceTotal} ${invoice.currency}) och kundnamn matchar`,
    }
  }

  if (exactAmount) {
    return {
      confidence: CONFIDENCE.EXACT_AMOUNT_ONLY,
      matchReason: `Exakt belopp (${invoiceTotal} ${invoice.currency})`,
    }
  }

  if (fuzzyAmount && customerMatch) {
    return {
      confidence: CONFIDENCE.FUZZY_AMOUNT_CUSTOMER,
      matchReason: `Belopp nära (±1%) och kundnamn matchar`,
    }
  }

  if (fuzzyAmount) {
    return {
      confidence: CONFIDENCE.FUZZY_AMOUNT_ONLY,
      matchReason: `Belopp nära (±1%)`,
    }
  }

  return { confidence: 0, matchReason: '' }
}

/**
 * The invoice's outstanding amount expressed in the transaction's currency, or
 * null when no such value can be established from STORED data.
 *
 * Never falls back to the raw foreign amount. That fallback would hand the
 * matcher a EUR total dressed up as kronor, which is the exact false match this
 * function exists to prevent. A missing conversion means "not comparable",
 * never "assume SEK".
 */
function comparableAmount(
  invoice: Invoice,
  transaction: Transaction,
  invoiceAmount: number
): number | null {
  // Currency codes normalize before any comparison: both `invoices.currency`
  // and `transactions.currency` are nullable with DEFAULT 'SEK', so a legacy
  // NULL (or lowercase) code means kronor and must keep matching a SEK bank
  // row instead of being routed down the cross-currency branch and dropped.
  // Same rule as normalizeCurrency in supplier-invoice-matching.ts.
  const invoiceCurrency = normalizeCurrencyCode(invoice.currency)
  const transactionCurrency = normalizeCurrencyCode(transaction.currency)

  // Same currency: raw magnitudes, no rate needed. The only path a SEK-only
  // company ever takes.
  if (invoiceCurrency === transactionCurrency) return invoiceAmount

  // Cross-currency: only a SEK bank row is comparable, and only against the
  // invoice's stored SEK conversion.
  if (transactionCurrency !== 'SEK') return null

  // One definition of "the invoice amount in SEK", shared with the
  // duplicate-payment guards: pro-rated total_sek first (total_sek covers the
  // whole invoice at the registration rate while remaining_amount is in the
  // invoice currency), then the stored exchange_rate when total_sek is 0 or
  // absent. Both are STORED conversions; a missing rate still returns null.
  return invoiceAmountSek({
    amount: invoiceAmount,
    currency: invoiceCurrency,
    total: invoice.total,
    totalSek: invoice.total_sek,
    exchangeRate: invoice.exchange_rate,
  })
}

/**
 * True when the only thing standing between this invoice and candidacy is its
 * own missing SEK conversion, i.e. the case POST
 * /api/invoices/{id}/refresh-exchange-rate repairs. A SEK invoice against a
 * foreign bank row, or two different foreign currencies, is a different
 * (rate-independent) exclusion and is not reported as one of these.
 */
function isUnconvertedForeignInvoice(invoice: Invoice, transaction: Transaction): boolean {
  // Same normalization as comparableAmount: a NULL/lowercase code is kronor,
  // so a legacy NULL-currency invoice is never reported as unconverted FX.
  const invoiceCurrency = normalizeCurrencyCode(invoice.currency)
  return (
    normalizeCurrencyCode(transaction.currency) === 'SEK' &&
    invoiceCurrency !== 'SEK' &&
    invoiceAmountSek({
      amount: invoice.remaining_amount ?? invoice.total,
      currency: invoiceCurrency,
      total: invoice.total,
      totalSek: invoice.total_sek,
      exchangeRate: invoice.exchange_rate,
    }) === null
  )
}

function emptyResult(): InvoiceMatchResult {
  return { matches: [], unconvertedFxCount: 0, unconvertedFxInvoices: [] }
}

/**
 * Find invoices that potentially match a bank transaction
 *
 * Only matches income transactions (amount > 0) against unpaid invoices
 * Returns matches sorted by confidence, filtered to >= 50% confidence
 *
 * Thin wrapper over `findInvoiceMatchCandidates()` that drops the exclusion
 * diagnostics. Use the candidates function when the caller can tell the user
 * why an invoice was withheld.
 */
export async function findMatchingInvoices(
  supabase: SupabaseClient,
  companyId: string,
  transaction: Transaction
): Promise<InvoiceMatch[]> {
  const { matches } = await findInvoiceMatchCandidates(supabase, companyId, transaction)
  return matches
}

/**
 * `findMatchingInvoices()` plus the invoices that were dropped before scoring
 * because they carried no comparable amount.
 */
export async function findInvoiceMatchCandidates(
  supabase: SupabaseClient,
  companyId: string,
  transaction: Transaction
): Promise<InvoiceMatchResult> {
  // Only match income transactions
  if (transaction.amount <= 0) {
    return emptyResult()
  }

  // Query unpaid invoices (sent or overdue) with customer info. Proformas,
  // delivery notes and quotes are never receivables, so a sent quote is never
  // proposed as a payment candidate.
  let invoices: Array<Invoice & { customer?: { name?: string | null } | null }>
  try {
    invoices = await fetchAllRows(({ from, to }) =>
      supabase
        .from('invoices')
        .select('*, customer:customers(*), credit_notes:invoices!credited_invoice_id(id, status, creation_complete)')
        .eq('company_id', companyId)
        .eq('document_type', 'invoice')
        .is('credited_invoice_id', null)
        .in('status', ['sent', 'overdue', 'partially_paid'])
        .order('id', { ascending: true })
        .range(from, to),
    )
  } catch {
    // Failed to fetch invoices: return empty matches
    return emptyResult()
  }

  // Defensive filter: exclude invoices that already have a payment voucher
  // attached but whose status leaked (still 'sent'/'overdue'). Partially-paid
  // invoices can legitimately take more payments, so they pass through.
  // Without this, a status leak would double-book the receipt.
  const payableInvoices = invoices.filter(
    (invoice) => {
      const creditNotes = (invoice as Invoice & {
        credit_notes?: Array<{ status: string; creation_complete?: boolean }>
      }).credit_notes ?? []
      return !invoice.credited_invoice_id && !creditNotes.some(
        (creditNote) => creditNote.status !== 'cancelled' && creditNote.creation_complete !== false,
      )
    },
  )
  const fullCandidateIds = payableInvoices
    .filter((inv) => inv.status === 'sent' || inv.status === 'overdue')
    .map((inv) => inv.id as string)
  const paidIds = new Set<string>()
  if (fullCandidateIds.length > 0) {
    const paymentRows = await fetchAllRows<{ id: string; invoice_id: string }>(({ from, to }) =>
      supabase
        .from('invoice_payments')
        .select('id, invoice_id')
        .eq('company_id', companyId)
        .in('invoice_id', fullCandidateIds)
        .not('journal_entry_id', 'is', null)
        .order('id', { ascending: true })
        .range(from, to),
    )
    for (const row of paymentRows) {
      paidIds.add((row as { invoice_id: string }).invoice_id)
    }
  }
  const filteredInvoices = payableInvoices.filter((inv) => !paidIds.has(inv.id as string))
  if (filteredInvoices.length === 0) {
    return emptyResult()
  }

  const matches: InvoiceMatch[] = []
  const unconvertedFxInvoices: InvoiceMatchExclusion[] = []

  // OCR/Bankgiro reference matching: highest confidence
  // Swedish standard: match transaction reference to invoice OCR number
  const txReference = (transaction as Transaction & { reference?: string | null }).reference
  if (txReference) {
    const normalizedRef = txReference.replace(/\s+/g, '')
    for (const invoice of filteredInvoices) {
      // Match against invoice_number (used as OCR reference in Swedish payments)
      const invoiceRef = invoice.invoice_number?.replace(/\s+/g, '')
      if (invoiceRef && normalizedRef === invoiceRef) {
        matches.push({
          invoice: invoice as Invoice & { customer?: Customer },
          confidence: CONFIDENCE.OCR_REFERENCE_MATCH,
          matchReason: `OCR-referens matchar fakturanummer ${invoice.invoice_number}`,
        })
      }
    }

    // If we found an OCR match, return immediately (highest possible confidence)
    if (matches.length > 0) {
      return { matches, unconvertedFxCount: 0, unconvertedFxInvoices: [] }
    }
  }

  for (const invoice of filteredInvoices) {
    // Use remaining_amount for partially paid invoices, otherwise total
    const invoiceAmount = invoice.remaining_amount ?? invoice.total

    // Every pass below compares amounts, so they need one shared unit. No
    // shared unit means this invoice is not a candidate at all: it must never
    // be offered on the strength of a raw foreign number that happens to line
    // up with a kronor bank row.
    const compareAmount = comparableAmount(invoice, transaction, invoiceAmount)
    if (compareAmount === null) {
      // Record the ones a missing exchange rate is holding back, so the caller
      // can say so instead of leaving the user to wonder.
      if (isUnconvertedForeignInvoice(invoice, transaction)) {
        unconvertedFxInvoices.push({
          invoiceId: invoice.id as string,
          invoiceNumber: invoice.invoice_number ?? null,
          currency: invoice.currency as string,
          reason: 'unconverted_fx',
        })
      }
      continue
    }

    const transactionAmount = transaction.amount

    // Check if amounts are close enough to consider
    const amountDiff = Math.abs(transactionAmount - compareAmount)
    const tolerance = compareAmount * FUZZY_TOLERANCE
    if (amountDiff > tolerance && transactionAmount !== compareAmount) {
      continue
    }

    // Calculate score
    const invoiceWithAdjustedTotal = {
      ...invoice,
      total: compareAmount, // Use the comparable amount
    }

    const { confidence, matchReason } = calculateMatchScore(
      transaction,
      invoiceWithAdjustedTotal as Invoice & { customer?: Customer }
    )

    if (confidence >= CONFIDENCE.MIN_THRESHOLD) {
      matches.push({
        invoice: invoice as Invoice & { customer?: Customer },
        confidence,
        matchReason,
      })
    }
  }

  // Sort by confidence descending. Ties (two open invoices for the same
  // amount on the same day) prefer the invoice that asked to be paid to the
  // account the money landed on. A tie-breaker only: scores are untouched, so
  // nothing that did not auto-match before starts to.
  const landedOn = (transaction as { cash_account_id?: string | null }).cash_account_id ?? null
  const prefers = (m: InvoiceMatch): number =>
    landedOn && m.invoice.payment_cash_account_id === landedOn ? 1 : 0
  matches.sort((a, b) => b.confidence - a.confidence || prefers(b) - prefers(a))

  return {
    matches,
    unconvertedFxCount: unconvertedFxInvoices.length,
    unconvertedFxInvoices,
  }
}

/**
 * Get the best matching invoice for a transaction
 * Returns the highest confidence match if it meets the threshold
 *
 * `InvoiceMatch | null` has nowhere to carry a reason, so an invoice withheld
 * for a missing exchange rate is invisible on this path. Callers that can show
 * the user something should use `findInvoiceMatchCandidates()` and read
 * `unconvertedFxInvoices`; widening this signature is left to whoever has a
 * surface to render it on.
 */
export async function getBestInvoiceMatch(
  supabase: SupabaseClient,
  companyId: string,
  transaction: Transaction,
  minConfidence: number = 0.80
): Promise<InvoiceMatch | null> {
  const matches = await findMatchingInvoices(supabase, companyId, transaction)

  if (matches.length > 0 && matches[0].confidence >= minConfidence) {
    return matches[0]
  }

  return null
}
