import { roundOre } from '@/lib/money'
import { activeOn, type GroupRelation, type SecurityKind } from './types'

/**
 * The årsredovisning texts the registers write (pure):
 *
 *   - Ställda säkerheter (ÅRL 5 kap. 14 §, K2 punkt 18.13-18.14): per type,
 *     företagsinteckningar, fastighetsinteckningar, tillgångar med
 *     äganderättsförbehåll, belånade fordringar and andra ställda
 *     säkerheter, each with the mortgage amount or the book value entered.
 *   - Eventualförpliktelser (ÅRL 5 kap. 15 §, K2 punkt 18.15-18.19):
 *     borgensförbindelser always stated (18.16), then the others.
 *   - What was given for group companies is stated apart (ÅRL 5 kap. 16 §).
 *   - Koncernförhållanden: the parent's name, organisation number and säte
 *     from the parent link that holds on the balance date.
 *
 * Only rows that hold on the balance date count. A category without rows
 * answers null, so the note keeps its "Inga." and the narrative free text
 * (arsredovisning_narratives) still overrides whatever is generated here.
 * The type labels are the K2 taxonomy's (se-gen-base StalldaSakerheter*).
 */
export interface SecurityNoteRow {
  kind: SecurityKind
  amount: number | string
  for_group_company: boolean
  valid_from: string | null
  valid_to: string | null
}

export interface GroupLinkNoteRow {
  relation: GroupRelation
  counterparty_name: string
  counterparty_org_number: string | null
  counterparty_registered_office: string | null
  ownership_percent: number | string | null
  valid_from: string | null
  valid_to: string | null
}

export interface RegisterNoteTexts {
  securities_pledged: string | null
  contingent_liabilities: string | null
  parent_company: { name: string; org_number: string | null; city: string | null } | null
}

const PLEDGED_LABELS: ReadonlyArray<[SecurityKind, string]> = [
  ['foretagsinteckning', 'Företagsinteckningar'],
  ['fastighetsinteckning', 'Fastighetsinteckningar'],
  ['aganderattsforbehall', 'Tillgångar med äganderättsförbehåll'],
  ['belanad_fordran', 'Belånade fordringar'],
  ['other_security', 'Andra ställda säkerheter'],
]

const CONTINGENCY_LABELS: ReadonlyArray<[SecurityKind, string]> = [
  ['borgen', 'Borgensförbindelser'],
  ['other_contingency', 'Övriga eventualförpliktelser'],
]

/** Whole kronor with Swedish digit grouping, as the other notes print amounts. */
export function formatNoteKr(amount: number): string {
  return Math.round(amount).toLocaleString('sv-SE')
}

function categoryText(
  rows: SecurityNoteRow[],
  labels: ReadonlyArray<[SecurityKind, string]>,
  totalLabel: string,
): string | null {
  const sums = labels
    .map(([kind, label]) => {
      const ofKind = rows.filter((r) => r.kind === kind)
      return { label, count: ofKind.length, sum: roundOre(ofKind.reduce((acc, r) => acc + Number(r.amount), 0)) }
    })
    .filter((s) => s.count > 0)
  if (sums.length === 0) return null
  const sentences = sums.map((s) => `${s.label} ${formatNoteKr(s.sum)} kr.`)
  const total = roundOre(sums.reduce((acc, s) => acc + s.sum, 0))
  if (sums.length > 1) sentences.push(`${totalLabel} ${formatNoteKr(total)} kr.`)
  const kinds = new Set(labels.map(([kind]) => kind))
  const group = roundOre(rows.filter((r) => kinds.has(r.kind) && r.for_group_company).reduce((acc, r) => acc + Number(r.amount), 0))
  if (group > 0) sentences.push(`Varav till förmån för koncernföretag ${formatNoteKr(group)} kr.`)
  return sentences.join(' ')
}

export function securityNoteTexts(rows: SecurityNoteRow[], balanceDate: string): Pick<RegisterNoteTexts, 'securities_pledged' | 'contingent_liabilities'> {
  const active = rows.filter((r) => activeOn(r, balanceDate))
  return {
    securities_pledged: categoryText(active, PLEDGED_LABELS, 'Summa ställda säkerheter'),
    contingent_liabilities: categoryText(active, CONTINGENCY_LABELS, 'Summa eventualförpliktelser'),
  }
}

/** The parent that holds on the balance date; with two, the larger holding, then the later start. */
export function parentOn(rows: GroupLinkNoteRow[], balanceDate: string): RegisterNoteTexts['parent_company'] {
  const parents = rows
    .filter((r) => r.relation === 'parent' && activeOn(r, balanceDate))
    .sort(
      (a, b) =>
        Number(b.ownership_percent ?? 0) - Number(a.ownership_percent ?? 0) ||
        (b.valid_from ?? '').localeCompare(a.valid_from ?? ''),
    )
  const parent = parents[0]
  if (!parent) return null
  return {
    name: parent.counterparty_name.trim(),
    org_number: parent.counterparty_org_number?.trim() || null,
    city: parent.counterparty_registered_office?.trim() || null,
  }
}

export function registerNoteTexts(
  securities: SecurityNoteRow[],
  groupLinks: GroupLinkNoteRow[],
  balanceDate: string,
): RegisterNoteTexts {
  return { ...securityNoteTexts(securities, balanceDate), parent_company: parentOn(groupLinks, balanceDate) }
}
