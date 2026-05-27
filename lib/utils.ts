import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { format as formatDateFns, parseISO } from "date-fns"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(amount: number, currency: string = 'SEK'): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount)
}

export function formatDate(date: Date | string): string {
  // parseISO interprets bare 'yyyy-MM-dd' as local midnight, not UTC midnight.
  // Using new Date() would shift the displayed day by one in timezones west of
  // UTC for bare date strings — that's an off-by-one we don't want for
  // accounting data.
  const d = typeof date === 'string' ? parseISO(date) : date
  return formatDateFns(d, 'yyyy-MM-dd')
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
