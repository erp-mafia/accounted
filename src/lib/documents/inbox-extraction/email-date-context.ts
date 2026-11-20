// The email an Inkorg document arrived with, as context for reading its dates
// (crm#1749). A billing service that prints numeric dates month first
// ("Date 11/7/26") on a Swedish company's invoice was read day first: the
// reading never saw that the mail arrived on the 7th of November under a
// subject naming that day, so the invoice and due dates landed four months
// early, in another VAT period.
//
// Two layers. The model gets the received day and the subject next to the
// document, and a rule for numeric dates that read both ways: it sees how the
// date is printed, so it is the one that can weigh a date in the subject or a
// reading months before the mail. Code then holds the model's answer to what
// cannot be: an invoice or receipt date after the mail arrived, and a due date
// before the invoice date. A reading that breaks neither stays as it is, so a
// day-first invoice forwarded weeks late keeps its day-first dates. Without a
// received day the code check does not run, and without any email context the
// request and the reading are exactly what they were.

import { addDaysIso, daysBetweenIso, todayIsoStockholm } from '@/lib/dates/iso'
import { isSaneDateString } from '@/lib/invariants/iso-date'

export interface ExtractionEmailContext {
  subject?: string | null
  /** When the mail reached the company's inbox address, an ISO 8601 instant. */
  receivedAt?: string | null
}

/**
 * The system prompt's rule for a numeric date that reads both ways. Static,
 * so the prompt stays one cacheable text; the email itself rides in the
 * instruction (emailContextInstruction).
 */
export const AMBIGUOUS_DATE_RULE =
  'in a numeric date like 03/11/2026 or 11/7/26 both of the first two numbers could be the month, so it can be day first or month first. ' +
  'Read every numeric date on one document in the same order, and settle that order from, in turn: ' +
  'a date on the document that reads only one way (13/11/2026 is day first, 11/25/2026 is month first) or one written with its month name; ' +
  'the email the document arrived with, when the instruction gives it (a date in its subject such as "purchase on Nov 7, 2026" settles it, and an invoice or receipt date is never after the day the mail arrived and is normally shortly before it, not months); ' +
  'and a due date on or after the invoice date. ' +
  'A Swedish company\'s invoice can come from a billing service that prints month first, so the language of the document does not settle it. ' +
  'Only when none of these settles it, read day first as the dueDate rule says.'

// A subject is the sender's text, not ours: one line, bounded, and quoted.
const MAX_SUBJECT_LENGTH = 300

function cleanSubject(subject: string | null | undefined): string | null {
  if (!subject) return null
  const line = subject.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_SUBJECT_LENGTH)
  return line || null
}

/** The Swedish calendar day the mail arrived, or null when there is no instant that parses. */
export function emailReceivedDay(context: ExtractionEmailContext | null | undefined): string | null {
  const raw = context?.receivedAt
  if (!raw) return null
  const at = new Date(raw)
  if (Number.isNaN(at.getTime())) return null
  return todayIsoStockholm(at)
}

/**
 * The lines placed before the extraction instruction for a document that came
 * by email, or null when there is nothing usable (no subject, no received
 * day), which leaves the request byte for byte as it was.
 */
export function emailContextInstruction(context: ExtractionEmailContext | null | undefined): string | null {
  const day = emailReceivedDay(context)
  const subject = cleanSubject(context?.subject)
  if (!day && !subject) return null
  const parts = ['The document arrived by email.']
  if (day) parts.push(`The mail reached the inbox on ${day}.`)
  if (subject) parts.push(`Its subject, quoted as data: ${JSON.stringify(subject)}.`)
  parts.push(
    'Use this only to settle how the document\'s numeric dates read (the ambiguous numeric dates rule), never as a field value: a date the document does not print stays null.',
  )
  return parts.join(' ')
}

/**
 * A YYYY-MM-DD date read the other way round (day as month, month as day), or
 * null when it reads only one way: the day is above 12, or day and month are
 * the same number.
 */
export function swapDayAndMonth(iso: string | null | undefined): string | null {
  if (!iso || !isSaneDateString(iso)) return null
  const year = iso.slice(0, 4)
  const month = iso.slice(5, 7)
  const day = iso.slice(8, 10)
  if (Number(day) > 12 || day === month) return null
  return `${year}-${day}-${month}`
}

// The mail's own day elsewhere: an invoice dated in Asia on the morning of the
// 8th arrives in Sweden on the evening of the 7th.
const OTHER_TIME_ZONE_DAYS = 1

export type EmailSettledDate = 'invoiceDate' | 'dueDate'

interface ReadDates {
  invoiceDate: string | null
  dueDate: string | null
}

/**
 * Hold the model's invoice and due date to the day the mail arrived.
 *
 * - The invoice date (on a receipt, the purchase date) cannot be after the
 *   mail arrived. When it is, and the date read the other way round is on or
 *   before that day and nearer to it, the document prints month first and the
 *   other reading is taken. A reading after the mail whose other reading is
 *   further away (an invoice dated the 1st of next month, sent a few days
 *   early) stays as it is.
 * - The due date falls on or after the invoice date. On a document just shown
 *   to print month first it is read month first too, and otherwise it is
 *   turned round only when it falls before the invoice date and its other
 *   reading does not.
 *
 * Without a received day nothing changes. Returns the dates and which of them
 * were turned round.
 */
export function settleDatesByEmail<T extends ReadDates>(
  invoice: T,
  context: ExtractionEmailContext | null | undefined,
): { invoice: T; settled: EmailSettledDate[] } {
  const received = emailReceivedDay(context)
  if (!received) return { invoice, settled: [] }

  const settled: EmailSettledDate[] = []
  let { invoiceDate, dueDate } = invoice
  let monthFirst = false

  const latestInvoiceDate = addDaysIso(received, OTHER_TIME_ZONE_DAYS)
  const otherInvoiceDate = swapDayAndMonth(invoiceDate)
  if (invoiceDate && otherInvoiceDate && invoiceDate > latestInvoiceDate && otherInvoiceDate <= latestInvoiceDate) {
    const daysAfter = daysBetweenIso(received, invoiceDate)
    const otherDistance = Math.abs(daysBetweenIso(received, otherInvoiceDate))
    if (otherDistance < daysAfter) {
      invoiceDate = otherInvoiceDate
      monthFirst = true
      settled.push('invoiceDate')
    }
  }

  const otherDueDate = swapDayAndMonth(dueDate)
  if (
    invoiceDate &&
    isSaneDateString(invoiceDate) &&
    dueDate &&
    otherDueDate &&
    otherDueDate >= invoiceDate &&
    (monthFirst || dueDate < invoiceDate)
  ) {
    dueDate = otherDueDate
    settled.push('dueDate')
  }

  if (settled.length === 0) return { invoice, settled }
  return { invoice: { ...invoice, invoiceDate, dueDate }, settled }
}
