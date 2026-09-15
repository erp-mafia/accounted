/**
 * generateINK2Declaration for a bostadsrättsförening: the äkta year's
 * property block lands on INK2S 4.3c/4.5c through the adjustment snapshot
 * and the engine explains it; an unassessed year is flagged as a blocker;
 * an oäkta year gets the uttagsbeskattning warning.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))
vi.mock('@/lib/bokslut/tax-provision/tax-adjustment-service', () => ({
  loadTaxAdjustmentSnapshot: vi.fn(),
  MEMBERSHIP_FEE_ACCOUNT: '3901',
}))

import { generateINK2Declaration } from '../ink2-engine'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { loadTaxAdjustmentSnapshot } from '@/lib/bokslut/tax-provision/tax-adjustment-service'
import type { TaxAdjustmentSnapshot } from '@/lib/bokslut/types'
import type { TrialBalanceRow } from '@/types'

function row(accountNumber: string, accountName: string, balance: number): TrialBalanceRow {
  const debit = balance > 0 ? balance : 0
  const credit = balance < 0 ? -balance : 0
  return {
    account_number: accountNumber,
    account_name: accountName,
    account_class: Number(accountNumber[0]),
    opening_debit: 0,
    opening_credit: 0,
    period_debit: debit,
    period_credit: credit,
    closing_debit: debit,
    closing_credit: credit,
  }
}

/**
 * Äkta BRF, open year: årsavgifter 2 400 000, drift 190 000, avskrivning
 * 900 000, ränta 800 000, ränteintäkt bank 12 000. Bokfört resultat
 * 522 000; the property block reverses 2 400 000 (4.5c) and 1 890 000
 * (4.3c), leaving 12 000 taxable.
 */
const ROWS: TrialBalanceRow[] = [
  row('1110', 'Byggnader', 60_000_000),
  row('1119', 'Ack. avskrivningar byggnader', -900_000),
  row('1930', 'Företagskonto', 1_034_000),
  row('2083', 'Insatser', -30_000_000),
  row('2350', 'Fastighetslån', -29_612_000),
  row('3020', 'Årsavgifter bostäder', -2_400_000),
  row('4110', 'Uppvärmning', 150_000),
  row('6310', 'Försäkringar', 40_000),
  row('7830', 'Avskrivningar byggnader', 900_000),
  row('8311', 'Ränteintäkter', -12_000),
  row('8410', 'Räntekostnader', 800_000),
]

function makeSupabase() {
  return {
    from: (table: string) => {
      if (table === 'fiscal_periods') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({
                  data: {
                    id: 'period-1',
                    name: 'Räkenskapsår 2026',
                    period_start: '2026-01-01',
                    period_end: '2026-12-31',
                    is_closed: false,
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
              single: async () => ({
                data: {
                  company_name: 'Brf Testhuset',
                  org_number: '7690000000',
                  entity_type: 'bostadsrattsforening',
                  address_line1: 'Testgatan 1',
                  postal_code: '11122',
                  city: 'Stockholm',
                  email: 'brf@example.com',
                },
                error: null,
              }),
            }),
          }),
        }
      }
      if (table === 'journal_entries') {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  } as unknown as Parameters<typeof generateINK2Declaration>[0]
}

function snapshot(brf: TaxAdjustmentSnapshot['brf'], overrides: Partial<TaxAdjustmentSnapshot> = {}): TaxAdjustmentSnapshot {
  return { items: [], nonDeductibleExpenses: 0, nonTaxableIncome: 0, brf, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(generateTrialBalance).mockResolvedValue({ rows: ROWS, totalDebit: 0, totalCredit: 0, isBalanced: true })
})

describe('generateINK2Declaration: bostadsrättsförening', () => {
  it('reverses the property block on INK2S 4.3c/4.5c for an äkta year and taxes the residue', async () => {
    vi.mocked(loadTaxAdjustmentSnapshot).mockResolvedValue(
      snapshot(
        { taxationYear: 2026, status: 'akta', propertyIncome: 2_400_000, propertyCosts: 1_890_000, taxableCapitalIncome: 12_000 },
        {
          nonDeductibleExpenses: 1_890_000,
          nonTaxableIncome: 2_400_000,
          items: [
            { sourceKey: 'brf:property_income', source: 'detected', adjustmentType: 'non_taxable_income', description: '', accountNumber: null, amount: 2_400_000, included: true },
            { sourceKey: 'brf:property_costs', source: 'detected', adjustmentType: 'non_deductible_expense', description: '', accountNumber: null, amount: 1_890_000, included: true },
          ],
        },
      ),
    )
    const result = await generateINK2Declaration(makeSupabase(), 'co', 'period-1')
    expect(result.ink2s['7650']).toBe(522_000)
    expect(result.ink2s['7653']).toBe(1_890_000)
    expect(result.ink2s['7754']).toBe(2_400_000)
    expect(result.ink2s['8020']).toBe(12_000)
    expect(result.ink2['7104']).toBe(12_000)
    expect(result.warnings.some((w) => w.includes('Privatbostadsföretag') && w.includes('INK2S 4.5c'))).toBe(true)
    expect(result.warnings.some((w) => w.includes('ruta 1.9'))).toBe(true)
    expect(result.warnings.some((w) => w.startsWith('SPÄRR'))).toBe(false)
  })

  it('flags an unassessed year and applies no exemption', async () => {
    vi.mocked(loadTaxAdjustmentSnapshot).mockResolvedValue(
      snapshot({ taxationYear: 2026, status: 'unassessed', propertyIncome: 0, propertyCosts: 0, taxableCapitalIncome: 12_000 }),
    )
    const result = await generateINK2Declaration(makeSupabase(), 'co', 'period-1')
    expect(result.ink2s['7754']).toBe(0)
    expect(result.ink2s['8020']).toBe(522_000)
    expect(result.warnings.some((w) => w.startsWith('SPÄRR') && w.includes('2026'))).toBe(true)
  })

  it('warns about uttagsbeskattning for an oäkta year', async () => {
    vi.mocked(loadTaxAdjustmentSnapshot).mockResolvedValue(
      snapshot({ taxationYear: 2026, status: 'oakta', propertyIncome: 0, propertyCosts: 0, taxableCapitalIncome: 12_000 }),
    )
    const result = await generateINK2Declaration(makeSupabase(), 'co', 'period-1')
    expect(result.ink2s['8020']).toBe(522_000)
    expect(result.warnings.some((w) => w.includes('Oäkta') && w.includes('4.6e') && w.includes('KU31'))).toBe(true)
  })
})
