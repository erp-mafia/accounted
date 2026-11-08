/**
 * Integration tests for the K3 årsredovisning end-to-end:
 *   - buildArsredovisningData produces the K3 noter + kassaflöde + equity
 *     statement when accounting_framework is 'k3'
 *   - K2 byte-equivalence: when framework is 'k2' the existing structure is
 *     unchanged (no kassaflodesanalys, no equity_changes_statement, K2 noter)
 *   - The K3 PDF template renders without errors against the resulting data
 *
 * Mocks the three report generators (income statement, balance sheet, trial
 * balance, kassaflöde) so the test can plant deterministic inputs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/reports/income-statement', () => ({
  generateIncomeStatement: vi.fn(),
}))
vi.mock('@/lib/reports/balance-sheet', () => ({
  generateBalanceSheet: vi.fn(),
}))
vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
  fetchTrialBalanceChart: vi.fn(async () => []),
}))
vi.mock('@/lib/reports/kassaflodesanalys', () => ({
  generateKassaflodesanalys: vi.fn(),
}))
vi.mock('@/lib/bokslut/assets/asset-service', () => ({
  listAssets: vi.fn().mockResolvedValue([]),
}))
const mockFetchAllRows = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: mockFetchAllRows,
}))
// The registers in Avtal och åtaganden (lib/commitments): nothing registered
// unless a test plants it, so every other test reads the narrative alone.
const mockRegisterNoteTexts = vi.hoisted(() => vi.fn())
vi.mock('@/lib/commitments/disclosures', () => ({
  loadRegisterNoteTexts: mockRegisterNoteTexts,
}))

import {
  buildArsredovisningData, resolveMedelantalNote,
  K3_CASH_FLOW_FAILED_WARNING, K3_CASH_FLOW_TAX_ALLOCATION_WARNING,
} from '../build-data'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { generateBalanceSheet } from '@/lib/reports/balance-sheet'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateKassaflodesanalys } from '@/lib/reports/kassaflodesanalys'
import { CashFlowTaxAllocationError } from '@/lib/reports/cash-flow-tax'
import { listAssets } from '@/lib/bokslut/assets/asset-service'
import type { TrialBalanceRowLike } from '@/lib/bokslut/ixbrl/k2-mapper'
import { CURRENT, PREVIOUS } from '@/lib/bokslut/ixbrl/__tests__/fixtures'
import type { TrialBalanceRow } from '@/types'
// Captured from the sequential (pre-dedupe) implementation: the parallel
// TB-pair fetch must reproduce it byte for byte.
import multiYearSnapshot from './arsredovisning-k3-multiyear-snapshot.json'

interface ChainableMock {
  from: ReturnType<typeof vi.fn>
  rpc: ReturnType<typeof vi.fn>
}

function makeSupabase(opts: {
  accountingFramework: 'k2' | 'k3'
  entityType?: string
  aktiekapital?: number | null
  antalAktier?: number | null
  agmDate?: string | null
  previousPeriodId?: string | null
  /** The current period's dates; the comparison year must end the day before it starts. */
  period?: { name: string; period_start: string; period_end: string }
  medelantalOverride?: number | null
  noteOverrides?: Record<string, string>
  omitCashFlow?: boolean
  registeredOffice?: string | null
  city?: string | null
  /** Verifikat on equity accounts, as get_entries_with_account_lines answers them. */
  equityEntries?: unknown[]
  /** The year's own row in fiscal_period_frameworks; absent means none (company default). */
  yearFramework?: { framework: 'k2' | 'k3'; source?: string; change_reason?: string | null }
}): ChainableMock {
  const from = vi.fn((table: string) => {
    if (table === 'fiscal_period_frameworks' && opts.yearFramework) {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    fiscal_period_id: 'fp1',
                    source: 'election',
                    previous_framework: null,
                    change_reason: null,
                    previously_applied_k2: null,
                    special_reasons_confirmed: null,
                    decided_at: '2026-01-10T10:00:00Z',
                    ...opts.yearFramework,
                  },
                  error: null,
                }),
            }),
          }),
        }),
      }
    }
    if (table === 'fiscal_periods') {
      return {
        select: () => ({
          eq: () => ({
            // The equity specification reads the years' ingående balans
            // verifikat ids: none in these books.
            in: () => Promise.resolve({ data: [], error: null }),
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: {
                    id: 'fp1',
                    name: '2025',
                    period_start: '2025-01-01',
                    period_end: '2025-12-31',
                    ...opts.period,
                    previous_period_id: opts.previousPeriodId ?? null,
                    closing_entry_id: null,
                  },
                  error: null,
                }),
            }),
          }),
        }),
      }
    }
    if (table === 'company_settings') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: {
                  company_name: 'Testbolaget AB',
                  org_number: '556677-8899',
                  address: { city: 'Stockholm' },
                  registered_office: opts.registeredOffice ?? null,
                  city: opts.city ?? null,
                  entity_type: opts.entityType ?? 'aktiebolag',
                  aktiekapital: opts.aktiekapital ?? null,
                  antal_aktier:
                    opts.antalAktier !== undefined
                      ? opts.antalAktier
                      : opts.aktiekapital
                        ? 500
                        : null,
                },
                error: null,
              }),
          }),
        }),
      }
    }
    if (table === 'companies') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: {
                  entity_type: opts.entityType ?? 'aktiebolag',
                  accounting_framework: opts.accountingFramework,
                },
                error: null,
              }),
          }),
        }),
      }
    }
    if (table === 'arsredovisning_narratives') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data:
                    opts.agmDate || opts.medelantalOverride != null || opts.noteOverrides || opts.omitCashFlow
                      ? {
                          note_overrides: opts.noteOverrides ?? {},
                          omit_kassaflodesanalys: opts.omitCashFlow ?? false,
                          kassaflodesanalys_omission_confirmed: false,
                          agm_date: opts.agmDate ?? null,
                          description: null,
                          important_events: null,
                          resultatdisposition: null,
                          medelantal_anstallda_override: opts.medelantalOverride ?? null,
                        }
                      : null,
                  error: null,
                }),
            }),
          }),
        }),
      }
    }
    if (table === 'employees') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ count: 0, error: null }),
          }),
        }),
      }
    }
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: null, error: null }),
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
      }),
    }
  })
  // get_entries_with_account_lines: the equity verifikat of the year. The
  // tests that read the specification plant their own (opts.equityEntries).
  const rpc = vi.fn(async (name: string, args: { p_start?: string; p_end?: string } = {}) =>
    name === 'get_entries_with_account_lines'
      ? {
          data: ((opts.equityEntries ?? []) as Array<{ entry_date: string }>).filter(
            (entry) => (!args.p_start || entry.entry_date >= args.p_start) && (!args.p_end || entry.entry_date <= args.p_end),
          ),
          error: null,
        }
      : { data: null, error: { message: `unexpected rpc ${name}` } },
  )
  return { from, rpc }
}

const mockedIncomeStatement = vi.mocked(generateIncomeStatement)
const mockedBalanceSheet = vi.mocked(generateBalanceSheet)
const mockedTrialBalance = vi.mocked(generateTrialBalance)
const mockedKassaflode = vi.mocked(generateKassaflodesanalys)
const mockedListAssets = vi.mocked(listAssets)

function plantStandardReports() {
  mockedIncomeStatement.mockResolvedValue({
    revenue_sections: [
      {
        title: 'Rörelsens intäkter',
        rows: [{ account_number: '3001', account_name: 'Försäljning 25%', amount: 500_000 }],
        subtotal: 500_000,
      },
    ],
    total_revenue: 500_000,
    expense_sections: [
      {
        title: 'Rörelsens kostnader',
        rows: [{ account_number: '4010', account_name: 'Inköp material', amount: 200_000 }],
        subtotal: 200_000,
      },
    ],
    total_expenses: 200_000,
    financial_sections: [],
    total_financial: 0,
    net_result: 300_000,
    period: { start: '2025-01-01', end: '2025-12-31' },
  })
  mockedBalanceSheet.mockResolvedValue({
    asset_sections: [
      {
        title: 'Omsättningstillgångar',
        rows: [{ account_number: '1930', account_name: 'Bank', amount: 600_000 }],
        subtotal: 600_000,
      },
    ],
    total_assets: 600_000,
    equity_liability_sections: [
      {
        title: 'Eget kapital',
        rows: [
          { account_number: '2081', account_name: 'Aktiekapital', amount: 50_000 },
          { account_number: '2099', account_name: 'Årets resultat', amount: 300_000 },
          { account_number: '2098', account_name: 'Balanserade vinstmedel', amount: 250_000 },
        ],
        subtotal: 600_000,
      },
    ],
    total_equity_liabilities: 600_000,
    period: { start: '2025-01-01', end: '2025-12-31' },
  })
  mockedTrialBalance.mockResolvedValue({
    rows: [
      {
        account_number: '2240',
        account_name: 'Uppskjuten skatteskuld',
        account_class: 2,
        opening_debit: 0,
        opening_credit: 50_000,
        period_debit: 0,
        period_credit: 20_600,
        closing_debit: 0,
        closing_credit: 70_600,
      },
      {
        account_number: '8940',
        account_name: 'Uppskjuten skatt',
        account_class: 8,
        opening_debit: 0,
        opening_credit: 0,
        period_debit: 20_600,
        period_credit: 0,
        closing_debit: 20_600,
        closing_credit: 0,
      },
    ],
    totalDebit: 20_600,
    totalCredit: 20_600,
    isBalanced: true,
  })
  mockedKassaflode.mockResolvedValue({
    fiscal_period_id: 'fp1',
    period_start: '2025-01-01',
    period_end: '2025-12-31',
    lopande: {
      resultat_efter_finansiella_poster: 300_000,
      avskrivningar: 0,
      ovriga_ej_kassaflodesposter: 0,
      delta_kortfristiga_fordringar: 0,
      delta_varulager: 0,
      delta_kortfristiga_skulder: 0,
      skatt_betald: 0,
      koncernbidrag: 0,
      ovriga_poster: 0,
      total: 300_000,
    },
    investerings: {
      forvarv_anlaggningar: 0,
      avyttring_anlaggningar: 0,
      kortfristiga_placeringar: 0,
      total: 0,
    },
    finansierings: {
      delta_lan: 0,
      utdelningar: 0,
      nyemission: 0,
      erhallna_aktieagartillskott: 0,
      total: 0,
    },
    total_cash_flow: 300_000,
    unclassified_accounts: [],
    reconciliation: {
      opening_cash_1xxx: 300_000,
      closing_cash_1xxx: 600_000,
      delta_actual: 300_000,
      delta_calculated: 300_000,
      mismatch_amount: 0,
      is_reconciled: true,
    },
  })
  mockedListAssets.mockResolvedValue([])
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetchAllRows.mockResolvedValue([])
  mockRegisterNoteTexts.mockResolvedValue(null)
  plantStandardReports()
})

describe('buildArsredovisningData: the registers in Avtal och åtaganden', () => {
  const registers = {
    securities_pledged: 'Företagsinteckningar 500 000 kr.',
    contingent_liabilities: 'Borgensförbindelser 300 000 kr.',
    parent_company: { name: 'Ägarbolaget AB', org_number: '559000-0000', city: 'Stockholm' },
  }

  it.each(['k2', 'k3'] as const)('%s: writes the säkerheter, eventualförpliktelser and parent notes from the registers', async (framework) => {
    mockRegisterNoteTexts.mockResolvedValue(registers)
    const supabase = makeSupabase({ accountingFramework: framework })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(mockRegisterNoteTexts).toHaveBeenCalledWith(supabase, 'co1', '2025-12-31')
    expect(data.noter.find((n) => n.title === 'Ställda säkerheter')?.body).toBe('Företagsinteckningar 500 000 kr.')
    expect(data.noter.find((n) => n.title === 'Eventualförpliktelser')?.body).toBe('Borgensförbindelser 300 000 kr.')
    expect(data.noter.find((n) => n.title === 'Koncernförhållanden')?.body).toBe(
      'Moderföretag: Ägarbolaget AB. Organisationsnummer: 559000-0000. Säte: Stockholm.',
    )
    expect(data.disclosures.from_registers).toEqual(registers)
    // The narrative fields stay what the person wrote (here nothing).
    expect(data.disclosures.securities_pledged).toBeNull()
  })

  it('leaves the document as before when nothing is registered', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k2' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.noter.find((n) => n.title === 'Ställda säkerheter')?.body).toBe('Inga.')
    expect(data.noter.find((n) => n.title === 'Koncernförhållanden')).toBeUndefined()
    expect(data.disclosures).not.toHaveProperty('from_registers')
  })
})

describe('buildArsredovisningData: medelantal anställda override (ÅRL 5:20 §)', () => {
  it.each(['k2', 'k3'] as const)(
    '%s: without an override the note reports no employees',
    async (framework) => {
      const supabase = makeSupabase({ accountingFramework: framework })
      // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
      const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
      const note = data.noter.find((n) => n.title === 'Medelantal anställda')
      expect(note?.body).toContain('inte haft några anställda')
      expect(data.disclosures.medelantal_anstallda_override).toBeNull()
    },
  )

  it.each(['k2', 'k3'] as const)(
    '%s: a manual figure on the narrative replaces the computed note',
    async (framework) => {
      const supabase = makeSupabase({ accountingFramework: framework, medelantalOverride: 1 })
      // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
      const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
      const note = data.noter.find((n) => n.title === 'Medelantal anställda')
      expect(note?.body).toBe('Under räkenskapsåret har medeltalet anställda uppgått till 1.')
      expect(data.disclosures.medelantal_anstallda_override).toBe(1)
    },
  )
})

describe('buildArsredovisningData: säte', () => {
  it('prints registered_office as säte, never the postal town', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k2', registeredOffice: 'Sateskommunen', city: 'Postorten' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.company.registered_office).toBe('Sateskommunen')
    expect(data.warnings.join('\n')).not.toContain('Säte saknas')
  })

  it('falls back to the postal town with a warning while the säte is unknown', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k2', registeredOffice: null, city: 'Postorten' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.company.registered_office).toBe('Postorten')
    expect(data.warnings).toContainEqual(expect.stringContaining('Säte saknas i företagsinställningarna'))
  })
})

describe('buildArsredovisningData: K3', () => {
  it('records accounting_framework=k3 in the output', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k3' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient: chainable mock isn't fully typed
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.accounting_framework).toBe('k3')
  })

  it('includes a kassaflödesanalys when framework is K3', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k3' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.kassaflodesanalys).toBeDefined()
    expect(data.kassaflodesanalys?.total_cash_flow).toBe(300_000)
    expect(data.kassaflodesanalys?.reconciliation.is_reconciled).toBe(true)
  })

  it('preserves an unallocatable tax explanation instead of blaming bank balances', async () => {
    vi.mocked(generateKassaflodesanalys).mockRejectedValueOnce(new CashFlowTaxAllocationError())
    const supabase = makeSupabase({ accountingFramework: 'k3' })
    // @ts-expect-error: chainable mock is not a complete SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.kassaflodesanalys).toBeUndefined()
    expect(data.warnings).toContain(K3_CASH_FLOW_TAX_ALLOCATION_WARNING)
    expect(data.warnings).not.toContain(K3_CASH_FLOW_FAILED_WARNING)
  })

  it('prints the equity specification in förvaltningsberättelsen by default, never the old residual statement', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k3' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.equity_specification?.placement).toBe('management_report')
    expect(data.equity_changes_statement).toBeUndefined()
  })

  it('emits the K3-style redovisningsprinciper note with framework citation', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k3' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    const principles = data.noter.find((n) => n.title.startsWith('Redovisnings'))
    expect(principles).toBeDefined()
    expect(principles!.body).toContain('BFNAR 2012:1')
  })

  it('emits an "Uppskjutna skatter" note with 2240 movement when balances exist', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k3' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    const uppskjuten = data.noter.find((n) => n.title === 'Uppskjutna skatter')
    expect(uppskjuten).toBeDefined()
    // Opening 50 000, change +20 600, closing 70 600
    expect(uppskjuten!.body).toMatch(/Ingående saldo.*50/)
    expect(uppskjuten!.body).toMatch(/Utgående saldo.*70/)
  })

  it('makes the principles note acknowledge the 2240 balance the movement note discloses', async () => {
    // The planted trial balance carries a legacy 2240/8940 pair, so the
    // document contains BOTH notes. They must tell one story: the policy
    // paragraph may not deny a separately recognised deferred tax on
    // obeskattade reserver while the next note discloses exactly that.
    const supabase = makeSupabase({ accountingFramework: 'k3' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    const principles = data.noter.find((n) => n.title.startsWith('Redovisnings'))!
    const uppskjuten = data.noter.find((n) => n.title === 'Uppskjutna skatter')!
    expect(uppskjuten).toBeDefined()
    expect(principles.body).toContain('konto 2240')
    expect(principles.body).toContain('Uppskjutna skatter')
    expect(principles.body).not.toContain('särredovisas inte')
  })

  it('discloses an uppskjuten skattefordran on 1370 that the K3 deferred tax posting booked', async () => {
    // commit_deferred_tax books 8940 against 2240 and 1370 (a deductible
    // difference or a recognised loss): the fordran is a post of the K3
    // balance sheet, so the note and the principles must show it too.
    mockedTrialBalance.mockResolvedValue({
      rows: [
        {
          account_number: '1370',
          account_name: 'Uppskjuten skattefordran',
          account_class: 1,
          opening_debit: 10_000,
          opening_credit: 0,
          period_debit: 30_900,
          period_credit: 0,
          closing_debit: 40_900,
          closing_credit: 0,
        },
        {
          account_number: '8940',
          account_name: 'Uppskjuten skatt',
          account_class: 8,
          opening_debit: 0,
          opening_credit: 0,
          period_debit: 0,
          period_credit: 30_900,
          closing_debit: 0,
          closing_credit: 30_900,
        },
      ],
      totalDebit: 30_900,
      totalCredit: 30_900,
      isBalanced: true,
    })
    const supabase = makeSupabase({ accountingFramework: 'k3' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    const uppskjuten = data.noter.find((n) => n.title === 'Uppskjutna skatter')
    expect(uppskjuten).toBeDefined()
    expect(uppskjuten!.body).toMatch(/Ingående saldo \(1370\): 10\s000 kr/)
    expect(uppskjuten!.body).toMatch(/Årets förändring: 30\s900 kr/)
    expect(uppskjuten!.body).toMatch(/Utgående saldo \(1370\): 40\s900 kr/)
    expect(uppskjuten!.body).toMatch(/\(8940\): -30\s900 kr/)
    expect(uppskjuten!.body).not.toContain('2240')
    const principles = data.noter.find((n) => n.title.startsWith('Redovisnings'))!
    expect(principles.body).toContain('Uppskjuten skattefordran redovisas på konto 1370.')
    expect(principles.body).not.toContain('särredovisas inte')
  })

  it('denies the split in the principles note when no 2240/8940 activity exists', async () => {
    // What the engine produces today: no deferred tax is booked, so there is
    // no movement note and the policy paragraph states the gross treatment.
    mockedTrialBalance.mockResolvedValue({
      rows: [],
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    })
    const supabase = makeSupabase({ accountingFramework: 'k3' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.noter.find((n) => n.title === 'Uppskjutna skatter')).toBeUndefined()
    const principles = data.noter.find((n) => n.title.startsWith('Redovisnings'))!
    expect(principles.body).toContain(
      'Uppskjuten skatt hänförlig till obeskattade reserver särredovisas inte i juridisk person',
    )
    expect(principles.body).not.toMatch(/2240/)
  })

  it('keeps the pair consistent when the provision is fully reversed to a zero closing balance', async () => {
    // Opening 50 000, reversed in full: the movement note is still emitted,
    // so the principles paragraph must stay on the "recognised" branch and
    // must not assert a closing balance that no longer exists.
    mockedTrialBalance.mockResolvedValue({
      rows: [
        {
          account_number: '2240',
          account_name: 'Uppskjuten skatteskuld',
          account_class: 2,
          opening_debit: 0,
          opening_credit: 50_000,
          period_debit: 50_000,
          period_credit: 0,
          closing_debit: 0,
          closing_credit: 0,
        },
        {
          account_number: '8940',
          account_name: 'Uppskjuten skatt',
          account_class: 8,
          opening_debit: 0,
          opening_credit: 0,
          period_debit: 0,
          period_credit: 50_000,
          closing_debit: 0,
          closing_credit: 50_000,
        },
      ],
      totalDebit: 50_000,
      totalCredit: 50_000,
      isBalanced: true,
    })
    const supabase = makeSupabase({ accountingFramework: 'k3' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    const uppskjuten = data.noter.find((n) => n.title === 'Uppskjutna skatter')!
    expect(uppskjuten).toBeDefined()
    expect(uppskjuten.body).toMatch(/Utgående saldo \(2240\): 0 kr/)
    const principles = data.noter.find((n) => n.title.startsWith('Redovisnings'))!
    expect(principles.body).not.toContain('särredovisas inte')
    expect(principles.body).not.toContain('i balansräkningen')
  })

  // ── Leasing paragraph: which balances contradict "all leases operational" ──
  //
  // The detection reads the company's OWN account names in kontogrupp 12, not
  // a hardcoded 1260/1269 pair. On the shipped BAS 2026 chart those two are
  // "(Fritt konto för Inventarier, verktyg och installationer)" and "Ack.
  // avskrivningar på datorer", so the number-based rule both missed real lease
  // accounts and flagged owned computers.
  function plantTbRow(row: {
    account_number: string
    account_name: string
    closing_debit?: number
    closing_credit?: number
  }) {
    mockedTrialBalance.mockResolvedValue({
      rows: [
        {
          account_number: row.account_number,
          account_name: row.account_name,
          account_class: 1,
          opening_debit: 0,
          opening_credit: 0,
          period_debit: 0,
          period_credit: 0,
          closing_debit: row.closing_debit ?? 0,
          closing_credit: row.closing_credit ?? 0,
        },
      ],
      totalDebit: row.closing_debit ?? 0,
      totalCredit: row.closing_credit ?? 0,
      isBalanced: true,
    })
  }

  async function leasingParagraph(): Promise<string> {
    const supabase = makeSupabase({ accountingFramework: 'k3' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    return data.noter.find((n) => n.title.startsWith('Redovisnings'))!.body
  }

  it('drops the blanket operational claim for a finance-leased asset on 1227', async () => {
    // 1227 Finansiellt leasade inventarier: a capitalized lease the old
    // 1260/1269 rule never saw, while the K2 mapper folds it into the same BR
    // post as ordinary inventarier.
    plantTbRow({
      account_number: '1227',
      account_name: 'Finansiellt leasade inventarier',
      closing_debit: 180_000,
    })
    const body = await leasingParagraph()
    expect(body).not.toMatch(/Samtliga leasingavtal/)
    expect(body).not.toMatch(/20\.29/)
    expect(body).toContain('leasade tillgångar')
  })

  it('keeps the blanket operational claim for owned inventarier on 1220', async () => {
    plantTbRow({
      account_number: '1220',
      account_name: 'Inventarier, verktyg och installationer',
      closing_debit: 180_000,
    })
    const body = await leasingParagraph()
    expect(body).toContain('Samtliga leasingavtal redovisas som operationella')
    expect(body).toContain('K3 punkt 20.29')
  })

  it('does not read owned datorer on 1269 as a leased asset', async () => {
    // Regression on the old rule: on this chart 1269 is "Ack. avskrivningar på
    // datorer", so an owned laptop used to flip the paragraph and put a leased
    // asset in a signed årsredovisning that has none.
    plantTbRow({
      account_number: '1269',
      account_name: 'Ack. avskrivningar på datorer',
      closing_credit: 40_000,
    })
    const body = await leasingParagraph()
    expect(body).toContain('Samtliga leasingavtal redovisas som operationella')
    expect(body).not.toContain('Balansräkningen innehåller leasade tillgångar')
  })

  it('does not claim a leased asset for a lease disposed during the year', async () => {
    // closing_debit/closing_credit are cumulative per-side totals, not a net
    // balance: a lease acquired in an earlier year and disposed this year has
    // both sides non-zero while the balansräkning carries nothing. Asserting
    // "Balansräkningen innehåller leasade tillgångar" about an empty balance
    // sheet is the same defect class this sweep exists to remove.
    plantTbRow({
      account_number: '1217',
      account_name: 'Finansiellt leasade maskiner',
      closing_debit: 180_000,
      closing_credit: 180_000,
    })
    const body = await leasingParagraph()
    expect(body).toContain('Samtliga leasingavtal redovisas som operationella')
    expect(body).not.toContain('Balansräkningen innehåller leasade tillgångar')
  })

  it('ignores a zero-balance lease account', async () => {
    plantTbRow({
      account_number: '1217',
      account_name: 'Finansiellt leasade maskiner',
    })
    const body = await leasingParagraph()
    expect(body).toContain('Samtliga leasingavtal redovisas som operationella')
  })

  it('ignores förutbetalda leasingavgifter on 1720 (the operational treatment)', async () => {
    plantTbRow({
      account_number: '1720',
      account_name: 'Förutbetalda leasingavgifter',
      closing_debit: 24_000,
    })
    const body = await leasingParagraph()
    expect(body).toContain('Samtliga leasingavtal redovisas som operationella')
  })

  it('emits an Eventualförpliktelser note', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k3' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.noter.find((n) => n.title === 'Eventualförpliktelser')).toBeDefined()
  })

  it('leaves Väsentliga händelser efter balansdagen to the disclosure matrix, never a default "Inga"', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k3' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    // ÅRL 5 kap. 22 §: the user answers it (disclosures/k3-mindre.ts); the
    // model prints the answer once the size class is known.
    expect(
      data.noter.find((n) => n.title === 'Väsentliga händelser efter balansdagen'),
    ).toBeUndefined()
  })

  it('derives kvotvärde in the aktiekapital note instead of reading a stored column', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k3', aktiekapital: 25_000 })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    const note = data.noter.find((n) => n.title === 'Aktiekapital')
    expect(note).toBeDefined()
    // 25 000 kr / 500 aktier per the settings mock (ABL 1 kap 6 §).
    expect(note!.body).toContain('Antal aktier: 500.')
    expect(note!.body).toContain('Kvotvärde per aktie: 50 kr.')
  })

  it('warns instead of emitting an aktiekapital note when settings are empty', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k3' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.noter.find((n) => n.title === 'Aktiekapital')).toBeUndefined()
    // ÅRL 5 kap. 34 § binds a större företag only: the note is voluntary for a mindre one.
    const warning = data.warnings.find((w) => w.startsWith('Aktiekapitalnoten utelämnas'))
    expect(warning).toContain('För ett mindre företag är noten frivillig')
    expect(warning).toContain('ÅRL 5 kap. 34 §')
  })

  it('treats a partial share-capital pair as missing (warns, no note) for K3', async () => {
    const supabase = makeSupabase({
      accountingFramework: 'k3',
      aktiekapital: 25_000,
      antalAktier: null,
    })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.noter.find((n) => n.title === 'Aktiekapital')).toBeUndefined()
    expect(data.warnings.find((w) => w.startsWith('Aktiekapitalnoten utelämnas'))).toBeDefined()
  })

  it('never queries depreciation_schedules when the asset register is empty', async () => {
    // buildRollforwardAssets skips the posted-schedules fetch entirely for
    // an empty register: pinning this keeps the makeSupabase mock (which has
    // no depreciation_schedules branch) honest.
    const supabase = makeSupabase({ accountingFramework: 'k3' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    await buildArsredovisningData(supabase, 'co1', 'fp1')
    const tables = supabase.from.mock.calls.map((call) => call[0])
    expect(tables).not.toContain('depreciation_schedules')
  })

  it('DROPS the old "K3 noter need manual augmentation" warning text', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k3' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    // The warning should no longer say the K3 noter need manual augmentation
    expect(
      data.warnings.find((w) =>
        /finns ännu inte i mallen och behöver kompletteras manuellt/.test(w),
      ),
    ).toBeUndefined()
  })
})

// R2: write-downs are offered to K2 and K3 alike, and ÅRL 5 kap. 8 § p. 5
// asks for årets nedskrivningar in the note. A note that leaves them out
// neither says so nor ties to the balansräkning.
describe('buildArsredovisningData: write-downs in the anläggningar note (ÅRL 5:8 § p. 5)', () => {
  const PERIODS = [{ id: 'fp1', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' }]
  const adjustment = (id: string, kind: 'impairment' | 'reversal', date: string, amount: number) => ({
    id,
    asset_id: 'mark-1',
    component_id: null,
    kind,
    adjustment_date: date,
    fiscal_period_id: 'fp1',
    amount,
    recoverable_amount: null,
    reason: 'Värdenedgång',
    expense_account: '7720',
    accumulated_account: '1118',
    journal_entry_id: `je-${id}`,
    created_at: '2025-06-30T00:00:00Z',
    journal_entry: { status: 'posted' },
  })
  // Mark for 900 000: 100 000 written down in 2024, 50 000 more in 2025 and
  // 20 000 of it reversed. Utgående nedskrivningar 130 000, redovisat värde 770 000.
  const mark = {
    id: 'mark-1',
    name: 'Tomt',
    category: 'land',
    acquisition_date: '2020-01-01',
    acquisition_cost: 900_000,
    salvage_value: 0,
    useful_life_months: 0,
    depreciation_method: 'linear',
    bas_asset_account: '1130',
    bas_accumulated_account: '1118',
    bas_expense_account: '7820',
    disposed_at: null,
    k3_components: null,
    components: [],
    value_adjustments: [
      adjustment('w1', 'impairment', '2024-12-31', 100_000),
      adjustment('w2', 'impairment', '2025-06-30', 50_000),
      adjustment('r1', 'reversal', '2025-12-31', 20_000),
    ],
  }
  const tbRow = (account: string, debit: number, credit: number) => ({
    account_number: account,
    account_name: account,
    account_class: 1,
    opening_debit: 0,
    opening_credit: 0,
    period_debit: 0,
    period_credit: 0,
    closing_debit: debit,
    closing_credit: credit,
  })
  function plantMark(writtenDownOnBooks: number) {
    mockFetchAllRows.mockResolvedValue(PERIODS)
    mockedListAssets.mockResolvedValue([mark] as never)
    mockedTrialBalance.mockResolvedValue({
      rows: [tbRow('1130', 900_000, 0), tbRow('1118', 0, writtenDownOnBooks)],
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    } as never)
  }

  for (const framework of ['k2', 'k3'] as const) {
    it(`${framework.toUpperCase()}: shows the year's write-down and reversal and ties to the books`, async () => {
      plantMark(130_000)
      const supabase = makeSupabase({ accountingFramework: framework })
      // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
      const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
      const note = data.noter.find((n) => n.title === 'Anläggningstillgångar')
      expect(note?.body).toContain('Mark')
      expect(note?.body).toMatch(/Ingående ackumulerade nedskrivningar: -100\s000 kr/)
      expect(note?.body).toMatch(/Årets nedskrivningar: -50\s000 kr/)
      expect(note?.body).toMatch(/Årets återförda nedskrivningar: 20\s000 kr/)
      expect(note?.body).toMatch(/Utgående ackumulerade nedskrivningar: -130\s000 kr/)
      expect(note?.body).toMatch(/Utgående redovisat värde: 770\s000 kr/)
      expect(data.errors).toBeUndefined()
      expect(data.warnings.find((w) => w.startsWith('Anläggningsnotens'))).toBeUndefined()
    })

    it(`${framework.toUpperCase()}: blocks a note that does not tie while the register holds write-downs`, async () => {
      // The reversal never reached 1118: the books say 150 000.
      plantMark(150_000)
      const supabase = makeSupabase({ accountingFramework: framework })
      // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
      const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
      expect(data.errors).toEqual([expect.stringMatching(/^Anläggningsnotens .*innan årsredovisningen kan låsas/)])
      expect(data.warnings.find((w) => w.startsWith('Anläggningsnotens'))).toBeUndefined()
    })
  }
})

// The merge of Phases 1 and 2: each nedskrivning has one source. Posted
// through the register, it is in the roll-forward; the ledger's write-down
// accounts beyond that (booked by hand, or before Accounted) are in the
// ledger note. Never both, and the tie-out counts each once.
describe('buildArsredovisningData: one source per nedskrivning', () => {
  const PERIODS = [{ id: 'fp1', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' }]
  const IMPAIRMENT_ACCOUNT = 'Ackumulerade nedskrivningar på byggnader och mark'
  const adjustment = (id: string, kind: 'impairment' | 'reversal', date: string, amount: number) => ({
    id,
    asset_id: 'mark-1',
    component_id: null,
    kind,
    adjustment_date: date,
    fiscal_period_id: 'fp1',
    amount,
    recoverable_amount: null,
    reason: 'Värdenedgång',
    expense_account: '7720',
    accumulated_account: '1118',
    journal_entry_id: `je-${id}`,
    created_at: '2025-06-30T00:00:00Z',
    journal_entry: { status: 'posted' },
  })
  const mark = (valueAdjustments: unknown[]) => ({
    id: 'mark-1',
    name: 'Tomt',
    category: 'land',
    acquisition_date: '2020-01-01',
    acquisition_cost: 900_000,
    salvage_value: 0,
    useful_life_months: 0,
    depreciation_method: 'linear',
    bas_asset_account: '1130',
    bas_accumulated_account: '1118',
    bas_expense_account: '7820',
    disposed_at: null,
    k3_components: null,
    components: [],
    value_adjustments: valueAdjustments,
  })
  // Through the register: 100 000 in 2024; in 2025 50 000 more and 20 000 reversed.
  const REGISTER = [
    adjustment('w1', 'impairment', '2024-12-31', 100_000),
    adjustment('w2', 'impairment', '2025-06-30', 50_000),
    adjustment('r1', 'reversal', '2025-12-31', 20_000),
  ]
  function plant(adjustments: unknown[], ledger: { opening: number; written: number; released: number }) {
    const closing = ledger.opening + ledger.written - ledger.released
    mockFetchAllRows.mockResolvedValue(PERIODS)
    mockedListAssets.mockResolvedValue([mark(adjustments)] as never)
    mockedTrialBalance.mockResolvedValue({
      rows: [
        {
          account_number: '1130', account_name: 'Mark', account_class: 1,
          opening_debit: 900_000, opening_credit: 0, period_debit: 0, period_credit: 0,
          closing_debit: 900_000, closing_credit: 0,
        },
        {
          account_number: '1118', account_name: IMPAIRMENT_ACCOUNT, account_class: 1,
          opening_debit: 0, opening_credit: ledger.opening, period_debit: ledger.released, period_credit: ledger.written,
          closing_debit: 0, closing_credit: closing,
        },
      ],
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    } as never)
  }
  async function build(framework: 'k2' | 'k3') {
    const supabase = makeSupabase({ accountingFramework: framework })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    return {
      data,
      rollforward: data.noter.find((n) => n.title === 'Anläggningstillgångar')?.body ?? '',
      ledger: data.noter.find((n) => n.title === 'Nedskrivningar av anläggningstillgångar')?.body,
    }
  }
  const tiesOut = (data: { errors?: string[]; warnings: string[] }) => {
    expect(data.errors).toBeUndefined()
    expect(data.warnings.find((w) => w.startsWith('Anläggningsnotens'))).toBeUndefined()
  }

  for (const framework of ['k3', 'k2'] as const) {
    it(`${framework.toUpperCase()}: a write-down posted through the register is shown once, in the roll-forward`, async () => {
      plant(REGISTER, { opening: 100_000, written: 50_000, released: 20_000 })
      const { data, rollforward, ledger } = await build(framework)
      expect(rollforward).toMatch(/Årets nedskrivningar: -50\s000 kr/)
      expect(rollforward).toMatch(/Utgående redovisat värde: 770\s000 kr/)
      expect(ledger).toBeUndefined()
      tiesOut(data)
    })

    it(`${framework.toUpperCase()}: a write-down booked by hand is shown from the ledger`, async () => {
      plant([], { opening: 0, written: 40_000, released: 0 })
      const { data, rollforward, ledger } = await build(framework)
      expect(rollforward).not.toContain('nedskrivningar')
      expect(ledger).toContain(IMPAIRMENT_ACCOUNT)
      expect(ledger).toMatch(/Årets nedskrivningar: -40\s000 kr/)
      expect(ledger).not.toContain('utanför anläggningsregistret')
      tiesOut(data)
    })

    it(`${framework.toUpperCase()}: with both, the ledger note shows only what the register did not book`, async () => {
      // 30 000 more booked by hand on 1118 in 2025, beside the register's.
      plant(REGISTER, { opening: 100_000, written: 80_000, released: 20_000 })
      const { data, rollforward, ledger } = await build(framework)
      expect(rollforward).toMatch(/Årets nedskrivningar: -50\s000 kr/)
      expect(rollforward).toMatch(/Utgående ackumulerade nedskrivningar: -130\s000 kr/)
      expect(ledger).toContain('utanför anläggningsregistret')
      expect(ledger).toMatch(/Ingående nedskrivningar: 0 kr/)
      expect(ledger).toMatch(/Årets nedskrivningar: -30\s000 kr/)
      expect(ledger).toMatch(/Utgående nedskrivningar: -30\s000 kr/)
      tiesOut(data)
    })
  }
})

describe('buildArsredovisningData: note overrides', () => {
  it('K3: replaces note 1 with the user text and keeps the generated text for reset', async () => {
    const supabase = makeSupabase({
      accountingFramework: 'k3',
      noteOverrides: { redovisningsprinciper: 'Egen principtext.' },
    })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    const principles = data.noter.find((n) => n.key === 'redovisningsprinciper')
    expect(principles?.number).toBe(1)
    expect(principles?.body).toBe('Egen principtext.')
    expect(principles?.generated_body).toContain('BFNAR 2012:1')
  })

  it('K3: a text written for the events-after note before the matrix stands as its answer', async () => {
    const supabase = makeSupabase({
      accountingFramework: 'k3',
      noteOverrides: { vasentliga_handelser_efter_balansdagen: 'Bolaget sålde sin fastighet i mars.' },
    })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.disclosures.disclosure_answers?.['not.handelser_efter_balansdagen']).toEqual({
      applies: true,
      text: 'Bolaget sålde sin fastighet i mars.',
    })
  })

  it('K3: ignores unknown keys stored in the column', async () => {
    const supabase = makeSupabase({
      accountingFramework: 'k3',
      noteOverrides: { medelantal_anstallda: 'Tio.' },
    })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    const note = data.noter.find((n) => n.title === 'Medelantal anställda')
    expect(note?.body).not.toBe('Tio.')
  })

  it('K2: overrides are not applied (the K2 notes feed the iXBRL filing)', async () => {
    const supabase = makeSupabase({
      accountingFramework: 'k2',
      noteOverrides: { redovisningsprinciper: 'Egen principtext.' },
    })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    const principles = data.noter.find((n) => n.title.startsWith('Redovisnings'))
    expect(principles?.body).toContain('BFNAR 2016:10')
    expect(principles?.key).toBeUndefined()
  })

  it('carries the cash-flow omission choice without deciding it (model.ts does)', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k3', omitCashFlow: true })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.disclosures.omit_kassaflodesanalys).toBe(true)
    expect(data.kassaflodesanalys).toBeDefined()
  })
})

describe('buildArsredovisningData: K2 byte-equivalence', () => {
  it('keeps tax and appropriations in the statutory pre-closing balance', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k2' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    await buildArsredovisningData(supabase, 'co1', 'fp1')

    expect(mockedTrialBalance).toHaveBeenCalledWith(
      expect.anything(),
      'co1',
      'fp1',
      expect.objectContaining({ closingEntry: 'exclude-final' }),
    )
    expect(mockedTrialBalance).not.toHaveBeenCalledWith(
      expect.anything(),
      'co1',
      'fp1',
      expect.objectContaining({ closingEntry: 'exclude-all-year-end' }),
    )
  })

  it('reuses the current-period mapping in the multi-year overview', async () => {
    mockFetchAllRows.mockResolvedValueOnce([
      {
        id: 'fp1',
        name: '2025',
        period_start: '2025-01-01',
        period_end: '2025-12-31',
      },
    ])
    const supabase = makeSupabase({ accountingFramework: 'k2' })

    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    await buildArsredovisningData(supabase, 'co1', 'fp1')

    const currentPeriodCalls = mockedTrialBalance.mock.calls.filter((call) => call[2] === 'fp1')
    expect(currentPeriodCalls).toHaveLength(2)
  })

  it('records accounting_framework=k2', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k2' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.accounting_framework).toBe('k2')
  })

  it('OMITS kassaflödesanalys when framework is K2', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k2' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.kassaflodesanalys).toBeUndefined()
  })

  it('carries the same equity specification for K2 (ÅRL 6 kap. 2 § andra stycket)', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k2' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.equity_changes_statement).toBeUndefined()
    expect(data.equity_specification?.current.totals.closing).toBe(
      data.balansrakning.equity_liabilities.find((r) => r.semantic_key === 'balance_sheet_equity_total')?.current,
    )
  })

  it('emits the K2-style redovisningsprinciper note (BFNAR 2016:10)', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k2' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    const principles = data.noter.find((n) => n.title.startsWith('Redovisnings'))
    expect(principles).toBeDefined()
    expect(principles!.body).toContain('BFNAR 2016:10')
  })

  it('derives kvotvärde in the K2 aktiekapital note', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k2', aktiekapital: 25_000 })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    const note = data.noter.find((n) => n.title === 'Aktiekapital')
    expect(note).toBeDefined()
    expect(note!.body).toContain('Antal aktier: 500.')
    expect(note!.body).toContain('Kvotvärde per aktie: 50 kr.')
  })

  it('treats a partial share-capital pair as missing (warns, no note) for K2', async () => {
    const supabase = makeSupabase({
      accountingFramework: 'k2',
      aktiekapital: 25_000,
      antalAktier: null,
    })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.noter.find((n) => n.title === 'Aktiekapital')).toBeUndefined()
    expect(data.warnings.find((w) => w.startsWith('Aktiekapitalnoten saknas'))).toBeDefined()
  })

  it('does NOT call generateKassaflodesanalys for K2', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k2' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(mockedKassaflode).not.toHaveBeenCalled()
  })
})

describe('buildArsredovisningData: K3 balance sheet posts (K3 4.3, ÅRL bilaga 1)', () => {
  beforeEach(() => {
    plantStandardReports()
  })

  it('K3: shows the deferred tax liability (2240) as a post of its own, with the totals unchanged', async () => {
    const k3 = makeSupabase({ accountingFramework: 'k3' })
    const k2 = makeSupabase({ accountingFramework: 'k2' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const k3Data = await buildArsredovisningData(k3, 'co1', 'fp1')
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const k2Data = await buildArsredovisningData(k2, 'co1', 'fp1')
    const label = (rows: { label: string; current: number | null }[], name: string) =>
      rows.find((r) => r.label === name)?.current
    expect(label(k3Data.balansrakning.equity_liabilities, 'Avsättningar för uppskjutna skatter')).toBe(70_600)
    expect(label(k3Data.balansrakning.equity_liabilities, 'Övriga avsättningar')).toBeUndefined()
    expect(label(k2Data.balansrakning.equity_liabilities, 'Uppskjuten skatteskuld')).toBeUndefined()
    expect(label(k2Data.balansrakning.equity_liabilities, 'Övriga avsättningar')).toBe(70_600)
    expect(k3Data.balansrakning.total_equity_liabilities).toBe(k2Data.balansrakning.total_equity_liabilities)
    expect(label(k3Data.balansrakning.equity_liabilities, 'Summa avsättningar')).toBe(
      label(k2Data.balansrakning.equity_liabilities, 'Summa avsättningar'),
    )
  })
})

describe('buildArsredovisningData: framework per räkenskapsår (BFNAR 2012:4)', () => {
  it('builds the year under its own framework, not the company default', async () => {
    // The company has since moved to K3; this year was prepared under K2.
    const supabase = makeSupabase({ accountingFramework: 'k3', yearFramework: { framework: 'k2' } })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.accounting_framework).toBe('k2')
    expect(data.kassaflodesanalys).toBeUndefined()
  })

  it('states the reasons for a switch from K3 to K2 in the principles note (punkt 3)', async () => {
    const supabase = makeSupabase({
      accountingFramework: 'k2',
      yearFramework: { framework: 'k2', change_reason: 'Verksamheten har minskat och bolaget är ett mindre företag.' },
    })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    const principles = data.noter.find((n) => n.title.startsWith('Redovisnings'))!
    expect(principles.body).toContain('BFNAR 2016:10')
    expect(principles.body).toContain('Byte av regelverk')
    expect(principles.body).toContain('Verksamheten har minskat och bolaget är ett mindre företag.')
  })

  it('leaves the K2 principles note unchanged without a switch', async () => {
    const withRow = makeSupabase({ accountingFramework: 'k2', yearFramework: { framework: 'k2' } })
    const without = makeSupabase({ accountingFramework: 'k2' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const a = await buildArsredovisningData(withRow, 'co1', 'fp1')
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const b = await buildArsredovisningData(without, 'co1', 'fp1')
    expect(a.noter[0]).toEqual(b.noter[0])
  })
})

describe('buildArsredovisningData: prior-period TB dedupe (multi-year)', () => {
  // Current period + previous year + 2 older years: exercises both the
  // comparative pair and the full flerårsöversikt window at once.
  const FOUR_PERIODS = [
    { id: 'fp1', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' },
    { id: 'fp0', name: '2024', period_start: '2024-01-01', period_end: '2024-12-31' },
    { id: 'fpA', name: '2023', period_start: '2023-01-01', period_end: '2023-12-31' },
    { id: 'fpB', name: '2022', period_start: '2022-01-01', period_end: '2022-12-31' },
  ]

  it('fetches each prior-period TB pair exactly once (previous year is no longer fetched twice)', async () => {
    mockFetchAllRows.mockResolvedValue(FOUR_PERIODS)
    const supabase = makeSupabase({ accountingFramework: 'k2', previousPeriodId: 'fp0' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    await buildArsredovisningData(supabase, 'co1', 'fp1')

    const callsFor = (periodId: string) =>
      mockedTrialBalance.mock.calls.filter((call) => call[2] === periodId)
    // Current period: full + statutory pre-closing from the statement batch.
    expect(callsFor('fp1')).toHaveLength(2)
    // Previous year: ONE pair, shared by the comparatives and the overview
    // (the sequential version fetched it twice: 4 calls).
    expect(callsFor('fp0')).toHaveLength(2)
    // Each older overview year: one pair.
    expect(callsFor('fpA')).toHaveLength(2)
    expect(callsFor('fpB')).toHaveLength(2)
    expect(mockedTrialBalance).toHaveBeenCalledTimes(8)
  })

  it('K3: drops the duplicate noter TB fetch and keeps output byte-identical', async () => {
    mockFetchAllRows.mockResolvedValue(FOUR_PERIODS)
    const supabase = makeSupabase({ accountingFramework: 'k3', previousPeriodId: 'fp0' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')

    // buildK3Noter used to fetch the current-period full TB a third time;
    // it now reuses the statement batch's rows.
    const currentPeriodCalls = mockedTrialBalance.mock.calls.filter((call) => call[2] === 'fp1')
    expect(currentPeriodCalls).toHaveLength(2)

    // Deep-equality against the output captured from the sequential
    // implementation: same rows, same note numbering, same warning order.
    expect(data.forvaltningsberattelse.flerarsoversikt).toEqual(
      multiYearSnapshot.flerarsoversikt,
    )
    expect(data.noter).toEqual(multiYearSnapshot.noter)
    expect(data.warnings).toEqual(multiYearSnapshot.warnings)
  })
})

describe('buildArsredovisningData: comparison year without bookkeeping', () => {
  // A previous year that exists but holds no entries in Accounted (done in
  // another system, klarmarkerad here) gives an all-zero comparison column.
  // ÅRL 3 kap. 5 § requires the prior year's amount per post, so the report
  // must say why the column reads 0 kr and where the fix lives.
  const TWO_PERIODS = [
    { id: 'fp1', name: 'Räkenskapsår 2025/2026', period_start: '2025-09-01', period_end: '2026-08-31' },
    { id: 'fp0', name: 'Räkenskapsår 2024/2025', period_start: '2024-06-03', period_end: '2025-08-31' },
  ]
  const EMPTY_TB = { rows: [], totalDebit: 0, totalCredit: 0, isBalanced: true }

  it('warns when the previous year has no entries at all', async () => {
    mockFetchAllRows.mockResolvedValue(TWO_PERIODS)
    const standard = await mockedTrialBalance.getMockImplementation()
    mockedTrialBalance.mockImplementation(async (client, companyId, periodId, opts) =>
      periodId === 'fp0' ? EMPTY_TB : standard!(client, companyId, periodId, opts),
    )
    const supabase = makeSupabase({ accountingFramework: 'k2', previousPeriodId: 'fp0', period: TWO_PERIODS[0] })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')

    const warning = data.warnings.find((w) => w.startsWith('Föregående räkenskapsår'))
    expect(warning).toBeDefined()
    expect(warning).toContain('Räkenskapsår 2024/2025')
    expect(warning).toContain('saknar bokföring i Accounted')
    expect(warning).toContain('Inställningar > Bokföring > Räkenskapsår')
    // The comparison year is still there: the column reads 0 kr, not "none".
    expect(data.previous_period?.name).toBe('Räkenskapsår 2024/2025')
  })

  it('stays silent when the previous year carries balances', async () => {
    mockFetchAllRows.mockResolvedValue(TWO_PERIODS)
    const supabase = makeSupabase({ accountingFramework: 'k2', previousPeriodId: 'fp0', period: TWO_PERIODS[0] })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')

    expect(data.warnings.find((w) => w.startsWith('Föregående räkenskapsår'))).toBeUndefined()
  })
})

describe('buildArsredovisningData: comparison year never closed in the books (crm#1080)', () => {
  // 2024 was closed in another system and came in without its closing entry:
  // the 40 000 kr result is still on the result accounts, 2099 is empty. 2025
  // is closed here. Every consumer below reads the one mapping, so the
  // statements, the flerårsöversikt and the K3 equity statement agree.
  const TWO_YEARS = [
    { id: 'fp1', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' },
    { id: 'fp0', name: '2024', period_start: '2024-01-01', period_end: '2024-12-31' },
  ]
  const NEVER_CLOSED = { full: PREVIOUS.preClosing, preClosing: PREVIOUS.preClosing }
  // Equity at each year's start (credit): 2024 opened on 25 000 + 60 000; 2025
  // opened with the 2024 result still on 2099, as the other system's IB left it.
  const EQUITY_OPENING: Record<string, Record<string, number>> = {
    fp0: { '2081': 25_000, '2091': 60_000 },
    fp1: { '2081': 25_000, '2091': 60_000, '2099': 40_000 },
  }
  const tbRows = (rows: TrialBalanceRowLike[], periodId: string): TrialBalanceRow[] =>
    rows.map((r) => ({
      ...r,
      account_class: Number(r.account_number[0]),
      opening_debit: 0,
      opening_credit: EQUITY_OPENING[periodId]?.[r.account_number] ?? 0,
      period_debit: 0,
      period_credit: 0,
    }))
  // 2025's equity verifikat: last year's result balanced, the year closed.
  const EQUITY_ENTRIES = [
    {
      id: 'je-disp',
      voucher_series: 'A',
      voucher_number: 1,
      entry_date: '2025-01-01',
      description: 'Resultatdisposition',
      status: 'posted',
      source_type: 'result_appropriation',
      source_id: null,
      reverses_id: null,
      correction_of_id: null,
      lines: [
        { id: 'l1', account_number: '2099', debit_amount: 40_000, credit_amount: 0 },
        { id: 'l2', account_number: '2091', debit_amount: 0, credit_amount: 40_000 },
      ],
    },
    {
      id: 'je-close',
      voucher_series: 'A',
      voucher_number: 99,
      entry_date: '2025-12-31',
      description: 'Årets resultat',
      status: 'posted',
      source_type: 'year_end',
      source_id: null,
      reverses_id: null,
      correction_of_id: null,
      lines: [
        { id: 'l3', account_number: '8999', debit_amount: 120_000, credit_amount: 0 },
        { id: 'l4', account_number: '2099', debit_amount: 0, credit_amount: 120_000 },
      ],
    },
  ]

  beforeEach(() => {
    mockFetchAllRows.mockResolvedValue(TWO_YEARS)
    mockedTrialBalance.mockImplementation(async (_client, _companyId, periodId, opts) => {
      const pair = periodId === 'fp0' ? NEVER_CLOSED : CURRENT
      return {
        rows: tbRows(opts.closingEntry === 'include' ? pair.full : pair.preClosing, periodId),
        totalDebit: 0,
        totalCredit: 0,
        isBalanced: true,
      }
    })
  })

  it('K2: the comparison column shows the result and balances, with one notice', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k2', previousPeriodId: 'fp0' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')

    expect(data.balansrakning.total_assets_previous).toBe(253_000)
    expect(data.balansrakning.total_equity_liabilities_previous).toBe(253_000)
    const equityRow = (key: string) =>
      data.balansrakning.equity_liabilities.find((r) => r.semantic_key === key)
    expect(equityRow('balance_sheet_current_year_result')).toMatchObject({
      current: 120_000,
      previous: 40_000,
    })
    expect(equityRow('balance_sheet_equity_total')).toMatchObject({
      current: 245_000,
      previous: 125_000,
    })
    expect(
      data.resultatrakning.find((r) => r.semantic_key === 'income_statement_result'),
    ).toMatchObject({ current: 120_000, previous: 40_000 })
    expect(data.warnings.filter((w) => w.includes('ämförelse'))).toEqual([
      'Jämförelseåret avslutades aldrig i bokföringen: årets resultat (40000 kr) står kvar på resultatkontona. Årets resultat i jämförelseårets balansräkning är därför hämtat från resultaträkningen. Stäm av jämförelsetalen mot föregående års fastställda årsredovisning.',
    ])
    // The current year is as booked: nothing to demand, nothing derived.
    expect(data.balansrakning.total_assets).toBe(380_000)
    expect(data.balansrakning.total_equity_liabilities).toBe(380_000)
    expect(data.warnings.some((w) => w.startsWith('Årets resultat enligt'))).toBe(false)
  })

  it('K2: the flerårsöversikt computes soliditet for that year on the same equity', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k2', previousPeriodId: 'fp0' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')

    // 2024: (125 000 eget kapital + 79,4 % of 30 000 periodiseringsfond) /
    // 253 000. On the booked equity (85 000) it read 43,0 %.
    expect(data.forvaltningsberattelse.flerarsoversikt).toEqual([
      { year: '2024', net_revenue: 500_000, result_after_financial: 60_000, soliditet_pct: 58.8 },
      { year: '2025', net_revenue: 1_000_000, result_after_financial: 151_340, soliditet_pct: 72.8 },
    ])
  })

  it('K3: the equity specification opens on the derived equity and reads the year from its verifikat', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k3', previousPeriodId: 'fp0', equityEntries: EQUITY_ENTRIES })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')

    // Opening on the comparison column (the 40 000 kr result derived for
    // 2024); the year's movements from its two verifikat. Read as booked the
    // opening was 85 000 and the old statement printed the gap as a
    // nyemission that never took place.
    const spec = data.equity_specification!
    expect(spec.current.posts.map(({ concept, opening, movements, closing }) => ({ concept, opening, movements, closing }))).toEqual([
      { concept: 'Aktiekapital', opening: 25_000, movements: {}, closing: 25_000 },
      { concept: 'BalanseratResultat', opening: 60_000, movements: { resultatdisposition: 40_000 }, closing: 100_000 },
      {
        concept: 'AretsResultatEgetKapital',
        opening: 40_000,
        movements: { resultatdisposition: -40_000, arets_resultat: 120_000 },
        closing: 120_000,
      },
    ])
    expect(spec.current.totals).toMatchObject({ opening: 125_000, closing: 245_000 })
    // 2024 was never closed here: its result is the derived one.
    expect(spec.previous?.derived).toBe(true)
    expect(spec.previous?.totals.movements).toEqual({ arets_resultat: 40_000 })
    expect(spec.integrity_issues).toEqual([])
  })
})

describe('buildArsredovisningData: medelantal anställda missing vs zero (feedback seq 366434)', () => {
  const SALARY_ROW = {
    account_number: '7210',
    account_name: 'Löner till tjänstemän',
    account_class: 7,
    opening_debit: 0,
    opening_credit: 0,
    period_debit: 480_000,
    period_credit: 480_000,
    closing_debit: 480_000,
    closing_credit: 480_000,
  }

  function plantSalaryYear() {
    mockedTrialBalance.mockResolvedValue({
      rows: [SALARY_ROW],
      totalDebit: 480_000,
      totalCredit: 480_000,
      isBalanced: true,
    })
  }

  it.each(['k2', 'k3'] as const)(
    '%s: salary posted, no employees, no override: the note says the figure is missing and the preview flags it',
    async (framework) => {
      plantSalaryYear()
      const supabase = makeSupabase({ accountingFramework: framework })
      // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
      const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
      const note = data.noter.find((n) => n.title === 'Medelantal anställda')
      expect(note?.body).toBe(
        'Uppgift om medelantal anställda saknas: ange antalet under Årsredovisning (not Medelantal anställda).',
      )
      expect(note?.body).not.toContain('inte haft några anställda')
      expect(data.warnings.some((w) => w.includes('7000-7399') && w.includes('Medelantal anställda'))).toBe(true)
    },
  )

  it.each(['k2', 'k3'] as const)(
    '%s: an explicit override of 0 next to posted salary is the user\'s statement: "inga anställda", no warning',
    async (framework) => {
      plantSalaryYear()
      const supabase = makeSupabase({ accountingFramework: framework, medelantalOverride: 0 })
      // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
      const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
      const note = data.noter.find((n) => n.title === 'Medelantal anställda')
      expect(note?.body).toBe('Bolaget har inte haft några anställda under räkenskapsåret.')
      expect(data.warnings.some((w) => w.includes('Medelantal anställda'))).toBe(false)
    },
  )

  it.each(['k2', 'k3'] as const)(
    '%s: no salary posted and no employees still reads "inga anställda" without a warning',
    async (framework) => {
      const supabase = makeSupabase({ accountingFramework: framework })
      // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
      const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
      const note = data.noter.find((n) => n.title === 'Medelantal anställda')
      expect(note?.body).toBe('Bolaget har inte haft några anställda under räkenskapsåret.')
      expect(data.warnings.some((w) => w.includes('Medelantal anställda'))).toBe(false)
    },
  )

  it('resolveMedelantalNote: reads period activity on 7000-7399 only', () => {
    const row = (account: string, debit: number, credit: number) => ({
      account_number: account,
      period_debit: debit,
      period_credit: credit,
    })
    const missing = resolveMedelantalNote({ medelantal: 0, hasOverride: false, tbFullRows: [row('7010', 100, 0)] })
    expect(missing.body).toContain('saknas')
    expect(missing.warning).toContain('7000-7399')
    // 7510 (arbetsgivaravgifter) alone, or a 7xxx row with no activity, is not salary.
    expect(resolveMedelantalNote({ medelantal: 0, hasOverride: false, tbFullRows: [row('7510', 100, 0)] }).warning).toBeNull()
    expect(resolveMedelantalNote({ medelantal: 0, hasOverride: false, tbFullRows: [row('7210', 0, 0)] }).warning).toBeNull()
    expect(resolveMedelantalNote({ medelantal: 2, hasOverride: false, tbFullRows: [] }).body).toBe(
      'Under räkenskapsåret har medeltalet anställda uppgått till 2.',
    )
  })
})
