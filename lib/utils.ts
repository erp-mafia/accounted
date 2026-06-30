import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { format as formatDateFns, parseISO, isValid } from "date-fns"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Shown by the date formatters when handed an Invalid Date. We fail closed —
 * render a neutral placeholder rather than the raw malformed string — so a
 * corrupted value is never surfaced to the UI, and never throws either. After
 * the server validation + DB CHECK landed, a bad date shouldn't reach here at
 * all; this is the last-resort guard.
 */
const INVALID_DATE_PLACEHOLDER = '—'

export function formatCurrency(
  amount: number,
  currency: string = 'SEK',
  options?: { minimumFractionDigits?: number; maximumFractionDigits?: number },
): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency,
    minimumFractionDigits: options?.minimumFractionDigits ?? 0,
    maximumFractionDigits: options?.maximumFractionDigits ?? 2,
  }).format(amount)
}

export function formatDate(date: Date | string): string {
  // parseISO interprets bare 'yyyy-MM-dd' as local midnight, not UTC midnight.
  // Using new Date() would shift the displayed day by one in timezones west of
  // UTC for bare date strings — that's an off-by-one we don't want for
  // accounting data.
  const d = typeof date === 'string' ? parseISO(date) : date
  // A malformed value (e.g. a 6-digit year fat-fingered into a native
  // <input type="date">, stored by Postgres as year 202403) yields an Invalid
  // Date, and date-fns `format` THROWS a RangeError on that. One bad row must
  // never crash an entire route via the error boundary — degrade to the raw
  // input instead.
  if (!isValid(d)) return INVALID_DATE_PLACEHOLDER
  return formatDateFns(d, 'yyyy-MM-dd')
}

/**
 * True when `s` is a real, in-range calendar date in `YYYY-MM-DD` form.
 *
 * The shape check (4-digit year) is what stops the native <input type="date">
 * 6-digit-year corruption ('202403-02-05'); the parse + range check also
 * rejects impossible dates (2024-13-40) and absurd years. Exported as the ONE
 * authoritative date rule shared by the client form and the server-side
 * CreateTransactionSchema, so the two validation layers can never drift.
 */
export function isSaneDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = parseISO(s)
  return isValid(d) && d.getFullYear() >= 1900 && d.getFullYear() <= 2100
}

/**
 * Date + time for audit / metadata displays: `2026-05-11 14:30`. ISO-ordered
 * and locale-independent (sortable, unambiguous), matching `formatDate`'s
 * accounting convention. Use for "created at" / "last synced" timestamps. For
 * date-only accounting values use `formatDate`; for friendly long-form metadata
 * dates use `formatDateLong`.
 */
export function formatDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? parseISO(date) : date
  if (!isValid(d)) return INVALID_DATE_PLACEHOLDER
  return formatDateFns(d, 'yyyy-MM-dd HH:mm')
}

/**
 * Bare amount with sv-SE grouping and exactly two decimals, no currency symbol:
 * `1234.5` → `1 234,50`. Use in table cells / inputs where the column header or
 * surrounding context already conveys "kr" and `formatCurrency`'s symbol would
 * be noise. Stays sv-SE in both locales (Swedish accounting convention, not a
 * UI string) — same rule as `formatCurrency`. When you need the SEK symbol, use
 * `formatCurrency`.
 */
export function formatAmount(amount: number): string {
  return new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

/**
 * Whole-krona amount, no decimals, sv-SE grouping: `1234.56` → `1 235`. For
 * compact KPI tiles and rounded summaries.
 *
 * NOTE: not for statutory output. INK2 / NE-bilaga / SRU require *truncation*
 * (`Math.trunc`) per SFL 22:1, not rounding — use the dedicated SRU formatter
 * for those surfaces.
 */
export function formatWholeKr(amount: number): string {
  return new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

/**
 * Long-form date for metadata/audit contexts (e.g. "9 maj 2026" / "May 9, 2026").
 * Use formatDate for transaction/voucher/invoice dates that need to align in tables.
 *
 * The locale arg is the UI language ('sv' | 'en'); default 'sv' keeps existing
 * server-side callers (logs, audit) Swedish without churn. For client UI use
 * the useFormat() hook which pulls the active locale from next-intl.
 */
export function formatDateLong(date: Date | string, locale: string = 'sv'): string {
  const d = typeof date === 'string' ? parseISO(date) : date
  if (!isValid(d)) return INVALID_DATE_PLACEHOLDER
  const intlLocale = locale === 'en' ? 'en-US' : 'sv-SE'
  return d.toLocaleDateString(intlLocale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/**
 * Today's date in Europe/Stockholm, labelled for the bookkeeping agent's system
 * prompt — e.g. "2026-05-27 (onsdag)".
 *
 * Date granularity (no clock time) is deliberate: the agent system prompt is
 * cached (cache_control ttl=1h) and this string sits inside the cached prefix,
 * so a full timestamp would bust the cache on every request while the value
 * actually changes at most once a day. Stockholm time zone — not the server's
 * UTC — so "idag" is right for Swedish users near midnight, where a UTC date can
 * read a day behind.
 */
export function swedishToday(now: Date = new Date()): string {
  const date = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const weekday = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    weekday: 'long',
  }).format(now)
  return `${date} (${weekday})`
}

export function formatOrgNumber(orgNumber: string): string {
  // Format Swedish org number: XXXXXX-XXXX
  const cleaned = orgNumber.replace(/\D/g, '')
  if (cleaned.length === 10) {
    return `${cleaned.slice(0, 6)}-${cleaned.slice(6)}`
  }
  return orgNumber
}

export function getCompanyDisplayName(settings: { company_name?: string | null }): string {
  return settings.company_name?.trim() || ''
}

export function getCompanyPrimaryName(settings: { company_name?: string | null }): string {
  return settings.company_name?.trim() || ''
}

export function generateInvoiceNumber(): string {
  const year = new Date().getFullYear()
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0')
  return `${year}-${random}`
}

// Shared FX-rate validator — keeps UI, RPC (>= 100000 / <= 0), and the
// invoices/supplier_invoices CHECK constraints in sync. Single source
// of truth for the 0 < rate < 100000 bound.
export function isValidExchangeRate(rate: number | null | undefined): rate is number {
  return rate != null && rate > 0 && rate < 100000
}
