import { describe, expect, it } from 'vitest'
import { insertPostedJournalEntry, seedCompany } from '@/tests/pg/fixtures'
import { withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260927195505_detect_voucher_gaps_leading_gap: every series starts
 * at 1 in its fiscal period, so the numbers before the lowest surviving
 * voucher are a gap like any hole between two vouchers (#3150).
 */

async function seedSeries(numbers: number[], series = 'A') {
  const seeded = await seedCompany()
  for (const voucherNumber of numbers) {
    await insertPostedJournalEntry({ ...seeded, voucherSeries: series, voucherNumber })
  }
  return seeded
}

async function detect(
  seeded: { userId: string; companyId: string; fiscalPeriodId: string },
  series = 'A',
) {
  return withUserContext(seeded.userId, async (client) => {
    const r = await client.query<{ gap_start: number; gap_end: number }>(
      `SELECT gap_start, gap_end FROM public.detect_voucher_gaps($1, $2, $3)`,
      [seeded.companyId, seeded.fiscalPeriodId, series],
    )
    return r.rows
  })
}

describe('detect_voucher_gaps', () => {
  it('reports the numbers before the first voucher as a gap', async () => {
    const seeded = await seedSeries([6, 7])
    expect(await detect(seeded)).toEqual([{ gap_start: 1, gap_end: 5 }])
  })

  it('reports a leading gap and an inner gap together, in order', async () => {
    const seeded = await seedSeries([3, 5])
    expect(await detect(seeded)).toEqual([
      { gap_start: 1, gap_end: 2 },
      { gap_start: 4, gap_end: 4 },
    ])
  })

  it('keeps reporting inner gaps in a series that starts at 1', async () => {
    const seeded = await seedSeries([1, 2, 5])
    expect(await detect(seeded)).toEqual([{ gap_start: 3, gap_end: 4 }])
  })

  it('reports nothing for an unbroken series or an empty one', async () => {
    const seeded = await seedSeries([1, 2, 3])
    expect(await detect(seeded)).toEqual([])
    expect(await detect(seeded, 'B')).toEqual([])
  })
})
