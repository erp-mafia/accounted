/**
 * Formatting shared by the formation document builders: kronor, counts,
 * personnummer, organisation numbers and the blank line printed where a
 * value is not known yet. Pure string logic, so the builders stay pure.
 */

import { maskPersonnummer } from '@/lib/salary/personnummer-format'
import { roundOre } from '@/lib/money'
import { formatPersonnummer } from '@/lib/salary/personnummer-format'
import { formatOrgNumberDisplay } from '@/lib/invariants/org-number'
import { type FormationAnswers, type FormationParty, primaryName } from '../answers'
import type { DocumentContext } from './context'

/** Printed where a value is unknown, so the founder fills it in by hand. */
export const BLANK = '____________'

const WHOLE = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 })
const ORE = new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const ONE_DECIMAL = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 })

/**
 * sv-SE groups digits with a no-break space and writes negatives with
 * U+2212; both become their plain ASCII forms so every renderer and font
 * prints them.
 */
function plain(text: string): string {
  return text.replace(/[\u00a0\u202f]/g, ' ').replace(/\u2212/g, '-')
}

/** "25 000 kr", or "33,33 kr" when the amount has öre. */
export function kr(amount: number): string {
  const value = roundOre(amount)
  const fmt = Number.isInteger(value) ? WHOLE : ORE
  return `${plain(fmt.format(value))} kr`
}

/** "25 000" without the unit, for the "lägst ... kronor" sentences. */
export function kronor(amount: number): string {
  return plain(WHOLE.format(Math.round(amount)))
}

/** "1 000" */
export function count(n: number): string {
  return plain(WHOLE.format(n))
}

/** "33,3 procent" from a 0-100 value. */
export function percentText(value: number): string {
  return `${plain(ONE_DECIMAL.format(Math.round(value * 10) / 10))} procent`
}

export function orBlank(value: string | null | undefined): string {
  const text = (value ?? '').trim()
  return text.length > 0 ? text : BLANK
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, '')
}

/** ÅÅÅÅMMDD-NNNN for a 12-digit personnummer, the blank line when missing. */
export function displayPersonnummer(value: string | null | undefined): string {
  const digits = digitsOf(value ?? '')
  if (digits.length === 12) return formatPersonnummer(digits)
  return orBlank(value)
}

/**
 * Only the last four digits stay visible: XXXXXXXX-NNNN. Used where the
 * text leaves Accounted (bolaget.md for the founder's own AI assistant).
 */
export function maskedPersonnummer(value: string | null | undefined): string {
  const digits = digitsOf(value ?? '')
  if (digits.length === 0) return BLANK
  // The repository's own mask (lib/salary): the birth date shown, the last four hidden.
  return maskPersonnummer(digits)
}

/** NNNNNN-NNNN, the blank line when missing. */
export function displayOrgNumber(value: string | null | undefined): string {
  const text = (value ?? '').trim()
  if (!text) return BLANK
  return formatOrgNumberDisplay(text)
}

/** Personnummer for a person, organisation number for a founding company. */
export function partyIdNumber(p: FormationParty): string {
  return p.type === 'person' ? displayPersonnummer(p.personnummer) : displayOrgNumber(p.orgNumber)
}

export function partyName(p: FormationParty): string {
  return orBlank(p.name)
}

/** The registered name once known, else the first name proposal, else a blank. */
export function companyName(a: FormationAnswers, ctx: DocumentContext): string {
  const registered = ctx.registration?.name?.trim()
  if (registered) return registered
  return a.names.some((n) => n.trim().length > 0) ? primaryName(a) : BLANK
}

/** "Testbolaget AB under bildande" before registration, the name after. */
export function companyNameWithStatus(a: FormationAnswers, ctx: DocumentContext): string {
  const name = companyName(a, ctx)
  return ctx.registration ? name : `${name} under bildande`
}

/** The organisation number once registered, else "under bildande". */
export function companyOrgNumber(ctx: DocumentContext): string {
  return ctx.registration ? displayOrgNumber(ctx.registration.orgNumber) : 'Under bildande'
}

/** The name proposals that are filled in, in the order Bolagsverket tries them. */
export function nameProposals(a: FormationAnswers): string[] {
  return a.names.map((n) => n.trim()).filter((n) => n.length > 0)
}

/** The rest of the verksamhet sentence, without a trailing full stop. */
export function descriptionText(a: FormationAnswers): string {
  const text = a.description.trim().replace(/[.\s]+$/, '')
  return text.length > 0 ? text : BLANK
}

/** "Aktiebolaget ska bedriva <description>." */
export function businessSentence(a: FormationAnswers): string {
  return `Aktiebolaget ska bedriva ${descriptionText(a)}.`
}

/** "A", "A och B", "A, B och C" */
export function joinNames(names: string[]): string {
  if (names.length === 0) return BLANK
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} och ${names[names.length - 1]}`
}

export function subtitleFor(a: FormationAnswers, ctx: DocumentContext): string {
  return `${companyNameWithStatus(a, ctx)}, ${ctx.today}`
}
