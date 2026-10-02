import type { CompanySettings, Currency, InvoicePaymentAccount, InvoiceQrMode } from '@/types'
import {
  companyWithInvoicePaymentAccount,
  hasUsableInvoicePaymentAccount,
  resolveInvoicePaymentAccount,
} from '@/lib/invoices/payment-accounts'
import {
  buildInvoicePaymentRows,
  printsPayableRow,
  type InvoicePaymentRow,
  type InvoicePaymentRowKey,
} from '@/lib/invoices/payment-rows'
import {
  resolveInvoicePaymentQr,
  type InvoiceQrKind,
  type ResolvedInvoicePaymentQr,
} from '@/lib/invoices/payment-qr'

/**
 * The invoice editor's Betalning section: ONE line that says what the
 * customer is asked to pay to and which QR code prints ("SEB · Bankgiro
 * 5432-1098 med OCR · QR-kod för bankapp"), at most one reason line when
 * something the user might expect is missing, and the terms line. Built from
 * the same functions the PDF uses (buildInvoicePaymentRows,
 * resolveInvoicePaymentQr), so the line never promises what the page does
 * not print.
 *
 * Pure: the component renders what these return.
 */

/**
 * The rows the summary names as the way to pay: an account or a number (the
 * reference, BIC and routing rows only qualify one; the payment link has its
 * own part). Whether the invoice is payable at all is printsPayableRow, the
 * preview's own test, which also counts the link.
 */
const METHOD_KEYS = new Set<InvoicePaymentRow['key']>(['bankgiro', 'plusgiro', 'bank_account', 'swish', 'iban'])

export interface EditorPaymentSummaryInput {
  settings: CompanySettings
  currency: Currency
  /** The payee the invoice chose (Betalas till); null = the company default for the currency. */
  payee: InvoicePaymentAccount | null
  invoice: {
    invoice_number: string | null
    document_type: string
    total: number
    deduction_total: number
    ore_rounding: boolean
    qr_mode: InvoiceQrMode | null
    payment_link_url: string | null
    due_date: string | null
    invoice_date: string | null
  }
  /** The country decides whether Swedish bank-app and Swish codes apply (auto mode). */
  customer: { customer_type?: string | null; country?: string | null } | null
  lang: 'sv' | 'en'
  /** A Stripe link is created when the invoice is sent (no link exists yet). */
  autoPaymentLink: boolean
}

export interface EditorPaymentSummary {
  /** The payee's bank ("SEB"); null when the account names none. */
  bankName: string | null
  /** The printed ways to pay, in the PDF's order. */
  methods: InvoicePaymentRow[]
  /** The printed payment reference: the OCR number, or the invoice number as a message. */
  reference: 'ocr' | 'message'
  /** A payment link prints, or is created at send. */
  paymentLink: 'printed' | 'auto' | null
  qr: ResolvedInvoicePaymentQr
  /**
   * The send has no payee: no usable account is stored for the currency, or
   * nothing payable prints (preview-draft's X-Invoice-Missing "payee").
   */
  payeeMissing: boolean
  /** The stored account could be paid to (the details exist but are hidden). */
  storedAccountUsable: boolean
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export function buildEditorPaymentSummary(input: EditorPaymentSummaryInput): EditorPaymentSummary {
  const account = resolveInvoicePaymentAccount(input.settings, input.currency, input.payee)
  const company = companyWithInvoicePaymentAccount(input.settings, input.currency, input.payee)
  const link = clean(input.invoice.payment_link_url)
  const rows = buildInvoicePaymentRows({
    company,
    invoice: { invoice_number: input.invoice.invoice_number, currency: input.currency, payment_link_url: link },
    lang: input.lang,
  })
  const methods = rows.filter((row) => METHOD_KEYS.has(row.key))
  const reference = rows.some((row) => row.key === 'ocr') ? 'ocr' : 'message'
  const qr = resolveInvoicePaymentQr({
    invoice: {
      total: input.invoice.total,
      currency: input.currency,
      document_type: input.invoice.document_type,
      status: 'draft',
      credited_invoice_id: null,
      deduction_total: input.invoice.deduction_total,
      ore_rounding: input.invoice.ore_rounding,
      qr_mode: input.invoice.qr_mode,
      invoice_number: input.invoice.invoice_number,
      invoice_date: input.invoice.invoice_date,
      due_date: input.invoice.due_date,
      payment_link_url: link,
    },
    company,
    customer: input.customer,
    lang: input.lang,
  })
  const storedAccountUsable = hasUsableInvoicePaymentAccount(account, input.currency)
  return {
    bankName: clean(account?.bank_name),
    methods,
    reference,
    paymentLink: link ? 'printed' : input.autoPaymentLink ? 'auto' : null,
    qr,
    payeeMissing: !storedAccountUsable || !printsPayableRow(rows),
    storedAccountUsable,
  }
}

/** One piece of the summary line: literal text, an i18n key (invoice_editor_pay) with values, or the other methods by name. */
export type SummaryPart =
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: string; values?: Record<string, string> }
  | { kind: 'others'; methods: InvoicePaymentRowKey[] }

const METHOD_PART_KEYS: Record<string, string> = {
  bankgiro: 'method_bankgiro',
  plusgiro: 'method_plusgiro',
  bank_account: 'method_bank_account',
  swish: 'method_swish',
  iban: 'method_iban',
}

const QR_PART_KEYS: Record<InvoiceQrKind, string> = {
  bank_app: 'qr_bank_app',
  swish: 'qr_swish',
  payment_link: 'qr_payment_link',
}

/**
 * The number a method part shows: the bank account without its bank name
 * (that leads the line). Everything else as the PDF prints it; the payment
 * rows already group an IBAN in fours and a Swish number as people read it.
 */
function methodValue(row: InvoicePaymentRow, bankName: string | null): string {
  if (row.key === 'bank_account' && bankName && row.value.startsWith(`${bankName}, `)) {
    return row.value.slice(bankName.length + 2)
  }
  return row.value
}

/**
 * The summary line, piece by piece: bank · first way to pay (with "med OCR"
 * when the OCR number belongs to it) and the names of the others ·
 * "Meddelande: fakturanummer" when there is no OCR · the payment link · the
 * QR code. With only a payment link printing (the account hidden), the line
 * is the link and its code. Empty when nothing prints (the section offers to
 * add details).
 */
export function describeEditorPaymentSummary(summary: EditorPaymentSummary): SummaryPart[] {
  if (summary.payeeMissing) return []
  const parts: SummaryPart[] = []
  const [first, ...others] = summary.methods
  if (first) {
    if (summary.bankName) parts.push({ kind: 'text', text: summary.bankName })
    const withOcr = summary.reference === 'ocr' && (first.key === 'bankgiro' || first.key === 'plusgiro')
    parts.push({
      kind: 'key',
      key: withOcr ? `${METHOD_PART_KEYS[first.key]}_ocr` : METHOD_PART_KEYS[first.key],
      values: { number: methodValue(first, summary.bankName) },
    })
    if (others.length > 0) parts.push({ kind: 'others', methods: others.map((row) => row.key) })
    if (summary.reference === 'message') parts.push({ kind: 'key', key: 'reference_message' })
  }
  if (summary.paymentLink === 'printed') parts.push({ kind: 'key', key: 'link_printed' })
  else if (summary.paymentLink === 'auto') parts.push({ kind: 'key', key: 'link_auto' })
  if (summary.qr.kind) parts.push({ kind: 'key', key: QR_PART_KEYS[summary.qr.kind] })
  return parts
}

/** The one reason line under the summary (keys of invoice_editor_pay), with an optional fix. */
export interface PaymentReason {
  key: string
  /** add_giro: the payee's giro is set in Inställningar; open_panel: the Betalning panel fixes it. */
  action: 'add_giro' | 'open_panel' | null
}

/**
 * Why the summary lacks something the user may expect, as one line: the QR
 * resolver's reason in plain Swedish, or that the payment details exist but
 * are hidden. Null when nothing needs saying: a code prints, the user chose
 * none, or nothing is due. A missing payee is not a reason line: the section
 * shows the inline "Lägg till betalningsuppgifter" instead.
 */
export function paymentReason(
  summary: EditorPaymentSummary,
  ctx: { lang: 'sv' | 'en'; showOcr: boolean },
): PaymentReason | null {
  if (summary.payeeMissing) {
    return summary.storedAccountUsable ? { key: 'reason_details_hidden', action: 'open_panel' } : null
  }
  const qr = summary.qr
  if (qr.kind) return null
  // A Stripe link made at send prints its code then (auto and an explicit
  // payment_link both reach it), whatever kept the other codes out.
  if (
    summary.paymentLink === 'auto' &&
    (qr.mode === 'auto' || qr.mode === 'payment_link') &&
    qr.reason !== 'mode_none' &&
    qr.reason !== 'not_payable' &&
    qr.reason !== 'nothing_due'
  ) {
    return { key: 'reason_link_at_send', action: null }
  }
  switch (qr.reason) {
    case 'mode_none':
    case 'not_payable':
    case 'partly_paid':
      return null
    case 'nothing_due':
      return { key: 'reason_nothing_due', action: null }
    case 'currency_not_sek':
      return { key: 'reason_currency', action: null }
    case 'no_printed_giro':
      return {
        key: ctx.lang === 'sv' && ctx.showOcr ? 'reason_no_giro_ocr' : 'reason_no_giro',
        action: 'add_giro',
      }
    case 'no_org_number':
      return { key: 'reason_no_org_number', action: null }
    case 'invalid_giro':
      return { key: 'reason_invalid_giro', action: 'add_giro' }
    case 'no_invoice_number':
      return { key: 'reason_no_number', action: null }
    case 'incomplete_details':
      return { key: 'reason_incomplete', action: null }
    case 'no_swish':
      return { key: 'reason_no_swish', action: 'open_panel' }
    case 'invalid_swish':
      return { key: 'reason_invalid_swish', action: null }
    case 'swish_hidden':
      return { key: 'reason_swish_hidden', action: 'open_panel' }
    case 'no_payment_link':
      return { key: 'reason_no_link', action: 'open_panel' }
    case 'foreign_customer':
      return { key: 'reason_foreign_customer', action: null }
  }
}

/**
 * The terms line's texts: Betalningsvillkor, then Dröjsmålsränta, each its
 * first line. Empty when the company has set neither.
 */
export function paymentTermsTexts(
  settings: Pick<CompanySettings, 'invoice_credit_terms_text' | 'invoice_late_fee_text'> | null | undefined,
): string[] {
  return [settings?.invoice_credit_terms_text, settings?.invoice_late_fee_text]
    .map((text) => clean(text?.split('\n')[0]))
    .filter((text): text is string => text !== null)
}
