import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertDraftJournalEntry, insertPostedJournalEntry, seedCompany } from './fixtures'

/**
 * Migration 20260920145033 (#1302): journal_entries_system_source_live_unique,
 * one live (draft or posted) source_type = 'system' entry per (company_id,
 * source_id). The skattekonto Bokför path writes source_id = the skattekonto
 * row id, so the index is what stops two concurrent Bokför clicks from
 * producing two verifikat for one Skatteverket event.
 *
 * The skattekonto side carries no unique index on purpose: Koppla links
 * several rows to one existing summary verifikat (N:1), see the last case.
 */
const INDEX = /journal_entries_system_source_live_unique/

// A settled Skatteverket event as the sync writes it. journal_entry_id is the
// single link pointer both Bokför (claims it after creating the verifikat) and
// Koppla (points it at an existing verifikat) write.
async function insertSkattekontoRow(params: {
  companyId: string
  journalEntryId?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.skattekonto_transactions
       (id, company_id, dedup_key, transaktionsdatum, transaktionstext,
        belopp_skatteverket, status, journal_entry_id)
     VALUES ($1, $2, $3, '2026-06-15', 'Debiterad preliminärskatt', -1000, 'booked', $4)`,
    [id, params.companyId, `pg-real-${id}`, params.journalEntryId ?? null],
  )
  return id
}

type Seeded = { userId: string; companyId: string; fiscalPeriodId: string }

// The header the booking path creates for a skattekonto row.
function systemEntry(seeded: Seeded, sourceId: string | null) {
  return {
    userId: seeded.userId,
    companyId: seeded.companyId,
    fiscalPeriodId: seeded.fiscalPeriodId,
    entryDate: '2026-06-15',
    description: 'Skattekonto: Debiterad preliminärskatt',
    sourceType: 'system',
    sourceId,
  }
}

const SKATTEKONTO_LINES = [
  { accountNumber: '2510', debitAmount: 1000, creditAmount: 0 },
  { accountNumber: '1630', debitAmount: 0, creditAmount: 1000 },
]

describe('skattekonto booking invariants (#1302)', () => {
  it('refuses the second of two concurrent Bokför drafts for the same skattekonto row', async () => {
    const seeded = await seedCompany()
    const rowId = await insertSkattekontoRow({ companyId: seeded.companyId })

    const results = await Promise.allSettled([
      insertDraftJournalEntry(systemEntry(seeded, rowId)),
      insertDraftJournalEntry(systemEntry(seeded, rowId)),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(String(rejected.reason)).toMatch(INDEX)
  })

  it('refuses a new draft while a posted verifikat for the row is live', async () => {
    const seeded = await seedCompany()
    const rowId = await insertSkattekontoRow({ companyId: seeded.companyId })
    await insertPostedJournalEntry({
      ...systemEntry(seeded, rowId),
      voucherNumber: 11,
      lines: SKATTEKONTO_LINES,
    })

    await expect(insertDraftJournalEntry(systemEntry(seeded, rowId))).rejects.toThrow(INDEX)
  })

  it('lets a row be booked again after a storno of its verifikat or a cancelled draft', async () => {
    const seeded = await seedCompany()

    const reversedRow = await insertSkattekontoRow({ companyId: seeded.companyId })
    const original = await insertPostedJournalEntry({
      ...systemEntry(seeded, reversedRow),
      voucherNumber: 21,
      lines: SKATTEKONTO_LINES,
    })
    await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [
      original,
    ])
    await expect(insertDraftJournalEntry(systemEntry(seeded, reversedRow))).resolves.toBeTruthy()

    const cancelledRow = await insertSkattekontoRow({ companyId: seeded.companyId })
    const draft = await insertDraftJournalEntry(systemEntry(seeded, cancelledRow))
    await getPool().query(`UPDATE public.journal_entries SET status = 'cancelled' WHERE id = $1`, [
      draft,
    ])
    await expect(insertDraftJournalEntry(systemEntry(seeded, cancelledRow))).resolves.toBeTruthy()
  })

  it('does not collide across companies', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const shared = randomUUID()

    await expect(insertDraftJournalEntry(systemEntry(a, shared))).resolves.toBeTruthy()
    await expect(insertDraftJournalEntry(systemEntry(b, shared))).resolves.toBeTruthy()
  })

  it('lets several skattekonto rows link to one existing imported or manual verifikat (N:1 Koppla)', async () => {
    const seeded = await seedCompany()

    for (const [sourceType, voucherNumber] of [
      ['import', 31],
      ['manual', 32],
    ] as const) {
      // One monthly 1630 summary voucher covering two Skatteverket events.
      const summary = await insertPostedJournalEntry({
        userId: seeded.userId,
        companyId: seeded.companyId,
        fiscalPeriodId: seeded.fiscalPeriodId,
        entryDate: '2026-06-30',
        description: 'Skattekonto juni',
        sourceType,
        voucherNumber,
        lines: [
          { accountNumber: '2510', debitAmount: 2000, creditAmount: 0 },
          { accountNumber: '1630', debitAmount: 0, creditAmount: 2000 },
        ],
      })
      await insertSkattekontoRow({ companyId: seeded.companyId, journalEntryId: summary })
      await insertSkattekontoRow({ companyId: seeded.companyId, journalEntryId: summary })

      const { rows } = await getPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.skattekonto_transactions WHERE journal_entry_id = $1`,
        [summary],
      )
      expect(rows[0].n).toBe('2')
    }
  })

  it('leaves other source types and NULL source_id outside the predicate', async () => {
    const seeded = await seedCompany()
    const shared = randomUUID()

    await insertDraftJournalEntry(systemEntry(seeded, shared))
    await expect(
      insertDraftJournalEntry({ ...systemEntry(seeded, shared), sourceType: 'manual' }),
    ).resolves.toBeTruthy()

    // Asset disposal writes source_type 'system' with no source_id: several
    // live ones coexist.
    await insertDraftJournalEntry(systemEntry(seeded, null))
    await expect(insertDraftJournalEntry(systemEntry(seeded, null))).resolves.toBeTruthy()
  })

  it('is the named partial unique index', async () => {
    const { rows } = await getPool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'journal_entries'
          AND indexname = 'journal_entries_system_source_live_unique'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].indexdef).toMatch(/UNIQUE INDEX/)
    expect(rows[0].indexdef).toMatch(/source_type = 'system'/)
    expect(rows[0].indexdef).toMatch(/status = ANY/)
  })
})
