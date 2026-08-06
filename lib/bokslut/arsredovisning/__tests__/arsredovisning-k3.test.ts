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
const mockFetchAllRows = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: mockFetchAllRows,
}))

import { buildArsredovisningData } from '../build-data'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { generateBalanceSheet } from '@/lib/reports/balance-sheet'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateKassaflodesanalys } from '@/lib/reports/kassaflodesanalys'
import { listAssets } from '@/lib/bokslut/assets/asset-service'
// Captured from the sequential (pre-dedupe) implementation: the parallel
// TB-pair fetch must reproduce it byte for byte.
import multiYearSnapshot from './arsredovisning-k3-multiyear-snapshot.json'

interface ChainableMock {
  from: ReturnType<typeof vi.fn>
}

function makeSupabase(opts: {
  accountingFramework: 'k2' | 'k3'
  entityType?: string
  aktiekapital?: number | null
  antalAktier?: number | null
  agmDate?: string | null
  previousPeriodId?: string | null
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
  mockFetchAllRows.mockResolvedValue([])
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

  it('emits Väsentliga händelser efter balansdagen for K3', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k3' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(
      data.noter.find((n) => n.title === 'Väsentliga händelser efter balansdagen'),
    ).toBeDefined()
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
    expect(data.warnings.find((w) => w.startsWith('Aktiekapitalnoten saknas'))).toBeDefined()
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
    expect(data.warnings.find((w) => w.startsWith('Aktiekapitalnoten saknas'))).toBeDefined()
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

describe('buildArsredovisningData: K2 byte-equivalence', () => {
  it('keeps tax and appropriations in the statutory pre-closing balance', async () => {
    const supabase = makeSupabase({ accountingFramework: 'k2' })
    // @ts-expect-error: chainable mock isn't fully typed as SupabaseClient
    await buildArsredovisningData(supabase, 'co1', 'fp1')

    expect(mockedTrialBalance).toHaveBeenCalledWith(
      expect.anything(),
      'co1',
      'fp1',
      { closingEntry: 'exclude-final' },
    )
    expect(mockedTrialBalance).not.toHaveBeenCalledWith(
      expect.anything(),
      'co1',
      'fp1',
      { closingEntry: 'exclude-all-year-end' },
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
