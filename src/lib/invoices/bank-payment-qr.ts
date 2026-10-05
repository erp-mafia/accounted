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
 *     virtually always made using PG (Plusgiro) or BG (Bankgiro). [...] Only
 *     if the sender didn't provide either a PG or BG number should BBAN be
 *     used." So pt BG with the bankgiro in acc, else pt PG with the
 *     plusgiro, and only when the invoice prints neither, pt BBAN with the
 *     Swedish bank account it prints: acc is the clearing and account digits
 *     as in the spec's examples ("6000658159712"; a 5-digit Swedbank clearing
 *     as "8169-5 9139876057"), bc the bank's BIC ("HANDSESS"; pt BBAN on a
 *     domestic invoice: "bank name in BIC form in bc"), left out when it is
 *     not known (bc is optional, chapter 5). No cc and no adr: the spec asks
 *     for them only with IBAN or a foreign bank code;
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
 * account a machine would read wrong: a giro or a bank account goes in only
 * when its check digit is valid (a bank account only when the bank's rule is
 * known, lib/bankgiro/account-number.ts).
 */
import QRCode from 'qrcode'
import { formatOrgNumber } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import {
  formatBankgiroNumber,
  formatPlusgiroNumber,
  generateOcrReference,
  luhnCheckDigit,
  validateBankgiroNumber,
  validatePlusgiroNumber,
} from '@/lib/bankgiro/luhn'
import { validateSwedishAccountChecksum } from '@/lib/bankgiro/account-number'
import {
  lookupBicByClearing,
  normalizeBankNumber,
  resolveDomesticBankAccount,
} from '@/lib/salary/payment/bank-account'
import {
  invoicePrintsBankgiro,
  invoicePrintsPlusgiro,
  invoiceShowsOcrReference,
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
  /** The printed Swedish bank account (both parts print, or neither: lib/invoices/payment-rows). */
  clearing_number?: string | null
  account_number?: string | null
  bic?: string | null
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
  /** The printed bank account is malformed or its check digit is wrong. */
  | 'invalid_bank_account'
  /** The printed bank account's bank has no check-digit rule we know: it cannot be verified. */
  | 'unverified_bank_account'

export type BankPaymentQrPayee =
  | { ok: true; pt: 'BG' | 'PG' | 'BBAN'; acc: string; bc?: string }
  | { ok: false; reason: BankPaymentQrPayeeProblem }

/** An 8- or 11-character BIC of a Swedish bank (country code SE). */
const SWEDISH_BIC = /^[A-Z]{4}SE[A-Z0-9]{2}([A-Z0-9]{3})?$/

/**
 * The printed Swedish bank account as pt BBAN, or why it cannot be one. Only
 * an account whose check digit the bank's rule confirms: 'invalid' and
 * 'unknown' both stay out, as a machine-read account that is wrong is worse
 * than no QR.
 */
function bankAccountPayee(company: BankPaymentQrCompany): BankPaymentQrPayee {
  // The account row prints only with both parts (lib/invoices/payment-rows).
  if (!company.clearing_number?.trim() || !company.account_number?.trim()) {
    return { ok: false, reason: 'no_printed_giro' }
  }
  // The shape every payout format accepts (lib/salary/payment/bank-account):
  // a 4-digit clearing or a 5-digit 8xxxx one, 5-10 account digits, or an
  // account typed with its clearing in front, which it strips.
  const clearing = normalizeBankNumber(company.clearing_number)
  const resolved = resolveDomesticBankAccount(clearing, company.account_number)
  if (!resolved.ok) return { ok: false, reason: 'invalid_bank_account' }
  // The account without its clearing: on a 5-digit clearing the resolver
  // carries the clearing's own check digit in front of it.
  const account = clearing.length === 5 ? resolved.accountDigits.slice(1) : resolved.accountDigits
  const checksum = validateSwedishAccountChecksum(clearing, account)
  if (checksum === 'invalid') return { ok: false, reason: 'invalid_bank_account' }
  if (checksum === 'unknown') return { ok: false, reason: 'unverified_bank_account' }

  // acc in the forms the spec shows. Swedbank and the savings banks (8xxxx)
  // as "8169-5 9139876057": the fifth clearing digit is the mod 10 check
  // digit of the first four, so a clearing stored without it gets it here
  // and the bank app cannot read the clearing's last digit as the account's
  // first. Every other bank as one run of digits, "6000658159712".
  const clearing4 = resolved.clearing4
  const acc = clearing4.startsWith('8')
    ? `${clearing4}-${clearing.length === 5 ? clearing[4] : luhnCheckDigit(clearing4)} ${account}`
    : `${clearing4}${account}`
  // bc names the bank of the clearing in acc: the clearing table's BIC, or
  // the payee's own stored BIC when the table does not know the clearing
  // (a Swedish one only: a foreign BIC cannot name a Swedish account's bank).
  const storedBic = company.bic?.replace(/\s/g, '').toUpperCase() ?? ''
  const bc = lookupBicByClearing(clearing4) ?? (SWEDISH_BIC.test(storedBic) ? storedBic : null)
  return { ok: true, pt: 'BBAN', acc, ...(bc ? { bc } : {}) }
}

/**
 * The one account the QR pays to (chapter 4.1). The format carries a single
 * payment method: a printed bankgiro first, then a printed plusgiro, and a
 * printed bank account only when the invoice prints no giro at all. A giro
 * the invoice prints with a wrong check digit gives no QR rather than a
 * code that quietly pays elsewhere: the page tells the payer to use it.
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
  return bankAccountPayee(company)
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
  const invoiceNumber = invoice.invoice_number
  const dueDate = compactDate(invoice.due_date)
  const account = bankPaymentQrPayee(company)
  if (!name || !orgNumber || !invoiceNumber?.trim() || !dueDate || !account.ok) return null

  // The reference the invoice tells the payer to use: the OCR row when it is
  // printed (only beside a printed giro), otherwise the invoice number.
  const reference = invoiceShowsOcrReference(company, lang)
    ? generateOcrReference(invoiceNumber)
    : invoiceNumber.trim()
  const invoiceDate = compactDate(invoice.invoice_date)

  return asciiJson({
    uqr: USINGQR_VERSION,
    tp: 1,
    nme: name,
    cid: formatOrgNumber(orgNumber),
    iref: reference,
    ...(invoiceDate ? { idt: invoiceDate } : {}),
    ddt: dueDate,
    due,
    pt: account.pt,
    acc: account.acc,
    ...(account.bc ? { bc: account.bc } : {}),
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
 * the format's site recommends), with the 4-module quiet zone. Synchronous,
 * so the template can draw it from the very amounts it prints. Null when the
 * payload does not fit a QR code.
 */
export function bankPaymentQrSymbol(payload: string): BankPaymentQrSymbol | null {
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
