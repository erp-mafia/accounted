/**
 * Bankgirot LB-fil (Leverantörsbetalningar) generator for salary batch payments.
 *
 * Used by Swedish banks (Swedbank, SEB, Handelsbanken, Nordea) for B2B and
 * salary payments via the corporate portal. Each company has a sender BG
 * registered with Bankgirot; the file is uploaded and Bankgirot routes the
 * funds to the receiver bank accounts.
 *
 * Format reference: Bankgirot: "Leverantörsbetalningar Användarmanual",
 *                   Posttyp specification (TK 11, 14, 54, 29).
 *                   https://www.bankgirot.se/tjanster/leverantorsbetalningar
 *
 * Encoding: ISO 8859-1 (Latin-1).
 * Line endings: CRLF.
 * Record length: exactly 80 characters per line.
 *
 * Per BFL: The generated file is räkenskapsinformation (underlag) linked to
 * the salary journal entry. Subject to 7-year retention.
 */

export interface BgLbCompanyData {
  name: string
  /** Sender bankgiro number, with or without dash. e.g. "123-4567" or "1234567" */
  senderBankgiro: string
}

export interface BgLbEmployee {
  name: string
  /** 4-5 digit clearing number. */
  clearingNumber: string
  /** Up to 10-digit bank account number. */
  bankAccountNumber: string
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
  /** Number of payment records (TK 54). */
  recordCount: number
}

/**
 * Generate a Bankgirot LB-fil for a salary batch.
 *
 * Layout:
 *   1× Öppningspost (TK 11)
 *   N× Betalning till bankkonto (TK 54), one per employee
 *   1× Slutpost (TK 29) with totals
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
  const todayYyMmDd = toYyMmDd(new Date().toISOString().slice(0, 10))

  const positivePayments = employees.filter((e) => e.netSalary > 0)
  const totalAmountOre = positivePayments.reduce(
    (sum, e) => sum + Math.round(e.netSalary * 100),
    0
  )

  const records: string[] = []

  // ─── Posttyp 11: Öppningspost ───
  // Pos 1-2:   "11"
  // Pos 3-12:  Sender bankgiro (10 digits, right-justified, zero-padded)
  // Pos 13-18: Created date YYMMDD
  // Pos 19-40: "LEVERANTÖRSBETALNINGAR" (22 chars)
  // Pos 41-44: "LEVE"
  // Pos 45-50: Payment date YYMMDD
  // Pos 51-52: Currency "SE" (Bankgirot uses "SE" for SEK in file headers)
  // Pos 53-80: Spaces (filler)
  records.push(
    pad('11', 2) +
      padNumber(senderBg, 10) +
      todayYyMmDd +
      padText('LEVERANTÖRSBETALNINGAR', 22) +
      'LEVE' +
      paymentDateYyMmDd +
      'SE' +
      pad('', 28)
  )

  // ─── Posttyp 54: Betalning till bankkonto (one per employee) ───
  // Pos 1-2:   "54"
  // Pos 3-6:   Clearing number (4 digits, right-justified, zero-padded)
  //            5-digit Swedbank clearings: digit 5 goes in pos 7 (we shift
  //            into the account field below per Bankgirot spec).
  // Pos 7-16:  Bank account number (10 digits, right-justified, zero-padded)
  // Pos 17-41: Receiver name (25 chars, left-justified, space-padded)
  // Pos 42-53: Amount in öre (12 digits, right-justified, zero-padded)
  // Pos 54-59: Payment date YYMMDD
  // Pos 60-80: Free reference / period label (21 chars)
  for (const emp of positivePayments) {
    const { clearing4, accountWithSwedbankPrefix } = encodeReceiverAccount(
      emp.clearingNumber,
      emp.bankAccountNumber
    )
    const amountOre = Math.round(emp.netSalary * 100)
    const reference = `Lon ${options.periodLabel}`

    records.push(
      pad('54', 2) +
        padNumber(clearing4, 4) +
        padNumber(accountWithSwedbankPrefix, 10) +
        padText(emp.name, 25) +
        padNumber(String(amountOre), 12) +
        paymentDateYyMmDd +
        padText(reference, 21)
    )
  }

  // ─── Posttyp 29: Slutpost ───
  // Pos 1-2:   "29"
  // Pos 3-12:  Sender bankgiro
  // Pos 13-20: Total record count incl. opening + closing (8 digits)
  // Pos 21-32: Total amount in öre (12 digits)
  // Pos 33-80: Spaces
  const totalRecords = records.length + 1 // include the closing record itself
  records.push(
    pad('29', 2) +
      padNumber(senderBg, 10) +
      padNumber(String(totalRecords), 8) +
      padNumber(String(totalAmountOre), 12) +
      pad('', 48)
  )

  // Validate every record is exactly 80 characters.
  for (let i = 0; i < records.length; i++) {
    if (records[i].length !== 80) {
      throw new Error(
        `Bankgirot LB-fil: post ${i + 1} har fel längd ${records[i].length} (förväntat 80)`
      )
    }
  }

  const content = records.join('\r\n') + '\r\n'

  return {
    content,
    filename: `bg_lb_lon_${options.periodLabel}.txt`,
    totalAmount: totalAmountOre / 100,
    recordCount: positivePayments.length,
  }
}

/**
 * Generate a Bankgirot LB-fil with a single TK 14 payment to a Bankgiro
 * receiver. Used for paying skatt + arbetsgivaravgifter to Skatteverket
 * (BG 5050-1055) with the company's Skattekontot OCR.
 *
 * Layout:
 *   1× Öppningspost (TK 11)
 *   1× Betalning till BG (TK 14): receiver BG, OCR, amount
 *   1× Slutpost (TK 29)
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
    /** Optional receiver name shown in additional info (max 25 chars). */
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
  const todayYyMmDd = toYyMmDd(new Date().toISOString().slice(0, 10))
  const amountOre = Math.round(payment.amount * 100)

  const records: string[] = []

  // ─── Posttyp 11: Öppningspost ───
  records.push(
    pad('11', 2) +
      padNumber(senderBg, 10) +
      todayYyMmDd +
      padText('LEVERANTÖRSBETALNINGAR', 22) +
      'LEVE' +
      paymentDateYyMmDd +
      'SE' +
      pad('', 28)
  )

  // ─── Posttyp 14: Betalning till BG ───
  // Pos 1-2:   "14"
  // Pos 3-12:  Receiver bankgiro (10 digits)
  // Pos 13-37: OCR / reference (25 chars, right-justified zero-padded for OCR)
  // Pos 38-49: Amount in öre (12 digits)
  // Pos 50-55: Payment date YYMMDD
  // Pos 56-80: Receiver name / free info (25 chars)
  records.push(
    pad('14', 2) +
      padNumber(receiverBg, 10) +
      padNumber(ocrDigits, 25) +
      padNumber(String(amountOre), 12) +
      paymentDateYyMmDd +
      padText(payment.receiverName ?? options.periodLabel, 25)
  )

  // ─── Posttyp 29: Slutpost ───
  const totalRecords = records.length + 1
  records.push(
    pad('29', 2) +
      padNumber(senderBg, 10) +
      padNumber(String(totalRecords), 8) +
      padNumber(String(amountOre), 12) +
      pad('', 48)
  )

  for (let i = 0; i < records.length; i++) {
    if (records[i].length !== 80) {
      throw new Error(
        `Bankgirot LB-fil: post ${i + 1} har fel längd ${records[i].length} (förväntat 80)`
      )
    }
  }

  return {
    content: records.join('\r\n') + '\r\n',
    filename: `bg_lb_skatt_${options.periodLabel}.txt`,
    totalAmount: payment.amount,
    recordCount: 1,
  }
}

// ============================================================
// Helpers
// ============================================================

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

/** Right-justify with zero-padding (for numeric fields). */
function padNumber(value: string, length: number): string {
  const digits = value.replace(/\D/g, '')
  if (digits.length > length) {
    throw new Error(`Numeriskt fält för långt (${digits.length} > ${length}): ${value}`)
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

/** Plain padding to length (for fixed literals like "11"). */
function pad(value: string, length: number): string {
  if (value.length > length) return value.slice(0, length)
  return value.padEnd(length, ' ')
}

/**
 * Bankgirot encodes 4-digit clearings directly. Swedbank uses 5-digit clearings
 * (8xxx-x); the 5th digit is moved to the leading position of the account field.
 *
 * For 5-digit clearings starting with "8": digits 1-4 go to the clearing field,
 * the 5th digit becomes the first digit of the 10-position account field.
 *
 * Nordea Personkonto with 11-digit account number: the displayed account
 * already includes the 4-digit clearing as its leading digits (e.g. clearing
 * 1708 + account 17082042825). The 10-digit BG-LB account field cannot fit
 * 11 digits, so we strip the redundant clearing prefix and zero-pad the
 * remaining 7 digits to 10. The receiving bank reconstructs the full
 * personkonto from clearing + account.
 */
function encodeReceiverAccount(
  clearingInput: string,
  accountInput: string
): { clearing4: string; accountWithSwedbankPrefix: string } {
  const clearing = clearingInput.replace(/\D/g, '')
  const account = accountInput.replace(/\D/g, '')

  if (clearing.length === 4) {
    // Nordea Personkonto: account is 11 digits and starts with the clearing.
    // Strip the redundant clearing prefix so it fits the 10-digit account field.
    if (account.length === 11 && account.startsWith(clearing)) {
      return { clearing4: clearing, accountWithSwedbankPrefix: account.slice(4) }
    }
    return { clearing4: clearing, accountWithSwedbankPrefix: account }
  }

  if (clearing.length === 5 && clearing.startsWith('8')) {
    // Swedbank: keep 4 leading digits in clearing field, prepend 5th digit to account.
    return {
      clearing4: clearing.slice(0, 4),
      accountWithSwedbankPrefix: clearing.slice(4) + account,
    }
  }

  throw new Error(
    `Ogiltigt clearingnummer: ${clearingInput} (förväntat 4 siffror, eller 5 siffror som börjar med 8 för Swedbank)`
  )
}
