import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertPostedJournalEntry, seedCompany } from './fixtures'

describe('rot/rut payout settlement voucher uniqueness', () => {
  it('allows exactly one live settlement voucher per begäran', async () => {
    const seeded = await seedCompany()
    const requestId = randomUUID()
    const common = {
      userId: seeded.userId,
      companyId: seeded.companyId,
      fiscalPeriodId: seeded.fiscalPeriodId,
      entryDate: '2026-07-10',
      description: 'Utbetalning ROT-avdrag från Skatteverket (ROT 2026-07)',
      sourceType: 'rot_rut_payout',
      sourceId: requestId,
      lines: [
        { accountNumber: '1930', debitAmount: 3000, creditAmount: 0 },
        { accountNumber: '1513', debitAmount: 0, creditAmount: 3000 },
      ],
    }

    const results = await Promise.allSettled([
      insertPostedJournalEntry({ ...common, voucherNumber: 31 }),
      insertPostedJournalEntry({ ...common, voucherNumber: 32 }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(String((rejected as PromiseRejectedResult).reason)).toMatch(
      /journal_entries_rot_rut_payout_live_unique/,
    )
  })

  it('does not block a second begäran or other source types', async () => {
    const seeded = await seedCompany()
    const common = {
      userId: seeded.userId,
      companyId: seeded.companyId,
      fiscalPeriodId: seeded.fiscalPeriodId,
      entryDate: '2026-07-10',
      sourceType: 'rot_rut_payout',
    }
    await insertPostedJournalEntry({ ...common, sourceId: randomUUID(), voucherNumber: 41 })
    await expect(
      insertPostedJournalEntry({ ...common, sourceId: randomUUID(), voucherNumber: 42 }),
    ).resolves.toBeTruthy()
    // Same source_id under another source_type is outside the predicate.
    const shared = randomUUID()
    await insertPostedJournalEntry({ ...common, sourceId: shared, voucherNumber: 43 })
    await expect(
      insertPostedJournalEntry({
        ...common,
        sourceType: 'manual',
        sourceId: shared,
        voucherNumber: 44,
      }),
    ).resolves.toBeTruthy()
  })
})
