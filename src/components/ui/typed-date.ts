/**
 * The typed date field behind `<Input type="date">` (crm#1954).
 *
 * A native date input cannot be typed the way people who come from Fortnox or
 * Visma type a date: in Chromium (Chrome, Edge) the segments follow the
 * browser's language, the year takes six digits before it moves on (so
 * `20261023` lands as year 202610) and `261023` or `23/10` are not accepted at
 * all. The shared Input therefore renders a text field for `type="date"` and
 * reads what was typed here. Callers keep receiving only a complete
 * `YYYY-MM-DD` date, or `''`, in `e.target.value`.
 */
import { stockholmYearMonth } from '@/lib/dates/iso'
import { ISO_DATE_RE, isSaneDateString } from '@/lib/invariants/iso-date'

const pad = (n: number, width: number) => String(n).padStart(width, '0')

/** `2026-10-23`, `2026/10/23`, `2026.10.23`, and single-digit month or day (`2026-1-5`). */
const ISO_LIKE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/
/** `20261023` */
const COMPACT_LONG = /^(\d{4})(\d{2})(\d{2})$/
/** `261023`: the year is 2000 + YY. */
const COMPACT_SHORT = /^(\d{2})(\d{2})(\d{2})$/
/** `23/10` or `5/1`: day first, this year in Sweden. */
const DAY_MONTH = /^(\d{1,2})\/(\d{1,2})$/

/**
 * Reads a typed date. Returns the date as `YYYY-MM-DD`, `''` for an empty
 * field, or `null` when the text is not a real date (`2026-02-30`, `23/13`, a
 * half-typed `2026-10`) or its year is outside 1900-2100 (the same rule the
 * server applies to a typed date, `isSaneDateString`).
 */
export function parseTypedDate(text: string, now: Date = new Date()): string | null {
  const s = text.trim()
  if (s === '') return ''
  let parts: [number, number, number] | null = null
  let m: RegExpExecArray | null
  if ((m = ISO_LIKE.exec(s)) || (m = COMPACT_LONG.exec(s))) {
    parts = [Number(m[1]), Number(m[2]), Number(m[3])]
  } else if ((m = COMPACT_SHORT.exec(s))) {
    parts = [2000 + Number(m[1]), Number(m[2]), Number(m[3])]
  } else if ((m = DAY_MONTH.exec(s))) {
    parts = [stockholmYearMonth(now).year, Number(m[2]), Number(m[1])]
  }
  if (!parts) return null
  const iso = `${pad(parts[0], 4)}-${pad(parts[1], 2)}-${pad(parts[2], 2)}`
  return isSaneDateString(iso) ? iso : null
}

/** What leaving the field (blur, Enter) settles on. */
export interface SettledDate {
  /** The date the caller holds afterwards: `YYYY-MM-DD`, or `''` when the text is empty or not a date. */
  date: string
  /** What the field shows: the date in `YYYY-MM-DD`, or the text as typed when it is not a date. */
  text: string
  /** The text is not a date: the field shows it in the invalid state so it can be corrected. */
  invalid: boolean
  /** The caller has not heard this date yet and gets a change event. */
  emit: boolean
}

/**
 * Settles the typed text against the date the caller last heard. A text that
 * is not a date clears the caller's value, as a native date input does with an
 * incomplete date, so a form never saves a date other than the one on screen.
 */
export function settleTypedDate(text: string, heard: string, now: Date = new Date()): SettledDate {
  const date = parseTypedDate(text, now)
  if (date === null) return { date: '', text, invalid: true, emit: heard !== '' }
  return { date, text: date, invalid: false, emit: date !== heard }
}

/**
 * The date a keystroke hands the caller right away: as soon as the text reads
 * as a date the caller has not heard, like a native date input does while its
 * segments are typed. A half-typed text says nothing until the field is left.
 */
export function liveTypedDate(text: string, heard: string, now: Date = new Date()): string | null {
  const date = parseTypedDate(text, now)
  return date !== null && date !== heard ? date : null
}

/** Whether a date falls before `min` or after `max` (both `YYYY-MM-DD`; anything else is ignored). */
export function dateRangeIssue(date: string, min?: unknown, max?: unknown): 'early' | 'late' | null {
  if (!ISO_DATE_RE.test(date)) return null
  if (typeof min === 'string' && ISO_DATE_RE.test(min) && date < min) return 'early'
  if (typeof max === 'string' && ISO_DATE_RE.test(max) && date > max) return 'late'
  return null
}

/**
 * The event target a date field hands its caller: the field itself, except
 * that `value` is the settled date rather than the text still being typed.
 * `type` reads as undefined because react-hook-form's `register()` re-reads a
 * typed target's DOM value (the half-typed text); without a type it takes the
 * event's value instead.
 */
export function dateTarget<T extends object>(field: T, value: string): T {
  return new Proxy(field, {
    get(target, key) {
      if (key === 'value') return value
      if (key === 'type') return undefined
      const v: unknown = Reflect.get(target, key, target)
      return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v
    },
  })
}

/** A copy of a React event with another type and target, keeping its methods (`preventDefault`, ...). */
export function retargetEvent<E extends object>(source: E, type: string, target: object): E {
  return Object.assign(Object.create(Object.getPrototypeOf(source) as object) as E, source, {
    type,
    target,
    currentTarget: target,
  })
}

/**
 * Callers style `<Input type="date">` as one box. The date field is a box
 * around the text field and its calendar button, so the classes that place
 * the box in the page (width, flex and grid sizing, margins, display,
 * position) move to the box and the rest stay on the text field.
 */
const BOX_UTILITY =
  /^-?(?:(?:w|min-w|max-w|flex|basis|grow|shrink|order|self|justify-self|place-self|col|row|m|mx|my|mt|mr|mb|ml|ms|me|top|right|bottom|left|z)(?:-|$)|inset(?:-[xy])?-(?!ring|shadow)|(?:hidden|block|inline-block|inline|static|fixed|absolute|relative|sticky)$)/

export function splitDateFieldClassName(className: string | undefined): { box: string; field: string } {
  const box: string[] = []
  const field: string[] = []
  for (const token of (className ?? '').split(/\s+/)) {
    if (!token) continue
    // The utility after any variants (`sm:`, `pointer-coarse:`), without the important mark.
    const utility = token.replace(/^(?:[^:[\]]*(?:\[[^\]]*\])?[^:[\]]*:)+/, '').replace(/^!|!$/g, '')
    ;(BOX_UTILITY.test(utility) ? box : field).push(token)
  }
  return { box: box.join(' '), field: field.join(' ') }
}
