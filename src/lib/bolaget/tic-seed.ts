/**
 * Roles and firmateckning read from the registry snapshot the company
 * already has (companies.tic_snapshot, the cached TIC profile): no registry
 * call is made. Pure.
 *
 * The snapshot is unvalidated registry JSON whose shape changes outside our
 * migrations, so every field is read defensively and anything unrecognised
 * is left out rather than guessed.
 */
import { ISO_DATE_RE } from '@/lib/invariants'
import { hasLegalForm } from '@/lib/parties/ledger-key'
import type { CompanyRoleKind, PartyKind } from './types'

export interface SeedRole {
  name: string
  kind: PartyKind
  role: CompanyRoleKind
  valid_from: string | null
  valid_to: string | null
  /** The registry's own wording, kept in details. */
  position: string | null
}

/** Registry position (type or Swedish description) to a role. Order matters: the specific before the general. */
const POSITION_RULES: Array<{ test: RegExp; role: CompanyRoleKind | null }> = [
  { test: /vice\s*verkst|deputy\s*ceo|deputyceo|vice\s*vd/i, role: 'vice_vd' },
  { test: /verkst[aä]llande\s*direkt|^ceo$|externalceo|extern\s*vd|^vd$/i, role: 'vd' },
  { test: /ordf[oö]rande|chair/i, role: 'styrelseordforande' },
  { test: /styrelsesuppleant|^suppleant$|deputy\s*board|deputyboardmember/i, role: 'styrelsesuppleant' },
  { test: /huvudansvarig\s*revisor|principal\s*auditor|principalauditor/i, role: 'huvudansvarig_revisor' },
  { test: /revisorssuppleant|deputy\s*auditor|deputyauditor/i, role: 'revisorssuppleant' },
  // A lay auditor (lekmannarevisor) is not one of the roles kept here.
  { test: /lekmannarevisor|lay\s*auditor/i, role: null },
  { test: /revisor|auditor/i, role: 'revisor' },
  { test: /firmatecknare|signatory/i, role: 'sarskild_firmatecknare' },
  { test: /styrelseledamot|^ledamot$|board\s*member|boardmember/i, role: 'styrelseledamot' },
]

export function roleFromPosition(positionType: string | null | undefined, description: string | null | undefined): CompanyRoleKind | null {
  for (const text of [description, positionType]) {
    const t = typeof text === 'string' ? text.trim() : ''
    if (!t) continue
    const rule = POSITION_RULES.find((r) => r.test.test(t))
    if (rule) return rule.role
  }
  return null
}

function isoDay(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const day = value.slice(0, 10)
  return ISO_DATE_RE.test(day) ? day : null
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Whether the snapshot lists any representative, answered or kept from the
 * last answered fetch, named or not (a role a company holds has no person's
 * name). An empty or missing list is nothing to seed the board from: a failed
 * detail call (incompleteSections), a registry without the board yet and a
 * snapshot without the detail calls all look like that.
 */
export function listsRepresentatives(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== 'object') return false
  const reps = (snapshot as { representatives?: unknown }).representatives
  return Array.isArray(reps) && reps.length > 0
}

/** The roles the snapshot names, one per person and role; a row without a name is left out. */
export function rolesFromTicSnapshot(snapshot: unknown): SeedRole[] {
  if (!snapshot || typeof snapshot !== 'object') return []
  const reps = (snapshot as { representatives?: unknown }).representatives
  if (!Array.isArray(reps)) return []
  const out: SeedRole[] = []
  const seen = new Set<string>()
  for (const raw of reps) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const name = textOf(r.name) ?? textOf(r.roleByPersonName) ?? textOf(r.roleByCompanyName)
    if (!name) continue
    const positionType = textOf(r.positionType)
    const positionDescription = textOf(r.positionDescription)
    const role = roleFromPosition(positionType, positionDescription)
    if (!role) continue
    const key = `${name.toLowerCase()}|${role}`
    if (seen.has(key)) continue
    seen.add(key)
    const companyLike = Boolean(textOf(r.roleByCompanyName)) || hasLegalForm(name)
    out.push({
      name,
      kind: companyLike ? 'company' : 'person',
      role,
      valid_from: isoDay(r.positionStart),
      valid_to: isoDay(r.positionEnd),
      position: positionDescription ?? positionType,
    })
  }
  return out
}

/**
 * The firmateckning texts the snapshot names. Bolagsverket's text carries ">"
 * list markers and runs several "Firman tecknas ..." clauses together; each
 * clause becomes its own rule, each once (the same cleaning the settings
 * page's company profile does).
 */
export function signatoryRulesFromTicSnapshot(snapshot: unknown): string[] {
  if (!snapshot || typeof snapshot !== 'object') return []
  const rows = (snapshot as { signatory?: unknown }).signatory
  if (!Array.isArray(rows)) return []
  const out: string[] = []
  for (const row of rows) {
    const description = row && typeof row === 'object' ? textOf((row as { description?: unknown }).description) : null
    if (!description) continue
    const normalised = description.replace(/>/g, ' ').replace(/\s+/g, ' ').trim()
    for (const clause of normalised.split(/(?=Firman tecknas)/g)) {
      const text = clause.trim()
      if (text && !out.includes(text)) out.push(text)
    }
  }
  return out
}
