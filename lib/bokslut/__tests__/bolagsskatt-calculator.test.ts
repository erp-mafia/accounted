import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/reports/income-statement', () => ({
  generateIncomeStatement: vi.fn(),
}))

import {
  calculateBolagsskatt,
  BOLAGSSKATT_RATE,
  sumPostedYearEndDispositions,
} from '../tax-provision/bolagsskatt-calculator'
import { generateIncomeStatement } from '@/lib/reports/income-statement'

const NOOP_CLIENT = {} as Parameters<typeof calculateBolagsskatt>[0]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('calculateBolagsskatt', () => {
  it('applies 20.6% to positive result and posts 8910/2512', async () => {
    vi.mocked(generateIncomeStatement).mockResolvedValue({
      net_result: 500_000,
    } as Awaited<ReturnType<typeof generateIncomeStatement>>)

    const result = await calculateBolagsskatt(NOOP_CLIENT, 'co', 'fp')

    expect(result).not.toBeNull()
    expect(result!.amount).toBe(Math.round(500_000 * BOLAGSSKATT_RATE)) // 103000
    const debit = result!.lines.find((l) => l.account_number === '8910')!
    const credit = result!.lines.find((l) => l.account_number === '2512')!
    expect(debit.debit_amount).toBe(103_000)
    expect(credit.credit_amount).toBe(103_000)
  })

  it('returns a zero-amount proposal for loss year (no entry posted)', async () => {
    vi.mocked(generateIncomeStatement).mockResolvedValue({
      net_result: -50_000,
    } as Awaited<ReturnType<typeof generateIncomeStatement>>)

    const result = await calculateBolagsskatt(NOOP_CLIENT, 'co', 'fp')

    expect(result).not.toBeNull()
    expect(result!.amount).toBe(0)
    expect(result!.lines).toEqual([])
    expect(result!.description).toContain('förlust')
  })

  it('adds non-deductible expenses to taxable result', async () => {
    vi.mocked(generateIncomeStatement).mockResolvedValue({
      net_result: 100_000,
    } as Awaited<ReturnType<typeof generateIncomeStatement>>)

    const result = await calculateBolagsskatt(NOOP_CLIENT, 'co', 'fp', {
      manualAdjustments: { nonDeductibleExpenses: 50_000 },
    })

    // (100_000 + 50_000) × 0.206 = 30_900
    expect(result!.amount).toBe(30_900)
  })

  it('subtracts non-taxable income from taxable result', async () => {
    vi.mocked(generateIncomeStatement).mockResolvedValue({
      net_result: 100_000,
    } as Awaited<ReturnType<typeof generateIncomeStatement>>)

    const result = await calculateBolagsskatt(NOOP_CLIENT, 'co', 'fp', {
      manualAdjustments: { nonTaxableIncome: 40_000 },
    })

    // (100_000 - 40_000) × 0.206 = 12_360
    expect(result!.amount).toBe(12_360)
  })

  it('adds schablonintäkt on periodiseringsfond to taxable result', async () => {
    vi.mocked(generateIncomeStatement).mockResolvedValue({
      net_result: 200_000,
    } as Awaited<ReturnType<typeof generateIncomeStatement>>)

    const result = await calculateBolagsskatt(NOOP_CLIENT, 'co', 'fp', {
      manualAdjustments: { schablonintaktPeriodiseringsfond: 3_000 },
    })

    // (200_000 + 3_000) × 0.206 = 41_818
    expect(result!.amount).toBe(41_818)
  })

  it('uses resultBeforeTaxOverride and does NOT read the income statement', async () => {
    // Preview mode: the dispositions builder passes the post-disposition base
    // directly. The income statement (pre-disposition) must not be consulted.
    const result = await calculateBolagsskatt(NOOP_CLIENT, 'co', 'fp', {
      resultBeforeTaxOverride: 750_000,
    })

    expect(result!.amount).toBe(Math.round(750_000 * BOLAGSSKATT_RATE)) // 154_500
    expect(generateIncomeStatement).not.toHaveBeenCalled()
  })

  it('combines resultBeforeTaxOverride with manual adjustments', async () => {
    const result = await calculateBolagsskatt(NOOP_CLIENT, 'co', 'fp', {
      resultBeforeTaxOverride: 750_000,
      manualAdjustments: { schablonintaktPeriodiseringsfond: 3_000 },
    })

    // (750_000 + 3_000) × 0.206 = 155_118
    expect(result!.amount).toBe(155_118)
    expect(generateIncomeStatement).not.toHaveBeenCalled()
  })

  /** Table-keyed FIFO client: consumption order per table mirrors the
   *  two-step entry-lines fetch plus the reversed-ids lookup. */
  function makeQueuedClient(queues: Record<string, { data: unknown; error: unknown }[]>) {
    const makeBuilder = (table: string) => {
      const handler: ProxyHandler<object> = {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) =>
              resolve(queues[table]?.shift() ?? { data: [], error: null })
          }
          return () => new Proxy({}, handler)
        },
      }
      return new Proxy({}, handler)
    }
    return { from: (table: string) => makeBuilder(table) } as unknown as Parameters<
      typeof sumPostedYearEndDispositions
    >[0]
  }

  it('sumPostedYearEndDispositions adds back periodiseringsfond + överavskrivning (class-88) + SLP, ignores tax/liability', async () => {
    // Commit path: bolagsskatt is computed after the other dispositions are
    // posted. They carry source_type='year_end' (excluded from the income
    // statement), so the tax base must add their P&L effect back.
    const rows = [
      { account_number: '8811', debit_amount: 150_000, credit_amount: 0 }, // avsättning      -150k
      { account_number: '8819', debit_amount: 0, credit_amount: 20_000 },  // återföring       +20k
      { account_number: '8853', debit_amount: 39_000, credit_amount: 0 },  // överavskrivning  -39k
      { account_number: '7533', debit_amount: 5_000, credit_amount: 0 },   // SLP               -5k
      { account_number: '8910', debit_amount: 123_600, credit_amount: 0 }, // skatt   : ignored
      { account_number: '2124', debit_amount: 0, credit_amount: 150_000 }, // skuld   : ignored
    ]
    const client = makeQueuedClient({
      journal_entries: [
        { data: [{ id: 'ye-posted-1' }], error: null }, // entries step of the lines fetch
        { data: [], error: null },                      // reversed year_end ids: none
      ],
      journal_entry_lines: [{ data: rows, error: null }],
    })

    const effect = await sumPostedYearEndDispositions(client, 'co', 'fp')
    expect(effect.total).toBe(-174_000) // -150k + 20k - 39k - 5k
    expect(effect.slpPortion).toBe(-5_000)
  })

  it('sumPostedYearEndDispositions counts the replacement of a corrected year_end entry', async () => {
    // A corrected disposition: the original is status='reversed' (invisible
    // to the posted year_end fetch) and the effective booking lives on the
    // correction entry (source_type='correction', correction_of_id → the
    // original). Its P&L effect must be part of the tax base.
    const client = makeQueuedClient({
      journal_entries: [
        { data: [], error: null },              // posted year_end entries: none
        { data: [{ id: 'ye-rev-1' }], error: null }, // reversed year_end ids
        { data: [{ id: 'corr-1' }], error: null },   // corrections entries step
      ],
      journal_entry_lines: [
        {
          data: [
            { account_number: '8811', debit_amount: 90_000, credit_amount: 0 },
            { account_number: '2125', debit_amount: 0, credit_amount: 90_000 },
          ],
          error: null,
        },
      ],
    })

    const effect = await sumPostedYearEndDispositions(client, 'co', 'fp')
    expect(effect.total).toBe(-90_000)
    expect(effect.slpPortion).toBe(0)
  })

  it('truncates taxable result to whole krona before applying tax', async () => {
    vi.mocked(generateIncomeStatement).mockResolvedValue({
      net_result: 100_999.99,
    } as Awaited<ReturnType<typeof generateIncomeStatement>>)

    const result = await calculateBolagsskatt(NOOP_CLIENT, 'co', 'fp')

    // floor(100_999.99) = 100_999, × 0.206 = 20805.794 → round = 20_806
    expect(result!.amount).toBe(20_806)
  })
})
