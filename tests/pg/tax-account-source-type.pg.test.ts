import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertDraftJournalEntry, insertPostedJournalEntry, seedCompany } from './fixtures'

/**
 * Migration 20261109170200 (#172): skattekonto bookings carry source_type
 * 'tax_account'; entries booked before keep 'system'. The CHECK accepts the
 * new type, and journal_entries_system_source_live_unique spans both: one
 * live (draft or posted) verifikat per skattekonto row, whichever of the two
 * types it was booked as. The single-type cases stay in
 * skattekonto-booking-invariants.pg.test.ts.
 */
const INDEX = /journal_entries_system_source_live_unique/

type Seeded = { userId: string; companyId: string; fiscalPeriodId: string }
type SkattekontoSourceType = 'system' | 'tax_account'

function skattekontoEntry(seeded: Seeded, sourceType: SkattekontoSourceType, sourceId: string | null) {
  return {
    userId: seeded.userId,
    companyId: seeded.companyId,
    fiscalPeriodId: seeded.fiscalPeriodId,
    entryDate: '2026-06-15',
    description: 'Skattekonto: Debiterad preliminärskatt',
    sourceType,
    sourceId,
  }
}

const SKATTEKONTO_LINES = [
  { accountNumber: '2510', debitAmount: 1000, creditAmount: 0 },
  { accountNumber: '1630', debitAmount: 0, creditAmount: 1000 },
]

describe('tax_account journal source (#172)', () => {
  it('accepts tax_account and keeps one live verifikat per skattekonto row', async () => {
    const seeded = await seedCompany()
    const rowId = randomUUID()

    await expect(insertDraftJournalEntry(skattekontoEntry(seeded, 'tax_account', rowId))).resolves.toBeTruthy()
    await expect(insertDraftJournalEntry(skattekontoEntry(seeded, 'tax_account', rowId))).rejects.toThrow(INDEX)
  })

  it('refuses a tax_account verifikat for a row whose live system verifikat was booked before the move', async () => {
    const seeded = await seedCompany()
    const rowId = randomUUID()
    await insertPostedJournalEntry({
      ...skattekontoEntry(seeded, 'system', rowId),
      voucherNumber: 41,
      lines: SKATTEKONTO_LINES,
    })

    await expect(insertDraftJournalEntry(skattekontoEntry(seeded, 'tax_account', rowId))).rejects.toThrow(INDEX)
  })

  it('refuses a system verifikat for a row that already has a live tax_account one', async () => {
    const seeded = await seedCompany()
    const rowId = randomUUID()
    await insertPostedJournalEntry({
      ...skattekontoEntry(seeded, 'tax_account', rowId),
      voucherNumber: 42,
      lines: SKATTEKONTO_LINES,
    })

    await expect(insertDraftJournalEntry(skattekontoEntry(seeded, 'system', rowId))).rejects.toThrow(INDEX)
  })

  it('lets exactly one of two concurrent drafts of different types win for the same row', async () => {
    const seeded = await seedCompany()
    const rowId = randomUUID()

    const results = await Promise.allSettled([
      insertDraftJournalEntry(skattekontoEntry(seeded, 'system', rowId)),
      insertDraftJournalEntry(skattekontoEntry(seeded, 'tax_account', rowId)),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(String(rejected.reason)).toMatch(INDEX)
  })

  it('books the row again as tax_account after a storno of its system verifikat', async () => {
    const seeded = await seedCompany()
    const rowId = randomUUID()
    const original = await insertPostedJournalEntry({
      ...skattekontoEntry(seeded, 'system', rowId),
      voucherNumber: 43,
      lines: SKATTEKONTO_LINES,
    })
    await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [original])

    await expect(insertDraftJournalEntry(skattekontoEntry(seeded, 'tax_account', rowId))).resolves.toBeTruthy()
  })

  it('leaves NULL source_id and other companies outside the predicate', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const shared = randomUUID()

    await insertDraftJournalEntry(skattekontoEntry(a, 'tax_account', shared))
    await expect(insertDraftJournalEntry(skattekontoEntry(b, 'tax_account', shared))).resolves.toBeTruthy()

    await insertDraftJournalEntry(skattekontoEntry(a, 'tax_account', null))
    await expect(insertDraftJournalEntry(skattekontoEntry(a, 'system', null))).resolves.toBeTruthy()
  })
})
