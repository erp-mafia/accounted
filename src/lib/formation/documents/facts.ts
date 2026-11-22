/**
 * Values derived from the answers that several documents print the same
 * way: the bolagsordning's limits, the share number ranges, the fiscal
 * year, role and bank labels, and the e-service fees.
 *
 * Sources (checked 2026-11-19): Bolagsverket fees page 2026-07-20
 * (2,400 kr registration, 250 kr beneficial owner, e-service); ABL 3 kap.
 * 1 § (min capital at least a quarter of max, share counts in the same
 * proportion); ABL 8 kap. 3 § (a board with fewer than three members has
 * a deputy); verksamt.se step 4 prefills ledamöter 1 to 10 and suppleanter
 * 0 to 10; Bolagsverket "Räkenskapsår": twelve months from the first day
 * of a month, the first year starts at registration, BFL 3 kap. 3 § lets
 * it run at most eighteen months.
 */

import { firstFiscalYear as firstYearFromRegistration } from '../fiscal-year'
import type { BankId, FormationAnswers, FormationParty, RoleKey } from '../answers'
import { boardMembers, deputies, founders } from '../answers'

export const REGISTRATION_FEE = 2_400
export const BENEFICIAL_OWNER_FEE = 250

export interface BoardLimits {
  membersMin: number
  membersMax: number
  deputiesMin: number
  deputiesMax: number
}

export function boardLimits(a: FormationAnswers): BoardLimits {
  const members = boardMembers(a).length
  const deps = deputies(a).length
  return {
    membersMin: 1,
    membersMax: Math.max(10, members),
    // With one or two members the law requires a deputy, so the floor follows.
    deputiesMin: members < 3 ? 1 : 0,
    deputiesMax: Math.max(10, deps),
  }
}

export interface CapitalLimits {
  capitalMin: number
  capitalMax: number
  sharesMin: number
  sharesMax: number
}

/** The founding capital as the floor and four times it as the ceiling, same for shares. */
export function capitalLimits(a: FormationAnswers): CapitalLimits {
  return {
    capitalMin: a.capital.amount,
    capitalMax: a.capital.amount * 4,
    sharesMin: a.capital.shares,
    sharesMax: a.capital.shares * 4,
  }
}

export interface ShareRange {
  party: FormationParty
  from: number
  to: number
  count: number
}

/** Share numbers in party order starting at 1, founders only. */
export function shareRanges(a: FormationAnswers): ShareRange[] {
  const out: ShareRange[] = []
  let next = 1
  for (const party of founders(a)) {
    out.push({ party, from: next, to: next + party.shares - 1, count: party.shares })
    next += party.shares
  }
  return out
}

export function rangeText(r: { from: number; to: number }): string {
  return r.from === r.to ? String(r.from) : `${r.from}-${r.to}`
}

/** A founder's share of all subscribed shares, 0-100. */
export function ownershipPercent(a: FormationAnswers, p: FormationParty): number {
  const total = founders(a).reduce((s, f) => s + f.shares, 0)
  return total > 0 ? (p.shares / total) * 100 : 0
}

// --- Fiscal year -------------------------------------------------------------

export const MONTHS = [
  'januari',
  'februari',
  'mars',
  'april',
  'maj',
  'juni',
  'juli',
  'augusti',
  'september',
  'oktober',
  'november',
  'december',
] as const

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function lastDayText(month: number): string {
  // February's last day moves with leap years, so it is named, not numbered.
  if (month === 2) return 'den sista februari'
  return `den ${daysInMonth(2025, month)} ${MONTHS[month - 1]}`
}

/** "från den 1 januari till den 31 december" */
export function fiscalYearText(startMonth: number): string {
  const endMonth = startMonth === 1 ? 12 : startMonth - 1
  return `från den 1 ${MONTHS[startMonth - 1]} till ${lastDayText(endMonth)}`
}

/** "1 januari till 31 december", for form fields. */
export function fiscalYearShort(startMonth: number): string {
  return fiscalYearText(startMonth).replace(/^från den /, '').replace(' till den ', ' till ')
}

export interface FirstFiscalYear {
  from: string
  to: string
  /** The founder asked for a longer first year and it fits within 18 months. */
  extended: boolean
  /** The founder asked for a longer first year but it would exceed 18 months. */
  extensionRefused: boolean
}

/**
 * The first fiscal year for a company registered on `registrationDate`:
 * from that day to the end of the fiscal year it falls in, or to the end of
 * the next one when the founder chose a longer first year and the result
 * is at most eighteen months.
 */
export function firstFiscalYear(a: FormationAnswers, registrationDate: string): FirstFiscalYear {
  // One definition of the first year (lib/formation/fiscal-year.ts, which
  // counts the 18 months with exceedsFiscalYearCap); the builders add only
  // whether a longer year was asked for but did not fit.
  const year = firstYearFromRegistration(registrationDate, a.fiscalYearStartMonth, a.extendFirstYear)
  return { from: year.start, to: year.end, extended: year.extended, extensionRefused: a.extendFirstYear && !year.extended }
}

/** "den 31 december": the last day of a fiscal year that starts in `startMonth`. */
export function fiscalYearEndText(startMonth: number): string {
  return lastDayText(startMonth === 1 ? 12 : startMonth - 1)
}

/** The first fiscal year in words, before the registration date is known. */
export function firstFiscalYearSentence(a: FormationAnswers): string {
  const base = 'Det första räkenskapsåret börjar den dag Bolagsverket registrerar bolaget'
  const end = fiscalYearEndText(a.fiscalYearStartMonth)
  if (a.extendFirstYear) return `${base} och förlängs till ${end} året därpå, om det första året då blir högst 18 månader.`
  return `${base} och slutar ${end} närmast efter registreringen.`
}

/** The same for a form field: "Från registreringen till och med den 31 december närmast efter". */
export function firstFiscalYearShort(a: FormationAnswers): string {
  const end = fiscalYearEndText(a.fiscalYearStartMonth)
  if (a.extendFirstYear) return `Förlängt: från registreringen till och med ${end} året därpå (högst 18 månader)`
  return `Från registreringen till och med ${end} närmast efter`
}

// --- Labels ------------------------------------------------------------------

/** The role checkboxes in verksamt.se step 4. */
export const ROLE_LABEL: Record<RoleKey, string> = {
  ledamot: 'Styrelseledamot',
  suppleant: 'Styrelsesuppleant',
  ordforande: 'Styrelseordförande',
  vd: 'VD',
}

const ROLE_ORDER: RoleKey[] = ['ledamot', 'ordforande', 'suppleant', 'vd']

/** "Stiftare, Styrelseledamot, VD" in the e-service's order. */
export function roleLabels(p: FormationParty): string[] {
  const out: string[] = []
  if (p.shares > 0) out.push('Stiftare')
  if (p.type === 'person') for (const r of ROLE_ORDER) if (p.roles.includes(r)) out.push(ROLE_LABEL[r])
  return out
}

export const BANK_LABEL: Record<BankId, string> = {
  seb: 'SEB',
  swedbank: 'Swedbank',
  handelsbanken: 'Handelsbanken',
  nordea: 'Nordea',
  danske: 'Danske Bank',
  lunar: 'Lunar',
  svea: 'Svea Bank',
  other: 'Er bank',
}

export function bankLabel(a: FormationAnswers): string | null {
  return a.bank ? BANK_LABEL[a.bank] : null
}
