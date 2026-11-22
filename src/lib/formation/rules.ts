/**
 * The checks verksamt.se and Bolagsverket apply to a cash formation, run
 * on the founder's answers before they ever open the e-service. Each issue
 * names the interview step and field it belongs to and a message code the
 * UI translates (`formation.issues.<code>`). Errors block the package;
 * warnings are shown but never block.
 *
 * Sources (Bolagsverket and verksamt.se steps 1-4, checked 2026-11-19): a board with fewer than three members needs a deputy; a chair only
 * with two or more members; the name says "aktiebolag" or "AB"; the
 * business description names the goods or the field and holds no SNI
 * codes, "bl.a.", "m.m." or "etc."; share capital at least 25,000 kr.
 */

import { expandPersonnummerTo12, validatePersonnummer } from '@/lib/salary/personnummer-format'
import { luhnValidate } from '@/lib/bankgiro/luhn'
import { orgNumberKey } from '@/lib/invariants/org-number'
import {
  type FormationAnswers,
  type FormationParty,
  MAX_FOUNDERS,
  MIN_SHARE_CAPITAL,
  boardMembers,
  deputies,
  founders,
  persons,
} from './answers'

export const STEPS = ['company', 'owners', 'board', 'details'] as const
export type FormationStep = (typeof STEPS)[number]

export interface FormationIssue {
  step: FormationStep
  /** A field path the UI can focus: "names.0", "parties.<id>.personnummer". */
  field: string
  code: string
  severity: 'error' | 'warning'
  params?: Record<string, string | number>
}

const FORBIDDEN_IN_DESCRIPTION = [
  /\bbl\.?\s?a\b\.?/i,
  /\bm\.?\s?m\b\.?/i,
  /\betc\b\.?/i,
  /\bbland annat\b/i,
  /\bmed mera\b/i,
  /\betcetera\b/i,
]

const VAGUE_DESCRIPTIONS = /^(handel|konsultverksamhet|konsulttjänster|konsulting|konsult|tjänster|försäljning|it|it-tjänster|import och export)$/i

export function normaliseDigits(value: string): string {
  return value.replace(/\D/g, '')
}

/** 10 or 12 digits to the 12-digit form; anything else unchanged (and then invalid). */
export function fullNumber(digits: string): string {
  return expandPersonnummerTo12(digits) ?? digits
}

export function isValidOrgNumber(value: string): boolean {
  const key = orgNumberKey(value)
  return key !== null && luhnValidate(key)
}

export function nameHasCompanyWord(name: string): boolean {
  return /\b(ab|aktiebolag|aktiebolaget)\b/i.test(name.trim())
}

export function checkDescription(description: string): Array<{ code: string; severity: 'error' | 'warning' }> {
  const text = description.trim()
  if (text.length === 0) return [{ code: 'description_missing', severity: 'error' }]
  const out: Array<{ code: string; severity: 'error' | 'warning' }> = []
  if (FORBIDDEN_IN_DESCRIPTION.some((re) => re.test(text))) out.push({ code: 'description_forbidden_words', severity: 'error' })
  if (/\b\d{5}\b/.test(text)) out.push({ code: 'description_sni_code', severity: 'error' })
  const bare = text.replace(/[.,;:!]+$/g, '').trim()
  if (VAGUE_DESCRIPTIONS.test(bare)) out.push({ code: 'description_vague', severity: 'error' })
  else if (bare.split(/\s+/).length < 4) out.push({ code: 'description_short', severity: 'warning' })
  return out
}

function partyShareOf(a: FormationAnswers, p: FormationParty): number {
  const total = founders(a).reduce((s, f) => s + f.shares, 0)
  return total > 0 ? p.shares / total : 0
}

export interface BeneficialOwner {
  name: string
  /** Share of votes, 0-100, rounded to one decimal. One share class: votes = capital. */
  percent: number
  /** 'direct' through own shares, 'indirect' through a founding company. */
  via: 'direct' | 'indirect'
  throughCompany?: string
}

/**
 * Beneficial owners as far as the answers show them: anyone holding more
 * than 25 percent of the votes, directly or through a founding company.
 * Close family holdings count together under the law; the interview asks
 * about that in its help text, it cannot see it in the numbers.
 */
export function beneficialOwners(a: FormationAnswers): BeneficialOwner[] {
  const out: BeneficialOwner[] = []
  for (const f of founders(a)) {
    const share = partyShareOf(a, f)
    if (share <= 0.25) continue
    const percent = Math.round(share * 1000) / 10
    if (f.type === 'person') {
      out.push({ name: f.name, percent, via: 'direct' })
    } else {
      for (const name of f.controlledBy.filter((n) => n.trim().length > 0)) {
        out.push({ name, percent, via: 'indirect', throughCompany: f.name })
      }
    }
  }
  return out
}

export function checkAnswers(a: FormationAnswers): FormationIssue[] {
  const issues: FormationIssue[] = []
  const push = (step: FormationStep, field: string, code: string, severity: 'error' | 'warning' = 'error', params?: FormationIssue['params']) =>
    issues.push({ step, field, code, severity, params })

  // --- Company ------------------------------------------------------------
  const names = a.names.map((n) => n.trim())
  if (!names.some((n) => n.length > 0)) push('company', 'names.0', 'name_missing')
  names.forEach((n, i) => {
    if (n.length > 0 && !nameHasCompanyWord(n)) push('company', `names.${i}`, 'name_needs_ab')
  })
  const lowered = names.filter(Boolean).map((n) => n.toLowerCase())
  if (new Set(lowered).size !== lowered.length) push('company', 'names', 'name_duplicate', 'warning')
  if (names.filter(Boolean).length === 1) push('company', 'names', 'name_only_one', 'warning')
  for (const d of checkDescription(a.description)) push('company', 'description', d.code, d.severity)
  if (!a.seat) push('company', 'seat', 'seat_missing')
  if (!a.address.street) push('company', 'address.street', 'address_missing')
  if (!/^\d{5}$/.test(normaliseDigits(a.address.postalCode)) || normaliseDigits(a.address.postalCode) !== a.address.postalCode.replace(/\s/g, ''))
    push('company', 'address.postalCode', 'postal_code_invalid')
  if (!a.address.city) push('company', 'address.city', 'city_missing')

  // --- Owners and capital -------------------------------------------------
  const fs = founders(a)
  if (fs.length === 0) push('owners', 'parties', 'founder_missing')
  if (fs.length > MAX_FOUNDERS) push('owners', 'parties', 'too_many_founders', 'error', { max: MAX_FOUNDERS })
  if (a.capital.amount < MIN_SHARE_CAPITAL) push('owners', 'capital.amount', 'capital_below_minimum', 'error', { min: MIN_SHARE_CAPITAL })
  const subscribed = fs.reduce((s, f) => s + f.shares, 0)
  if (fs.length > 0 && subscribed !== a.capital.shares)
    push('owners', 'capital.shares', 'shares_do_not_add_up', 'error', { subscribed, total: a.capital.shares })

  const seen = new Map<string, string>()
  for (const p of a.parties) {
    const involved = p.shares > 0 || (p.type === 'person' && p.roles.length > 0)
    if (!involved) continue
    const home: FormationStep = p.shares > 0 ? 'owners' : 'board'
    if (!p.name) push(home, `parties.${p.id}.name`, 'party_name_missing')
    if (p.type === 'person') {
      const digits = normaliseDigits(p.personnummer)
      if (!digits && p.personnummerLast4) {
        // Sealed on an earlier save, where it was validated.
      } else if (!digits) push(p.shares > 0 ? 'owners' : 'board', `parties.${p.id}.personnummer`, 'personnummer_missing', 'error', { name: p.name })
      else if (!validatePersonnummer(fullNumber(digits)).valid)
        push(p.shares > 0 ? 'owners' : 'board', `parties.${p.id}.personnummer`, 'personnummer_invalid', 'error', { name: p.name })
      else if (seen.has(fullNumber(digits))) push('owners', `parties.${p.id}.personnummer`, 'personnummer_duplicate', 'error', { name: p.name })
      else seen.set(fullNumber(digits), p.id)
    } else {
      if (!isValidOrgNumber(p.orgNumber)) push('owners', `parties.${p.id}.orgNumber`, 'org_number_invalid', 'error', { name: p.name })
      if (p.signatories.filter((s) => s.trim()).length === 0) push('owners', `parties.${p.id}.signatories`, 'company_signatory_missing', 'error', { name: p.name })
      if (partyShareOf(a, p) > 0.25 && p.controlledBy.filter((s) => s.trim()).length === 0)
        push('owners', `parties.${p.id}.controlledBy`, 'company_controller_missing', 'error', { name: p.name })
    }
  }

  // --- Board --------------------------------------------------------------
  const members = boardMembers(a)
  const deps = deputies(a)
  if (members.length === 0) push('board', 'roles', 'board_member_missing')
  if (members.length > 0 && members.length < 3 && deps.length === 0) push('board', 'roles', 'deputy_required')
  const chairs = persons(a).filter((p) => p.roles.includes('ordforande'))
  if (chairs.length > 1) push('board', 'roles', 'chair_only_one')
  if (chairs.length === 1 && members.length < 2) push('board', 'roles', 'chair_needs_two_members')
  if (chairs.some((c) => !c.roles.includes('ledamot'))) push('board', 'roles', 'chair_must_be_member')
  if (persons(a).some((p) => p.roles.includes('ledamot') && p.roles.includes('suppleant'))) push('board', 'roles', 'member_and_deputy')
  if (persons(a).filter((p) => p.roles.includes('vd')).length > 1) push('board', 'roles', 'vd_only_one')
  if (a.signatoryRule === 'board_or_two' && members.length < 2) push('board', 'signatoryRule', 'signatory_two_needs_two_members')
  if (a.auditor.has && !a.auditor.name) push('board', 'auditor.name', 'auditor_name_missing')

  // --- Details ------------------------------------------------------------
  if (!a.contact.name) push('details', 'contact.name', 'contact_name_missing')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.contact.email)) push('details', 'contact.email', 'contact_email_invalid')
  if (normaliseDigits(a.contact.phone).length < 7) push('details', 'contact.phone', 'contact_phone_invalid')
  if (a.companyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.companyEmail)) push('company', 'companyEmail', 'company_email_invalid')
  if (!a.bank) push('details', 'bank', 'bank_missing', 'warning')

  return issues
}

export function blockingIssues(a: FormationAnswers): FormationIssue[] {
  return checkAnswers(a).filter((i) => i.severity === 'error')
}

export function issuesForStep(issues: FormationIssue[], step: FormationStep): FormationIssue[] {
  return issues.filter((i) => i.step === step)
}
