import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { getCompanyGraph, markCompanyGraphStale } from '@/lib/arkiv/graph/snapshot'
import { listLiveFacts, recordFact, revertFact } from './store'

/**
 * Company facts from the sources of record that need no document: the
 * ledger (what was paid and earned, what stands on the balance sheet), the
 * registers (employees, bank connections, the company settings) and the
 * Bolagsverket snapshot. The brain (dev_docs/arkiv_plan.md, the company
 * profile plan of 2026-09-21) reads facts, not prose, and most companies
 * have a ledger long before they upload an agreement.
 *
 * Every fact here is recomputed on each run and recorded through
 * record_company_fact, which keeps the same value in place and supersedes a
 * changed one, so a nightly run leaves no churn. Baselines (typical monthly
 * cost per account) are what an anomaly is measured against. A fact a
 * document or a person already established is left alone: the registry and
 * the ledger rank below them for the terms of the company.
 */
export interface LedgerLine {
  account_number: string
  entry_date: string
  debit: number
  credit: number
}

export interface CompanyFactInputs {
  today: string
  /** Posted lines of the last twelve months on the accounts read here, plus every balance-account line. */
  lines: LedgerLine[]
  accountName: (account: string) => string | null
  activeEmployees: number | null
  accountingMethod: 'accrual' | 'cash' | null
  fiscalYearStartMonth: number | null
  tic: TicSnapshot | null
  bankConnections: Array<{ bank_name: string | null; created_at: string }>
  /** Counterparties by money moved in the period, from the company graph; ref is the graph node the fact points back at. */
  counterparties: Array<{ name: string; flow: number; ref?: string }>
  /** Predicates a document or a person already holds a live fact for: the registry does not overwrite them. */
  heldByHigherTrust: Set<string>
}

export interface TicSnapshot {
  sniCodes?: Array<{ code?: string; name?: string }> | null
  beneficialOwners?: Array<{ name?: string; extentDescription?: string }> | null
  employeeRange?: string | null
  registration?: { vat?: boolean; fTax?: boolean; payroll?: boolean } | null
  board?: unknown
}

export interface FactDraft {
  predicate: string
  value: unknown
  valueText: string
  sourceKind: 'ledger' | 'registry'
  singleValued: boolean
  evidence: Record<string, unknown>
}

const inRange = (account: string, from: string, to: string) => account >= from && account <= to
const monthOf = (d: string) => d.slice(0, 7)

/** Twelve months back from today, as YYYY-MM-DD. */
export function periodStart(today: string): string {
  const [y, m, d] = today.split('-').map(Number)
  const date = new Date(Date.UTC(y - 1, m - 1, d))
  return date.toISOString().slice(0, 10)
}

const kr = (n: number) => `${Math.round(n).toLocaleString('sv-SE').replace(/ /g, ' ')} kr`

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Guarded predicates: written from the registry only when no document or person holds them. */
const REGISTRY_GUARDED = new Set(['fiscal_year', 'board'])

export const TOP_COUNTERPARTIES = 5
export const BASELINE_MIN_MONTHS = 3

/** The facts, pure: what the inputs say, nothing about the database. */
export function companyFactsFrom(inputs: CompanyFactInputs): FactDraft[] {
  const from = periodStart(inputs.today)
  const recent = inputs.lines.filter((l) => l.entry_date >= from && l.entry_date <= inputs.today)
  const period = { from, to: inputs.today }
  const drafts: FactDraft[] = []
  const add = (draft: FactDraft) => {
    if (draft.sourceKind === 'registry' && REGISTRY_GUARDED.has(draft.predicate) && inputs.heldByHigherTrust.has(draft.predicate)) return
    drafts.push(draft)
  }

  // Salaries: the months that had any, averaged. 7000-7399 is gross pay in BAS; the fees on 75xx are not pay.
  const salaryByMonth = new Map<string, number>()
  for (const l of recent) if (inRange(l.account_number, '7000', '7399') && l.debit > 0) salaryByMonth.set(monthOf(l.entry_date), (salaryByMonth.get(monthOf(l.entry_date)) ?? 0) + l.debit)
  if (salaryByMonth.size > 0) {
    const months = [...salaryByMonth.values()]
    const avg = roundOre(months.reduce((n, v) => n + v, 0) / months.length)
    add({ predicate: 'monthly_salary_cost', value: avg, valueText: `${kr(avg)}/mån (${months.length} mån med lön)`, sourceKind: 'ledger', singleValued: true, evidence: { accounts: '7000-7399', months: months.length, ...period } })
  }

  // Revenue: the 3xxx accounts, net of credit notes.
  const revenue = recent.filter((l) => inRange(l.account_number, '3000', '3799')).reduce((n, l) => n + l.credit - l.debit, 0)
  if (revenue !== 0) add({ predicate: 'revenue_12m', value: roundOre(revenue), valueText: `${kr(revenue)} (12 mån)`, sourceKind: 'ledger', singleValued: true, evidence: { accounts: '3000-3799', ...period } })

  // Loans: what stands on the balance sheet, from every posting. 2310-2399 is every long-term loan in BAS
  // (bonds and convertibles, overdrafts, credit institutions, group and other loans); 2840-2849 the short-term ones.
  const byLoanAccount = new Map<string, number>()
  for (const l of inputs.lines) {
    if (!inRange(l.account_number, '2310', '2399') && !inRange(l.account_number, '2840', '2849')) continue
    byLoanAccount.set(l.account_number, (byLoanAccount.get(l.account_number) ?? 0) + l.credit - l.debit)
  }
  const loanBalance = [...byLoanAccount.values()].reduce((n, v) => n + v, 0)
  if (Math.abs(loanBalance) >= 1) {
    const accounts = [...byLoanAccount.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([account, balance]) => ({ account, balance: roundOre(balance) }))
    const breakdown = accounts.length > 1 ? accounts.map((a) => `${a.account}: ${kr(a.balance)}`).join('; ') : accounts[0].account
    add({ predicate: 'loan_balance', value: roundOre(loanBalance), valueText: `${kr(loanBalance)} (${breakdown})`, sourceKind: 'ledger', singleValued: true, evidence: { accounts, as_of: inputs.today } })
  }

  // Baselines: the typical month per cost account with enough months to say so.
  const costByAccount = new Map<string, Map<string, number>>()
  for (const l of recent) {
    if (!inRange(l.account_number, '4000', '7999') || l.debit <= 0) continue
    const months = costByAccount.get(l.account_number) ?? new Map<string, number>()
    months.set(monthOf(l.entry_date), (months.get(monthOf(l.entry_date)) ?? 0) + l.debit)
    costByAccount.set(l.account_number, months)
  }
  for (const [account, months] of [...costByAccount.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (months.size < BASELINE_MIN_MONTHS) continue
    const values = [...months.values()]
    const mid = roundOre(median(values))
    const low = roundOre(Math.min(...values))
    const high = roundOre(Math.max(...values))
    const name = inputs.accountName(account)
    const label = name ? `${account} ${name}` : account
    add({
      predicate: 'monthly_cost_baseline',
      value: { account, name, median: mid, low, high, months: months.size },
      valueText: `${label}: typiskt ${kr(mid)}/mån (${kr(low)} till ${kr(high)}, ${months.size} mån)`,
      sourceKind: 'ledger',
      singleValued: false,
      evidence: { account, months: months.size, ...period },
    })
  }

  // Counterparties: who the money moves with, from the graph's flows.
  for (const c of [...inputs.counterparties].filter((c) => c.flow > 0).sort((a, b) => b.flow - a.flow).slice(0, TOP_COUNTERPARTIES)) {
    add({ predicate: 'top_counterparty', value: { name: c.name, flow: roundOre(c.flow) }, valueText: `${c.name}: ${kr(c.flow)} (12 mån)`, sourceKind: 'ledger', singleValued: false, evidence: { ...(c.ref ? { node: c.ref } : {}), ...period } })
  }

  // Registers.
  if (inputs.activeEmployees != null) {
    add({ predicate: 'employee_count', value: inputs.activeEmployees, valueText: `${inputs.activeEmployees} aktiva anställda i lönesystemet`, sourceKind: 'registry', singleValued: true, evidence: { register: 'employees', as_of: inputs.today } })
  }
  if (inputs.accountingMethod) {
    const text = inputs.accountingMethod === 'cash' ? 'Bokslutsmetoden (kontantmetoden), enligt inställningarna' : 'Faktureringsmetoden, enligt inställningarna'
    add({ predicate: 'accounting_method', value: inputs.accountingMethod, valueText: text, sourceKind: 'registry', singleValued: true, evidence: { register: 'company_settings' } })
  }
  if (inputs.fiscalYearStartMonth) {
    const start = String(inputs.fiscalYearStartMonth).padStart(2, '0')
    const end = String(((inputs.fiscalYearStartMonth + 10) % 12) + 1).padStart(2, '0')
    add({ predicate: 'fiscal_year', value: `${start}01 - ${end}${end === '02' ? '28' : ['04', '06', '09', '11'].includes(end) ? '30' : '31'}`, valueText: `${start}01 - ${end}${end === '02' ? '28' : ['04', '06', '09', '11'].includes(end) ? '30' : '31'} (enligt inställningarna)`, sourceKind: 'registry', singleValued: true, evidence: { register: 'company_settings' } })
  }
  for (const b of inputs.bankConnections) {
    if (!b.bank_name) continue
    add({ predicate: 'bank_connection', value: { bank: b.bank_name, since: b.created_at.slice(0, 10) }, valueText: `${b.bank_name}, ansluten ${b.created_at.slice(0, 10)}`, sourceKind: 'registry', singleValued: false, evidence: { register: 'bank_connections' } })
  }

  // The Bolagsverket snapshot: industry, owners, and what the registry says about employees (often stale, kept as what the registry says).
  const tic = inputs.tic
  if (tic?.sniCodes?.length) {
    const codes = tic.sniCodes.filter((c) => c.code).map((c) => `${c.code}${c.name ? ` ${c.name}` : ''}`)
    if (codes.length) add({ predicate: 'sni_codes', value: tic.sniCodes.map((c) => c.code), valueText: codes.join('; '), sourceKind: 'registry', singleValued: true, evidence: { register: 'bolagsverket' } })
  }
  if (tic?.beneficialOwners?.length) {
    const owners = tic.beneficialOwners.filter((o) => o.name).map((o) => `${o.name}${o.extentDescription ? ` (${o.extentDescription})` : ''}`)
    if (owners.length) add({ predicate: 'beneficial_owners', value: owners, valueText: owners.join('; '), sourceKind: 'registry', singleValued: true, evidence: { register: 'bolagsverket' } })
  }
  if (tic?.employeeRange) {
    add({ predicate: 'employee_range_registry', value: tic.employeeRange, valueText: `${tic.employeeRange} (enligt registret)`, sourceKind: 'registry', singleValued: true, evidence: { register: 'bolagsverket' } })
  }
  return drafts
}

export interface DeriveCompanyFactsOutcome {
  recorded: number
  /** Many-valued facts of an earlier run that this run no longer derives, deprecated. */
  retired: number
  predicates: string[]
}

/**
 * The many-valued predicates this derivation owns. A single-valued fact is
 * superseded by record_company_fact when its value changes; a many-valued one
 * accumulates, so a baseline that moved or a counterparty that dropped out of
 * the top five would stay live next to its replacement unless retired here.
 * Only ledger and registry facts are touched: a document's or a person's
 * fact under the same predicate is theirs.
 */
const RETIRABLE = new Set(['monthly_cost_baseline', 'top_counterparty', 'bank_connection'])

/** Loads the inputs for one company, computes the facts and records them. */
export async function deriveCompanyFacts(supabase: SupabaseClient, companyId: string, today: string, accountName: (account: string) => string | null): Promise<DeriveCompanyFactsOutcome> {
  const from = periodStart(today)
  const base = () =>
    supabase
      .from('journal_entry_lines')
      .select('account_number, debit_amount, credit_amount, journal_entries!inner(entry_date, status, company_id)')
      .eq('journal_entries.company_id', companyId)
      // A reversed original stays in the ledger and its storno cancels it; the reports sum both, so must the facts.
      .in('journal_entries.status', ['posted', 'reversed'])
  // Literal on purpose: the phantom-column guard can only check what it can read.
  const [recent, balance, employees, settings, company, banks, held] = await Promise.all([
    base().gte('journal_entries.entry_date', from).or('and(account_number.gte.3000,account_number.lte.3799),and(account_number.gte.4000,account_number.lte.7999)').limit(20000),
    base().or('and(account_number.gte.2310,account_number.lte.2399),and(account_number.gte.2840,account_number.lte.2849)').limit(5000),
    supabase.from('employees').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('is_active', true),
    supabase.from('company_settings').select('accounting_method, fiscal_year_start_month').eq('company_id', companyId).maybeSingle(),
    supabase.from('companies').select('tic_snapshot').eq('id', companyId).maybeSingle(),
    supabase.from('bank_connections').select('bank_name, created_at').eq('company_id', companyId).eq('status', 'active').is('superseded_by', null).limit(20),
    listLiveFacts(supabase, companyId, { kind: 'company', id: companyId }),
  ])
  for (const r of [recent, balance, employees, settings, company, banks]) if (r.error) throw new Error(`company facts input failed: ${r.error.message}`)
  const toLine = (r: { account_number: string | number; debit_amount: number | string | null; credit_amount: number | string | null; journal_entries: { entry_date: string } | Array<{ entry_date: string }> }): LedgerLine => {
    const je = Array.isArray(r.journal_entries) ? r.journal_entries[0] : r.journal_entries
    return { account_number: String(r.account_number), entry_date: je?.entry_date ?? '', debit: Number(r.debit_amount ?? 0), credit: Number(r.credit_amount ?? 0) }
  }
  const graph = await getCompanyGraph(supabase, companyId, { today })
  // The graph's flow counts both sides of every voucher (debits and credits); the money that moved is half of it.
  const counterparties = graph.nodes.filter((n) => n.kind === 'party' || n.kind === 'merchant').map((n) => ({ name: n.label, flow: Number((n.meta as { flow?: number }).flow ?? 0) / 2, ref: n.ref }))
  const s = (settings.data ?? null) as { accounting_method: 'accrual' | 'cash' | null; fiscal_year_start_month: number | null } | null
  const inputs: CompanyFactInputs = {
    today,
    lines: [...((recent.data ?? []) as unknown[]), ...((balance.data ?? []) as unknown[])].map((r) => toLine(r as never)),
    accountName,
    activeEmployees: employees.count ?? null,
    accountingMethod: s?.accounting_method ?? null,
    fiscalYearStartMonth: s?.fiscal_year_start_month ?? null,
    tic: ((company.data as { tic_snapshot: TicSnapshot | null } | null)?.tic_snapshot ?? null) as TicSnapshot | null,
    bankConnections: (banks.data ?? []) as Array<{ bank_name: string | null; created_at: string }>,
    counterparties,
    heldByHigherTrust: new Set(held.filter((f) => f.source_kind === 'extraction' || f.source_kind === 'person').map((f) => f.predicate)),
  }
  const drafts = companyFactsFrom(inputs)
  for (const d of drafts) {
    await recordFact(supabase, {
      companyId,
      subjectKind: 'company',
      subjectId: companyId,
      predicate: d.predicate,
      value: d.value,
      valueText: d.valueText,
      singleValued: d.singleValued,
      sourceKind: d.sourceKind,
      evidence: { ...d.evidence, at: new Date().toISOString(), derived: 'company' },
      confidence: 1,
    })
  }
  const stillDerived = new Set(drafts.map((d) => `${d.predicate}\u0000${d.valueText}`))
  const stale = held.filter((f) => RETIRABLE.has(f.predicate) && (f.source_kind === 'ledger' || f.source_kind === 'registry') && f.rank !== 'deprecated' && !stillDerived.has(`${f.predicate}\u0000${f.value_text}`))
  for (const f of stale) await revertFact(supabase, f.id, 'not derived by the latest run')
  // The facts are nodes of the graph: the next read draws them.
  if (drafts.length > 0 || stale.length > 0) await markCompanyGraphStale(supabase, companyId)
  return { recorded: drafts.length, retired: stale.length, predicates: [...new Set(drafts.map((d) => d.predicate))] }
}
