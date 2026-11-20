/**
 * The invoice behind each part of a Bankgirot split.
 *
 * A bankgiro deposit is one row on the statement; with Open Payments'
 * enrichment it arrives with its split: one part per payer with name,
 * organisationsnummer, OCR reference, invoice numbers and amount (a payout
 * likewise per payee). This module resolves each part against the company's
 * open invoices so the person (or an agent) can settle all of them in one go
 * through the batch allocation (match_batch_allocate). Suggestion only: a
 * part's suggestion books nothing, and the single-invoice one-click confirm
 * stays what it is today. The bank side asks through its open-invoice
 * plug-in point (lib/transactions/open-invoices.ts); what a suggestion looks
 * like and when a split is complete stay with it
 * (lib/transactions/part-suggestions.ts).
 *
 * Which references identify a customer invoice is not decided here:
 * lib/invoices/ocr-keys.ts owns that (the bare invoice number, the OCR the
 * invoice printed, and Bankgirot's length-digit OCR when neither names one),
 * exactly as the single-row OCR pass in lib/invoices/invoice-matching.ts
 * reads it. A supplier invoice is identified
 * by its payment reference (OCR) and the supplier's own invoice number, and a
 * payee account names the supplier through its bankgiro or plusgiro, as the
 * supplier heuristics do.
 *
 * Pure: the ingest loads the pools once per batch and scores every row's
 * parts against them, so a batch never re-reads the invoices per part.
 */
import type { MatchableInvoice } from '@/lib/invoices/invoice-matching'
import { normalizeOcrReference } from '@/lib/invoices/duplicate-payment-guard'
import { normalizeCurrencyCode } from '@/lib/invoices/duplicate-guard-currency'
import { invoicesNamedByReference } from '@/lib/invoices/ocr-keys'
import { amountToOre } from '@/lib/transactions/external-id'
import type { PartSuggestion, PartSuggestionInput } from '@/lib/transactions/part-suggestions'
import type { BankTransactionPartInput, BankTransactionPartSuggestionReason, SupplierInvoice } from '@/types'

const noSuggestion = (seq: number): PartSuggestion => ({
  seq,
  suggested_invoice_id: null,
  suggested_supplier_invoice_id: null,
  suggestion_reason: null,
})

const digits = (value: string | null | undefined): string => normalizeOcrReference(value ?? null)

/** Letters and digits only, upper case: how a supplier's invoice number is compared. */
const alnum = (value: string | null | undefined): string => (value ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase()

/** Lower case, one space between words: how a counterparty name is compared. */
const nameKey = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

const sameOre = (a: number, b: number): boolean => amountToOre(a) === amountToOre(b)

/**
 * The part's amount against the invoice's remaining amount: equal is a
 * settlement; below it is a partial payment, accepted only when the payer
 * named the invoice (`named`), never on an amount alone.
 */
function amountFits(partAmount: number, remaining: number, named: boolean): boolean {
  if (remaining <= 0) return false
  if (sameOre(partAmount, remaining)) return true
  return named && amountToOre(partAmount) < amountToOre(remaining)
}

/** Prefer the candidate the amount settles exactly; else the first the payer named. */
function pickNamed<T>(candidates: T[], partAmount: number, remainingOf: (c: T) => number): T | null {
  const exact = candidates.find((c) => sameOre(partAmount, remainingOf(c)))
  if (exact) return exact
  return candidates.find((c) => amountFits(partAmount, remainingOf(c), true)) ?? null
}

/** Exactly one candidate the amount settles; two of them leave the person to pick. */
function pickOnlyExact<T>(candidates: T[], partAmount: number, remainingOf: (c: T) => number): T | null {
  const exact = candidates.filter((c) => sameOre(partAmount, remainingOf(c)))
  return exact.length === 1 ? exact[0]! : null
}

function suggestCustomerPart(
  part: BankTransactionPartInput,
  pool: readonly MatchableInvoice[],
  taken: Set<string>,
): { invoice: MatchableInvoice; reason: BankTransactionPartSuggestionReason } | null {
  const partAmount = Math.abs(part.amount)
  if (partAmount === 0) return null
  const currency = normalizeCurrencyCode(part.currency)
  const remainingOf = (invoice: MatchableInvoice): number => Number(invoice.remaining_amount ?? invoice.total ?? 0)
  const isOpen = (invoice: MatchableInvoice): boolean =>
    !taken.has(invoice.id) && normalizeCurrencyCode(invoice.currency) === currency && remainingOf(invoice) > 0
  const open = pool.filter(isOpen)
  if (open.length === 0) return null
  // What a reference names is read over the whole pool and only then narrowed
  // to the invoices still open to this part: a reference that names an
  // invoice another part already took must not fall through to a weaker
  // reading of the same digits (invoicesNamedByReference).
  const namedOpen = (references: string | string[]): MatchableInvoice[] =>
    invoicesNamedByReference(pool, references).filter(isOpen)

  // 1. The OCR or invoice number the payer typed as the reference.
  const reference = digits(part.reference)
  if (reference) {
    const named = namedOpen(reference)
    const pick = pickNamed(named, partAmount, remainingOf)
    if (pick) return { invoice: pick, reason: 'ocr_exact' }
  }

  // 2. The invoice numbers the payer listed (referredDocumentInformation, or
  //    the further references Bankgirot found for a BG Max payment).
  const numbers = (part.invoice_numbers ?? []).map(digits).filter((n) => n.length > 0)
  if (numbers.length > 0) {
    const named = namedOpen(numbers)
    const pick = pickNamed(named, partAmount, remainingOf)
    if (pick) return { invoice: pick, reason: 'invoice_number' }
  }

  // 3. The payer's one open invoice for exactly this amount.
  const orgNumber = digits(part.counterparty_org_number)
  const name = nameKey(part.counterparty_name)
  const ofPayer = open.filter((invoice) => {
    const customer = invoice.customer
    if (!customer) return false
    if (orgNumber && digits(customer.org_number) === orgNumber) return true
    return name.length > 0 && nameKey(customer.name) === name
  })
  const pick = pickOnlyExact(ofPayer, partAmount, remainingOf)
  return pick ? { invoice: pick, reason: 'amount_only' } : null
}

function suggestSupplierPart(
  part: BankTransactionPartInput,
  pool: readonly SupplierInvoice[],
  taken: Set<string>,
): { invoice: SupplierInvoice; reason: BankTransactionPartSuggestionReason } | null {
  const partAmount = Math.abs(part.amount)
  if (partAmount === 0) return null
  const currency = normalizeCurrencyCode(part.currency)
  const remainingOf = (invoice: SupplierInvoice): number => Number(invoice.remaining_amount ?? invoice.total ?? 0)
  const open = pool.filter(
    (invoice) => !taken.has(invoice.id) && normalizeCurrencyCode(invoice.currency) === currency && remainingOf(invoice) > 0,
  )
  if (open.length === 0) return null

  // 1. The payment reference (OCR) the invoice asked for.
  const reference = digits(part.reference)
  if (reference) {
    const named = open.filter((invoice) => digits(invoice.payment_reference) === reference)
    const pick = pickNamed(named, partAmount, remainingOf)
    if (pick) return { invoice: pick, reason: 'ocr_exact' }
  }

  // 2. The supplier's own invoice number.
  const numbers = (part.invoice_numbers ?? []).map(alnum).filter((n) => n.length > 0)
  if (numbers.length > 0) {
    const named = open.filter((invoice) => {
      const own = alnum(invoice.supplier_invoice_number)
      return own.length > 0 && numbers.includes(own)
    })
    const pick = pickNamed(named, partAmount, remainingOf)
    if (pick) return { invoice: pick, reason: 'invoice_number' }
  }

  // 3. The payee's one open invoice for exactly this amount: the payee is the
  //    supplier whose bankgiro or plusgiro the part was paid to (or the
  //    invoice's own stated payee), else the organisationsnummer, else the name.
  const account = digits(part.counterparty_account)
  const orgNumber = digits(part.counterparty_org_number)
  const name = nameKey(part.counterparty_name)
  const ofPayee = open.filter((invoice) => {
    const supplier = invoice.supplier
    if (account) {
      const accounts = [supplier?.bankgiro, supplier?.plusgiro, invoice.payee_bankgiro, invoice.payee_plusgiro].map(digits)
      if (accounts.some((a) => a.length > 0 && a === account)) return true
    }
    if (!supplier) return false
    if (orgNumber && digits(supplier.org_number) === orgNumber) return true
    return name.length > 0 && nameKey(supplier.name) === name
  })
  const pick = pickOnlyExact(ofPayee, partAmount, remainingOf)
  return pick ? { invoice: pick, reason: 'amount_only' } : null
}

/**
 * One suggestion per part, in the parts' order. A deposit (parentAmount > 0)
 * resolves against the open customer invoices, a payout (parentAmount < 0)
 * against the open supplier invoices; an invoice is suggested to at most one
 * part of the row, never to a part whose currency differs from its own, and
 * never to a part signed against the row (a deduction).
 */
export function suggestPartInvoices(input: PartSuggestionInput): PartSuggestion[] {
  const taken = new Set<string>(input.excludeInvoiceIds ?? [])
  return input.parts.map((part, index) => {
    const seq = index + 1
    // A part signed against its row is a deduction (BG Max TK21, a credit
    // note the payer subtracted): it pays no invoice, so nothing is offered.
    if (Math.sign(part.amount) !== Math.sign(input.parentAmount)) return noSuggestion(seq)
    if (input.parentAmount > 0) {
      const hit = suggestCustomerPart(part, input.customerInvoices, taken)
      if (!hit) return noSuggestion(seq)
      taken.add(hit.invoice.id)
      return { seq, suggested_invoice_id: hit.invoice.id, suggested_supplier_invoice_id: null, suggestion_reason: hit.reason }
    }
    if (input.parentAmount < 0) {
      const hit = suggestSupplierPart(part, input.supplierInvoices, taken)
      if (!hit) return noSuggestion(seq)
      taken.add(hit.invoice.id)
      return { seq, suggested_invoice_id: null, suggested_supplier_invoice_id: hit.invoice.id, suggestion_reason: hit.reason }
    }
    return noSuggestion(seq)
  })
}
