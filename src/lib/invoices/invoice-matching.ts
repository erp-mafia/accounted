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
 * suggestions. `matchInvoiceCandidates()` therefore returns the dropped
 * invoices alongside the matches (same shape as `unconverted_fx_count` in
 * lib/reports/supplier-ledger.ts), so a caller can name them and point at the
 * repair: POST /api/invoices/{id}/refresh-exchange-rate.
 *
 * Which references identify an invoice is NOT decided here: lib/invoices/ocr-keys.ts
 * owns that, and derives them from the same generator the PDF prints, so the
 * value the customer types into the bank (invoice number digits + Luhn check
 * digit) is always one of the values this matcher looks for.
 *
 * The supplier-side twin is lib/invoices/supplier-invoice-matching.ts. Keep the
 * two guards in step.
 *
 * Reading and scoring are separate: `loadInvoiceMatchPool()` reads the open
 * invoices once for a batch of bank rows, and the scorers below are pure, so
 * a batch never re-reads the same invoices for every row.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { normalizeCurrencyCode, invoiceAmountSek } from './duplicate-guard-currency'
import { normalizeOcrReference } from './duplicate-payment-guard'
import { invoicesNamedByReference, invoicesNamedInTiers, distinctiveReferenceKeys } from './ocr-keys'
import type { Invoice, Transaction, Customer } from '@/types'
import { MATCHABLE_INVOICE_STATUSES } from '@/lib/bookkeeping/matchable-statuses'

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
  /**
   * A reference key found inside the free bank text (description / merchant
   * name) rather than in the reference field. Weaker than an exact reference
   * hit, because free text can coincide, but stronger than an amount that
   * happens to line up: it still names the invoice.
   */
  OCR_REFERENCE_IN_TEXT: 0.85,
  /**
   * Voucher matching: the invoice number sits in the verifikat text but the
   * amount does not settle the invoice. A strong hint for a person, below
   * the unattended auto-link bar (0.95) in bulk-reconcile-supplier-vouchers.
   */
  REFERENCE_AMOUNT_MISMATCH: 0.9,
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
 * A Swedish mobile number standing in free text as a whole token: +46 7x,
 * 0046 7x or 07x, then eight more digits, single spaces or hyphens allowed
 * between digits; or the country code with no plus, 467 and eight digits
 * written together, which is how SEB writes a Swish payer's number as the
 * whole bank text (crm#1399). The token may not touch a digit on either
 * side, so the digits inside a 16-digit Swish id or any longer run never
 * read as a number. Group 1 or group 2 is the subscriber part from the 7.
 */
const SWEDISH_MOBILE_IN_TEXT = /(?<![\d+])(?:(?:(?:\+|00)46[ -]?|0)(7(?:[ -]?\d){8})|46(7\d{8}))(?!\d)/g

/**
 * The Swedish mobile numbers in a bank text, normalised to `+467XXXXXXXX`.
 */
export function swedishMobileNumbersIn(text: string | null | undefined): string[] {
  if (!text) return []
  return Array.from(text.matchAll(SWEDISH_MOBILE_IN_TEXT), (m) => `+46${(m[1] ?? m[2]).replace(/\D/g, '')}`)
}

/**
 * A stored phone number (customers.phone, typed by hand in any format) as
 * `+467XXXXXXXX`, or null when it is not a Swedish mobile number.
 */
export function normalizeSwedishMobile(phone: string | null | undefined): string | null {
  if (!phone) return null
  let digits = phone.replace(/[^\d+]/g, '')
  if (digits.startsWith('+46')) digits = digits.slice(3)
  else if (digits.startsWith('0046')) digits = digits.slice(4)
  else if (/^467\d{8}$/.test(digits)) digits = digits.slice(2)
  if (digits.startsWith('0')) digits = digits.slice(1)
  return /^7\d{8}$/.test(digits) ? `+46${digits}` : null
}

/**
 * True when the customer's mobile number appears in the bank row. Swish
 * payments carry the payer's number in the bank text, often with no name at
 * all, so this is the same "this is the customer" signal as a name match.
 * Each field is searched on its own.
 */
export function customerPhoneMatches(
  customerPhone: string | null | undefined,
  transaction: Pick<Transaction, 'description' | 'merchant_name' | 'reference'>
): boolean {
  const phone = normalizeSwedishMobile(customerPhone)
  if (!phone) return false
  return [transaction.description, transaction.merchant_name, transaction.reference]
    .some((text) => swedishMobileNumbersIn(text).includes(phone))
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
  const nameMatch = customerNameMatches(
    invoice.customer?.name,
    transaction.description,
    transaction.merchant_name
  )
  // A phone hit counts as the customer, like a name hit; the amount is
  // still required below. The name reason wins when both hold.
  const phoneMatch = !nameMatch && customerPhoneMatches(invoice.customer?.phone, transaction)
  const customerMatch = nameMatch || phoneMatch
  const customerReason = phoneMatch ? 'kundens telefonnummer matchar' : 'kundnamn matchar'

  if (exactAmount && customerMatch) {
    return {
      confidence: CONFIDENCE.EXACT_AMOUNT_CUSTOMER,
      matchReason: `Exakt belopp (${invoiceTotal} ${invoice.currency}) och ${customerReason}`,
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
      matchReason: `Belopp nära (±1%) och ${customerReason}`,
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

/** An open customer invoice as the matcher reads it: the row with its customer. */
export type MatchableInvoice = Invoice & { customer?: Customer }

/**
 * The open customer invoices a batch of bank rows is matched against. Read
 * once per batch by `loadInvoiceMatchPool()`, then scored row by row by the
 * pure `matchInvoiceCandidates()`, so a batch of N income rows costs the same
 * two reads as one row instead of 2N.
 *
 * Already narrowed to what may be offered: fakturor only (no quote, proforma
 * or delivery note), no credit note, no invoice a live credit note covers, and
 * no sent/overdue invoice whose payment voucher already exists. Ordered by id.
 */
export interface InvoiceMatchPool {
  readonly invoices: readonly MatchableInvoice[]
}

/**
 * Read the open, payable customer invoices of a company once, for a whole
 * batch of bank rows. A failed invoice read yields an empty pool (no match,
 * never a failed import); a failed payment-voucher read throws, because
 * without it a status-leaked paid invoice would be offered again.
 */
export async function loadInvoiceMatchPool(
  supabase: SupabaseClient,
  companyId: string,
): Promise<InvoiceMatchPool> {
  // Unpaid invoices (sent or overdue) with customer info. Proformas, delivery
  // notes and quotes are never receivables, so a sent quote is never proposed
  // as a payment candidate.
  let invoices: Array<Invoice & { customer?: { name?: string | null } | null }>
  try {
    invoices = await fetchAllRows(({ from, to }) =>
      supabase
        .from('invoices')
        .select('*, customer:customers(*), credit_notes:invoices!credited_invoice_id(id, status, creation_complete)')
        .eq('company_id', companyId)
        .eq('document_type', 'invoice')
        .is('credited_invoice_id', null)
        .in('status', [...MATCHABLE_INVOICE_STATUSES])
        .order('id', { ascending: true })
        .range(from, to),
    )
  } catch {
    return { invoices: [] }
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
      paidIds.add(row.invoice_id)
    }
  }
  return {
    invoices: payableInvoices.filter((inv) => !paidIds.has(inv.id as string)) as MatchableInvoice[],
  }
}

/**
 * Score one bank row against a loaded pool: the matches (sorted by confidence,
 * >= 50 %) plus the invoices dropped before scoring because they carried no
 * comparable amount. Pure: no reads, so a caller scores a whole batch against
 * one `loadInvoiceMatchPool()`.
 *
 * Only income rows (amount > 0) match.
 */
export function matchInvoiceCandidates(
  transaction: Transaction,
  pool: InvoiceMatchPool,
): InvoiceMatchResult {
  if (transaction.amount <= 0 || pool.invoices.length === 0) {
    return emptyResult()
  }
  const filteredInvoices = pool.invoices

  const matches: InvoiceMatch[] = []
  const unconvertedFxInvoices: InvoiceMatchExclusion[] = []

  // OCR/Bankgiro reference matching: highest confidence
  // Swedish standard: match transaction reference to invoice OCR number. The
  // bare invoice number, the OCR the invoice printed (same digits plus a Luhn
  // check digit) and Bankgirot's length-digit OCR all count, because each is
  // something a customer can legitimately have typed into the bank; which
  // invoices a reference names is ocr-keys' one rule.
  const txReference = (transaction as Transaction & { reference?: string | null }).reference
  const normalizedRef = normalizeOcrReference(txReference)
  if (normalizedRef) {
    for (const invoice of invoicesNamedByReference(filteredInvoices, normalizedRef)) {
      matches.push({
        invoice,
        confidence: CONFIDENCE.OCR_REFERENCE_MATCH,
        matchReason: `OCR-referens matchar fakturanummer ${invoice.invoice_number}`,
      })
    }

    // If we found an OCR match, return immediately (highest possible confidence)
    if (matches.length > 0) {
      return { matches, unconvertedFxCount: 0, unconvertedFxInvoices: [] }
    }
  }

  // Fallback: plenty of banks drop the OCR into the free text instead of the
  // reference field ("Faktura 202600425", "BG inbet 2026 0042 5"). Free text
  // is weaker than an exact reference, so it scores lower and, unlike the
  // exact branch above, it does NOT short-circuit: every invoice is still
  // scored on amount below and the stronger of the two reasons wins.
  // The reference must stand in the text as a whole number
  // (descriptionMentionsReference), never as digits inside a longer run:
  // "Inbetalning 2026-10-11" is a date, not invoice 1011. The invoice number
  // as written is a needle too, so a series prefix with digits and a dash
  // ("2026-001") is still found where its bare digits are not. That holds
  // only when the bare digits are distinctive themselves; otherwise "701"
  // would slip under the floor that its 4-digit OCR clears. Each field is
  // searched on its own, so the end of the description and the start of the
  // merchant name never form a reference that exists in neither. The forms
  // are ranked as for the reference field (invoicesNamedInTiers): a text
  // that names an invoice by its number or printed OCR is read exactly as
  // before, and Bankgirot's length-digit OCR is read only when it names none.
  // Normalised once per row as descriptionMentionsReference would (it is
  // idempotent on them): every invoice of the pool is searched for in them.
  const referenceHaystacks = [transaction.description, transaction.merchant_name]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/\s+/g, '').toLowerCase())
  const referenceInTextIds = new Set<string>()
  if (referenceHaystacks.length > 0) {
    const mentioned = invoicesNamedInTiers(filteredInvoices, (invoice, forms) => {
      const keys = distinctiveReferenceKeys(invoice.invoice_number, forms)
      const needles = keys.includes(normalizeOcrReference(invoice.invoice_number))
        ? [...keys, invoice.invoice_number as string]
        : keys
      return needles.some((needle) => referenceHaystacks.some((text) => descriptionMentionsReference(text, needle)))
    })
    for (const invoice of mentioned) referenceInTextIds.add(invoice.id as string)
  }
  const inTextMatch = (invoice: MatchableInvoice): InvoiceMatch => ({
    invoice,
    confidence: CONFIDENCE.OCR_REFERENCE_IN_TEXT,
    matchReason: `OCR-referens för faktura ${invoice.invoice_number} förekommer i banktexten`,
  })

  for (const invoice of filteredInvoices) {
    const referenceInText = referenceInTextIds.has(invoice.id as string)
    // Use remaining_amount for partially paid invoices, otherwise total
    const invoiceAmount = invoice.remaining_amount ?? invoice.total

    // Every pass below compares amounts, so they need one shared unit. No
    // shared unit means this invoice is not a candidate at all: it must never
    // be offered on the strength of a raw foreign number that happens to line
    // up with a kronor bank row.
    const compareAmount = comparableAmount(invoice, transaction, invoiceAmount)
    if (compareAmount === null) {
      // A reference names the invoice on its own, so it survives the missing
      // conversion the same way the exact branch above does: no amount is
      // involved in the claim.
      if (referenceInText) {
        matches.push(inTextMatch(invoice))
        continue
      }
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
      // Amount off, reference present: still the invoice the payer named, e.g.
      // a part payment or a rounded transfer quoting the OCR.
      if (referenceInText) matches.push(inTextMatch(invoice))
      continue
    }

    // Score against the comparable amount; the pool's row is left untouched.
    const { confidence, matchReason } = calculateMatchScore(transaction, {
      ...invoice,
      total: compareAmount,
    })

    // The reference reason and the amount reason are two readings of the same
    // invoice, so the invoice is offered once, under the stronger of the two.
    if (referenceInText && CONFIDENCE.OCR_REFERENCE_IN_TEXT > confidence) {
      matches.push(inTextMatch(invoice))
    } else if (confidence >= CONFIDENCE.MIN_THRESHOLD) {
      matches.push({ invoice, confidence, matchReason })
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
 * The highest-confidence match for one bank row when it meets
 * `minConfidence`, else null. Pure, like `matchInvoiceCandidates()`.
 *
 * `InvoiceMatch | null` has nowhere to carry a reason, so an invoice withheld
 * for a missing exchange rate is invisible on this path. Callers that can show
 * the user something should use `matchInvoiceCandidates()` and read
 * `unconvertedFxInvoices`.
 */
export function bestInvoiceMatch(
  transaction: Transaction,
  pool: InvoiceMatchPool,
  minConfidence: number = 0.80,
): InvoiceMatch | null {
  const { matches } = matchInvoiceCandidates(transaction, pool)
  if (matches.length > 0 && matches[0].confidence >= minConfidence) {
    return matches[0]
  }
  return null
}

/**
 * True when `reference` occurs in `description` as a whole number, never as
 * part of a longer digit run. Whitespace is stripped from both sides first so
 * an OCR string typed in groups ("1234 5678") still matches; after that a hit
 * may not touch a digit on either side. That is what keeps ankomstnummer 14
 * out of "Levbet Tele2 (1814)" and invoice 26 out of "2026-05-11". The plain
 * substring test this replaces linked a Tele2 payment to a Postronic invoice
 * as a 99 % match (desk crm#64, 2026-09-16).
 */
export function descriptionMentionsReference(
  description: string | null | undefined,
  reference: string | number | null | undefined,
): boolean {
  if (!description || reference === null || reference === undefined) return false
  const haystack = description.replace(/\s+/g, '').toLowerCase()
  const needle = String(reference).replace(/\s+/g, '').toLowerCase()
  if (needle.length < 2) return false
  let from = 0
  while (from + needle.length <= haystack.length) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return false
    const before = at > 0 ? haystack[at - 1] : ''
    const after = haystack[at + needle.length] ?? ''
    if (!isDigit(before) && !isDigit(after)) return true
    from = at + 1
  }
  return false
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}
