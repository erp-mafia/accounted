/**
 * Bankgirot LB-fil (Leverantörsbetalningar): the records every LB file shares
 * and the supplier payment file, for a bank that takes no pain.001 (Svea Bank
 * answers a pain.001 upload with "Content is neither BgLon or LbFile",
 * crm#1424). The salary batch and the tax payment build on the same records
 * in lib/salary/payment/bg-lb-generator.ts.
 *
 * Layout per Bankgirot, "Leverantörsbetalningar Teknisk manual" (okt 2025),
 * section 5.2 Postbeskrivningar. Encoding: ISO 8859-1 (Latin-1). Line
 * endings: CRLF. Every record is exactly 80 characters.
 *
 * Per BFL 7 kap. 1 § a generated file is räkenskapsinformation (underlag)
 * for the payments it initiates; the batch rows it derives from are retained.
 */

import { roundOre } from '@/lib/money'
import { todayIsoStockholm } from '@/lib/dates/iso'

/** A supplier payment in an LB file: to a bankgiro (TK14) or a PlusGironummer (TK54). */
export interface BgLbSupplierPayment {
  payee: { type: 'bankgiro'; bankgiro: string } | { type: 'plusgiro'; plusgiro: string }
  /** The OCR number, or the supplier's invoice number without a valid OCR: what the receiver matches the payment by. */
  reference: string
  /** Amount in SEK, above zero. */
  amount: number
  /** YYYY-MM-DD execution date. */
  paymentDate: string
  /** Shown only in the sender's återredovisning (20 characters). */
  payeeName: string
}

/**
 * Generate an LB file for supplier payments.
 *
 * Layout:
 *   1× öppningspost (TK11), its payment date blank: each payment carries its
 *      own, and a date here would override every one of them (manual 4.3.4)
 *   N× betalningspost: TK14 to a bankgiro, TK54 to a PlusGironummer, with
 *      the OCR or invoice number in the payment record itself (4.3.1)
 *   1× slutsummapost (TK29): the TK14 and TK54 count and their total
 *
 * No clock is read: the write date is the batch's creation day, so a stored
 * batch regenerates byte for byte, like its pain.001.
 */
export function generateSupplierBgLb(
  senderBankgiro: string,
  payments: BgLbSupplierPayment[],
  options: { writeDate: string },
): string {
  const senderBg = stripBgFormat(senderBankgiro)
  if (!/^\d{7,8}$/.test(senderBg)) {
    throw new Error(`Ogiltigt avsändar-bankgiro: ${senderBankgiro}`)
  }
  // An LB section may not be empty (manual 4.1.2).
  if (payments.length === 0) throw new Error('LB-filen behöver minst en betalning')

  const records: string[] = [openingRecord(senderBg, pad('', 6), toYyMmDd(options.writeDate))]
  let totalAmountOre = 0
  for (const payment of payments) {
    const amountOre = Math.round(roundOre(payment.amount) * 100)
    if (amountOre <= 0) throw new Error(`${payment.payeeName}: beloppet måste vara större än noll`)
    totalAmountOre += amountOre
    records.push(supplierPaymentRecord(payment, amountOre))
  }
  records.push(closingRecord(senderBg, payments.length, totalAmountOre))
  assertRecordWidths(records)
  return records.join('\r\n') + '\r\n'
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
 *   Pos 41-46: Payment date YYMMDD, applies to the whole section; blank
 *              when every payment record carries its own
 *   Pos 47-59: Blank (13)
 *   Pos 60-62: Currency "SEK"
 *   Pos 63-80: Blank (18)
 */
export function openingRecord(senderBg: string, paymentDateYyMmDd: string, writeDateYyMmDd: string = toYyMmDd(todayIsoStockholm())): string {
  return (
    '11' +
    padNumber(senderBg, 10) +
    writeDateYyMmDd +
    padText('LEVERANTÖRSBETALNINGAR', 22) +
    paymentDateYyMmDd +
    pad('', 13) +
    'SEK' +
    pad('', 18)
  )
}

/**
 * TK14 betalningspost to a bankgiro, or TK54 betalningspost to a
 * PlusGironummer: the same 80 positions (manual 5.2.3 and 5.2.7).
 *   Pos 1-2:   "14" or "54"
 *   Pos 3-12:  Receiver bankgiro or PlusGironummer (10, right-justified,
 *              zero-filled)
 *   Pos 13-37: OCR or invoice number (25, alphanumeric, left-justified and
 *              blank-filled as in Bankgirot's LBin example files, so an OCR
 *              keeps its exact digits)
 *   Pos 38-49: Amount in öre (12 digits, right-justified, zero-filled)
 *   Pos 50-55: Payment date YYMMDD
 *   Pos 56-60: Blank (5)
 *   Pos 61-80: Information to the sender (20 chars): the payee's name
 */
function supplierPaymentRecord(payment: BgLbSupplierPayment, amountOre: number): string {
  const [code, receiver] = payment.payee.type === 'bankgiro' ? ['14', payment.payee.bankgiro] : ['54', payment.payee.plusgiro]
  return (
    code +
    padNumber(receiver, 10) +
    padText(payment.reference, 25) +
    padNumber(String(amountOre), 12) +
    toYyMmDd(payment.paymentDate) +
    pad('', 5) +
    padText(payment.payeeName, 20)
  )
}

/**
 * TK29 slutsummapost.
 *   Pos 1-2:   "29"
 *   Pos 3-12:  Sender bankgiro (10 digits)
 *   Pos 13-20: Number of payment records (TK14 and TK54) in the section (8 digits)
 *   Pos 21-32: Total amount in öre (12 digits)
 *   Pos 33:    Minus sign for a negative total, otherwise blank
 *   Pos 34-80: Blank (47)
 */
export function closingRecord(senderBg: string, paymentCount: number, totalAmountOre: number): string {
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
// Field writers
// ============================================================

export function assertRecordWidths(records: string[]): void {
  for (let i = 0; i < records.length; i++) {
    if (records[i].length !== 80) {
      throw new Error(
        `Bankgirot LB-fil: post ${i + 1} har fel längd ${records[i].length} (förväntat 80)`
      )
    }
  }
}

/** Strip dashes/spaces from a Bankgiro number. */
export function stripBgFormat(bg: string): string {
  return bg.replace(/[-\s]/g, '')
}

/** Convert YYYY-MM-DD to YYMMDD. */
export function toYyMmDd(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!m) throw new Error(`Ogiltigt datum: ${isoDate}`)
  return m[1].slice(2) + m[2] + m[3]
}

/** Right-justify with zero-padding (for numeric fields). The value itself is
 *  never echoed: it can be a bank account number, and the message reaches
 *  toasts, API responses and logs. */
export function padNumber(value: string, length: number): string {
  const digits = value.replace(/\D/g, '')
  if (digits.length > length) {
    throw new Error(`Numeriskt fält för långt (${digits.length} > ${length})`)
  }
  return digits.padStart(length, '0')
}

/** Left-justify with space-padding, then truncate to length (for text fields).
 *  Bankgirot uses ISO 8859-1; keep å/ä/ö but strip anything outside that range. */
export function padText(value: string, length: number): string {
  const sanitized = value
    .replace(/[\r\n\t]/g, ' ')
    // Strip characters outside ISO 8859-1 printable range to avoid encoding errors.
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
    .slice(0, length)
  return sanitized.padEnd(length, ' ')
}

/** Plain padding to length (for fixed literals and blank fields). */
export function pad(value: string, length: number): string {
  if (value.length > length) return value.slice(0, length)
  return value.padEnd(length, ' ')
}
