/**
 * buildArsredovisningData for a bostadsrättsförening: the ÅRL 6 kap. 3 a §
 * and BFNAR 2012:1 kapitel 38 block (brf_disclosures), the kassaflödesanalys
 * under K2 (ÅRL 2 kap. 1 §), the nettoomsättning note (38.13) and the fond
 * för yttre underhåll rows of the K3 equity statement (38.11-38.12). An
 * aktiebolag built by the same code carries none of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/reports/trial-balance', () => ({ generateTrialBalance: vi.fn() }))
vi.mock('@/lib/reports/kassaflodesanalys', () => ({ generateKassaflodesanalys: vi.fn() }))
vi.mock('@/lib/bokslut/assets/asset-service', () => ({ listAssets: vi.fn().mockResolvedValue([]) }))
const mockFetchAllRows = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/fetch-all', () => ({ fetchAllRows: mockFetchAllRows }))

import { buildArsredovisningData, buildK3EquityChangesStatement, fondYttreUnderhallMovement } from '../build-data'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateKassaflodesanalys } from '@/lib/reports/kassaflodesanalys'
import { listAssets } from '@/lib/bokslut/assets/asset-service'
import { mapTrialBalancesToK2 } from '@/lib/bokslut/ixbrl/k2-mapper'
import type { TrialBalanceRow } from '@/types'

const mockedTrialBalance = vi.mocked(generateTrialBalance)
const mockedKassaflode = vi.mocked(generateKassaflodesanalys)
const mockedListAssets = vi.mocked(listAssets)

function tb(account: string, opening: number, period: number): TrialBalanceRow {
  // Positive = credit balance / credit movement, negative = debit.
  const closing = opening + period
  return {
    account_number: account,
    account_name: account,
    account_class: Number(account[0]),
    opening_debit: opening < 0 ? -opening : 0,
    opening_credit: opening > 0 ? opening : 0,
    period_debit: period < 0 ? -period : 0,
    period_credit: period > 0 ? period : 0,
    closing_debit: closing < 0 ? -closing : 0,
    closing_credit: closing > 0 ? closing : 0,
  }
}

// A BRF year: 1 000 000 in årsavgifter, 200 000 lokalhyra, 300 000
// avskrivningar, 100 000 energy, 150 000 ränta, a 10 MSEK loan, insatser 20
// MSEK, upplåtelseavgifter 1 MSEK, a fond för yttre underhåll of 500 000
// with a 150 000 reservering and 50 000 ianspråktagande during the year.
function brfRows(result: number): { full: TrialBalanceRow[]; preClosing: TrialBalanceRow[] } {
  const rr = [
    tb('3020', 0, 1_000_000),
    tb('3012', 0, 200_000),
    tb('7830', 0, -300_000),
    tb('5370', 0, -100_000),
    tb('8410', 0, -150_000),
    tb('5170', 0, -(1_000_000 + 200_000 - 300_000 - 100_000 - 150_000 - result)),
  ]
  // 2088: a 150 000 reservering (credit) and a 50 000 ianspråktagande (debit)
  // in the same year, net +100 000, mirrored on 2091.
  const fond: TrialBalanceRow = {
    ...tb('2088', 500_000, 100_000),
    period_debit: 50_000,
    period_credit: 150_000,
  }
  // Bank chosen so the balance sheet balances at opening (4 900 000) and at
  // closing (5 200 000 + result).
  const br = [
    tb('1110', -30_000_000, 0),
    tb('1119', 3_000_000, 300_000),
    tb('1930', -4_900_000, -(300_000 + result)),
    tb('2350', 10_000_000, 0),
    tb('2083', 20_000_000, 0),
    tb('2087', 1_000_000, 0),
    fond,
    tb('2091', 400_000, -100_000),
    tb('2099', 0, result),
  ]
  return { full: [...br], preClosing: [...br.filter((r) => r.account_number !== '2099'), ...rr] }
}

function makeSupabase(opts: {
  entityType: string
  accountingFramework: 'k2' | 'k3'
  facts?: Record<string, unknown> | null
  profile?: Record<string, unknown> | null
  narrative?: Record<string, unknown> | null
}) {
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
                    name: '2026',
                    period_start: '2026-01-01',
                    period_end: '2026-12-31',
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
                data: { company_name: 'Brf Testhuset', org_number: '769600-0001', city: 'Uppsala', entity_type: opts.entityType },
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
                data: { entity_type: opts.entityType, accounting_framework: opts.accountingFramework },
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
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: opts.narrative ?? null, error: null }) }),
          }),
        }),
      }
    }
    if (table === 'brf_property_facts') {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: opts.facts ?? null, error: null }) }),
        }),
      }
    }
    if (table === 'brf_tax_profiles') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: opts.profile ?? null, error: null }) }),
          }),
        }),
      }
    }
    if (table === 'employees') {
      return { select: () => ({ eq: () => ({ eq: () => Promise.resolve({ count: 0, error: null }) }) }) }
    }
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: null, error: null }),
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
    }
  })
  return { from }
}

const facts = {
  kvm_bostadsratt: 5_000,
  kvm_hyresratt: 0,
  kvm_lokaler: 400,
  kvm_lokaler_bostadsratt: null,
  antal_bostadslagenheter: 60,
  antal_lokaler: 2,
  taxeringsvarde: 80_000_000,
  tomtratt: true,
  tomtratt_avgald_until: '2031-12-31',
  tomtratt_expires_on: '2050-12-31',
  samfallighet: null,
  underhallsplan: true,
  notes: null,
}

function plant(result: number) {
  const rows = brfRows(result)
  mockedTrialBalance.mockImplementation(async (_s, _c, _p, options) => {
    const closing = (options as { closingEntry?: string } | undefined)?.closingEntry
    const set = closing === 'include' ? rows.full : rows.preClosing
    return { rows: set, totalDebit: 0, totalCredit: 0, isBalanced: true }
  })
  mockedKassaflode.mockResolvedValue({
    fiscal_period_id: 'fp1',
    period_start: '2026-01-01',
    period_end: '2026-12-31',
    lopande: {
      resultat_efter_finansiella_poster: result,
      avskrivningar: 300_000,
      ovriga_ej_kassaflodesposter: 0,
      delta_kortfristiga_fordringar: 0,
      delta_varulager: 0,
      delta_kortfristiga_skulder: 0,
      skatt_betald: 0,
      total: result + 300_000,
    },
    investerings: { forvarv_anlaggningar: 0, avyttring_anlaggningar: 0, total: 0 },
    finansierings: { delta_lan: 0, utdelningar: 0, nyemission: 0, erhallna_aktieagartillskott: 0, total: 0 },
    total_cash_flow: result + 300_000,
    reconciliation: {
      opening_cash_1xxx: 2_000_000,
      closing_cash_1xxx: 2_000_000 + result + 300_000,
      delta_actual: result + 300_000,
      delta_calculated: result + 300_000,
      mismatch_amount: 0,
      is_reconciled: true,
    },
  })
  mockedListAssets.mockResolvedValue([])
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetchAllRows.mockResolvedValue([
    { id: 'fp1', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' },
  ])
  plant(150_000)
})

describe('buildArsredovisningData: bostadsrättsförening', () => {
  it('attaches brf_disclosures with the year\'s nyckeltal, the 38.2 statements and the 38.13 note (K3)', async () => {
    const supabase = makeSupabase({
      entityType: 'bostadsrattsforening',
      accountingFramework: 'k3',
      facts,
      profile: { privatbostadsforetag: true, fiscal_year: 2026 },
      narrative: { energikostnad_vidaredebiterad: 20_000 },
    })
    // @ts-expect-error: chainable mock
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    const brf = data.forvaltningsberattelse.brf_disclosures
    expect(brf).toBeDefined()
    expect(brf!.privatbostadsforetag).toBe(true)
    expect(brf!.tomtratt).toBe(true)
    expect(brf!.tomtratt_expires_on).toBe('2050-12-31')
    expect(brf!.underhallsplan).toBe(true)
    expect(brf!.facts_missing).toEqual([])
    expect(brf!.energikostnad_vidaredebiterad).toBe(20_000)
    expect(brf!.nyckeltal).toHaveLength(1)
    const row = brf!.nyckeltal[0]
    expect(row.year).toBe('2026')
    expect(row.arsavgift_per_kvm_bostadsratt).toBe(200) // 1 000 000 / 5 000
    expect(row.skuldsattning_per_kvm).toBe(1_852) // 10 000 000 / 5 400
    expect(row.skuldsattning_per_kvm_bostadsratt).toBe(2_000)
    expect(row.rantekanslighet_pct).toBe(10) // 100 000 / 1 000 000
    expect(row.energikostnad_per_kvm).toBe(19) // 100 000 / 5 400
    expect(row.nettoomsattning).toBe(1_200_000)
    expect(brf!.nettoomsattning_split.arsavgifter_bostader).toBe(1_000_000)
    expect(brf!.nettoomsattning_split.hyror_lokaler).toBe(200_000)
    expect(brf!.nettoomsattning_split.total).toBe(1_200_000)
    // The building is carried on 1110 and the register has no components.
    expect(brf!.building_without_components).toBe(true)
    const note = data.noter.find((n) => n.title === 'Nettoomsättningens fördelning')
    expect(note?.body).toContain('Årsavgifter bostäder: 1 000 000 kr')
    expect(note?.body).toContain('punkt 38.13')
    // The disclosure inputs are echoed for the editor.
    expect(data.disclosures.energikostnad_vidaredebiterad).toBe(20_000)
    expect(data.disclosures.loss_financing_explanation).toBeNull()
  })

  it('shows the fond för yttre underhåll omföringar in the K3 equity statement (38.11-38.12)', async () => {
    const supabase = makeSupabase({ entityType: 'bostadsrattsforening', accountingFramework: 'k3', facts, profile: null })
    // @ts-expect-error: chainable mock
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    const rows = data.equity_changes_statement!.rows
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.amount]))
    expect(byLabel['Ingående fond för yttre underhåll']).toBe(500_000)
    expect(byLabel['Reservering till fond för yttre underhåll']).toBe(150_000)
    expect(byLabel['Ianspråktagande av fond för yttre underhåll']).toBe(-50_000)
    expect(byLabel['Omföring till/från balanserat resultat']).toBe(-100_000)
    // The omföringar do not change total equity; no utdelning is invented.
    expect(rows.map((r) => r.label)).not.toContain('Utdelning till medlemmar')
    expect(byLabel['Summa utgående eget kapital']).toBe(20_000_000 + 1_000_000 + 600_000 + 300_000 + 150_000)
    // Without an assessment the statement says so and completeness will block.
    expect(data.forvaltningsberattelse.brf_disclosures!.privatbostadsforetag).toBeNull()
  })

  it('includes a kassaflödesanalys under K2 for the form (ÅRL 2 kap. 1 §) and the K2 note set', async () => {
    const supabase = makeSupabase({ entityType: 'bostadsrattsforening', accountingFramework: 'k2', facts: null, profile: null })
    // @ts-expect-error: chainable mock
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect(data.kassaflodesanalys).toBeDefined()
    expect(data.kassaflodesanalys!.reconciliation.is_reconciled).toBe(true)
    expect(data.equity_changes_statement).toBeUndefined()
    const brf = data.forvaltningsberattelse.brf_disclosures!
    expect(brf.facts_missing).toEqual(['kvm_bostadsratt', 'kvm_hyresratt', 'kvm_lokaler', 'tomtratt', 'underhallsplan'])
    expect(brf.nyckeltal[0].arsavgift_per_kvm_bostadsratt).toBeNull()
    expect(brf.nyckeltal[0].rantekanslighet_pct).toBe(10)
  })

  it('leaves every other legal form untouched: no brf_disclosures, no K2 kassaflöde, no note', async () => {
    const supabase = makeSupabase({ entityType: 'aktiebolag', accountingFramework: 'k2', facts, profile: { privatbostadsforetag: true } })
    // @ts-expect-error: chainable mock
    const data = await buildArsredovisningData(supabase, 'co1', 'fp1')
    expect('brf_disclosures' in data.forvaltningsberattelse).toBe(false)
    expect('loss_financing_explanation' in data.disclosures).toBe(false)
    expect(data.kassaflodesanalys).toBeUndefined()
    expect(data.noter.find((n) => n.title === 'Nettoomsättningens fördelning')).toBeUndefined()
    expect(supabase.from).not.toHaveBeenCalledWith('brf_property_facts')
  })
})

describe('fondYttreUnderhallMovement and buildK3EquityChangesStatement', () => {
  it('reads reservering (credit) and ianspråktagande (debit) on 2088', () => {
    const rows = [
      { account_number: '2088', period_debit: 50_000, period_credit: 150_000 },
      { account_number: '2091', period_debit: 150_000, period_credit: 50_000 },
    ]
    expect(fondYttreUnderhallMovement(rows)).toEqual({ reservering: 150_000, ianspraktagande: 50_000 })
  })

  it('keeps the aktiebolag statement unchanged when no fund movement is given', () => {
    const rows = brfRows(150_000)
    const mapping = mapTrialBalancesToK2({ full: rows.full, preClosing: rows.preClosing }, null, {
      legalForm: 'bostadsrattsforening',
    })
    const plain = buildK3EquityChangesStatement(mapping)
    expect(plain.rows.map((r) => r.label)).not.toContain('Ingående fond för yttre underhåll')
    const withFund = buildK3EquityChangesStatement(mapping, { reservering: 150_000, ianspraktagande: 50_000 })
    expect(withFund.closing_total).toBe(plain.closing_total)
  })
})
