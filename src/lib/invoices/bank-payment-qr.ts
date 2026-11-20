/**
 * Bank-app payment QR on the invoice PDF ("QR-kod för betalning", crm#249).
 *
 * Format: UsingQR, format specification revision 2, published at
 * https://qrkod.info/ (specification.pdf). Swedish bank apps scan it to fill
 * in a payment: payee, account, reference, due date and amount. The spec is
 * free to implement; it asks that it is not modified and is implemented in
 * full, so this module follows it to the letter:
 *
 *   - a JSON object, keys uqr (format version 1) and tp (1 = payment) first;
 *   - mandatory for tp 1: uqr, tp, nme, cid, iref, ddt, due, pt, acc;
 *   - dates as YYYYMMDD, the amount as a JSON number with a dot decimal and
 *     no insignificant digits (500.10 is 500.1, 500.00 is 500);
 *   - the account, chapter 4.1 (Sweden): "Domestic payments in Sweden are
 *     virtually always made using PG (Plusgiro) or BG (Bankgiro)." So pt BG
 *     with the bankgiro in acc, else pt PG with the plusgiro, and no code at
 *     all when the invoice prints neither. The spec also allows pt BBAN for
 *     a plain bank account, but a bank app scans the code into its giro
 *     payment: Handelsbanken's app reads a Handelsbanken account written
 *     exactly as the spec's example 2 ("6000658159712", bc HANDSESS) as a
 *     giro number it cannot find (crm#1191), and no bank documents that its
 *     app pays a BBAN code. A code that cannot pay is worse than none, so an
 *     invoice with only a bank account prints the account (and IBAN) as text
 *     and no bank-app code;
 *   - cur left out: only SEK invoices get a QR, and the spec lets a domestic
 *     invoice omit it;
 *   - idt (invoice date) included, as in the official example;
 *   - QR model 2, byte mode, a quiet zone of at least 4 modules.
 *
 * Character set: the spec asks for UTF-8 flagged with ECI 000026. The
 * bundled `qrcode` encoder writes byte mode but cannot write an ECI segment,
 * so every character outside printable ASCII is written as a JSON \u escape
 * instead. The bytes are then plain ASCII, which read the same in UTF-8 and
 * in ISO 8859-1 (the QR default), and any JSON parser restores "Företag AB"
 * exactly.
 *
 * The data must say what the printed invoice says, so the caller passes the
 * amount the PDF prints as "Att betala" and the document language (which
 * decides whether the OCR row is printed). No QR for anything a bank app
 * must not pay: credit notes (tp 2 "cannot be used by banking apps"),
 * proformas, quotes, delivery notes, paid, cancelled or credited invoices,
 * foreign-currency invoices, or a missing mandatory field. And never an
 * account a machine would read wrong: a giro goes in only when its check
 * digit is valid.
 */
import { formatOrgNumberDisplay } from '@/lib/invariants/org-number'
import { roundOre } from '@/lib/money'
import {
  formatBankgiroNumber,
  formatPlusgiroNumber,
  validateBankgiroNumber,
  validatePlusgiroNumber,
} from '@/lib/bankgiro/luhn'
import {
  invoicePaymentReference,
  invoicePrintsBankgiro,
  invoicePrintsPlusgiro,
} from '@/lib/invoices/ocr-reference'
import { isInvoicePayableStatus } from '@/lib/invoices/amount-due'

/** UsingQR format version (key uqr). Every example in revision 2 uses 1. */
export const USINGQR_VERSION = 1

/** Quiet zone around the symbol, in modules (spec 1.2: at least 4). */
export const BANK_PAYMENT_QR_QUIET_ZONE = 4

export interface BankPaymentQrCompany {
  company_name?: string | null
  org_number?: string | null
  bankgiro?: string | null
  plusgiro?: string | null
  /** The printed Swedish bank account: only tells why there is no code (bank_account_only). */
  clearing_number?: string | null
  account_number?: string | null
  invoice_show_bankgiro?: boolean | null
  invoice_show_plusgiro?: boolean | null
  invoice_show_ocr?: boolean | null
}

export interface BankPaymentQrInvoice {
  invoice_number?: string | null
  invoice_date?: string | null
  due_date?: string | null
  currency?: string | null
  status?: string | null
  document_type?: string | null
  credited_invoice_id?: string | null
}

export interface BankPaymentQrInput {
  company: BankPaymentQrCompany
  invoice: BankPaymentQrInvoice
  /**
   * What the PDF prints as "Att betala": invoiceAmountDue (lib/invoices/amount-due),
   * the remaining amount on a partly paid invoice, the same figure the Swish QR encodes.
   */
  amountDue: number
  /** Document language: the OCR reference is printed (and encoded) only on a Swedish invoice. */
  lang: 'sv' | 'en'
}

/** YYYY-MM-DD (optionally with a time part) to YYYYMMDD; null when it is not a date. */
function compactDate(value: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? '')
  return match ? `${match[1]}${match[2]}${match[3]}` : null
}

/** Why the code has no account to pay to. The same strings are reason codes in lib/invoices/payment-qr.ts. */
export type BankPaymentQrPayeeProblem =
  /** No bankgiro or plusgiro prints, and no bank account (clearing and account number) either. */
  | 'no_printed_giro'
  /** The printed giro has a wrong check digit. */
  | 'invalid_giro'
  /** No bankgiro or plusgiro prints, only a bank account: bank apps pay the code to a giro (module comment). */
  | 'bank_account_only'

export type BankPaymentQrPayee =
  | { ok: true; pt: 'BG' | 'PG'; acc: string }
  | { ok: false; reason: BankPaymentQrPayeeProblem }

/**
 * The one account the QR pays to (chapter 4.1). The format carries a single
 * payment method: a printed bankgiro first, then a printed plusgiro. A giro
 * the invoice prints with a wrong check digit gives no QR rather than a
 * code that quietly pays elsewhere: the page tells the payer to use it. A
 * printed bank account alone gives no QR either (see the module comment),
 * with its own reason so the editor can say the account still prints.
 */
export function bankPaymentQrPayee(company: BankPaymentQrCompany): BankPaymentQrPayee {
  const printsBankgiro = invoicePrintsBankgiro(company)
  const printsPlusgiro = invoicePrintsPlusgiro(company)
  const bankgiro = company.bankgiro?.trim()
  if (printsBankgiro && bankgiro && validateBankgiroNumber(bankgiro)) {
    return { ok: true, pt: 'BG', acc: formatBankgiroNumber(bankgiro) }
  }
  const plusgiro = company.plusgiro?.trim()
  if (printsPlusgiro && plusgiro && validatePlusgiroNumber(plusgiro)) {
    return { ok: true, pt: 'PG', acc: formatPlusgiroNumber(plusgiro) }
  }
  if (printsBankgiro || printsPlusgiro) return { ok: false, reason: 'invalid_giro' }
  // The account row prints only with both parts (lib/invoices/payment-rows).
  const printsBankAccount = !!company.clearing_number?.trim() && !!company.account_number?.trim()
  return { ok: false, reason: printsBankAccount ? 'bank_account_only' : 'no_printed_giro' }
}

/** JSON with every character outside printable ASCII as a \u escape (see the module comment). */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[^\x20-\x7e]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

/**
 * The UsingQR payload for an invoice, or null when the invoice must not
 * carry one (not a payable SEK invoice, nothing left to pay, or a mandatory
 * field missing). Whether the invoice prints this code at all is decided by
 * lib/invoices/payment-qr.ts (the invoice's QR mode); this only builds it.
 */
export function buildBankPaymentQrPayload({ company, invoice, amountDue, lang }: BankPaymentQrInput): string | null {
  // The same gate as the Swish and payment-link QRs (lib/invoices/amount-due).
  if (!isInvoicePayableStatus(invoice)) return null
  if ((invoice.currency ?? 'SEK') !== 'SEK') return null

  const due = roundOre(amountDue)
  if (!Number.isFinite(due) || due <= 0) return null

  const name = company.company_name?.trim()
  const orgNumber = company.org_number?.trim()
  // The reference the invoice tells the payer to use: the OCR row when it is
  // printed (only beside a printed giro), otherwise the invoice number. Null
  // while the invoice has no number.
  const { reference } = invoicePaymentReference(company, invoice.invoice_number, lang)
  const dueDate = compactDate(invoice.due_date)
  const account = bankPaymentQrPayee(company)
  if (!name || !orgNumber || !reference || !dueDate || !account.ok) return null

  const invoiceDate = compactDate(invoice.invoice_date)

  return asciiJson({
    uqr: USINGQR_VERSION,
    tp: 1,
    nme: name,
    cid: formatOrgNumberDisplay(orgNumber),
    iref: reference,
    ...(invoiceDate ? { idt: invoiceDate } : {}),
    ddt: dueDate,
    due,
    pt: account.pt,
    acc: account.acc,
  })
}

export interface BankPaymentQrSymbol {
  /** Side of the symbol in modules, quiet zone included. */
  size: number
  /** SVG path of the dark modules on a size x size grid (one subpath per horizontal run). */
  path: string
}

/**
 * Encode a payload as a QR symbol the PDF draws as vector paths: model 2,
 * byte mode (spec 2.3), error correction M (the "low to medium" redundancy
 * the format's site recommends), with the 4-module quiet zone. Null when the
 * payload does not fit a QR code.
 *
 * qrcode is imported here, at render time, so the invoice editor (a client
 * bundle) can use this module's payload and payee helpers without it.
 */
export async function bankPaymentQrSymbol(payload: string): Promise<BankPaymentQrSymbol | null> {
  const { default: QRCode } = await import('qrcode')
  let modules: { size: number; data: Uint8Array }
  try {
    modules = QRCode.create([{ mode: 'byte', data: new TextEncoder().encode(payload) }], {
      errorCorrectionLevel: 'M',
    }).modules
  } catch {
    return null
  }
  const { size, data } = modules
  const q = BANK_PAYMENT_QR_QUIET_ZONE
  const parts: string[] = []
  for (let row = 0; row < size; row++) {
    let col = 0
    while (col < size) {
      if (!data[row * size + col]) {
        col++
        continue
      }
      const start = col
      while (col < size && data[row * size + col]) col++
      const run = col - start
      parts.push(`M${start + q} ${row + q}h${run}v1h-${run}z`)
    }
  }
  return { size: size + 2 * q, path: parts.join('') }
}
