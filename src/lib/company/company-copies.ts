import { format, isValid, parseISO } from 'date-fns'
import { formatDateLong } from '@/lib/utils'
import type { CompanyRole } from '@/types'

/**
 * Telling apart companies a user holds more than once: the copies under one
 * org number that the onboarding stop lists, and the rows of the company
 * switcher that carry the same name. A copy usually shares both its name and
 * its org number with the company it copies, so neither separates them; when
 * each was created does.
 */
export interface CompanyCopy {
  id: string
  /** companies.created_at (ISO timestamp); null when unknown. */
  createdAt: string | null
}

/** How precisely a created line states the moment: the day, or the day and the minute. */
export type CreatedPrecision = 'date' | 'minute'

/** Formats a created timestamp at a precision (formatCreatedMoment in the UI). */
export type CreatedFormatter = (iso: string, precision: CreatedPrecision) => string

function createdMs(iso: string | null): number | null {
  if (!iso) return null
  const d = parseISO(iso)
  return isValid(d) ? d.getTime() : null
}

/**
 * The key two company names collide on: letter case, Unicode composition and
 * runs of whitespace do not make two names different to the eye.
 */
export function companyNameKey(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('sv')
}

/**
 * A defined order for a user's copies of one company: oldest first, a row
 * without a readable created time last, ties by id. The order never depends
 * on what the database happened to return.
 */
export function orderCompanyCopies<T extends CompanyCopy>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const ta = createdMs(a.createdAt)
    const tb = createdMs(b.createdAt)
    if (ta !== tb) {
      if (ta === null) return 1
      if (tb === null) return -1
      return ta - tb
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * The created line of each row, only as precise as it must be to tell the
 * rows apart: the day, or the day and the minute once two rows read the same
 * day. All rows take the same precision so they read alike. A row without a
 * readable created time gets no line.
 */
export function createdLabels(rows: readonly CompanyCopy[], formatAt: CreatedFormatter): Map<string, string> {
  const dated = rows.filter((row): row is CompanyCopy & { createdAt: string } => createdMs(row.createdAt) !== null)
  const days = dated.map((row) => formatAt(row.createdAt, 'date'))
  const daysDiffer = new Set(days).size === days.length
  return new Map(dated.map((row, i) => [row.id, daysDiffer ? days[i] : formatAt(row.createdAt, 'minute')]))
}

/**
 * The created line of every listed company whose name another listed company
 * shares (companyNameKey), told apart within its namesakes (createdLabels).
 * A company with a name of its own gets no line: its name already separates it.
 */
export function sameNameCreatedLabels(
  rows: readonly (CompanyCopy & { name: string })[],
  formatAt: CreatedFormatter,
): Map<string, string> {
  const groups = new Map<string, CompanyCopy[]>()
  for (const row of rows) {
    const key = companyNameKey(row.name)
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }
  const labels = new Map<string, string>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    for (const [id, label] of createdLabels(group, formatAt)) labels.set(id, label)
  }
  return labels
}

/**
 * A created timestamp for a created line: "12 mars 2026", with the clock time
 * ("12 mars 2026 14:05") at minute precision. Local time, like formatDateLong.
 */
export function formatCreatedMoment(iso: string, precision: CreatedPrecision, locale: string): string {
  const day = formatDateLong(iso, locale)
  if (precision === 'date') return day
  const d = parseISO(iso)
  return isValid(d) ? `${day} ${format(d, 'HH:mm')}` : day
}

const ROLE_LABEL_KEY: Record<CompanyRole, `members_role_${CompanyRole}`> = {
  owner: 'members_role_owner',
  admin: 'members_role_admin',
  member: 'members_role_member',
  viewer: 'members_role_viewer',
  invoicer: 'members_role_invoicer',
}

/**
 * The `settings_company` message key that names a company role (the labels
 * of Inställningar > Användare), or null for a value the app does not know:
 * a stored role is never shown as its raw value.
 */
export function companyRoleLabelKey(role: string | null | undefined): `members_role_${CompanyRole}` | null {
  if (!role || !Object.prototype.hasOwnProperty.call(ROLE_LABEL_KEY, role)) return null
  return ROLE_LABEL_KEY[role as CompanyRole]
}
