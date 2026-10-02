/**
 * ONE payment QR code per invoice, chosen here.
 *
 * The PDF used to stack up to three codes (Swish, the payment link and the
 * bank-app UsingQR code), each behind its own switch, which moved the
 * payment box around and printed different codes on different invoices of
 * one company. Now every render path asks this resolver which single code to
 * print, and the invoice editor asks it why there is none.
 *
 * Mode: invoices.qr_mode ?? company_settings.invoice_qr_mode ?? 'auto'.
 *
 *   auto          a private customer (customer_type individual) gets Swish
 *                 when Swish is usable; otherwise the bank-app QR when it is
 *                 usable, else Swish, else the payment-link QR when the
 *                 invoice has a link, else none
 *   bank_app      the UsingQR code a Swedish bank app scans (SEK, a printed
 *                 bankgiro or plusgiro with a valid check digit, org number)
 *   swish         the Swish code (SEK, a printed, valid Swish number)
 *   payment_link  the invoice's payment link
 *   none          no code
 *
 * An explicit mode that cannot be printed resolves to none WITH the reason:
 * it never silently prints another code than the one the user chose.
 *
 * Every code encodes what the invoice still asks for (lib/invoices/amount-due):
 * nothing on a paid, cancelled or credited invoice or a document that is not
 * a payment request, and the remainder on a partly paid one.
 *
 * The company passed in must already carry the invoice's payee
 * (companyWithInvoicePaymentAccount), the same company the PDF renders with,
 * so the code pays to the account the page prints.
 *
 * Pure and isomorphic (no fs, no crypto): the invoice editor imports it.
 */
import { INVOICE_QR_MODES, type InvoiceQrMode } from '@/types'
import {
  invoiceAmountDue,
  isInvoicePayableStatus,
  type AmountDueInvoice,
} from '@/lib/invoices/amount-due'
import { buildBankPaymentQrPayload, type BankPaymentQrCompany } from '@/lib/invoices/bank-payment-qr'
import { invoicePrintsBankgiro, invoicePrintsPlusgiro } from '@/lib/invoices/ocr-reference'
import { invoicePrintsSwish } from '@/lib/invoices/payment-rows'
import { validateBankgiroNumber, validatePlusgiroNumber } from '@/lib/bankgiro/luhn'
import { buildSwishQrPayload, isValidSwish, normaliseSwish } from '@/lib/payments/swish'

export type InvoiceQrKind = 'bank_app' | 'swish' | 'payment_link'

/**
 * Why an invoice prints no QR code. Stable codes: the editor maps each to
 * one Swedish line.
 */
export const INVOICE_QR_REASONS = [
  /** The mode is none. */
  'mode_none',
  /** Not a payment request: credit note, proforma, quote, delivery note, or paid, cancelled or credited. */
  'not_payable',
  /** Nothing left to pay (a deduction covers it all). */
  'nothing_due',
  /** Bank-app and Swish codes are SEK-only. */
  'currency_not_sek',
  /** No bankgiro or plusgiro prints on the invoice. */
  'no_printed_giro',
  /** The bank-app code needs the seller's org number. */
  'no_org_number',
  /** The printed giro has a wrong check digit: a wrong machine-read account is worse than none. */
  'invalid_giro',
  /** The bank-app code needs the invoice number as its reference (an unnumbered draft has none). */
  'no_invoice_number',
  /** The bank-app code lacks another mandatory field (company name or due date). */
  'incomplete_details',
  /** The company has no Swish number. */
  'no_swish',
  /** The Swish number is not a valid Swish number. */
  'invalid_swish',
  /** The company hides Swish on its invoices ("Visa Swish" off). */
  'swish_hidden',
  /** The invoice has no payment link. */
  'no_payment_link',
  /** A link's amount was fixed when it was created: it cannot ask for a partly paid remainder. */
  'partly_paid',
] as const

export type InvoiceQrReason = (typeof INVOICE_QR_REASONS)[number]

type Lang = 'sv' | 'en'

/** The caption printed under the code. */
export const INVOICE_QR_CAPTIONS: Record<Lang, Record<InvoiceQrKind, string>> = {
  sv: {
    bank_app: 'Skanna med din bankapp',
    swish: 'Skanna för att betala med Swish',
    payment_link: 'Skanna för att betala online',
  },
  en: {
    bank_app: 'Scan with your banking app',
    swish: 'Scan to pay with Swish',
    payment_link: 'Scan to pay online',
  },
}

export type ResolvedInvoicePaymentQr =
  | {
      kind: InvoiceQrKind
      /** The effective mode (auto, or the explicit one). */
      mode: InvoiceQrMode
      caption: string
      /** What the code encodes: the UsingQR JSON, the Swish "C" string or the link URL. */
      payload: string
      /** The amount the code asks for (the payment link's own amount may differ: it was set at creation). */
      amount: number
    }
  | {
      kind: null
      mode: InvoiceQrMode
      reason: InvoiceQrReason
    }

/**
 * The QR code as the PDF template draws it: a PNG data URL (Swish, payment
 * link) or a vector path (bank app), with its caption.
 */
export interface InvoicePdfPaymentQr {
  kind: InvoiceQrKind
  caption: string
  imageDataUrl?: string
  /** SVG path of the dark modules on a size x size grid, quiet zone included. */
  vector?: { path: string; size: number }
}

export type InvoicePaymentQrInvoice = AmountDueInvoice & {
  qr_mode?: InvoiceQrMode | null
  invoice_number?: string | null
  invoice_date?: string | null
  due_date?: string | null
  payment_link_url?: string | null
}

export type InvoicePaymentQrCompany = BankPaymentQrCompany & {
  invoice_qr_mode?: InvoiceQrMode | null
  swish?: string | null
  invoice_show_swish?: boolean | null
  ore_rounding?: boolean | null
}

export interface ResolveInvoicePaymentQrInput {
  invoice: InvoicePaymentQrInvoice
  /** The company with the invoice's payee applied (see the module comment). */
  company: InvoicePaymentQrCompany
  /** Decides auto's Swish-first rule; a missing customer counts as a business. */
  customer?: { customer_type?: string | null } | null
  /** Document language: the bank-app code's reference is the OCR only on a Swedish invoice. */
  lang: Lang
}

function knownMode(value: unknown): InvoiceQrMode | null {
  return typeof value === 'string' && (INVOICE_QR_MODES as readonly string[]).includes(value)
    ? (value as InvoiceQrMode)
    : null
}

/** invoices.qr_mode, else the company's invoice_qr_mode, else auto. */
export function resolveInvoiceQrMode(
  invoice: Pick<InvoicePaymentQrInvoice, 'qr_mode'>,
  company: Pick<InvoicePaymentQrCompany, 'invoice_qr_mode'>,
): InvoiceQrMode {
  return knownMode(invoice.qr_mode) ?? knownMode(company.invoice_qr_mode) ?? 'auto'
}

type Candidate = { ok: true; payload: string } | { ok: false; reason: InvoiceQrReason }

function bankAppCandidate(input: ResolveInvoicePaymentQrInput, amount: number): Candidate {
  const { invoice, company, lang } = input
  if ((invoice.currency ?? 'SEK') !== 'SEK') return { ok: false, reason: 'currency_not_sek' }
  const printsBankgiro = invoicePrintsBankgiro(company)
  const printsPlusgiro = invoicePrintsPlusgiro(company)
  if (!printsBankgiro && !printsPlusgiro) return { ok: false, reason: 'no_printed_giro' }
  const validGiro =
    (printsBankgiro && validateBankgiroNumber(company.bankgiro!.trim())) ||
    (printsPlusgiro && validatePlusgiroNumber(company.plusgiro!.trim()))
  if (!validGiro) return { ok: false, reason: 'invalid_giro' }
  if (!company.org_number?.trim()) return { ok: false, reason: 'no_org_number' }
  if (!invoice.invoice_number?.trim()) return { ok: false, reason: 'no_invoice_number' }
  const payload = buildBankPaymentQrPayload({ company, invoice, amountDue: amount, lang })
  return payload ? { ok: true, payload } : { ok: false, reason: 'incomplete_details' }
}

function swishCandidate(input: ResolveInvoicePaymentQrInput, amount: number): Candidate {
  const { invoice, company } = input
  if ((invoice.currency ?? 'SEK') !== 'SEK') return { ok: false, reason: 'currency_not_sek' }
  const number = normaliseSwish(company.swish)
  if (!number) return { ok: false, reason: 'no_swish' }
  if (!invoicePrintsSwish(company)) return { ok: false, reason: 'swish_hidden' }
  if (!isValidSwish(number)) return { ok: false, reason: 'invalid_swish' }
  const payload = buildSwishQrPayload(number, amount, invoice.invoice_number ?? '')
  return payload ? { ok: true, payload } : { ok: false, reason: 'invalid_swish' }
}

function paymentLinkCandidate(input: ResolveInvoicePaymentQrInput): Candidate {
  const url = input.invoice.payment_link_url?.trim()
  if (!url) return { ok: false, reason: 'no_payment_link' }
  if (input.invoice.status === 'partially_paid') return { ok: false, reason: 'partly_paid' }
  return { ok: true, payload: url }
}

/** Which code the invoice prints, or why none. See the module comment. */
export function resolveInvoicePaymentQr(input: ResolveInvoicePaymentQrInput): ResolvedInvoicePaymentQr {
  const mode = resolveInvoiceQrMode(input.invoice, input.company)
  if (mode === 'none') return { kind: null, mode, reason: 'mode_none' }
  if (!isInvoicePayableStatus(input.invoice)) return { kind: null, mode, reason: 'not_payable' }
  // Rounding on unless the company turned it off: the same default
  // getAmountToPay applies to a company row without the flag.
  const amount = invoiceAmountDue(input.invoice, { ore_rounding: input.company.ore_rounding ?? true })
  if (!(amount > 0)) return { kind: null, mode, reason: 'nothing_due' }

  const evaluate = (kind: InvoiceQrKind): Candidate =>
    kind === 'bank_app'
      ? bankAppCandidate(input, amount)
      : kind === 'swish'
        ? swishCandidate(input, amount)
        : paymentLinkCandidate(input)

  const resolved = (kind: InvoiceQrKind, payload: string): ResolvedInvoicePaymentQr => ({
    kind,
    mode,
    caption: INVOICE_QR_CAPTIONS[input.lang][kind],
    payload,
    amount,
  })

  if (mode !== 'auto') {
    const candidate = evaluate(mode)
    return candidate.ok ? resolved(mode, candidate.payload) : { kind: null, mode, reason: candidate.reason }
  }

  const isPrivate = input.customer?.customer_type === 'individual'
  const order: InvoiceQrKind[] = isPrivate
    ? ['swish', 'bank_app', 'payment_link']
    : ['bank_app', 'swish', 'payment_link']
  // When nothing fits, the reason is the bank-app code's: it is the code auto
  // reaches for on every SEK invoice, and its reason names what to add.
  let fallbackReason: InvoiceQrReason | null = null
  for (const kind of order) {
    const candidate = evaluate(kind)
    if (candidate.ok) return resolved(kind, candidate.payload)
    if (kind === 'bank_app') fallbackReason = candidate.reason
  }
  return { kind: null, mode, reason: fallbackReason ?? 'no_printed_giro' }
}

/** For logs and the preview header: the kind, or none:<reason>. */
export function describeInvoicePaymentQr(qr: ResolvedInvoicePaymentQr): string {
  return qr.kind ?? `none:${qr.reason}`
}
