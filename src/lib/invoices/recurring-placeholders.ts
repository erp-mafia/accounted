import { applyPlaceholders } from '@/lib/email/user-text'
import { isoFromParts, lastDayOfMonth, parseIsoDate } from '@/lib/invoices/recurring-run-date'

/**
 * Placeholders a recurring schedule may use in its notes and line
 * descriptions. Substituted when the invoice is spawned (cron or "Skapa
 * faktura nu"), never when the schedule is saved, so "Fakturan avser
 * {månad} {år}" reads differently on every generated faktura.
 *
 * Same {key} syntax and matcher as the invoice email texts
 * (lib/email/user-text.ts applyPlaceholders): case-insensitive, whitespace
 * inside the braces ignored, unknown keys left intact. Swedish keys on
 * purpose: the invoice editor and the email texts already speak Swedish to
 * the user, and the customer never sees the key, only the value.
 */
export const RECURRING_PLACEHOLDER_KEYS = [
  'månad',
  'nästa månad',
  'föregående månad',
  'år',
  'periodstart',
  'periodslut',
  'nästa periodstart',
] as const

/** The keys that only resolve when the schedule has a period_start. */
export const RECURRING_PERIOD_PLACEHOLDER_KEYS = [
  'periodstart',
  'periodslut',
  'nästa periodstart',
] as const

const MONTH_NAMES = {
  sv: [
    'januari', 'februari', 'mars', 'april', 'maj', 'juni',
    'juli', 'augusti', 'september', 'oktober', 'november', 'december',
  ],
  en: [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ],
} as const

export interface RecurringPlaceholderContext {
  /** The generated invoice's date (ISO yyyy-mm-dd): drives {månad} and {år}. */
  runDate: string
  /** First day of the period this invoice covers, or null when the schedule has none. */
  periodStart: string | null | undefined
  intervalMonths: number
  /** Month names follow the customer's invoice language. */
  lang: 'sv' | 'en'
}

// month0 is 0-based, like parseIsoDate / isoFromParts / lastDayOfMonth.
function shiftMonths(iso: string, months: number): { year: number; month0: number; day: number } {
  const parts = parseIsoDate(iso)
  if (!parts) throw new Error(`invalid ISO date: ${iso}`)
  const total = parts.month0 + months
  const year = parts.year + Math.floor(total / 12)
  const month0 = ((total % 12) + 12) % 12
  return { year, month0, day: parts.day }
}

/**
 * period_start one interval later, keeping the stored day and clamping it to
 * the target month's length (Jan 31 + 1 month = Feb 28/29), exactly like the
 * run-date grid does for day_of_month.
 */
export function advancePeriodStart(periodStart: string, intervalMonths: number): string {
  const { year, month0, day } = shiftMonths(periodStart, intervalMonths)
  return isoFromParts(year, month0, Math.min(day, lastDayOfMonth(year, month0)))
}

/** Last day of the period: the day before the next period starts. */
export function periodEndInclusive(periodStart: string, intervalMonths: number): string {
  const next = parseIsoDate(advancePeriodStart(periodStart, intervalMonths))
  if (!next) throw new Error(`invalid period start: ${periodStart}`)
  const d = new Date(Date.UTC(next.year, next.month0, next.day))
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function monthName(month0: number, lang: 'sv' | 'en'): string {
  return MONTH_NAMES[lang][month0]
}

export function buildRecurringPlaceholderValues(ctx: RecurringPlaceholderContext): Record<string, string> {
  const run = parseIsoDate(ctx.runDate)
  if (!run) throw new Error(`invalid run date: ${ctx.runDate}`)
  const current = shiftMonths(ctx.runDate, 0)
  const next = shiftMonths(ctx.runDate, 1)
  const previous = shiftMonths(ctx.runDate, -1)
  const values: Record<string, string> = {
    'månad': monthName(current.month0, ctx.lang),
    'nästa månad': monthName(next.month0, ctx.lang),
    'föregående månad': monthName(previous.month0, ctx.lang),
    'år': String(run.year),
  }
  if (ctx.periodStart) {
    values['periodstart'] = ctx.periodStart
    values['periodslut'] = periodEndInclusive(ctx.periodStart, ctx.intervalMonths)
    values['nästa periodstart'] = advancePeriodStart(ctx.periodStart, ctx.intervalMonths)
  }
  return values
}

/** Substitute into one user text; null/undefined pass through unchanged. */
export function applyRecurringPlaceholders<T extends string | null | undefined>(
  text: T,
  values: Record<string, string>,
): T {
  if (typeof text !== 'string') return text
  return applyPlaceholders(text, values) as T
}

const PERIOD_TOKEN_RE = new RegExp(
  `\\{\\s*(${RECURRING_PERIOD_PLACEHOLDER_KEYS.map((k) => k.replace(/\s+/g, '\\s+')).join('|')})\\s*\\}`,
  'i',
)

/** True when any of the texts uses a period placeholder. */
export function mentionsPeriodPlaceholder(texts: ReadonlyArray<string | null | undefined>): boolean {
  return texts.some((t) => typeof t === 'string' && PERIOD_TOKEN_RE.test(t))
}

/** Swedish, user-facing: shown by the API and the dialog. */
export const PERIOD_PLACEHOLDER_REQUIRES_START_MESSAGE =
  'Ange Periodstart för att kunna använda {periodstart}, {periodslut} och {nästa periodstart}.'

/**
 * Update-side rule: after merging a partial update with the stored row, the
 * texts that will be in effect must not use a period placeholder unless a
 * period_start will be in effect too. Returns the Swedish message to
 * reject with, or null when the update is fine.
 */
export function periodPlaceholderProblem(params: {
  notes: string | null | undefined
  itemDescriptions: ReadonlyArray<string | null | undefined>
  periodStart: string | null | undefined
}): string | null {
  if (params.periodStart) return null
  return mentionsPeriodPlaceholder([params.notes, ...params.itemDescriptions])
    ? PERIOD_PLACEHOLDER_REQUIRES_START_MESSAGE
    : null
}
