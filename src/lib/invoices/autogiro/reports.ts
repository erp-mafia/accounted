/**
 * Reports from Bankgirot for Autogiro, in the new file layout.
 *
 * Source: Bankgirot, "Bg Autogiro Teknisk manual" (november 2021), chapter 8:
 * Betalningsspecifikation (8.2: deposits TK15 with their debits TK82, payout
 * batches TK16 with TK32, refunds TK17 with TK77, end record TK09),
 * Medgivandeavisering (8.3: TK73), Avvisade betalningar (8.4: TK82 and TK32
 * with a comment code), Medgivanden via Internetbanken (8.6: TK51-TK56 and
 * TK59, the same in both layouts) and Utdrag ur Medgivanderegistret (8.8:
 * register records without opening or end record). Every report but the
 * last two opens each section with a TK01 that names its content in
 * positions 45-64.
 *
 * The old layout carries less on file (3.3), and Bankgirot recommends the
 * new one, so an old-layout report is recognised and refused rather than
 * misread. A file Bankgirot sealed keeps its TK00 and TK99 records; they are
 * skipped here and checked with verifyAutogiroSeal.
 *
 * Parsers never throw on content: every problem becomes an issue with its
 * line number. Amounts are summed in whole öre and returned in kronor.
 */
import { describeCode, MANDATE_COMMENT_CODES, MANDATE_INFORMATION_CODES, REJECTION_COMMENT_CODES } from './codes'
import {
  field,
  readAmount,
  readBankAccount,
  readBankgiro,
  readDate,
  readIdentityNumber,
  readNumber,
  readOre,
  readText,
  splitRecords,
  type AutogiroBankAccount,
  type NumberedRecord,
} from './records'

export interface AutogiroIssue {
  /** 1-based line number in the file; 0 for the file as a whole. */
  line: number
  severity: 'warning' | 'error'
  message: string
}

export type AutogiroReportKind =
  | 'payment_specification'
  | 'mandate_notice'
  | 'rejected_payments'
  | 'internet_bank_mandates'
  | 'mandate_register'

export type AutogiroReportDetection =
  | { kind: AutogiroReportKind }
  /** An Autogiro report this module does not read: the old layout, or a report v1 has no use for (its TK01 content is given). */
  | { kind: 'unsupported'; reason: 'old_layout' | 'other_report'; content: string | null }

export interface AutogiroSectionHeader {
  /** 1-based line of the section's opening record. */
  line: number
  /** The payee's Kundnummer at Bankgirot, without zero padding. */
  customer_number: string | null
  /** The payee's bankgiro, formatted ("123-4567"). */
  bankgiro: string | null
  /** The day Bankgirot wrote the file, YYYY-MM-DD. */
  written_on: string | null
}

interface ParsedFile {
  records: NumberedRecord[]
  sealed: boolean
}

/** The records without the seal's TK00 and TK99. */
function unsealed(content: string): ParsedFile {
  const all = splitRecords(content)
  const first = all[0]?.text ?? ''
  const sealed = first.startsWith('00') && field(first, 9, 12) === 'HMAC' && all.length > 1 && all[all.length - 1]!.text.startsWith('99')
  return { records: sealed ? all.slice(1, -1) : all, sealed }
}

/** Positions 3-22 of a new-layout TK01 hold AUTOGIRO left-aligned; the old layout has its write date there. */
function isNewLayoutOpening(line: string): boolean {
  return line.startsWith('01') && field(line, 3, 22).trim() === 'AUTOGIRO'
}

function isOldLayoutOpening(line: string): boolean {
  return line.startsWith('01') && (field(line, 11, 18) === 'AUTOGIRO' || field(line, 25, 33) === 'AG-MEDAVI')
}

/** A register record: digits up to position 58, type in 39 and status in 58 each 1 or 2. */
function isRegisterRecord(line: string): boolean {
  return /^\d{58}/.test(line) && /[12]/.test(field(line, 39, 39)) && /[12]/.test(field(line, 58, 58))
}

/** Which Autogiro report a file is; null when it is none (a BG Max file, a bank statement). */
export function detectAutogiroReport(content: string): AutogiroReportDetection | null {
  const { records } = unsealed(content)
  const first = records[0]?.text
  if (!first) return null
  const tk = first.slice(0, 2)
  if (tk === '51' && field(first, 25, 44).trim() === 'AG-EMEDGIV') return { kind: 'internet_bank_mandates' }
  if (isNewLayoutOpening(first)) {
    const label = field(first, 45, 64).trim()
    if (label.startsWith('BET. SPEC')) return { kind: 'payment_specification' }
    if (label === 'AG-MEDAVI') return { kind: 'mandate_notice' }
    if (label === 'AVVISADE BET UPPDR') return { kind: 'rejected_payments' }
    return { kind: 'unsupported', reason: 'other_report', content: label || null }
  }
  if (isOldLayoutOpening(first)) return { kind: 'unsupported', reason: 'old_layout', content: null }
  if (records.every((r) => isRegisterRecord(r.text))) return { kind: 'mandate_register' }
  return null
}

/** A new-layout TK01. Betalningsspecifikation stamps date and time in 25-44 (ÅÅÅÅMMDDTTmmSSNNNNNN); its first 8 are the date as in the others. */
function header(rec: NumberedRecord): AutogiroSectionHeader {
  return {
    line: rec.line,
    customer_number: readNumber(field(rec.text, 65, 70)),
    bankgiro: readBankgiro(field(rec.text, 71, 80)),
    written_on: readDate(field(rec.text, 25, 32)),
  }
}

function count(value: string): number | null {
  const n = readNumber(value)
  return n === null ? null : Number(n)
}

// ---------------------------------------------------------------------------
// Betalningsspecifikation (8.2)

export interface AutogiroPaymentLine {
  line: number
  /** The payment day, YYYY-MM-DD. */
  date: string | null
  payer_number: string | null
  /** Kronor. */
  amount: number
  /** The payee's own reference, as written in the payment file: the invoice's OCR. */
  reference: string | null
  /** Betalningsstatuskod (codes.ts PAYMENT_STATUS_CODES): '0' done; '1', '2' and '9' stopped in the funds check. */
  status: string
  /** True when the status is 0: the money moved. */
  completed: boolean
}

export interface AutogiroDeposit {
  line: number
  /** The day the deposit was credited, YYYY-MM-DD. */
  date: string | null
  /** Insättningslöpnummer, unique per bankgiro and year; null when no debit in it was completed. */
  serial: string | null
  /** The payee's bank account the deposit went to: clearing number and account, digits only. */
  bank_account: string | null
  /** Kronor: the sum of the completed debits. */
  amount: number
  /** False when the completed debits do not add up to the deposit record: never settle from it. */
  balanced: boolean
  /** Completed and stopped debits, in file order. */
  debits: AutogiroPaymentLine[]
}

export interface AutogiroPayoutBatch {
  line: number
  date: string | null
  serial: string | null
  bank_account: string | null
  amount: number
  balanced: boolean
  payouts: AutogiroPaymentLine[]
}

export interface AutogiroRefund {
  line: number
  /** The day the payer got the money back, YYYY-MM-DD. */
  date: string | null
  /** Kronor, from the withdrawal record (TK17). */
  amount: number
  payer_number: string | null
  original_date: string | null
  original_amount: number
  original_reference: string | null
  /** Återbetalningskod (codes.ts REFUND_REASON_CODES). */
  reason_code: string | null
}

export interface AutogiroPaymentSpecificationSection extends AutogiroSectionHeader {
  deposits: AutogiroDeposit[]
  payout_batches: AutogiroPayoutBatch[]
  refunds: AutogiroRefund[]
}

export interface AutogiroPaymentSpecification {
  kind: 'payment_specification'
  sealed: boolean
  sections: AutogiroPaymentSpecificationSection[]
  issues: AutogiroIssue[]
}

/** A TK82 or TK32 in Betalningsspecifikation; null when its amount is not numeric. */
function paymentLine(rec: NumberedRecord): (AutogiroPaymentLine & { ore: number }) | null {
  const ore = readOre(field(rec.text, 32, 43))
  if (ore === null) return null
  const status = field(rec.text, 80, 80).trim()
  return {
    line: rec.line,
    date: readDate(field(rec.text, 3, 10)),
    payer_number: readNumber(field(rec.text, 16, 31)),
    amount: readAmount(field(rec.text, 32, 43))!,
    reference: readText(field(rec.text, 54, 69)),
    status,
    completed: status === '0',
    ore,
  }
}

interface BatchDraft {
  line: number
  date: string | null
  serial: string | null
  bank_account: string | null
  ore: number
  count: number
  lines: Array<AutogiroPaymentLine & { ore: number }>
}

/** A TK15, TK16 or TK17: positions 3-37 account, 38-45 date, 46-50 serial, 51-68 amount, 72-79 count. */
function batchRecord(rec: NumberedRecord): BatchDraft | null {
  const ore = readOre(field(rec.text, 51, 68))
  const n = count(field(rec.text, 72, 79))
  if (ore === null || n === null) return null
  const account = readNumber(field(rec.text, 3, 37))
  const serial = readNumber(field(rec.text, 46, 50))
  return {
    line: rec.line,
    date: readDate(field(rec.text, 38, 45)),
    serial: serial && serial !== '0' ? field(rec.text, 46, 50) : null,
    bank_account: account && account !== '0' ? account : null,
    ore,
    count: n,
    lines: [],
  }
}

function strip<T extends { ore: number }>(line: T): Omit<T, 'ore'> {
  const { ore: _ore, ...rest } = line
  return rest
}

/** Closes a deposit or payout batch: its completed lines must add up to the batch record in öre and count. */
function closeBatch(batch: BatchDraft, what: string, issues: AutogiroIssue[]): { balanced: boolean } {
  const completed = batch.lines.filter((l) => l.completed)
  const sum = completed.reduce((acc, l) => acc + l.ore, 0)
  const balanced = sum === batch.ore && completed.length === batch.count
  if (!balanced) {
    issues.push({
      line: batch.line,
      severity: 'error',
      message: `${what} stämmer inte med sina genomförda betalningar (${completed.length} st, ${sum} öre mot ${batch.count} st, ${batch.ore} öre).`,
    })
  }
  return { balanced }
}

export function parsePaymentSpecification(content: string): AutogiroPaymentSpecification {
  const { records, sealed } = unsealed(content)
  const issues: AutogiroIssue[] = []
  const sections: AutogiroPaymentSpecificationSection[] = []
  let section: AutogiroPaymentSpecificationSection | null = null
  let batch: { kind: 'deposit' | 'payout'; draft: BatchDraft } | null = null
  let refund: { line: number; date: string | null; ore: number } | null = null
  const tally = { deposits: 0, debits: 0, payoutBatches: 0, payouts: 0, refundWithdrawals: 0, refunds: 0 }

  const flushBatch = () => {
    if (!batch || !section) return
    const { draft } = batch
    if (batch.kind === 'deposit') {
      const { balanced } = closeBatch(draft, 'Insättningen', issues)
      section.deposits.push({
        line: draft.line,
        date: draft.date,
        serial: draft.serial,
        bank_account: draft.bank_account,
        amount: readAmount(String(draft.ore))!,
        balanced,
        debits: draft.lines.map(strip),
      })
    } else {
      const { balanced } = closeBatch(draft, 'Uttaget', issues)
      section.payout_batches.push({
        line: draft.line,
        date: draft.date,
        serial: draft.serial,
        bank_account: draft.bank_account,
        amount: readAmount(String(draft.ore))!,
        balanced,
        payouts: draft.lines.map(strip),
      })
    }
    batch = null
  }

  for (const rec of records) {
    const tk = rec.text.slice(0, 2)
    if (tk === '01') {
      if (section) {
        issues.push({ line: rec.line, severity: 'error', message: 'Ett nytt avsnitt börjar innan det förra avslutades med en slutpost.' })
        flushBatch()
        sections.push(section)
      }
      if (!isNewLayoutOpening(rec.text)) {
        issues.push({ line: rec.line, severity: 'error', message: 'Öppningsposten är inte i Bankgirots nya fillayout.' })
        section = null
        continue
      }
      section = { ...header(rec), deposits: [], payout_batches: [], refunds: [] }
      Object.assign(tally, { deposits: 0, debits: 0, payoutBatches: 0, payouts: 0, refundWithdrawals: 0, refunds: 0 })
      continue
    }
    if (!section) {
      issues.push({ line: rec.line, severity: 'error', message: 'Posten ligger utanför ett avsnitt.' })
      continue
    }
    switch (tk) {
      case '15':
      case '16': {
        flushBatch()
        const draft = batchRecord(rec)
        if (!draft) {
          issues.push({ line: rec.line, severity: 'error', message: `${tk === '15' ? 'Insättningsposten' : 'Uttagsposten'} har inget giltigt belopp eller antal.` })
          continue
        }
        batch = { kind: tk === '15' ? 'deposit' : 'payout', draft }
        if (tk === '15') tally.deposits++
        else tally.payoutBatches++
        continue
      }
      case '82':
      case '32': {
        const expected = tk === '82' ? 'deposit' : 'payout'
        if (!batch || batch.kind !== expected) {
          issues.push({
            line: rec.line,
            severity: 'error',
            message: tk === '82' ? 'Inbetalningsposten ligger inte under en insättningspost.' : 'Utbetalningsposten ligger inte under en uttagspost.',
          })
          continue
        }
        const line = paymentLine(rec)
        if (!line) {
          issues.push({ line: rec.line, severity: 'error', message: 'Betalningsposten har inget giltigt belopp.' })
          continue
        }
        const recordBankgiro = readBankgiro(field(rec.text, 44, 53))
        if (recordBankgiro && section.bankgiro && recordBankgiro !== section.bankgiro) {
          issues.push({ line: rec.line, severity: 'warning', message: 'Betalningsposten gäller ett annat bankgironummer än avsnittet.' })
        }
        batch.draft.lines.push(line)
        if (tk === '82') tally.debits++
        else tally.payouts++
        continue
      }
      case '17': {
        flushBatch()
        const draft = batchRecord(rec)
        refund = draft ? { line: rec.line, date: draft.date, ore: draft.ore } : null
        if (!draft) issues.push({ line: rec.line, severity: 'error', message: 'Uttagsposten för återbetalning har inget giltigt belopp.' })
        else tally.refundWithdrawals++
        continue
      }
      case '77': {
        flushBatch()
        tally.refunds++
        if (!refund) {
          issues.push({ line: rec.line, severity: 'error', message: 'Återbetalningsposten saknar sin uttagspost.' })
          continue
        }
        section.refunds.push({
          line: rec.line,
          date: readDate(field(rec.text, 70, 77)) ?? refund.date,
          amount: readAmount(String(refund.ore))!,
          payer_number: readNumber(field(rec.text, 16, 31)),
          original_date: readDate(field(rec.text, 3, 10)),
          original_amount: readAmount(field(rec.text, 32, 43)) ?? 0,
          original_reference: readText(field(rec.text, 54, 69)),
          reason_code: readText(field(rec.text, 78, 79)),
        })
        refund = null
        continue
      }
      case '09': {
        flushBatch()
        const checks: Array<[string, number | null, number[]]> = [
          ['insättningsposter', count(field(rec.text, 15, 20)), [tally.deposits]],
          ['inbetalningsposter', count(field(rec.text, 21, 32)), [completedCount(section, 'deposits'), tally.debits]],
          ['uttagsposter', count(field(rec.text, 33, 38)), [tally.payoutBatches]],
          ['utbetalningsposter', count(field(rec.text, 39, 50)), [completedCount(section, 'payout_batches'), tally.payouts]],
          ['uttagsposter för återbetalning', count(field(rec.text, 51, 56)), [tally.refundWithdrawals]],
          ['återbetalningsposter', count(field(rec.text, 57, 68)), [tally.refunds]],
        ]
        for (const [what, stated, seen] of checks) {
          if (stated !== null && !seen.includes(stated)) {
            issues.push({ line: rec.line, severity: 'warning', message: `Slutposten anger ${stated} ${what}, filen innehåller ${seen[seen.length - 1]}.` })
          }
        }
        sections.push(section)
        section = null
        continue
      }
      default:
        continue
    }
  }
  if (section) {
    flushBatch()
    issues.push({ line: 0, severity: 'error', message: 'Filen slutar utan slutpost (TK09).' })
    sections.push(section)
  }
  return { kind: 'payment_specification', sealed, sections, issues }
}

function completedCount(section: AutogiroPaymentSpecificationSection, key: 'deposits' | 'payout_batches'): number {
  if (key === 'deposits') return section.deposits.reduce((n, d) => n + d.debits.filter((l) => l.completed).length, 0)
  return section.payout_batches.reduce((n, b) => n + b.payouts.filter((l) => l.completed).length, 0)
}

// ---------------------------------------------------------------------------
// Medgivandeavisering (8.3)

export interface AutogiroMandateNotice {
  line: number
  payer_number: string | null
  /** The payer's account, when the notice carries it (information codes 04, 05, 42, 43, 46). */
  bank_account: AutogiroBankAccount | null
  /** 12-digit personnummer or 10-digit organisationsnummer; null when not given. */
  identity_number: string | null
  /** Informationskod: what the record is about (codes.ts MANDATE_INFORMATION_CODES). */
  information_code: string | null
  /** Kommentarskod: the outcome or reason (codes.ts MANDATE_COMMENT_CODES). */
  comment_code: string | null
  information: string | null
  comment: string | null
  /** The day Bankgirot acted, YYYY-MM-DD. */
  action_date: string | null
}

export interface AutogiroMandateNoticeSection extends AutogiroSectionHeader {
  mandates: AutogiroMandateNotice[]
}

export interface AutogiroMandateNoticeReport {
  kind: 'mandate_notice'
  sealed: boolean
  sections: AutogiroMandateNoticeSection[]
  issues: AutogiroIssue[]
}

export function parseMandateNotice(content: string): AutogiroMandateNoticeReport {
  const { records, sealed } = unsealed(content)
  const issues: AutogiroIssue[] = []
  const sections: AutogiroMandateNoticeSection[] = []
  let section: AutogiroMandateNoticeSection | null = null

  for (const rec of records) {
    const tk = rec.text.slice(0, 2)
    if (tk === '01') {
      if (section) {
        issues.push({ line: rec.line, severity: 'error', message: 'Ett nytt avsnitt börjar innan det förra avslutades med en slutpost.' })
        sections.push(section)
      }
      if (!isNewLayoutOpening(rec.text)) {
        issues.push({ line: rec.line, severity: 'error', message: 'Öppningsposten är inte i Bankgirots nya fillayout.' })
        section = null
        continue
      }
      section = { ...header(rec), mandates: [] }
      continue
    }
    if (!section) {
      issues.push({ line: rec.line, severity: 'error', message: 'Posten ligger utanför ett avsnitt.' })
      continue
    }
    if (tk === '73') {
      const informationCode = readText(field(rec.text, 62, 63))
      const commentCode = readText(field(rec.text, 64, 65))
      section.mandates.push({
        line: rec.line,
        payer_number: readNumber(field(rec.text, 13, 28)),
        bank_account: readBankAccount(field(rec.text, 29, 44)),
        identity_number: readIdentityNumber(field(rec.text, 45, 56)),
        information_code: informationCode,
        comment_code: commentCode,
        information: informationCode ? describeCode(MANDATE_INFORMATION_CODES, informationCode) : null,
        comment: commentCode ? describeCode(MANDATE_COMMENT_CODES, commentCode) : null,
        action_date: readDate(field(rec.text, 66, 73)),
      })
      continue
    }
    if (tk === '09') {
      const stated = count(field(rec.text, 15, 21))
      if (stated !== null && stated !== section.mandates.length) {
        issues.push({ line: rec.line, severity: 'warning', message: `Slutposten anger ${stated} poster, avsnittet innehåller ${section.mandates.length}.` })
      }
      sections.push(section)
      section = null
    }
  }
  if (section) {
    issues.push({ line: 0, severity: 'error', message: 'Filen slutar utan slutpost (TK09).' })
    sections.push(section)
  }
  return { kind: 'mandate_notice', sealed, sections, issues }
}

// ---------------------------------------------------------------------------
// Avvisade betalningar (8.4)

export interface AutogiroRejectedPayment {
  line: number
  /** 'debit' (TK82, a rejected withdrawal from the payer) or 'payout' (TK32). */
  direction: 'debit' | 'payout'
  date: string | null
  payer_number: string | null
  amount: number
  reference: string | null
  /** Kommentarskod (codes.ts REJECTION_COMMENT_CODES). */
  comment_code: string | null
  comment: string | null
}

export interface AutogiroRejectedPaymentsSection extends AutogiroSectionHeader {
  payments: AutogiroRejectedPayment[]
}

export interface AutogiroRejectedPaymentsReport {
  kind: 'rejected_payments'
  sealed: boolean
  sections: AutogiroRejectedPaymentsSection[]
  issues: AutogiroIssue[]
}

export function parseRejectedPayments(content: string): AutogiroRejectedPaymentsReport {
  const { records, sealed } = unsealed(content)
  const issues: AutogiroIssue[] = []
  const sections: AutogiroRejectedPaymentsSection[] = []
  let section: AutogiroRejectedPaymentsSection | null = null
  const sums = { debits: 0, debitOre: 0, payouts: 0, payoutOre: 0 }

  for (const rec of records) {
    const tk = rec.text.slice(0, 2)
    if (tk === '01') {
      if (section) {
        issues.push({ line: rec.line, severity: 'error', message: 'Ett nytt avsnitt börjar innan det förra avslutades med en slutpost.' })
        sections.push(section)
      }
      if (!isNewLayoutOpening(rec.text)) {
        issues.push({ line: rec.line, severity: 'error', message: 'Öppningsposten är inte i Bankgirots nya fillayout.' })
        section = null
        continue
      }
      section = { ...header(rec), payments: [] }
      Object.assign(sums, { debits: 0, debitOre: 0, payouts: 0, payoutOre: 0 })
      continue
    }
    if (!section) {
      issues.push({ line: rec.line, severity: 'error', message: 'Posten ligger utanför ett avsnitt.' })
      continue
    }
    if (tk === '82' || tk === '32') {
      // Avvisade betalningar has no reserve at 15: the payer number starts at 15, one position before the specification's.
      const ore = readOre(field(rec.text, 31, 42))
      if (ore === null) {
        issues.push({ line: rec.line, severity: 'error', message: 'Betalningsposten har inget giltigt belopp.' })
        continue
      }
      const commentCode = readText(field(rec.text, 59, 60))
      section.payments.push({
        line: rec.line,
        direction: tk === '82' ? 'debit' : 'payout',
        date: readDate(field(rec.text, 3, 10)),
        payer_number: readNumber(field(rec.text, 15, 30)),
        amount: readAmount(field(rec.text, 31, 42))!,
        reference: readText(field(rec.text, 43, 58)),
        comment_code: commentCode,
        comment: commentCode ? describeCode(REJECTION_COMMENT_CODES, commentCode) : null,
      })
      if (tk === '82') {
        sums.debits++
        sums.debitOre += ore
      } else {
        sums.payouts++
        sums.payoutOre += ore
      }
      continue
    }
    if (tk === '09') {
      const stated = {
        payouts: count(field(rec.text, 15, 20)),
        payoutOre: readOre(field(rec.text, 21, 32)),
        debits: count(field(rec.text, 33, 38)),
        debitOre: readOre(field(rec.text, 39, 50)),
      }
      if (
        stated.payouts !== sums.payouts ||
        stated.payoutOre !== sums.payoutOre ||
        stated.debits !== sums.debits ||
        stated.debitOre !== sums.debitOre
      ) {
        issues.push({ line: rec.line, severity: 'error', message: 'Slutpostens antal eller summor stämmer inte med avsnittets betalningar.' })
      }
      sections.push(section)
      section = null
    }
  }
  if (section) {
    issues.push({ line: 0, severity: 'error', message: 'Filen slutar utan slutpost (TK09).' })
    sections.push(section)
  }
  return { kind: 'rejected_payments', sealed, sections, issues }
}

// ---------------------------------------------------------------------------
// Medgivanden via Internetbanken (8.6)

export interface AutogiroInternetBankMandate {
  line: number
  /** The payer number the payer typed in its internet bank: check it before approving. */
  payer_number: string | null
  bank_account: AutogiroBankAccount | null
  identity_number: string | null
  /** Meddelandetyp: 'new', or Bankgirot's first or second reminder that the mandate still waits for an answer. */
  message_type: 'new' | 'reminder_1' | 'reminder_2' | null
  /** Särskild information from the payer (TK53), free text. */
  information: string | null
  /** Name and address lines (TK54, TK55), blank lines dropped. */
  name_and_address: string[]
  postal_code: string | null
  /** Postort, or the country for a foreign address. */
  city: string | null
}

export interface AutogiroInternetBankSection {
  line: number
  bankgiro: string | null
  written_on: string | null
  mandates: AutogiroInternetBankMandate[]
}

export interface AutogiroInternetBankReport {
  kind: 'internet_bank_mandates'
  sealed: boolean
  sections: AutogiroInternetBankSection[]
  issues: AutogiroIssue[]
}

const MESSAGE_TYPES = { '0': 'new', '1': 'reminder_1', '2': 'reminder_2' } as const

export function parseInternetBankMandates(content: string): AutogiroInternetBankReport {
  const { records, sealed } = unsealed(content)
  const issues: AutogiroIssue[] = []
  const sections: AutogiroInternetBankSection[] = []
  let section: AutogiroInternetBankSection | null = null
  let current: AutogiroInternetBankMandate | null = null

  for (const rec of records) {
    const tk = rec.text.slice(0, 2)
    if (tk === '51') {
      if (section) {
        issues.push({ line: rec.line, severity: 'error', message: 'Ett nytt avsnitt börjar innan det förra avslutades med en slutpost.' })
        sections.push(section)
      }
      section = {
        line: rec.line,
        bankgiro: readBankgiro(field(rec.text, 15, 24)),
        written_on: readDate(field(rec.text, 3, 10)),
        mandates: [],
      }
      current = null
      continue
    }
    if (!section) {
      issues.push({ line: rec.line, severity: 'error', message: 'Posten ligger utanför ett avsnitt.' })
      continue
    }
    switch (tk) {
      case '52': {
        const type = field(rec.text, 62, 62)
        current = {
          line: rec.line,
          payer_number: readNumber(field(rec.text, 13, 28)),
          bank_account: readBankAccount(field(rec.text, 29, 44)),
          identity_number: readIdentityNumber(field(rec.text, 45, 56)),
          message_type: type in MESSAGE_TYPES ? MESSAGE_TYPES[type as keyof typeof MESSAGE_TYPES] : null,
          information: null,
          name_and_address: [],
          postal_code: null,
          city: null,
        }
        section.mandates.push(current)
        continue
      }
      case '53':
      case '54':
      case '55':
      case '56': {
        if (!current) {
          issues.push({ line: rec.line, severity: 'error', message: 'Uppgiften saknar sin medgivandepost (TK52).' })
          continue
        }
        if (tk === '53') {
          const info = readText(field(rec.text, 3, 38))
          if (info) current.information = current.information ? `${current.information} ${info}` : info
        } else if (tk === '56') {
          const postal = readNumber(field(rec.text, 3, 7))
          current.postal_code = postal && postal !== '0' ? field(rec.text, 3, 7) : null
          current.city = readText(field(rec.text, 8, 38))
        } else {
          for (const part of [field(rec.text, 3, 38), field(rec.text, 39, 74)]) {
            const text = readText(part)
            if (text) current.name_and_address.push(text)
          }
        }
        continue
      }
      case '59': {
        const stated = count(field(rec.text, 15, 21))
        if (stated !== null && stated !== section.mandates.length) {
          issues.push({ line: rec.line, severity: 'warning', message: `Slutposten anger ${stated} poster, avsnittet innehåller ${section.mandates.length} medgivanden.` })
        }
        sections.push(section)
        section = null
        current = null
        continue
      }
      default:
        continue
    }
  }
  if (section) {
    issues.push({ line: 0, severity: 'error', message: 'Filen slutar utan slutpost (TK59).' })
    sections.push(section)
  }
  return { kind: 'internet_bank_mandates', sealed, sections, issues }
}

// ---------------------------------------------------------------------------
// Utdrag ur Medgivanderegistret (8.8)

export interface AutogiroRegisteredMandate {
  line: number
  bankgiro: string | null
  identity_number: string | null
  payer_number: string | null
  /** Medgivandetyp: 'payee' (1, set up by the payee) or 'internet_bank' (2, signed by the payer in its internet bank). */
  initiated_by: 'payee' | 'internet_bank'
  /** Senaste aktivitetsår, ÅÅ as given. */
  last_activity_year: string | null
  created_on: string | null
  changed_on: string | null
  /** 'approved' (1, godkänt för Autogiro) or 'pending' (2, under förfrågan). */
  status: 'approved' | 'pending'
  /** The account debited; null when the payer pays from its bankgiro. */
  bank_account: AutogiroBankAccount | null
}

export interface AutogiroMandateRegister {
  kind: 'mandate_register'
  sealed: boolean
  mandates: AutogiroRegisteredMandate[]
  issues: AutogiroIssue[]
}

/** Bankgirot's extract of every mandate it holds for the payee: the way to bring existing mandates along. */
export function parseMandateRegister(content: string): AutogiroMandateRegister {
  const { records, sealed } = unsealed(content)
  const issues: AutogiroIssue[] = []
  const mandates: AutogiroRegisteredMandate[] = []
  for (const rec of records) {
    if (!isRegisterRecord(rec.text)) {
      issues.push({ line: rec.line, severity: 'error', message: 'Raden är ingen registerpost ur medgivanderegistret.' })
      continue
    }
    const type = field(rec.text, 39, 39)
    const status = field(rec.text, 58, 58)
    const changed = field(rec.text, 50, 57)
    mandates.push({
      line: rec.line,
      bankgiro: readBankgiro(field(rec.text, 1, 10)),
      identity_number: readIdentityNumber(field(rec.text, 11, 22)),
      payer_number: readNumber(field(rec.text, 23, 38)),
      initiated_by: type === '1' ? 'payee' : 'internet_bank',
      last_activity_year: readText(field(rec.text, 40, 41)),
      created_on: readDate(field(rec.text, 42, 49)),
      changed_on: /^0+$/.test(changed) ? null : readDate(changed),
      status: status === '1' ? 'approved' : 'pending',
      bank_account: readBankAccount(field(rec.text, 65, 80)),
    })
  }
  return { kind: 'mandate_register', sealed, mandates, issues }
}

// ---------------------------------------------------------------------------

export type AutogiroReport =
  | AutogiroPaymentSpecification
  | AutogiroMandateNoticeReport
  | AutogiroRejectedPaymentsReport
  | AutogiroInternetBankReport
  | AutogiroMandateRegister

/** Reads any report v1 understands; null with the detection when the file is not one (old layout, other report, no Autogiro file). */
export function parseAutogiroReport(
  content: string,
): { report: AutogiroReport; detection: AutogiroReportDetection } | { report: null; detection: AutogiroReportDetection | null } {
  const detection = detectAutogiroReport(content)
  switch (detection?.kind) {
    case 'payment_specification':
      return { report: parsePaymentSpecification(content), detection }
    case 'mandate_notice':
      return { report: parseMandateNotice(content), detection }
    case 'rejected_payments':
      return { report: parseRejectedPayments(content), detection }
    case 'internet_bank_mandates':
      return { report: parseInternetBankMandates(content), detection }
    case 'mandate_register':
      return { report: parseMandateRegister(content), detection }
    default:
      return { report: null, detection: detection ?? null }
  }
}
