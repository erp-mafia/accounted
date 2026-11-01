import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { format as formatDateFns, parseISO, isValid } from "date-fns"
import { roundOre } from "@/lib/money"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Shown by the date formatters when handed an Invalid Date. We fail closed:
 * render a neutral placeholder rather than the raw malformed string: so a
 * corrupted value is never surfaced to the UI, and never throws either. After
 * the server validation + DB CHECK landed, a bad date shouldn't reach here at
 * all; this is the last-resort guard.
 */
const INVALID_DATE_PLACEHOLDER = '-'

type FractionDigitOptions = { minimumFractionDigits?: number; maximumFractionDigits?: number }

/**
 * Öre are shown as two digits or not at all: `174.5` -> `174,50 kr`, `1000` ->
 * `1 000 kr`. A minimum of 0 made Intl drop the trailing zero and print
 * `174,5 kr`, which reads as a typo on an amount. A caller that passes
 * `minimumFractionDigits` gets exactly what it asked for; one that passes only
 * a maximum below 2 gets that maximum as the minimum too (min above max throws).
 */
function currencyFractionDigits(options?: FractionDigitOptions): Intl.NumberFormatOptions {
  if (options?.minimumFractionDigits !== undefined) {
    return {
      minimumFractionDigits: options.minimumFractionDigits,
      maximumFractionDigits: options.maximumFractionDigits ?? 2,
    }
  }
  const max = options?.maximumFractionDigits ?? 2
  return {
    minimumFractionDigits: Math.min(2, max),
    maximumFractionDigits: max,
    trailingZeroDisplay: 'stripIfInteger',
  }
}

/**
 * Money with a currency symbol, sv-SE grouping: `1234.5` -> `1 234,50 kr`,
 * `1000` -> `1 000 kr` (see currencyFractionDigits).
 *
 * `currency` defaults to SEK and stays sv-SE in both locales: that is a Swedish
 * accounting convention, not a UI string (.claude/rules/i18n.md), and the
 * single-argument form is the correct call on the hundreds of values that ARE
 * kronor (ledger amounts, KPI aggregates, salary, tax).
 *
 * What the default cannot know is that the number came off a record carrying
 * its own currency. `formatCurrency(invoice.total)` on a 1 000 EUR invoice
 * prints "1 000 kr", and nothing downstream can tell that apart from a real
 * SEK total. So: pass `record.currency` whenever the record has one, or format
 * the kronor twin (`total_sek` / `amount_sek`). Journal entry line amounts are
 * always SEK already (lib/bookkeeping/ledger-line-amount.ts).
 *
 * scripts/checks/format-currency-sek-label.mjs fails CI on a new single-argument
 * call whose value is read off a record the same file reads `.currency` from.
 */
export function formatCurrency(
  amount: number,
  currency?: string | null,
  options?: FractionDigitOptions,
): string {
  // A `= 'SEK'` default only covers undefined. `transactions.currency` is a
  // nullable column whose NULL is legacy for the 'SEK' default (see migration
  // 20260726100000), yet the Transaction type declares it required, so a NULL
  // reached Intl unguarded: `currency: null` throws RangeError and a single
  // legacy row blanked the whole transactions list into the error boundary.
  const code = currency || 'SEK'
  const digits = currencyFractionDigits(options)
  try {
    return new Intl.NumberFormat('sv-SE', { style: 'currency', currency: code, ...digits }).format(
      amount,
    )
  } catch {
    // A value that is not a currency code (a webshop plugin wrote the
    // HTML-encoded symbol "&#107;&#114;" into an order's currency) makes Intl
    // throw RangeError, and one such row took the whole Orders page into the
    // error boundary. Formatting is display: show the number and the raw
    // value, never crash the page.
    return `${new Intl.NumberFormat('sv-SE', digits).format(amount)} ${code}`
  }
}

/**
 * An amount in kronor with öre only when it has them: whole kronor without
 * decimals ("12 500 kr"), otherwise both öre digits ("11 250,50 kr"). The
 * collections screens and the kundförlust texts show amounts this way.
 * Pure and client-safe.
 */
export function formatKronor(amount: number): string {
  const ore = roundOre(amount)
  return Number.isInteger(ore)
    ? formatCurrency(ore, 'SEK', { maximumFractionDigits: 0 })
    : formatCurrency(ore, 'SEK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function formatDate(date: Date | string): string {
  // parseISO interprets bare 'yyyy-MM-dd' as local midnight, not UTC midnight.
  // Using new Date() would shift the displayed day by one in timezones west of
  // UTC for bare date strings: that's an off-by-one we don't want for
  // accounting data.
  const d = typeof date === 'string' ? parseISO(date) : date
  // A malformed value (e.g. a 6-digit year fat-fingered into a native
  // <input type="date">, stored by Postgres as year 202403) yields an Invalid
  // Date, and date-fns `format` THROWS a RangeError on that. One bad row must
  // never crash an entire route via the error boundary: degrade to the raw
  // input instead.
  if (!isValid(d)) return INVALID_DATE_PLACEHOLDER
  return formatDateFns(d, 'yyyy-MM-dd')
}

/**
 * True when `s` is a real, in-range calendar date in `YYYY-MM-DD` form.
 *
 * The shape check (4-digit year) is what stops the native <input type="date">
 * 6-digit-year corruption ('202403-02-05'); the parse + range check also
 * rejects impossible dates (2024-13-40) and absurd years. The ONE authoritative
 * date rule shared by the client form and the server-side
 * CreateTransactionSchema, so the two validation layers can never drift.
 *
 * Implementation lives in `lib/invariants/iso-date.ts` alongside the other
 * shared format contracts; re-exported here because this is where callers have
 * always imported it from.
 */
export { isSaneDateString } from '@/lib/invariants/iso-date'

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
 * UI string): same rule as `formatCurrency`. When you need the SEK symbol, use
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
 * (`Math.trunc`) per SFL 22:1, not rounding: use the dedicated SRU formatter
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
 * prompt: e.g. "2026-05-27 (onsdag)".
 *
 * Date granularity (no clock time) is deliberate: the agent system prompt is
 * cached (cache_control ttl=1h) and this string sits inside the cached prefix,
 * so a full timestamp would bust the cache on every request while the value
 * actually changes at most once a day. Stockholm time zone: not the server's
 * UTC: so "idag" is right for Swedish users near midnight, where a UTC date can
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

/** UTC YYYYMMDD stamp (e.g. for archive download filenames). */
export function utcDateStamp(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

/** Resolve after `ms` milliseconds (setTimeout as a promise). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Split `items` into consecutive slices of at most `size` elements. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function getCompanyDisplayName(settings: { company_name?: string | null }): string {
  return settings.company_name?.trim() || ''
}


// Shared FX-rate validator: keeps UI, RPC (>= 100000 / <= 0), and the
// invoices/supplier_invoices CHECK constraints in sync. Single source
// of truth for the 0 < rate < 100000 bound.
export function isValidExchangeRate(rate: number | null | undefined): rate is number {
  return rate != null && rate > 0 && rate < 100000
}

// Run a promise against a wall-clock budget. The underlying work continues to
// completion on the server when the budget elapses: we just stop waiting for
// it. For Anthropic calls that's fine: a slow Opus turn finishing later still
// warms its own cache.
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/**
 * Collapse a possibly multi-line description to one line.
 *
 * Line descriptions may carry line breaks (the editor allows them so the PDF
 * breaks where the user wants). Every consumer that is a single-line field by
 * format (Peppol cbc:Name, journal entry and SIE texts) goes through this.
 */
export function toSingleLine(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}
