import type { AccountingMethod, MomsPeriod } from '@/types'
import { roundOre } from '@/lib/money'
import { daysBetween } from '@/lib/arkiv/agreements/dates'

/**
 * Arkiv phase 6: the nightly lint. Pure checks over what the archive knows
 * and what the rest of the product believes; each returns findings a person
 * can act on, keyed so a rerun updates rather than repeats. Nothing here
 * changes settings or records: a finding proposes, a person applies.
 */
export type FindingKind = 'settings_mismatch' | 'agreement_ending' | 'agreement_no_counterparty' | 'agreement_duplicate' | 'duplicate_document' | 'document_stuck' | 'document_expected'
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
  kind: string
  title: string
  status: string
  starts_on: string | null
  ends_on: string | null
  amount: number | string | null
  principal: number | string | null
  notice_months: number | null
  counterparty_party_id: string | null
  counterparty_name: string | null
}

/** Kinds with parties rather than one counterparty: a shareholders agreement, an employment contract. */
const NO_COUNTERPARTY_KINDS = new Set(['shareholder', 'employment'])

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
    if (!a.counterparty_party_id && !NO_COUNTERPARTY_KINDS.has(a.kind)) {
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
  return [...out, ...duplicateAgreements(agreements)]
}

/** The same contract read from two files (a draft and the signed scan) becomes two agreements with the same kind, counterparty, amount and start. */
export function duplicateAgreements(agreements: AgreementForLint[]): FindingDraft[] {
  const groups = new Map<string, AgreementForLint[]>()
  for (const a of agreements) {
    if (a.status !== 'active') continue
    const who = (a.counterparty_party_id ?? a.counterparty_name ?? '').toLowerCase().trim()
    const money = a.principal ?? a.amount
    if (!who || money == null) continue
    const key = [a.kind, who, Number(money), a.starts_on ?? ''].join('|')
    groups.set(key, [...(groups.get(key) ?? []), a])
  }
  const out: FindingDraft[] = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const sorted = [...group].sort((x, y) => x.id.localeCompare(y.id))
    out.push({
      kind: 'agreement_duplicate',
      key: `agreement_duplicate:${sorted.map((a) => a.id.slice(0, 8)).join('+')}`,
      severity: 'info',
      subjectKind: 'agreement',
      subjectId: sorted[0].id,
      detail: { agreement_ids: sorted.map((a) => a.id), titles: sorted.map((a) => a.title) },
    })
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

/** A posted journal line the expectations read: account, date, side. */
export interface LedgerLine {
  account_number: string
  entry_date: string
  debit: number
  credit: number
}

/**
 * Phase 9: what the books say should exist. A rule names the cost accounts
 * or the balance accounts that prove an agreement of a kind, and how many
 * months of evidence it takes. Money-backed rules only: a single transaction
 * never asks anyone for anything.
 */
export interface ExpectationRule {
  id: string
  expectedType: string
  agreementKind: string
  label: string
  hint: string
  cost?: { from: string; to: string }
  balance?: Array<{ from: string; to: string }>
  minMonths: number
}

export const EXPECTATION_RULES: ExpectationRule[] = [
  {
    id: 'loan',
    expectedType: 'agreement.loan',
    agreementKind: 'loan',
    label: 'Låneavtal',
    hint: 'Skuldebrev eller låneavtal, oftast en PDF från banken eller Almi i mejlen kring utbetalningen.',
    cost: { from: '8410', to: '8419' },
    balance: [
      { from: '2350', to: '2359' },
      { from: '2390', to: '2399' },
      { from: '2840', to: '2849' },
    ],
    minMonths: 3,
  },
  {
    id: 'rent',
    expectedType: 'agreement.rental',
    agreementKind: 'rental',
    label: 'Hyresavtal',
    hint: 'Hyresavtalet, ofta en PDF från hyresvärden eller i mejlen kring inflyttningen.',
    cost: { from: '5010', to: '5019' },
    minMonths: 3,
  },
]

const inRange = (account: string, r: { from: string; to: string }) => account >= r.from && account <= r.to
const monthOf = (d: string) => d.slice(0, 7)
function monthsBack(today: string, n: number): string {
  const d = new Date(`${today}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() - n)
  return d.toISOString().slice(0, 10)
}

/** The last day of the month an ISO date falls in. */
function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

/** The six months up to and including today's, as YYYY-MM. Year and month arithmetic only: a date minus a month overflows on the 29th to the 31st. */
function recentMonths(today: string): string[] {
  const [y, m] = today.slice(0, 7).split('-').map(Number)
  const months: string[] = []
  for (let n = 5; n >= 0; n--) {
    const index = y * 12 + (m - 1) - n
    months.push(`${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`)
  }
  return months
}

/**
 * Months in the window where the rule's balance accounts carry a balance,
 * computed from every line given: a loan paid out a year ago moves nothing
 * for months and is still a loan (the first rollout company: 992 610 kr on
 * 2359, zero balance months under the old movement count).
 */
function monthsWithBalance(lines: LedgerLine[], ranges: Array<{ from: string; to: string }>, today: string): number {
  const onAccounts = lines.filter((l) => ranges.some((r) => inRange(l.account_number, r)))
  if (onAccounts.length === 0) return 0
  let months = 0
  for (const month of recentMonths(today)) {
    const end = monthEnd(month)
    const balance = onAccounts.filter((l) => l.entry_date <= end).reduce((n, l) => n + l.credit - l.debit, 0)
    if (Math.abs(balance) >= 0.01) months++
  }
  return months
}

/** A recurring cost or a standing balance in the last six months with no active agreement of that kind in the archive. */
export function expectedDocuments(lines: LedgerLine[], agreements: AgreementForLint[], today: string): FindingDraft[] {
  const since = monthsBack(today, 6)
  const recent = lines.filter((l) => l.entry_date >= since)
  const drafts: FindingDraft[] = []
  for (const rule of EXPECTATION_RULES) {
    if (agreements.some((a) => a.kind === rule.agreementKind && a.status === 'active')) continue
    const costLines = rule.cost ? recent.filter((l) => inRange(l.account_number, rule.cost as { from: string; to: string }) && l.debit > 0) : []
    const costMonths = new Set(costLines.map((l) => monthOf(l.entry_date)))
    const costTotal = costLines.reduce((n, l) => n + l.debit, 0)
    const balanceMonths = rule.balance ? monthsWithBalance(lines, rule.balance, today) : 0
    const balanceLines = rule.balance ? lines.filter((l) => (rule.balance ?? []).some((r) => inRange(l.account_number, r))) : []
    if (costMonths.size < rule.minMonths && balanceMonths < rule.minMonths) continue
    drafts.push({
      kind: 'document_expected',
      key: `document_expected:${rule.id}`,
      severity: 'info',
      subjectKind: 'company',
      subjectId: null,
      detail: {
        rule: rule.id,
        expected_type: rule.expectedType,
        evidence: {
          cost_months: costMonths.size,
          cost_total: roundOre(costTotal),
          balance_months: balanceMonths,
          accounts: [...new Set([...costLines, ...balanceLines].map((l) => l.account_number))].sort(),
          since,
        },
      },
    })
  }
  return drafts
}
