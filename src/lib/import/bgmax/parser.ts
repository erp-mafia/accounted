/**
 * BG Max: Bankgirot's deposit specification file (Bankgiro Inbetalningar,
 * "insättningsuppgifter"), crm#1170.
 *
 * A bank statement shows a bankgiro deposit as one row ("Bankgiro
 * inbetalning", "BG 123-4567 00012"): Bankgirot credits the day's incoming
 * payments to the company's bankgiro as one sum. Who paid, with which OCR,
 * lives only in Bankgirot's own specification, which the bank can deliver
 * as a BG Max file. This module reads that file; it never creates bank
 * rows. lib/import/bgmax/attach.ts attaches each deposit's payments to the
 * bank row that is the deposit.
 *
 * Source: Bankgirot, "Bankgiro Inbetalningar Teknisk manual" (oktober 2023),
 * chapter 2, https://www.bankgirot.se/globalassets/dokument/tekniska-manualer/bankgiroinbetalningar_tekniskmanual_sv.pdf
 *
 * The layout is 80 characters per record, the transaction code (TK) in
 * positions 1-2. A file is a start record (TK01, layout name "BGMAX"), one or
 * more sections and an end record (TK70). A section is an opening record
 * (TK05, the receiving bankgiro and currency), its payments and deductions,
 * and a deposit record (TK15, the bank account, payment date, deposit serial
 * number, amount and record count). A payment (TK20) or deduction (TK21)
 * may be followed by extra reference records (TK22, TK23 negative), up to 90
 * information records (TK25), a name (TK26), two address records (TK27,
 * TK28) and an organisation number (TK29). The manual asks readers to ignore
 * record types they do not know; this parser does.
 *
 * Positions below are the manual's (1-based, inclusive). Amounts are whole
 * öre (the last two digits are öre), kept as integers until the very end so
 * a deposit's sum is checked without float drift.
 */
import { roundOre } from '@/lib/money'
import { formatBankgiroNumber, validateBankgiroNumber } from '@/lib/bankgiro/luhn'

export interface BgMaxPayment {
  /** 'payment' (TK20) adds to the deposit, 'deduction' (TK21, e.g. a credit note) subtracts from it. */
  kind: 'payment' | 'deduction'
  /** Kronor, signed: a deduction is negative. */
  amount: number
  /** The payer's bankgiro, formatted ("123-4567"); null when Bankgirot does not give it. */
  payer_bankgiro: string | null
  /** The reference field as the payer gave it (OCR or free text); null when blank. */
  reference: string | null
  /** Bankgirot's reference code (Tabell 5): 2 = a checked OCR, 3 = one or more unchecked references, 0/1 = blank. */
  reference_code: string
  /** Further references Bankgirot found for the same payment (TK22/TK23), in file order. */
  extra_references: string[]
  /** The information records (TK25), joined with a space; null when none. */
  message: string | null
  /** The payer's name (TK26), with its extra name field; null when Bankgirot has none. */
  payer_name: string | null
  /** The payer's organisationsnummer (TK29), 10 digits; null when absent. */
  payer_org_number: string | null
  /** Bankgirot's serial number for the payment (BGC-löpnummer), unique over two years. */
  bgc_serial: string | null
}

export interface BgMaxDeposit {
  /** The receiving bankgiro from the opening record (TK05), formatted ("123-4567"). */
  bankgiro: string
  /** The receiving bank account (TK15 positions 3-37): clearing number then account, digits only. */
  bank_account: string | null
  /** The payment date the deposit was made on (TK15), YYYY-MM-DD. */
  date: string
  /** The deposit serial number (insättningslöpnummer), unique per bankgiro and year; banks may print it on the statement row. */
  serial: string | null
  /** The deposit's amount in kronor: the sum of its payments less its deductions. */
  amount: number
  currency: string
  /** The payments and deductions of the section, in file order. */
  payments: BgMaxPayment[]
}

export interface BgMaxIssue {
  /** 1-based line number in the file; 0 for the file as a whole. */
  line: number
  severity: 'warning' | 'error'
  message: string
}

export interface BgMaxParseResult {
  /** The deposits whose payments add up to the deposit record; only these may be attached. */
  deposits: BgMaxDeposit[]
  /** Deposits the parser could not trust (their payments do not sum to the deposit, or the section is broken). */
  rejected_deposits: number
  /** True when the start record marks a test file ("T"): never attached to real bank rows. */
  test_file: boolean
  date_from: string | null
  date_to: string | null
  issues: BgMaxIssue[]
}

/** The layout name in the start record, positions 3-22. */
const START_RECORD = /^01BGMAX\s/

/** True when the content is a BG Max file: its first record is a BGMAX start record. */
export function detectBgMax(content: string): boolean {
  const first = content.replace(/^﻿/, '').split(/\r?\n/).find((line) => line.trim().length > 0)
  return first !== undefined && START_RECORD.test(first)
}

/** Characters `from`-`to` (the manual's 1-based inclusive positions). A trimmed line simply yields ''. */
function field(line: string, from: number, to: number): string {
  return line.slice(from - 1, to)
}

/** A zero-padded numeric field as whole öre; null when it is not digits. */
function ore(value: string): number | null {
  const digits = value.trim()
  if (!/^\d+$/.test(digits)) return null
  return Number(digits)
}

/** SSÅÅMMDD as YYYY-MM-DD; null when it is not a real date. */
function isoDate(value: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim())
  if (!m) return null
  const [, y, mo, d] = m
  const date = new Date(`${y}-${mo}-${d}T00:00:00Z`)
  if (Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(d)) return null
  return `${y}-${mo}-${d}`
}

/** A zero-padded giro number: digits without the padding, formatted when it is a valid bankgiro. */
function bankgiro(value: string): string | null {
  const digits = value.replace(/\D/g, '').replace(/^0+/, '')
  if (!digits) return null
  return validateBankgiroNumber(digits) ? formatBankgiroNumber(digits) : digits
}

function text(value: string): string | null {
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > 0 ? trimmed : null
}

/** TK29: 12 positions, zero-padded, "anges med 10 siffror". */
function orgNumber(value: string): string | null {
  const digits = value.replace(/\D/g, '')
  if (!digits || /^0+$/.test(digits)) return null
  return digits.length > 10 ? digits.slice(-10) : digits
}

interface PaymentDraft extends Omit<BgMaxPayment, 'amount' | 'message'> {
  ore: number
  messages: string[]
}

interface SectionDraft {
  line: number
  bankgiro: string | null
  currency: string
  payments: PaymentDraft[]
  broken: boolean
}

function finishPayment(p: PaymentDraft): BgMaxPayment {
  const { ore: paymentOre, messages, ...rest } = p
  const signed = p.kind === 'deduction' ? -paymentOre : paymentOre
  return {
    ...rest,
    amount: roundOre(signed / 100),
    message: messages.length > 0 ? messages.join(' ') : null,
  }
}

/**
 * Parse a BG Max file. Never throws on content: every problem becomes an
 * issue, and a deposit whose payments do not add up to its deposit record is
 * left out (counted in rejected_deposits), because its split would not
 * explain the bank row.
 */
export function parseBgMax(content: string): BgMaxParseResult {
  const lines = content.replace(/^﻿/, '').split(/\r?\n/)
  const issues: BgMaxIssue[] = []
  const deposits: BgMaxDeposit[] = []
  let rejected = 0
  let testFile = false
  let sawStart = false
  let sawEnd = false
  let section: SectionDraft | null = null
  let current: PaymentDraft | null = null
  const counted = { payments: 0, deductions: 0, extraReferences: 0, deposits: 0 }

  const reject = (lineNo: number, message: string) => {
    issues.push({ line: lineNo, severity: 'error', message })
    if (section) section.broken = true
  }

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!
    const lineNo = index + 1
    const line = raw.replace(/\s+$/, '')
    if (line.length === 0) continue
    const tk = line.slice(0, 2)

    switch (tk) {
      case '01': {
        sawStart = true
        if (!START_RECORD.test(line)) issues.push({ line: lineNo, severity: 'error', message: 'Startposten saknar layoutnamnet BGMAX.' })
        if (field(line, 45, 45) === 'T') {
          testFile = true
          issues.push({ line: lineNo, severity: 'error', message: 'Filen är märkt som testfil (T) hos Bankgirot.' })
        }
        continue
      }
      case '05': {
        if (section) {
          reject(lineNo, 'Ett nytt avsnitt börjar innan det förra avslutades med en insättningspost.')
          rejected++
        }
        current = null
        const bg = bankgiro(field(line, 3, 12))
        section = {
          line: lineNo,
          bankgiro: bg,
          currency: (text(field(line, 23, 25)) ?? 'SEK').toUpperCase(),
          payments: [],
          broken: false,
        }
        if (!bg) reject(lineNo, 'Öppningsposten saknar mottagarens bankgironummer.')
        continue
      }
      case '20':
      case '21': {
        if (!section) {
          issues.push({ line: lineNo, severity: 'error', message: 'Betalningspost utanför ett avsnitt.' })
          continue
        }
        const amountOre = ore(field(line, 38, 55))
        if (amountOre === null) {
          reject(lineNo, 'Betalningsposten har inget giltigt belopp.')
          continue
        }
        const referenceCode = field(line, 56, 56).trim()
        const serial = field(line, 58, 69).trim()
        current = {
          kind: tk === '20' ? 'payment' : 'deduction',
          ore: amountOre,
          payer_bankgiro: bankgiro(field(line, 3, 12)),
          reference: referenceCode === '0' || referenceCode === '1' ? null : text(field(line, 13, 37)),
          reference_code: referenceCode,
          extra_references: [],
          messages: [],
          payer_name: null,
          payer_org_number: null,
          bgc_serial: serial && !/^0+$/.test(serial) ? serial : null,
        }
        section.payments.push(current)
        if (tk === '20') counted.payments++
        else counted.deductions++
        continue
      }
      case '22':
      case '23': {
        counted.extraReferences++
        const reference = text(field(line, 13, 37))
        if (current && reference && !current.extra_references.includes(reference)) current.extra_references.push(reference)
        continue
      }
      case '25': {
        const info = text(field(line, 3, 52))
        if (current && info) current.messages.push(info)
        continue
      }
      case '26': {
        const name = text(`${field(line, 3, 37)} ${field(line, 38, 72)}`)
        if (current && name) current.payer_name = name
        continue
      }
      case '29': {
        if (current) current.payer_org_number = orgNumber(field(line, 3, 14))
        continue
      }
      case '15': {
        if (!section) {
          issues.push({ line: lineNo, severity: 'error', message: 'Insättningspost utan öppningspost.' })
          continue
        }
        counted.deposits++
        const open: SectionDraft = section
        section = null
        current = null
        const date = isoDate(field(line, 38, 45))
        const amountOre = ore(field(line, 51, 68))
        const declaredCount = ore(field(line, 72, 79))
        const sumOfPayments = open.payments.reduce((sum, p) => sum + (p.kind === 'deduction' ? -p.ore : p.ore), 0)
        let broken = open.broken
        if (!date) {
          issues.push({ line: lineNo, severity: 'error', message: 'Insättningsposten har inget giltigt betalningsdatum.' })
          broken = true
        }
        if (amountOre === null) {
          issues.push({ line: lineNo, severity: 'error', message: 'Insättningsposten har inget giltigt belopp.' })
          broken = true
        } else if (amountOre !== sumOfPayments) {
          issues.push({
            line: lineNo,
            severity: 'error',
            message: 'Insättningens belopp stämmer inte med summan av dess betalningar; insättningen kopplas inte.',
          })
          broken = true
        }
        if (declaredCount !== null && declaredCount !== open.payments.length) {
          issues.push({ line: lineNo, severity: 'warning', message: 'Antalet betalningar i insättningsposten stämmer inte med avsnittet.' })
        }
        if (open.payments.length === 0) {
          issues.push({ line: lineNo, severity: 'error', message: 'Avsnittet saknar betalningar.' })
          broken = true
        }
        if (broken || !open.bankgiro || !date || amountOre === null) {
          rejected++
          continue
        }
        const account = field(line, 3, 37).replace(/\D/g, '').replace(/^0+/, '')
        const serial = field(line, 46, 50).trim()
        deposits.push({
          bankgiro: open.bankgiro,
          bank_account: account || null,
          date,
          serial: serial && /^\d+$/.test(serial) ? serial : null,
          amount: roundOre(amountOre / 100),
          currency: (text(field(line, 69, 71)) ?? open.currency).toUpperCase(),
          payments: open.payments.map(finishPayment),
        })
        continue
      }
      case '70': {
        sawEnd = true
        const declared = {
          payments: ore(field(line, 3, 10)),
          deductions: ore(field(line, 11, 18)),
          extraReferences: ore(field(line, 19, 26)),
          deposits: ore(field(line, 27, 34)),
        }
        const mismatch = (Object.keys(declared) as (keyof typeof declared)[]).some(
          (key) => declared[key] !== null && declared[key] !== counted[key],
        )
        if (mismatch) issues.push({ line: lineNo, severity: 'warning', message: 'Slutpostens antal stämmer inte med filens poster.' })
        continue
      }
      default:
        // TK27/TK28 (address) and any record type a later layout adds: the
        // manual asks readers to ignore what they do not use.
        continue
    }
  }

  if (!sawStart) issues.push({ line: 0, severity: 'error', message: 'Filen saknar startpost (TK01 BGMAX).' })
  if (section) {
    issues.push({ line: section.line, severity: 'error', message: 'Sista avsnittet saknar insättningspost; det kopplas inte.' })
    rejected++
  }
  if (!sawEnd) issues.push({ line: 0, severity: 'warning', message: 'Filen saknar slutpost (TK70); den kan vara avkortad.' })

  const dates = deposits.map((d) => d.date).sort()
  return {
    deposits: testFile ? [] : deposits,
    rejected_deposits: testFile ? rejected + deposits.length : rejected,
    test_file: testFile,
    date_from: dates[0] ?? null,
    date_to: dates[dates.length - 1] ?? null,
    issues,
  }
}
