import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { companyFactsFrom, deriveCompanyFacts, periodStart, type CompanyFactInputs, type LedgerLine } from '../derive-company'
import { PREDICATES } from '../predicates'
import { getCompanyGraph, markCompanyGraphStale } from '@/lib/arkiv/graph/snapshot'
import { listLiveFacts, recordFact, revertFact } from '../store'

vi.mock('@/lib/arkiv/graph/snapshot', () => ({ getCompanyGraph: vi.fn(), markCompanyGraphStale: vi.fn() }))
vi.mock('../store', () => ({ listLiveFacts: vi.fn(), recordFact: vi.fn(), revertFact: vi.fn() }))

const line = (account_number: string, entry_date: string, debit = 0, credit = 0): LedgerLine => ({ account_number, entry_date, debit, credit })

function inputs(over: Partial<CompanyFactInputs> = {}): CompanyFactInputs {
  return {
    today: '2026-09-22',
    lines: [],
    accountName: (a) => ({ '5420': 'Programvaror', '7210': 'Löner till tjänstemän' })[a] ?? null,
    activeEmployees: null,
    accountingMethod: null,
    fiscalYearStartMonth: null,
    tic: null,
    bankConnections: [],
    counterparties: [],
    heldByHigherTrust: new Set(),
    ...over,
  }
}

const by = (drafts: ReturnType<typeof companyFactsFrom>, predicate: string) => drafts.filter((d) => d.predicate === predicate)

describe('companyFactsFrom', () => {
  it('every predicate it writes is in the vocabulary, on the company, with the right cardinality', () => {
    const drafts = companyFactsFrom(
      inputs({
        lines: [line('7210', '2026-07-25', 70000), line('7210', '2026-08-25', 70000), line('3010', '2026-08-01', 0, 100000), line('2359', '2026-02-02', 0, 500000), line('5420', '2026-06-01', 30000), line('5420', '2026-07-01', 20000), line('5420', '2026-08-01', 50000)],
        activeEmployees: 2,
        accountingMethod: 'accrual',
        fiscalYearStartMonth: 1,
        tic: { sniCodes: [{ code: '62010', name: 'Dataprogrammering' }], beneficialOwners: [{ name: 'Jakob Wennberg', extentDescription: '100 %' }], employeeRange: 'Inga anställda' },
        bankConnections: [{ bank_name: 'Swedbank', created_at: '2026-02-01T10:00:00Z' }],
        counterparties: [{ name: 'Almi', flow: 60000 }],
      }),
    )
    expect(drafts.length).toBeGreaterThan(8)
    for (const d of drafts) {
      const def = PREDICATES[d.predicate]
      expect(def, d.predicate).toBeDefined()
      expect(def.subject).toBe('company')
      expect(def.singleValued, d.predicate).toBe(d.singleValued)
    }
  })

  it('averages salary over the months that had any, nets revenue, and reads the loan balance from every posting', () => {
    const drafts = companyFactsFrom(
      inputs({
        lines: [
          line('7210', '2026-07-25', 50000),
          line('7210', '2026-08-25', 70000),
          line('7290', '2026-08-25', 8400),
          line('3010', '2026-08-01', 0, 100000),
          line('3010', '2026-08-15', 20000), // a credit note
          line('2359', '2025-02-02', 0, 500000), // paid out before the period: still a loan
          line('2359', '2026-03-31', 10417), // one amortisation
        ],
      }),
    )
    expect(by(drafts, 'monthly_salary_cost')[0]).toMatchObject({ value: 64200, valueText: '64 200 kr/mån (2 mån med lön)', sourceKind: 'ledger' })
    expect(by(drafts, 'revenue_12m')[0]).toMatchObject({ value: 80000 })
    expect(by(drafts, 'loan_balance')[0]).toMatchObject({ value: 489583, valueText: '489 583 kr (2359)', evidence: { accounts: [{ account: '2359', balance: 489583 }], as_of: '2026-09-22' } })
  })

  it('counts a convertible on 2320 as a loan and breaks the balance down per account', () => {
    const drafts = companyFactsFrom(inputs({ lines: [line('2320', '2025-10-16', 0, 400000), line('2359', '2026-02-02', 0, 500000), line('2359', '2026-02-02', 492610), line('2440', '2026-03-31', 0, 15100)] }))
    expect(by(drafts, 'loan_balance')[0]).toMatchObject({ value: 407390, valueText: '407 390 kr (2320: 400 000 kr; 2359: 7 390 kr)' })
  })

  it('writes a baseline only for accounts with three months of cost, with the typical month and its range', () => {
    const drafts = companyFactsFrom(
      inputs({
        lines: [line('5420', '2026-06-01', 30000), line('5420', '2026-06-15', 5000), line('5420', '2026-07-01', 20000), line('5420', '2026-08-01', 50000), line('6570', '2026-08-01', 140), line('6570', '2026-09-01', 140)],
      }),
    )
    const baselines = by(drafts, 'monthly_cost_baseline')
    expect(baselines).toHaveLength(1)
    expect(baselines[0].value).toEqual({ account: '5420', name: 'Programvaror', median: 35000, low: 20000, high: 50000, months: 3 })
    expect(baselines[0].valueText).toBe('5420 Programvaror: typiskt 35 000 kr/mån (20 000 kr till 50 000 kr, 3 mån)')
  })

  it('keeps the five biggest counterparties by flow, in order, each pointing at its graph node', () => {
    const counterparties = ['A', 'B', 'C', 'D', 'E', 'F'].map((name, i) => ({ name, flow: (i + 1) * 1000, ref: `party:${name}` }))
    const top = by(companyFactsFrom(inputs({ counterparties })), 'top_counterparty')
    expect(top.map((d) => (d.value as { name: string }).name)).toEqual(['F', 'E', 'D', 'C', 'B'])
    expect(top[0].valueText).toBe('F: 6 000 kr (12 mån)')
    expect(top[0].evidence).toMatchObject({ node: 'party:F', from: '2025-09-22', to: '2026-09-22' })
  })

  it('leaves fiscal_year and board to a document or a person when they hold it, and says where a registry value comes from', () => {
    const held = companyFactsFrom(inputs({ fiscalYearStartMonth: 1, accountingMethod: 'cash', heldByHigherTrust: new Set(['fiscal_year']) }))
    expect(by(held, 'fiscal_year')).toEqual([])
    expect(by(held, 'accounting_method')[0].valueText).toBe('Bokslutsmetoden (kontantmetoden), enligt inställningarna')
    const free = companyFactsFrom(inputs({ fiscalYearStartMonth: 7 }))
    expect(by(free, 'fiscal_year')[0]).toMatchObject({ value: '0701 - 0630', sourceKind: 'registry' })
  })

  it('reads industry, owners and the registry employee range from the Bolagsverket snapshot', () => {
    const drafts = companyFactsFrom(inputs({ tic: { sniCodes: [{ code: '62010', name: 'Dataprogrammering' }, { code: '64920', name: 'Annan kreditgivning' }], beneficialOwners: [{ name: 'Jakob Wennberg', extentDescription: '100 %' }], employeeRange: 'Inga anställda' } }))
    expect(by(drafts, 'sni_codes')[0].valueText).toBe('62010 Dataprogrammering; 64920 Annan kreditgivning')
    expect(by(drafts, 'beneficial_owners')[0].valueText).toBe('Jakob Wennberg (100 %)')
    expect(by(drafts, 'employee_range_registry')[0].valueText).toBe('Inga anställda (enligt registret)')
  })

  it('writes nothing from an empty company', () => {
    expect(companyFactsFrom(inputs())).toEqual([])
    expect(periodStart('2026-09-22')).toBe('2025-09-22')
  })
})

describe('deriveCompanyFacts', () => {
  const mock = createQueuedMockSupabase()
  const supabase = mock.supabase as unknown as SupabaseClient
  const node = (ref: string, kind: string, label: string, flow: number) => ({ ref, cluster: 'party', kind, label, weight: flow, meta: { flow } })

  beforeEach(() => {
    vi.clearAllMocks()
    mock.reset()
    ;(listLiveFacts as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(recordFact as ReturnType<typeof vi.fn>).mockResolvedValue('fact-id')
  })

  /** The reads, in the order deriveCompanyFacts awaits them: recent lines, loan lines, employees, settings, company, banks. */
  const enqueueReads = (over: { recent?: unknown[]; loans?: unknown[] } = {}) => {
    mock.enqueue({ data: over.recent ?? [] })
    mock.enqueue({ data: over.loans ?? [] })
    mock.enqueue({ count: null })
    mock.enqueue({ data: null })
    mock.enqueue({ data: { tic_snapshot: null } })
    mock.enqueue({ data: [] })
  }

  it('reads every loan account, halves the graph flow into money moved, keeps the node ref, retires what an earlier run derived and this one does not, and marks the graph stale', async () => {
    enqueueReads({ loans: [{ account_number: '2320', debit_amount: 0, credit_amount: 400000, journal_entries: { entry_date: '2025-10-16' } }] })
    ;(getCompanyGraph as ReturnType<typeof vi.fn>).mockResolvedValue({ nodes: [node('party:p-almi', 'party', 'Almi', 1000000), node('merchant:konsult', 'merchant', 'Konsult', 394260), node('account:1930', 'account', '1930', 5)], links: [] })
    ;(listLiveFacts as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'f-old-utb', predicate: 'top_counterparty', value_text: 'Utbetalning: 502 713 kr (12 mån)', source_kind: 'ledger', rank: 'normal' },
      { id: 'f-same', predicate: 'top_counterparty', value_text: 'Almi: 500 000 kr (12 mån)', source_kind: 'ledger', rank: 'normal' },
      { id: 'f-loan-old', predicate: 'loan_balance', value_text: '7 390 kr (2359)', source_kind: 'ledger', rank: 'normal' },
      { id: 'f-person', predicate: 'top_counterparty', value_text: 'Kund AB', source_kind: 'person', rank: 'normal' },
    ])
    const out = await deriveCompanyFacts(supabase, 'co-1', '2026-09-22', () => null)
    expect(out).toEqual({ recorded: 3, retired: 1, predicates: ['loan_balance', 'top_counterparty'] })
    // The counterparty that fell out is retired; the same value stays; a single-valued fact is superseded by the record itself; a person's fact is theirs.
    expect((revertFact as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])).toEqual(['f-old-utb'])
    expect(mock.findCalls('journal_entry_lines', 'or').map((c) => c[0])).toContain('and(account_number.gte.2310,account_number.lte.2399),and(account_number.gte.2840,account_number.lte.2849)')
    // A storno cancels its original only when both are summed: reversed entries stay in.
    expect(mock.findCalls('journal_entry_lines', 'in')).toEqual(expect.arrayContaining([['journal_entries.status', ['posted', 'reversed']]]))
    const recorded = (recordFact as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as { predicate: string; value: unknown; valueText: string; evidence: Record<string, unknown> })
    expect(recorded.find((r) => r.predicate === 'loan_balance')).toMatchObject({ value: 400000, valueText: '400 000 kr (2320)' })
    expect(recorded.filter((r) => r.predicate === 'top_counterparty').map((r) => [r.valueText, r.evidence.node])).toEqual([
      ['Almi: 500 000 kr (12 mån)', 'party:p-almi'],
      ['Konsult: 197 130 kr (12 mån)', 'merchant:konsult'],
    ])
    expect(markCompanyGraphStale).toHaveBeenCalledWith(supabase, 'co-1')
  })

  it('leaves the graph alone when there was nothing to record', async () => {
    enqueueReads()
    ;(getCompanyGraph as ReturnType<typeof vi.fn>).mockResolvedValue({ nodes: [], links: [] })
    expect(await deriveCompanyFacts(supabase, 'co-1', '2026-09-22', () => null)).toEqual({ recorded: 0, retired: 0, predicates: [] })
    expect(recordFact).not.toHaveBeenCalled()
    expect(revertFact).not.toHaveBeenCalled()
    expect(markCompanyGraphStale).not.toHaveBeenCalled()
  })
})
