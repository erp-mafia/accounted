/**
 * Bankgirot LB-fil (Leverantörsbetalningar) generators: the salary batch
 * (löneinsättning to the employees' bank accounts) and the single tax payment
 * to a bankgiro receiver.
 *
 * Layout per Bankgirot, "Leverantörsbetalningar Teknisk manual" (okt 2025),
 * section 5.2 Postbeskrivningar:
 *
 *   TK11  öppningspost: sender bankgiro, write date, product, payment date, SEK.
 *   TK40  kontonummerpost: the payee's clearing + account (12 wide), code L
 *         for lön. Placed immediately before the TK14 it belongs to.
 *   TK14  betalningspost: amount and payment date. For a bank-account payee
 *         the receiver field holds the utbetalningsnummer, not a bankgiro.
 *   TK29  slutsummapost: the number of payment records and their total.
 *
 * The utbetalningsnummer is a fictitious bankgiro number the sender assigns
 * per payee: at most five digits plus a check digit, always the same number
 * for the same payee, never shared by two payees, never all zeros. TK40 and
 * TK14 carry the same number; that is what ties the account to the amount.
 * Here it is the employee's AGI specification number (unique per company,
 * stable for the employee's lifetime) with a Luhn check digit.
 *
 * TK54 is "girering till PlusGironummer" and never carries a bank account.
 * An earlier version of this file wrote salaries as TK54 records with the
 * account squeezed into a 10-wide field, which is why a 5-digit Swedbank
 * clearing with a 10-digit account "did not fit": the TK40 account field is
 * 12 wide and every payable account fits it.
 *
 * Encoding: ISO 8859-1 (Latin-1). Line endings: CRLF. Every record is exactly
 * 80 characters.
 *
 * Per BFL 7 kap. 1 § the generated file is räkenskapsinformation (underlag)
 * linked to the salary journal entry, subject to 7-year retention.
 */

import { luhnCheckDigit } from '@/lib/bankgiro/luhn'
import { payeeAccountParts } from './bank-account'

export interface BgLbCompanyData {
  name: string
  /** Sender bankgiro number, with or without dash. e.g. "123-4567" or "1234567" */
  senderBankgiro: string
}

export interface BgLbEmployee {
  name: string
  /** 4-5 digit clearing number. */
  clearingNumber: string
  /**
   * Bank account number without clearing. What resolves is decided by
   * resolveDomesticBankAccount; every resolved account fits the TK40 field.
   */
  bankAccountNumber: string
  /**
   * The base of the payee's utbetalningsnummer: a positive integer of at most
   * five digits, unique per payee within the company and the same on every
   * run (the employee's AGI specification number). The check digit is added
   * here.
   */
  payeeNumber: number
  /** Net salary in SEK (öre handled internally). */
  netSalary: number
}

export interface BgLbOptions {
  /** YYYY-MM-DD execution date. Bankgirot encodes as YYMMDD. */
  paymentDate: string
  /** Period label shown on payslip-side info, e.g. "2026-04". */
  periodLabel: string
}

export interface BgLbResult {
  /** ISO 8859-1 ready text content with CRLF line endings. */
  content: string
  /** Suggested filename. */
  filename: string
  /** Total amount in SEK. */
  totalAmount: number
  /** Number of payment records (TK14). */
  recordCount: number
}

/** Largest utbetalningsnummer base: five digits before the check digit. */
export const PAYEE_NUMBER_MAX = 99999

/**
 * The utbetalningsnummer for a payee: the base zero-filled to five digits plus
 * its Luhn (10-modulen) check digit, six digits in all, which is the width of
 * the TK40 field. Never all zeros, since the base is at least 1.
 */
export function utbetalningsnummer(payeeNumber: number): string {
  if (!Number.isInteger(payeeNumber) || payeeNumber < 1 || payeeNumber > PAYEE_NUMBER_MAX) {
    throw new Error(`Utbetalningsnumret måste vara ett heltal mellan 1 och ${PAYEE_NUMBER_MAX}`)
  }
  const base = String(payeeNumber).padStart(5, '0')
  return base + String(luhnCheckDigit(base))
}

/**
 * Generate a Bankgirot LB-fil for a salary batch.
 *
 * Layout:
 *   1× öppningspost (TK11)
 *   N× kontonummerpost (TK40) + betalningspost (TK14), one pair per employee
 *   1× slutsummapost (TK29) with the payment count and total
 */
export function generateBgLb(
  company: BgLbCompanyData,
  employees: BgLbEmployee[],
  options: BgLbOptions
): BgLbResult {
  const senderBg = stripBgFormat(company.senderBankgiro)
  if (!/^\d{7,8}$/.test(senderBg)) {
    throw new Error(`Ogiltigt bankgironummer: ${company.senderBankgiro}`)
  }

  const paymentDateYyMmDd = toYyMmDd(options.paymentDate)
  const reference = `Lön ${options.periodLabel}`

  const positivePayments = employees.filter((e) => e.netSalary > 0)

  const records: string[] = [openingRecord(senderBg, paymentDateYyMmDd)]
  const payeeNumbers = new Map<string, string>()
  let totalAmountOre = 0

  for (const emp of positivePayments) {
    // Refuses by name (never with the number) a pair that names no payable
    // account; the same verdict the run applied before generating.
    const { clearing4, accountDigits } = payeeAccountParts(
      emp.name,
      emp.clearingNumber,
      emp.bankAccountNumber
    )
    const payeeNo = payeeUtbetalningsnummer(emp)
    const holder = payeeNumbers.get(payeeNo)
    if (holder !== undefined) {
      throw new Error(
        `${holder}, ${emp.name}: samma utbetalningsnummer i LB-filen. Varje anställd behöver ett eget specifikationsnummer.`
      )
    }
    payeeNumbers.set(payeeNo, emp.name)

    const amountOre = Math.round(emp.netSalary * 100)
    totalAmountOre += amountOre

    records.push(accountRecord(payeeNo, clearing4, accountDigits, reference))
    records.push(paymentRecord(payeeNo, reference, amountOre, paymentDateYyMmDd, emp.name))
  }

  records.push(closingRecord(senderBg, positivePayments.length, totalAmountOre))
  assertRecordWidths(records)

  return {
    content: records.join('\r\n') + '\r\n',
    filename: `bg_lb_lon_${options.periodLabel}.txt`,
    totalAmount: totalAmountOre / 100,
    recordCount: positivePayments.length,
  }
}

/**
 * Generate a Bankgirot LB-fil with a single TK14 payment to a bankgiro
 * receiver. Used for paying skatt + arbetsgivaravgifter to Skatteverket
 * (BG 5050-1055) with the company's Skattekontot OCR.
 *
 * Layout:
 *   1× öppningspost (TK11)
 *   1× betalningspost (TK14): receiver bankgiro, OCR, amount
 *   1× slutsummapost (TK29)
 */
export function generateBankgiroPaymentBgLb(
  company: BgLbCompanyData,
  payment: {
    /** Receiver bankgiro (e.g. "5050-1055" for Skattekontot). */
    receiverBankgiro: string
    /** OCR reference (numeric, ≤ 25 digits, including Luhn check digit). */
    ocr: string
    /** Amount in SEK. */
    amount: number
    /** Optional receiver name shown in the sender's återredovisning (max 20 chars). */
    receiverName?: string
  },
  options: BgLbOptions
): BgLbResult {
  const senderBg = stripBgFormat(company.senderBankgiro)
  const receiverBg = stripBgFormat(payment.receiverBankgiro)
  if (!/^\d{7,8}$/.test(senderBg)) {
    throw new Error(`Ogiltigt avsändar-bankgiro: ${company.senderBankgiro}`)
  }
  if (!/^\d{7,8}$/.test(receiverBg)) {
    throw new Error(`Ogiltigt mottagar-bankgiro: ${payment.receiverBankgiro}`)
  }
  const ocrDigits = payment.ocr.replace(/\D/g, '')
  if (ocrDigits.length === 0 || ocrDigits.length > 25) {
    throw new Error(`Ogiltigt OCR-nummer: ${payment.ocr}`)
  }

  const paymentDateYyMmDd = toYyMmDd(options.paymentDate)
  const amountOre = Math.round(payment.amount * 100)

  const records: string[] = [
    openingRecord(senderBg, paymentDateYyMmDd),
    // TK14 to a bankgiro: pos 3-12 receiver bankgiro, 13-37 OCR (zero-filled),
    // 38-49 amount in öre, 50-55 payment date, 56-60 blank, 61-80 information
    // to the sender.
    '14' +
      padNumber(receiverBg, 10) +
      padNumber(ocrDigits, 25) +
      padNumber(String(amountOre), 12) +
      paymentDateYyMmDd +
      pad('', 5) +
      padText(payment.receiverName ?? options.periodLabel, 20),
    closingRecord(senderBg, 1, amountOre),
  ]
  assertRecordWidths(records)

  return {
    content: records.join('\r\n') + '\r\n',
    filename: `bg_lb_skatt_${options.periodLabel}.txt`,
    totalAmount: payment.amount,
    recordCount: 1,
  }
}

// ============================================================
// Records
// ============================================================

/**
 * TK11 öppningspost.
 *   Pos 1-2:   "11"
 *   Pos 3-12:  Sender bankgiro (10 digits, right-justified, zero-filled)
 *   Pos 13-18: Write date YYMMDD (the day the file was created)
 *   Pos 19-40: "LEVERANTÖRSBETALNINGAR" (22 chars)
 *   Pos 41-46: Payment date YYMMDD, applies to the whole section
 *   Pos 47-59: Blank (13)
 *   Pos 60-62: Currency "SEK"
 *   Pos 63-80: Blank (18)
 */
function openingRecord(senderBg: string, paymentDateYyMmDd: string): string {
  const todayYyMmDd = toYyMmDd(new Date().toISOString().slice(0, 10))
  return (
    '11' +
    padNumber(senderBg, 10) +
    todayYyMmDd +
    padText('LEVERANTÖRSBETALNINGAR', 22) +
    paymentDateYyMmDd +
    pad('', 13) +
    'SEK' +
    pad('', 18)
  )
}

/**
 * TK40 kontonummerpost, immediately before the TK14 it belongs to.
 *   Pos 1-2:   "40"
 *   Pos 3-6:   "0000"
 *   Pos 7-12:  Utbetalningsnummer (6), the same as in the TK14 that follows
 *   Pos 13-16: Clearing number (4 digits)
 *   Pos 17-28: Account number (12 digits, right-justified, zero-filled).
 *              5-digit Swedbank clearings: digit 5 is carried as the leading
 *              digit of the account (resolveDomesticBankAccount), so the
 *              longest payable account is 11 digits and always fits.
 *   Pos 29-40: Identification of the payment (12 chars), printed on the
 *              payee's bank statement
 *   Pos 41:    "L" (lön)
 *   Pos 42-80: Blank (39)
 */
function accountRecord(payeeNo: string, clearing4: string, accountDigits: string, reference: string): string {
  return (
    '40' +
    '0000' +
    payeeNo +
    padNumber(clearing4, 4) +
    padNumber(accountDigits, 12) +
    padText(reference, 12) +
    'L' +
    pad('', 39)
  )
}

/**
 * TK14 betalningspost for a bank-account payee.
 *   Pos 1-2:   "14"
 *   Pos 3-12:  Utbetalningsnummer (10, right-justified, zero-filled)
 *   Pos 13-37: Reference (25 chars)
 *   Pos 38-49: Amount in öre (12 digits, right-justified, zero-filled)
 *   Pos 50-55: Payment date YYMMDD
 *   Pos 56-60: Blank (5)
 *   Pos 61-80: Information to the sender (20 chars), shown only in the
 *              sender's återredovisning: the payee's name
 */
function paymentRecord(
  payeeNo: string,
  reference: string,
  amountOre: number,
  paymentDateYyMmDd: string,
  payeeName: string
): string {
  return (
    '14' +
    padNumber(payeeNo, 10) +
    padText(reference, 25) +
    padNumber(String(amountOre), 12) +
    paymentDateYyMmDd +
    pad('', 5) +
    padText(payeeName, 20)
  )
}

/**
 * TK29 slutsummapost.
 *   Pos 1-2:   "29"
 *   Pos 3-12:  Sender bankgiro (10 digits)
 *   Pos 13-20: Number of payment records (TK14) in the section (8 digits)
 *   Pos 21-32: Total amount in öre (12 digits)
 *   Pos 33:    Minus sign for a negative total, otherwise blank
 *   Pos 34-80: Blank (47)
 */
function closingRecord(senderBg: string, paymentCount: number, totalAmountOre: number): string {
  return (
    '29' +
    padNumber(senderBg, 10) +
    padNumber(String(paymentCount), 8) +
    padNumber(String(totalAmountOre), 12) +
    ' ' +
    pad('', 47)
  )
}

// ============================================================
// Helpers
// ============================================================

/** The payee's utbetalningsnummer, or an error that names the payee only. */
function payeeUtbetalningsnummer(emp: BgLbEmployee): string {
  try {
    return utbetalningsnummer(emp.payeeNumber)
  } catch {
    throw new Error(
      `${emp.name}: saknar ett giltigt specifikationsnummer (1-${PAYEE_NUMBER_MAX}), som utbetalningsnumret i LB-filen bygger på.`
    )
  }
}

function assertRecordWidths(records: string[]): void {
  for (let i = 0; i < records.length; i++) {
    if (records[i].length !== 80) {
      throw new Error(
        `Bankgirot LB-fil: post ${i + 1} har fel längd ${records[i].length} (förväntat 80)`
      )
    }
  }
}

/** Strip dashes/spaces from a Bankgiro number. */
function stripBgFormat(bg: string): string {
  return bg.replace(/[-\s]/g, '')
}

/** Convert YYYY-MM-DD to YYMMDD. */
function toYyMmDd(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!m) throw new Error(`Ogiltigt datum: ${isoDate}`)
  return m[1].slice(2) + m[2] + m[3]
}

/** Right-justify with zero-padding (for numeric fields). The value itself is
 *  never echoed: it can be a bank account number, and the message reaches
 *  toasts, API responses and logs. */
function padNumber(value: string, length: number): string {
  const digits = value.replace(/\D/g, '')
  if (digits.length > length) {
    throw new Error(`Numeriskt fält för långt (${digits.length} > ${length})`)
  }
  return digits.padStart(length, '0')
}

/** Left-justify with space-padding, then truncate to length (for text fields).
 *  Bankgirot uses ISO 8859-1; keep å/ä/ö but strip anything outside that range. */
function padText(value: string, length: number): string {
  const sanitized = value
    .replace(/[\r\n\t]/g, ' ')
    // Strip characters outside ISO 8859-1 printable range to avoid encoding errors.
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
    .slice(0, length)
  return sanitized.padEnd(length, ' ')
}

/** Plain padding to length (for fixed literals and blank fields). */
function pad(value: string, length: number): string {
  if (value.length > length) return value.slice(0, length)
  return value.padEnd(length, ' ')
}
