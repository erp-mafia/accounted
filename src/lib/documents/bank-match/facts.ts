/**
 * What an underlag says about the payment it expects, read off the one
 * reading (lib/documents/reading) for match on arrival: whether money left or
 * came back, how much, in which currency, under which OCR and to which giro,
 * and when.
 *
 * Only a supplier invoice, a supplier credit note and a receipt are matched:
 * a government letter or another document is not paid from the bank by the
 * company in a way one bank row settles. A value a person cleared is no
 * value. Pure: no client, no I/O.
 */
import { DATE_TOLERANCE_DAYS } from '@/lib/documents/core-receipt-matcher'
import type { DocumentReading, ReadingFieldName, ReadingValues } from '@/lib/documents/reading/types'
import { addDaysIso } from '@/lib/dates/iso'
import { ISO_DATE_RE as ISO_DATE } from '@/lib/invariants/iso-date'

export type BankMatchKind = 'supplier_invoice' | 'credit_note' | 'receipt'

export interface BankMatchFacts {
  kind: BankMatchKind
  /** out: the company paid (an invoice, a receipt); in: money came back (a credit note, a refund). */
  direction: 'out' | 'in'
  /** The amount due as a magnitude, in `currency`. */
  amount: number
  /** Upper-case; SEK when the reading names none. */
  currency: string
  /** The OCR or payment reference the document prints (remittance information). */
  reference: string | null
  /** The giro the document asks to be paid to. */
  bankgiro: string | null
  plusgiro: string | null
  /** The giro on the matched supplier's card, which the bank feed's matcher also compares. */
  supplierBankgiro: string | null
  supplierPlusgiro: string | null
  issueDate: string | null
  dueDate: string | null
  /** The seller's name as read, then the matched supplier's own name: the counterparty and its alias. */
  names: string[]
  /** The day the item arrived, YYYY-MM-DD: the anchor when the document carries no date. */
  arrivedOn: string
  /**
   * The last four digits of the card the purchase was paid with, as the
   * document or the receipt it came with says (extracted_data.payment); the
   * reading carries no card, so the refresh adds it. Null or absent for none.
   */
  cardLast4?: string | null
}

/** The matched supplier's card, as far as matching reads it. */
export interface SupplierCardForMatch {
  name: string | null
  bankgiro: string | null
  plusgiro: string | null
}

function valueOf<K extends ReadingFieldName>(reading: DocumentReading, field: K): ReadingValues[K] | null {
  return (reading.fields[field]?.value ?? null) as ReadingValues[K] | null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function isoDate(value: unknown): string | null {
  const raw = text(value)
  return raw && ISO_DATE.test(raw.slice(0, 10)) ? raw.slice(0, 10) : null
}

export function bankMatchFacts(
  reading: DocumentReading,
  supplier: SupplierCardForMatch | null,
  arrivedOn: string,
): BankMatchFacts | null {
  const kind = valueOf(reading, 'document_type')
  if (kind !== 'supplier_invoice' && kind !== 'credit_note' && kind !== 'receipt') return null
  const total = valueOf(reading, 'amount_due_for_payment')
  if (typeof total !== 'number' || !Number.isFinite(total) || total === 0) return null

  const names: string[] = []
  for (const name of [text(valueOf(reading, 'seller_name')), text(supplier?.name)]) {
    if (name && !names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name)
  }

  return {
    kind,
    // A credit note's amounts are below zero in the reading; a receipt below zero is a refund.
    direction: kind === 'credit_note' || total < 0 ? 'in' : 'out',
    amount: Math.abs(total),
    currency: (text(valueOf(reading, 'invoice_currency_code')) ?? 'SEK').toUpperCase(),
    reference: text(valueOf(reading, 'remittance_information')),
    bankgiro: text(valueOf(reading, 'payment_account_bankgiro')),
    plusgiro: text(valueOf(reading, 'payment_account_plusgiro')),
    supplierBankgiro: text(supplier?.bankgiro),
    supplierPlusgiro: text(supplier?.plusgiro),
    issueDate: isoDate(valueOf(reading, 'invoice_issue_date')),
    dueDate: kind === 'receipt' ? null : isoDate(valueOf(reading, 'payment_due_date')),
    names,
    arrivedOn,
  }
}

export interface PaymentWindow {
  /** YYYY-MM-DD, inclusive. */
  start: string
  end: string
  /** The days the payment is expected on: the issue date to the due date. */
  coreStart: string
  coreEnd: string
}

/**
 * The days a payment of this document may fall on.
 *
 * An invoice: the bank feed's supplier-invoice matcher's window for an
 * amount-and-date match (lib/invoices/supplier-invoice-matching.ts, pass 3):
 * five days before the invoice date to five days after the due date, about
 * thirty days of credit on the side that is missing. A receipt is paid the
 * day it is dated, and a card purchase settles days later: five days before
 * it to the receipt matcher's ten after (core-receipt-matcher
 * DATE_TOLERANCE_DAYS). Null when the document carries no date: then only
 * the OCR can pair it.
 */
export function paymentWindow(facts: BankMatchFacts): PaymentWindow | null {
  if (facts.kind === 'receipt') {
    const day = facts.issueDate ?? facts.arrivedOn
    return { start: addDaysIso(day, -5), end: addDaysIso(day, DATE_TOLERANCE_DAYS), coreStart: day, coreEnd: day }
  }
  const { issueDate, dueDate } = facts
  if (!issueDate && !dueDate) return null
  const start = issueDate ? addDaysIso(issueDate, -5) : addDaysIso(dueDate as string, -35)
  const end = dueDate ? addDaysIso(dueDate, 5) : addDaysIso(issueDate as string, 35)
  return { start, end, coreStart: issueDate ?? (dueDate as string), coreEnd: dueDate ?? (issueDate as string) }
}

/**
 * The due date the window above implies, for handing the reading to the
 * supplier-invoice matcher as if it were registered: its window then ends
 * where paymentWindow ends.
 */
export function windowDueDate(facts: BankMatchFacts): string | null {
  if (facts.kind === 'receipt') {
    const day = facts.issueDate ?? facts.arrivedOn
    return addDaysIso(day, DATE_TOLERANCE_DAYS - 5)
  }
  return facts.dueDate
}

/** Days the bank-row search spans on either side of every date the item knows. */
const SEARCH_MARGIN_DAYS = 60

/**
 * The bank-row dates to read: every date the document and the item know,
 * widened by two months (an OCR pairs a payment outside the window), and
 * never ending before today.
 */
export function searchRange(facts: BankMatchFacts, today: string): { from: string; to: string } {
  const known = [facts.issueDate, facts.dueDate, facts.arrivedOn].filter((d): d is string => !!d).sort()
  const earliest = known[0] ?? facts.arrivedOn
  const latest = known[known.length - 1] ?? facts.arrivedOn
  const to = addDaysIso(latest, SEARCH_MARGIN_DAYS)
  return { from: addDaysIso(earliest, -SEARCH_MARGIN_DAYS), to: to > today ? to : today }
}
