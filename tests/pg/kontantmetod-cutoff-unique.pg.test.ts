import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
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

/**
 * The marker table (20260914150109) is what the two VAT functions read instead
 * of the Swedish descriptions. These assert the contract the writer and both
 * readers depend on, plus the one-time backfill that carried every legacy
 * cut-off across.
 */
describe('kontantmetod cut-off markers', () => {
  const MIGRATION_PATH = new URL(
    '../../supabase/migrations/20260914150109_kontantmetod_cutoff_entries_marker.sql',
    import.meta.url,
  )

  /**
   * The migration's backfill statement, taken from the migration file itself.
   * Running a hand-copied version would prove nothing about the statement that
   * actually runs on production, so the file carries markers for this test.
   */
  function backfillStatement(): string {
    const sql = readFileSync(MIGRATION_PATH, 'utf8')
    const start = sql.indexOf('-- backfill:begin')
    const end = sql.indexOf('-- backfill:end')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const statement = sql.slice(start + '-- backfill:begin'.length, end)
    const conflict = 'ON CONFLICT (journal_entry_id) DO NOTHING;'
    expect(statement).toContain(conflict)
    // Keep the conversion intact, but replay only this synthetic company.
    return statement.replace(conflict, `AND e.company_id = $1\n${conflict}`)
  }

  const LEGACY = [
    { description: 'Kundfordringar vid bokslut (kontantmetoden)', kind: 'receivable' },
    { description: 'Vändning kundfordringar bokslut (kontantmetoden)', kind: 'receivable_reversal' },
    { description: 'Leverantörsskulder vid bokslut (kontantmetoden)', kind: 'payable' },
    { description: 'Vändning leverantörsskulder bokslut (kontantmetoden)', kind: 'payable_reversal' },
  ]

  it('backfills every legacy description to its kind, and is idempotent', async () => {
    const seeded = await seedCompany()
    const entryIds: Record<string, string> = {}

    for (const [index, legacy] of LEGACY.entries()) {
      entryIds[legacy.kind] = await insertPostedJournalEntry({
        userId: seeded.userId,
        companyId: seeded.companyId,
        fiscalPeriodId: seeded.fiscalPeriodId,
        voucherNumber: 100 + index,
        entryDate: '2026-12-31',
        description: legacy.description,
        sourceType: 'year_end',
        sourceId: seeded.fiscalPeriodId,
      })
    }

    const statement = backfillStatement()
    await getPool().query(statement, [seeded.companyId])
    // Re-running must add nothing: ON CONFLICT DO NOTHING is what makes the
    // migration replayable and keeps the writer safe afterwards.
    await getPool().query(statement, [seeded.companyId])

    const { rows } = await getPool().query<{ kind: string; journal_entry_id: string }>(
      `SELECT kind, journal_entry_id FROM public.kontantmetod_cutoff_entries
        WHERE company_id = $1 ORDER BY kind`,
      [seeded.companyId],
    )
    expect(rows).toEqual(
      [...LEGACY]
        .sort((a, b) => a.kind.localeCompare(b.kind))
        .map((legacy) => ({ kind: legacy.kind, journal_entry_id: entryIds[legacy.kind] })),
    )
  })

  it('marks a reversed legacy cut-off too, the way the VAT functions already treated it', async () => {
    // Both functions scope to status IN ('posted','reversed') and dropped both
    // on description, so the backfill must take both or a filed figure moves.
    const seeded = await seedCompany()
    const entryId = await insertPostedJournalEntry({
      userId: seeded.userId,
      companyId: seeded.companyId,
      fiscalPeriodId: seeded.fiscalPeriodId,
      voucherNumber: 130,
      entryDate: '2026-12-31',
      description: 'Vändning kundfordringar bokslut (kontantmetoden)',
      sourceType: 'year_end',
      sourceId: seeded.fiscalPeriodId,
    })
    await getPool().query(
      `UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`,
      [entryId],
    )

    await getPool().query(backfillStatement(), [seeded.companyId])

    const { rows } = await getPool().query<{ kind: string }>(
      `SELECT kind FROM public.kontantmetod_cutoff_entries WHERE journal_entry_id = $1`,
      [entryId],
    )
    expect(rows).toEqual([{ kind: 'receivable_reversal' }])
  })

  const INSERT_MARKER = `INSERT INTO public.kontantmetod_cutoff_entries
      (company_id, fiscal_period_id, kind, journal_entry_id)
    VALUES ($1, $2, $3, $4)`

  it('refuses a marker on a verifikat that is not a year-end posting for that period', async () => {
    // Without this a member could mark an ordinary sale and take it out of
    // their own momsdeklaration. Asserted from a real member session: the guard
    // is enforced for the API roles, not for migrations.
    const seeded = await seedCompany()
    const ordinaryId = await insertPostedJournalEntry({
      userId: seeded.userId,
      companyId: seeded.companyId,
      fiscalPeriodId: seeded.fiscalPeriodId,
      voucherNumber: 140,
      description: 'Vanlig försäljning',
      sourceType: 'invoice_created',
    })

    await withUserContext(seeded.userId, async (client) => {
      await expect(
        client.query(INSERT_MARKER, [
          seeded.companyId, seeded.fiscalPeriodId, 'receivable', ordinaryId,
        ]),
      ).rejects.toThrow(/must reference a year_end journal entry/)
    })
  })

  it('refuses a vändning marker with no mirrored cut-off, and takes it once there is one', async () => {
    // What binds a marker to the cut-off writer without a shared secret: a
    // vändning may only be marked when a marked cut-off for the same period is
    // its exact mirror. Marking an arbitrary VAT-bearing entry therefore means
    // first posting and marking that entry's mirror, which is COUNTED in the
    // figure and hands the amount straight back.
    const seeded = await seedCompany()
    const common = {
      userId: seeded.userId,
      companyId: seeded.companyId,
      fiscalPeriodId: seeded.fiscalPeriodId,
      sourceType: 'year_end',
      sourceId: seeded.fiscalPeriodId,
    }
    const cutoffId = await insertPostedJournalEntry({
      ...common,
      voucherNumber: 160,
      entryDate: '2026-12-31',
      description: 'Avgränsning',
      lines: [
        { accountNumber: '1510', debitAmount: 1250, creditAmount: 0 },
        { accountNumber: '2618', debitAmount: 0, creditAmount: 250 },
        { accountNumber: '3001', debitAmount: 0, creditAmount: 1000 },
      ],
    })
    const reversalId = await insertPostedJournalEntry({
      ...common,
      voucherNumber: 161,
      entryDate: '2027-01-01',
      description: 'Vändning',
      lines: [
        { accountNumber: '1510', debitAmount: 0, creditAmount: 1250 },
        { accountNumber: '2618', debitAmount: 250, creditAmount: 0 },
        { accountNumber: '3001', debitAmount: 1000, creditAmount: 0 },
      ],
    })
    const unrelatedId = await insertPostedJournalEntry({
      ...common,
      voucherNumber: 162,
      entryDate: '2027-01-01',
      description: 'Inte en vändning',
      lines: [
        { accountNumber: '2611', debitAmount: 500, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 500 },
      ],
    })

    await withUserContext(seeded.userId, async (client) => {
      // No cut-off marker yet: the vändning cannot be marked at all.
      await expect(
        client.query(INSERT_MARKER, [
          seeded.companyId, seeded.fiscalPeriodId, 'receivable_reversal', reversalId,
        ]),
      ).rejects.toThrow(/requires an already marked cut-off/)
    })

    await withUserContext(seeded.userId, async (client) => {
      await client.query(INSERT_MARKER, [
        seeded.companyId, seeded.fiscalPeriodId, 'receivable', cutoffId,
      ])
      // Now the mirror exists, so the real vändning goes through ...
      await client.query(INSERT_MARKER, [
        seeded.companyId, seeded.fiscalPeriodId, 'receivable_reversal', reversalId,
      ])
      // ... but an unrelated year-end entry still cannot ride along on it.
      await expect(
        client.query(INSERT_MARKER, [
          seeded.companyId, seeded.fiscalPeriodId, 'payable_reversal', unrelatedId,
        ]),
      ).rejects.toThrow(/requires an already marked cut-off/)
    })
  })

  it('lets the service role, the MCP commit path, mark a valid pair', async () => {
    // The guard runs SECURITY INVOKER, so it has to work for a caller that
    // bypasses RLS as well as for a member session.
    const seeded = await seedCompany()
    const common = {
      userId: seeded.userId,
      companyId: seeded.companyId,
      fiscalPeriodId: seeded.fiscalPeriodId,
      sourceType: 'year_end',
      sourceId: seeded.fiscalPeriodId,
    }
    const cutoffId = await insertPostedJournalEntry({
      ...common,
      voucherNumber: 170,
      entryDate: '2026-12-31',
      description: 'Avgränsning leverantörsskulder',
      lines: [
        { accountNumber: '2440', debitAmount: 0, creditAmount: 1250 },
        { accountNumber: '2648', debitAmount: 250, creditAmount: 0 },
        { accountNumber: '5410', debitAmount: 1000, creditAmount: 0 },
      ],
    })
    const reversalId = await insertPostedJournalEntry({
      ...common,
      voucherNumber: 171,
      entryDate: '2027-01-01',
      description: 'Vändning leverantörsskulder',
      lines: [
        { accountNumber: '2440', debitAmount: 1250, creditAmount: 0 },
        { accountNumber: '2648', debitAmount: 0, creditAmount: 250 },
        { accountNumber: '5410', debitAmount: 0, creditAmount: 1000 },
      ],
    })

    const marked = await runAsServiceRole(async (client) => {
      await client.query(INSERT_MARKER, [
        seeded.companyId, seeded.fiscalPeriodId, 'payable', cutoffId,
      ])
      await client.query(INSERT_MARKER, [
        seeded.companyId, seeded.fiscalPeriodId, 'payable_reversal', reversalId,
      ])
      const res = await client.query<{ kind: string }>(
        `SELECT kind FROM public.kontantmetod_cutoff_entries
          WHERE company_id = $1 ORDER BY kind`,
        [seeded.companyId],
      )
      return res.rows.map((row) => row.kind)
    })
    expect(marked).toEqual(['payable', 'payable_reversal'])
  })

  it('is append-only: no UPDATE or DELETE for any API role, and anon sees nothing', async () => {
    const { rows } = await getPool().query<Record<string, boolean>>(
      `SELECT
         has_table_privilege('authenticated', 'public.kontantmetod_cutoff_entries', 'SELECT') AS auth_select,
         has_table_privilege('authenticated', 'public.kontantmetod_cutoff_entries', 'INSERT') AS auth_insert,
         has_table_privilege('authenticated', 'public.kontantmetod_cutoff_entries', 'UPDATE') AS auth_update,
         has_table_privilege('authenticated', 'public.kontantmetod_cutoff_entries', 'DELETE') AS auth_delete,
         has_table_privilege('service_role', 'public.kontantmetod_cutoff_entries', 'INSERT') AS service_insert,
         has_table_privilege('service_role', 'public.kontantmetod_cutoff_entries', 'DELETE') AS service_delete,
         has_table_privilege('anon', 'public.kontantmetod_cutoff_entries', 'SELECT') AS anon_select`,
    )
    expect(rows[0]).toEqual({
      auth_select: true,
      auth_insert: true,
      auth_update: false,
      auth_delete: false,
      service_insert: true,
      service_delete: false,
      anon_select: false,
    })
  })

  it('shows a member only its own company markers', async () => {
    const mine = await seedCompany()
    const theirs = await seedCompany()

    for (const seeded of [mine, theirs]) {
      const entryId = await insertPostedJournalEntry({
        userId: seeded.userId,
        companyId: seeded.companyId,
        fiscalPeriodId: seeded.fiscalPeriodId,
        voucherNumber: 150,
        entryDate: '2026-12-31',
        description: 'Kundfordringar vid bokslut (kontantmetoden)',
        sourceType: 'year_end',
        sourceId: seeded.fiscalPeriodId,
      })
      await getPool().query(
        `INSERT INTO public.kontantmetod_cutoff_entries
           (company_id, fiscal_period_id, kind, journal_entry_id)
         VALUES ($1, $2, 'receivable', $3)`,
        [seeded.companyId, seeded.fiscalPeriodId, entryId],
      )
    }

    const visible = await withUserContext(mine.userId, async (client) => {
      const res = await client.query<{ company_id: string }>(
        `SELECT company_id FROM public.kontantmetod_cutoff_entries`,
      )
      return res.rows.map((row) => row.company_id)
    })
    expect(visible).toEqual([mine.companyId])
  })
})
