import type { AccountingMethod, MomsPeriod } from '@/types'
import { daysBetween } from '@/lib/arkiv/agreements/dates'

/**
 * Arkiv phase 6: the nightly lint. Pure checks over what the archive knows
 * and what the rest of the product believes; each returns findings a person
 * can act on, keyed so a rerun updates rather than repeats. Nothing here
 * changes settings or records: a finding proposes, a person applies.
 */
export type FindingKind = 'settings_mismatch' | 'agreement_ending' | 'agreement_no_counterparty' | 'duplicate_document' | 'document_stuck'
export type FindingSeverity = 'info' | 'warning'
export type FindingSubjectKind = 'company' | 'agreement' | 'document'

export interface FindingDraft {
  kind: FindingKind
  /** Stable per company: `<kind>:<what>`. */
  key: string
  severity: FindingSeverity
  subjectKind: FindingSubjectKind
  subjectId: string | null
  detail: Record<string, unknown>
}

/** The settings a company fact can contradict. */
export interface SettingsSnapshot {
  company_name: string | null
  org_number: string | null
  f_skatt: boolean | null
  vat_registered: boolean | null
  employer_registered: boolean | null
  moms_period: MomsPeriod | null
  accounting_method: AccountingMethod | null
  fiscal_year_start_month: number | null
}

export type SettingsField = keyof SettingsSnapshot

export interface LiveFact {
  id: string
  predicate: string
  value_text: string
  source_document_id: string | null
  sources: Array<{ page?: number | null }> | null
}

interface SettingsRule {
  predicate: string
  field: SettingsField
  /** The settings value the fact implies; undefined when the fact's wording says nothing usable. */
  proposed: (valueText: string) => unknown
  same: (current: unknown, proposed: unknown) => boolean
}

const digits = (s: string) => s.replace(/\D/g, '')
const fold = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const yesNo = (v: string) => (v === 'yes' || v === 'approved' ? true : v === 'no' || v === 'not_approved' ? false : undefined)

export const SETTINGS_RULES: SettingsRule[] = [
  { predicate: 'legal_name', field: 'company_name', proposed: (v) => v.trim(), same: (a, b) => fold(String(a ?? '')) === fold(String(b ?? '')) },
  { predicate: 'org_number', field: 'org_number', proposed: (v) => digits(v), same: (a, b) => digits(String(a ?? '')) === digits(String(b ?? '')) },
  { predicate: 'f_skatt', field: 'f_skatt', proposed: yesNo, same: (a, b) => a === b },
  { predicate: 'vat_registered', field: 'vat_registered', proposed: yesNo, same: (a, b) => a === b },
  { predicate: 'employer_registered', field: 'employer_registered', proposed: yesNo, same: (a, b) => a === b },
  { predicate: 'vat_period', field: 'moms_period', proposed: momsPeriodFromText, same: (a, b) => a === b },
  { predicate: 'vat_method', field: 'accounting_method', proposed: accountingMethodFromText, same: (a, b) => a === b },
  { predicate: 'fiscal_year', field: 'fiscal_year_start_month', proposed: fiscalYearStartMonth, same: (a, b) => a === b },
]

/** "helt beskattningsår", "kvartal", "varje månad": the settings value, or undefined for wording such as "januari 2026". */
export function momsPeriodFromText(text: string): MomsPeriod | undefined {
  const t = text.toLowerCase()
  if (/beskattningsår|helår|yearly|annual|årsvis/.test(t)) return 'yearly'
  if (/kvartal|quarter|tremånader|tre månader/.test(t)) return 'quarterly'
  if (/månad|month/.test(t) && !/tre|three|kvartal/.test(t)) return 'monthly'
  return undefined
}

export function accountingMethodFromText(text: string): AccountingMethod | undefined {
  const t = text.toLowerCase()
  if (/bokslutsmetod|kontantmetod|cash/.test(t)) return 'cash'
  if (/faktureringsmetod|accrual/.test(t)) return 'accrual'
  return undefined
}

/** "0101 - 1231" or "0501-0430": the month the fiscal year starts. */
export function fiscalYearStartMonth(text: string): number | undefined {
  const m = text.match(/(\d{2})(\d{2})\s*[-–]\s*\d{4}/)
  if (!m) return undefined
  const month = Number(m[1])
  return month >= 1 && month <= 12 ? month : undefined
}

export function settingsMismatches(facts: LiveFact[], settings: SettingsSnapshot): FindingDraft[] {
  const out: FindingDraft[] = []
  for (const rule of SETTINGS_RULES) {
    const fact = facts.find((f) => f.predicate === rule.predicate)
    if (!fact) continue
    const proposed = rule.proposed(fact.value_text)
    if (proposed === undefined || proposed === null || proposed === '') continue
    const current = settings[rule.field]
    if (current == null || rule.same(current, proposed)) continue
    out.push({
      kind: 'settings_mismatch',
      key: `settings_mismatch:${rule.field}`,
      severity: 'warning',
      subjectKind: 'company',
      subjectId: null,
      detail: {
        field: rule.field,
        current,
        proposed,
        fact_id: fact.id,
        fact_value: fact.value_text,
        source_document_id: fact.source_document_id,
        page: fact.sources?.[0]?.page ?? null,
      },
    })
  }
  return out
}

export interface AgreementForLint {
  id: string
  title: string
  status: string
  ends_on: string | null
  notice_months: number | null
  counterparty_party_id: string | null
  counterparty_name: string | null
}

/** Days ahead an agreement's end is worth a finding when the notice period is unknown. */
export const ENDING_WITHIN_DAYS = 60

export function agreementFindings(agreements: AgreementForLint[], today: string): FindingDraft[] {
  const out: FindingDraft[] = []
  for (const a of agreements) {
    if (a.status !== 'active') continue
    if (a.ends_on && a.notice_months == null) {
      const days = daysBetween(today, a.ends_on)
      if (days >= 0 && days <= ENDING_WITHIN_DAYS) {
        out.push({
          kind: 'agreement_ending',
          key: `agreement_ending:${a.id}`,
          severity: 'warning',
          subjectKind: 'agreement',
          subjectId: a.id,
          detail: { title: a.title, ends_on: a.ends_on, days },
        })
      }
    }
    if (!a.counterparty_party_id) {
      out.push({
        kind: 'agreement_no_counterparty',
        key: `agreement_no_counterparty:${a.id}`,
        severity: 'info',
        subjectKind: 'agreement',
        subjectId: a.id,
        detail: { title: a.title, counterparty_name: a.counterparty_name },
      })
    }
  }
  return out
}

export interface DocumentContent {
  document_id: string
  file_name: string
  content_sha256: string | null
}

/** Two admitted documents with the same page text: the same file uploaded twice, or a copy of one already in the archive. */
export function duplicateDocuments(documents: DocumentContent[]): FindingDraft[] {
  const groups = new Map<string, DocumentContent[]>()
  for (const d of documents) {
    if (!d.content_sha256) continue
    groups.set(d.content_sha256, [...(groups.get(d.content_sha256) ?? []), d])
  }
  const out: FindingDraft[] = []
  for (const [sha, docs] of groups) {
    if (docs.length < 2) continue
    const sorted = [...docs].sort((a, b) => a.document_id.localeCompare(b.document_id))
    out.push({
      kind: 'duplicate_document',
      key: `duplicate_document:${sha.slice(0, 16)}`,
      severity: 'info',
      subjectKind: 'document',
      subjectId: sorted[0].document_id,
      detail: { document_ids: sorted.map((d) => d.document_id), file_names: sorted.map((d) => d.file_name) },
    })
  }
  return out
}

export interface StuckJob {
  document_id: string
  file_name: string
  kind: string
  last_error: string | null
}

export function stuckDocuments(jobs: StuckJob[]): FindingDraft[] {
  const seen = new Set<string>()
  const out: FindingDraft[] = []
  for (const j of jobs) {
    if (seen.has(j.document_id)) continue
    seen.add(j.document_id)
    out.push({
      kind: 'document_stuck',
      key: `document_stuck:${j.document_id}`,
      severity: 'warning',
      subjectKind: 'document',
      subjectId: j.document_id,
      detail: { file_name: j.file_name, step: j.kind, last_error: j.last_error?.slice(0, 200) ?? null },
    })
  }
  return out
}
