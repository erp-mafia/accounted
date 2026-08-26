import { describe, expect, it } from 'vitest'
import { insertPostedJournalEntry, seedCompany } from './fixtures'

describe('kontantmetod cut-off live marker uniqueness', () => {
  it('allows exactly one of two concurrent live markers', async () => {
    const seeded = await seedCompany()
    const description = 'Kundfordringar vid bokslut (kontantmetoden)'
    const common = {
      userId: seeded.userId,
      companyId: seeded.companyId,
      fiscalPeriodId: seeded.fiscalPeriodId,
      entryDate: '2026-12-31',
      description,
      sourceType: 'year_end',
      sourceId: seeded.fiscalPeriodId,
    }

    const results = await Promise.allSettled([
      insertPostedJournalEntry({ ...common, voucherNumber: 11 }),
      insertPostedJournalEntry({ ...common, voucherNumber: 12 }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({ status: 'rejected' })
    expect(String((rejected as PromiseRejectedResult).reason)).toMatch(
      /journal_entries_kontantmetod_cutoff_live_marker_unique/,
    )
  })

  it('preserves the corporate-tax race guard without blocking other year-end entries', async () => {
    const seeded = await seedCompany()
    const common = {
      userId: seeded.userId,
      companyId: seeded.companyId,
      fiscalPeriodId: seeded.fiscalPeriodId,
      entryDate: '2026-12-31',
      description: 'Bokslutsdisposition: Bolagsskatt 20,6 %',
      sourceType: 'year_end',
      sourceId: seeded.fiscalPeriodId,
    }

    await insertPostedJournalEntry({ ...common, voucherNumber: 21 })
    await expect(insertPostedJournalEntry({ ...common, voucherNumber: 22 })).rejects.toThrow(
      /uq_year_end_corporate_tax_per_period/,
    )
  })
})
