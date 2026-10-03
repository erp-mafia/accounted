import { differenceInCalendarDays, isValid, parseISO } from 'date-fns'
import { ISO_DATE_RE as ISO_DATE } from '@/lib/invariants'
import type { FiscalPeriod, InvoiceDocumentType } from '@/types'

/**
 * The invoice editor's Detaljer section: one row of chips (Fakturadatum,
 * Förfaller, Valuta, Språk, + Leveransdatum) that opens into real fields by
 * itself when something is not the everyday case. 76% of invoices keep
 * today's date, 82% the default term and 94% are in SEK, so the fields stay
 * folded until a value needs a decision.
 *
 * Pure: the component renders what these return.
 */

export type DetailsLanguage = 'sv' | 'en'

/** Why the invoice date cannot be booked: the DB triggers refuse it. */
export type InvoiceDateLock =
  /** On or before company_settings.bookkeeping_locked_through. */
  | 'company_lock'
  /** Inside a fiscal period with locked_at set. */
  | 'locked_period'
  /** Inside a closed fiscal year. */
  | 'closed_period'

/**
 * Whether a voucher dated `date` would be refused, by the same rules as the
 * enforcement triggers: the company lock date (inclusive), then a closed or
 * locked fiscal period. Null when the date books (or is not a full date yet).
 */
export function invoiceDateLock(input: {
  date: string | null | undefined
  lockedThrough: string | null | undefined
  periods: ReadonlyArray<Pick<FiscalPeriod, 'period_start' | 'period_end' | 'is_closed' | 'locked_at'>>
}): InvoiceDateLock | null {
  const date = input.date ?? ''
  if (!ISO_DATE.test(date)) return null
  if (input.lockedThrough && date <= input.lockedThrough) return 'company_lock'
  const period = input.periods.find((p) => p.period_start <= date && date <= p.period_end)
  if (period?.is_closed) return 'closed_period'
  if (period?.locked_at) return 'locked_period'
  return null
}

/** Why the Detaljer section shows its fields instead of the chips. */
export type DetailsReason =
  /** Not SEK: the rate line and the payee for that currency matter. */
  | 'currency'
  /** The customer reads English: OCR and labels change. */
  | 'language'
  /** An EU or non-EU business: VAT treatment and currency deserve a look. */
  | 'foreign_customer'
  /** A delivery date other than the invoice date (printed only then). */
  | 'delivery_date'
  /** The date falls in a locked or closed period: it cannot be booked. */
  | 'date_locked'
  /** A quote valid until before its own date. */
  | 'quote_validity'

export interface DetailsExpansionInput {
  documentType: InvoiceDocumentType
  isSelfBilled: boolean
  currency: string
  language: DetailsLanguage
  customerType: string | null | undefined
  invoiceDate: string
  deliveryDate: string
  validUntil: string
  /** invoiceDateLock() of the invoice date, only where sending books it. */
  dateLock: InvoiceDateLock | null
}

/**
 * The reasons the Detaljer section opens by itself, in the order the aside
 * names them. Empty = the chip row.
 */
export function resolveDetailsExpansion(input: DetailsExpansionInput): DetailsReason[] {
  const reasons: DetailsReason[] = []
  if (input.currency && input.currency !== 'SEK') reasons.push('currency')
  if (!input.isSelfBilled) {
    if (input.language === 'en') reasons.push('language')
    if (input.customerType === 'eu_business' || input.customerType === 'non_eu_business') {
      reasons.push('foreign_customer')
    }
    if (
      input.documentType === 'invoice' &&
      input.deliveryDate &&
      input.deliveryDate !== input.invoiceDate
    ) {
      reasons.push('delivery_date')
    }
  }
  if (input.dateLock) reasons.push('date_locked')
  if (
    !input.isSelfBilled &&
    input.documentType === 'quote' &&
    ISO_DATE.test(input.validUntil) &&
    ISO_DATE.test(input.invoiceDate) &&
    input.validUntil < input.invoiceDate
  ) {
    reasons.push('quote_validity')
  }
  return reasons
}

/** Days from the invoice date to the due date; null when either is missing. */
export function termDays(invoiceDate: string, dueDate: string): number | null {
  if (!invoiceDate || !dueDate) return null
  const from = parseISO(invoiceDate)
  const to = parseISO(dueDate)
  if (!isValid(from) || !isValid(to)) return null
  return differenceInCalendarDays(to, from)
}

export type DetailsChip =
  /** Fakturadatum (Offertdatum on a quote). */
  | { kind: 'invoice_date'; date: string }
  | { kind: 'due'; date: string; days: number | null }
  | { kind: 'valid_until'; date: string; days: number | null }
  | { kind: 'currency'; currency: string }
  /** From the customer card: there is no per-invoice language. */
  | { kind: 'language'; language: DetailsLanguage }
  /** dims null: the dashed "+ Dimensioner" chip. */
  | { kind: 'dimensions'; dims: string | null }

export interface DetailsChipsInput {
  documentType: InvoiceDocumentType
  isSelfBilled: boolean
  invoiceDate: string
  dueDate: string
  validUntil: string
  currency: string
  language: DetailsLanguage
  /** company_settings.dimensions_enabled, on a faktura. */
  dimensionsEnabled: boolean
  /** The invoice's default dimensions, compacted ("KS01 · P001"); null when none. */
  dims: string | null
}

/**
 * The chip row, in reading order. A received självfaktura shows its dates
 * next to the issuer, so only the due date and the currency are chips there.
 *
 * Leveransdatum is not a chip: it prints only when it differs from the
 * invoice date, and then the section opens by itself (resolveDetailsExpansion).
 * Until then it is one "+ Leveransdatum" link inside the opened fields, so
 * the everyday invoice keeps the row to dates, currency and language
 * (p2-coverage 3.2) on one line.
 */
export function resolveDetailsChips(input: DetailsChipsInput): DetailsChip[] {
  const chips: DetailsChip[] = []
  if (!input.isSelfBilled && input.invoiceDate) chips.push({ kind: 'invoice_date', date: input.invoiceDate })
  if (input.documentType === 'quote' && !input.isSelfBilled) {
    if (input.validUntil) {
      chips.push({ kind: 'valid_until', date: input.validUntil, days: termDays(input.invoiceDate, input.validUntil) })
    }
  } else if (input.dueDate) {
    chips.push({ kind: 'due', date: input.dueDate, days: termDays(input.invoiceDate, input.dueDate) })
  }
  chips.push({ kind: 'currency', currency: input.currency })
  if (!input.isSelfBilled) {
    chips.push({ kind: 'language', language: input.language })
    if (input.documentType === 'invoice' && input.dimensionsEnabled) {
      chips.push({ kind: 'dimensions', dims: input.dims })
    }
  }
  return chips
}

/**
 * A date as a chip says it: "2 okt" / "2 Oct", with the year only when it is
 * not this year's ("2 okt 2025"). Accounting dates elsewhere stay ISO.
 */
export function formatChipDate(iso: string, locale: string, todayIso: string): string {
  const date = parseISO(iso)
  if (!ISO_DATE.test(iso) || !isValid(date)) return iso
  const sameYear = iso.slice(0, 4) === todayIso.slice(0, 4)
  const text = date.toLocaleDateString(locale === 'en' ? 'en-GB' : 'sv-SE', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
  // Swedish short months carry an abbreviation dot ("okt."): a chip reads cleaner without it.
  return text.replace(/\.(?=\s|$)/g, '')
}
