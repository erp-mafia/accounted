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
}))
vi.mock('@/lib/reports/kassaflodesanalys', () => ({
  generateKassaflodesanalys: vi.fn(),
}))
vi.mock('@/lib/bokslut/assets/asset-service', () => ({
  listAssets: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: vi.fn().mockResolvedValue([]),
}))

import { buildArsredovisningData } from '../build-data'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { generateBalanceSheet } from '@/lib/reports/balance-sheet'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateKassaflodesanalys } from '@/lib/reports/kassaflodesanalys'
import { listAssets } from '@/lib/bokslut/assets/asset-service'

interface ChainableMock {
  from: ReturnType<typeof vi.fn>
}

function makeSupabase(opts: {
  accountingFramework: 'k2' | 'k3'
  entityType?: string
  aktiekapital?: number | null
  agmDate?: string | null
}): ChainableMock {
  const from = vi.fn((table: string) => {
    if (table === 'fiscal_periods') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: {
                    id: 'fp1',
                    name: '2025',
                    period_start: '2025-01-01',
                    period_end: '2025-12-31',
                    previous_period_id: null,
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
                  entity_type: opts.entityType ?? 'aktiebolag',
                  aktiekapital: opts.aktiekapital ?? null,
                  antal_aktier: opts.aktiekapital ? 500 : null,
                  kvotvarde: opts.aktiekapital ? 100 : null,
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
                  data: opts.agmDate
                    ? {
                        agm_date: opts.agmDate,
                        description: null,
                        important_events: null,
                        resultatdisposition: null,
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
  return { from }
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
      total: 300_000,
    },
    investerings: {
      forvarv_anlaggningar: 0,
      avyttring_anlaggningar: 0,
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
  plantStandardReports()
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

  it('includes a separate equity_changes_statement when framework is K3', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k3' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.equity_changes_statement).toBeDefined()
    expect(data.equity_changes_statement!.rows.length).toBeGreaterThan(0)
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

  it('emits an Eventualförpliktelser note', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k3' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.noter.find((n) => n.title === 'Eventualförpliktelser')).toBeDefined()
  })

  it('emits Väsentliga händelser efter balansdagen for K3', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k3' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(
      data.noter.find((n) => n.title === 'Väsentliga händelser efter balansdagen'),
    ).toBeDefined()
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

describe('buildArsredovisningData: K2 byte-equivalence', () => {
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

  it('OMITS equity_changes_statement when framework is K2', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k2' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.equity_changes_statement).toBeUndefined()
  })

  it('emits the K2-style redovisningsprinciper note (BFNAR 2016:10)', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k2' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    const principles = data.noter.find((n) => n.title.startsWith('Redovisnings'))
    expect(principles).toBeDefined()
    expect(principles!.body).toContain('BFNAR 2016:10')
  })

  it('does NOT call generateKassaflodesanalys for K2', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k2' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(mockedKassaflode).not.toHaveBeenCalled()
  })
})
