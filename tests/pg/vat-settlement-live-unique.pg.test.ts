/**
 * journal_entries_vat_settlement_live_unique (migration 20261101002920,
 * accounted#58): one live (draft or posted) momsredovisning per
 * (company, source_id). bookVatSettlement writes source_id =
 * vatSettlementSourceId(company, period), so two bookings of the same period
 * that both passed the "already posted" read cannot both post.
 */
import { describe, expect, it } from 'vitest'
import { insertDraftJournalEntry, insertPostedJournalEntry, seedCompany } from './fixtures'
import { vatSettlementSourceId } from '@/lib/reports/vat-settlement-booking'

const LINES = [
  { accountNumber: '2611', debitAmount: 2500, creditAmount: 0 },
  { accountNumber: '2650', debitAmount: 0, creditAmount: 2500 },
]

async function settlement() {
  const seeded = await seedCompany()
  return {
    seeded,
    common: {
      userId: seeded.userId,
      companyId: seeded.companyId,
      fiscalPeriodId: seeded.fiscalPeriodId,
      entryDate: '2026-03-31',
      description: 'Momsredovisning Kvartal 1 2026',
      sourceType: 'vat_settlement',
      sourceId: vatSettlementSourceId(seeded.companyId, { start: '2026-01-01', end: '2026-03-31' }),
      lines: LINES,
    },
  }
}

describe('vat settlement live uniqueness', () => {
  it('lets exactly one of two concurrent settlements of a period post', async () => {
    const { common } = await settlement()
    const results = await Promise.allSettled([
      insertPostedJournalEntry({ ...common, voucherNumber: 31 }),
      insertPostedJournalEntry({ ...common, voucherNumber: 32 }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(String((rejected as PromiseRejectedResult).reason)).toMatch(/journal_entries_vat_settlement_live_unique/)
  })

  it('refuses the draft insert while the period has a live draft with the key', async () => {
    const { common } = await settlement()
    const { lines: _lines, ...header } = common
    await insertDraftJournalEntry({ ...header, status: 'draft' })
    await expect(insertPostedJournalEntry({ ...common, voucherNumber: 33 })).rejects.toThrow(
      /journal_entries_vat_settlement_live_unique/,
    )
  })

  it('a reversed or cancelled settlement leaves the period bookable again', async () => {
    const { common } = await settlement()
    const { lines: _lines, ...header } = common
    await insertDraftJournalEntry({ ...header, status: 'reversed', voucherNumber: 34 })
    await insertDraftJournalEntry({ ...header, status: 'cancelled' })
    await expect(insertPostedJournalEntry({ ...common, voucherNumber: 35 })).resolves.toBeTruthy()
  })

  it('does not tie other periods, keyless settlements or other source types', async () => {
    const { seeded, common } = await settlement()
    await insertPostedJournalEntry({ ...common, voucherNumber: 41 })
    // Another quarter.
    await expect(
      insertPostedJournalEntry({
        ...common,
        entryDate: '2026-06-30',
        sourceId: vatSettlementSourceId(seeded.companyId, { start: '2026-04-01', end: '2026-06-30' }),
        voucherNumber: 42,
      }),
    ).resolves.toBeTruthy()
    // Booked from the journal entry form or imported: no source_id.
    await insertPostedJournalEntry({ ...common, sourceId: null, voucherNumber: 43 })
    await expect(insertPostedJournalEntry({ ...common, sourceId: null, voucherNumber: 44 })).resolves.toBeTruthy()
    // The same id under another source_type is outside the predicate.
    await expect(
      insertPostedJournalEntry({ ...common, sourceType: 'manual', voucherNumber: 45 }),
    ).resolves.toBeTruthy()
    // Another company's same period.
    const other = await seedCompany()
    await expect(
      insertPostedJournalEntry({
        ...common,
        userId: other.userId,
        companyId: other.companyId,
        fiscalPeriodId: other.fiscalPeriodId,
        sourceId: vatSettlementSourceId(other.companyId, { start: '2026-01-01', end: '2026-03-31' }),
        voucherNumber: 46,
      }),
    ).resolves.toBeTruthy()
  })
})
