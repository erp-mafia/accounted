import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

// A completed sie_imports row the correction history can point at.
async function insertSieImport(companyId: string, userId: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.sie_imports (company_id, user_id, filename, file_hash, sie_type, status)
     VALUES ($1, $2, 'fixture.se', md5(gen_random_uuid()::text), 4, 'completed')
     RETURNING id`,
    [companyId, userId],
  )
  return rows[0]!.id
}

describe('import_sie_journal_entries RPC', () => {
  it('rolls back the journal entry header when a line insert fails', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    const payload = [
      {
        sourceId: 'A1',
        series: 'A',
        date: '2026-01-15',
        description: 'Bad imported voucher',
        sourceSeries: 'A',
        sourceNumber: 1,
        sourceType: 'import',
        lines: [
          {
            account_number: '1930',
            debit_amount: 100,
            credit_amount: 0,
            currency: 'SEK',
            line_description: 'Bank',
            sort_order: 0,
          },
          {
            account_number: null,
            debit_amount: 0,
            credit_amount: 100,
            currency: 'SEK',
            line_description: 'Invalid line',
            sort_order: 1,
          },
        ],
      },
    ]

    await expect(
      getPool().query(
        `SELECT public.import_sie_journal_entries($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
        [companyId, userId, fiscalPeriodId, JSON.stringify(payload)],
      ),
    ).rejects.toThrow(/null value in column "account_number"|violates not-null constraint/i)

    const headers = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM public.journal_entries
        WHERE company_id = $1
          AND fiscal_period_id = $2
          AND description = 'Bad imported voucher'`,
      [companyId, fiscalPeriodId],
    )
    expect(headers.rows[0]!.count).toBe('0')

    const sequence = await getPool().query<{ last_number: number }>(
      `SELECT last_number
         FROM public.voucher_sequences
        WHERE company_id = $1
          AND fiscal_period_id = $2
          AND voucher_series = 'A'`,
      [companyId, fiscalPeriodId],
    )
    expect(sequence.rowCount).toBe(0)
  })

  it('posts a balanced voucher and carries the dimensions jsonb through to the generated mirrors', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    const payload = [
      {
        sourceId: 'A1',
        series: 'A',
        date: '2026-02-01',
        description: 'Dimensioned import',
        sourceSeries: 'A',
        sourceNumber: 1,
        sourceType: 'import',
        lines: [
          {
            account_number: '5010',
            debit_amount: 100,
            credit_amount: 0,
            currency: 'SEK',
            line_description: 'Lokalhyra',
            sort_order: 0,
            // SIE object-list codes: 1 = kostnadsställe, 6 = projekt.
            dimensions: { '1': 'CC-10', '6': 'PROJ-X' },
          },
          {
            account_number: '1930',
            debit_amount: 0,
            credit_amount: 100,
            currency: 'SEK',
            line_description: 'Bank',
            sort_order: 1,
          },
        ],
      },
    ]

    const res = await getPool().query<{ import_sie_journal_entries: { inserted_entries: unknown[] } }>(
      `SELECT public.import_sie_journal_entries($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
      [companyId, userId, fiscalPeriodId, JSON.stringify(payload)],
    )
    expect(res.rows[0]!.import_sie_journal_entries.inserted_entries).toHaveLength(1)

    const posted = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM public.journal_entries
        WHERE company_id = $1 AND status = 'posted' AND description = 'Dimensioned import'`,
      [companyId],
    )
    expect(posted.rows[0]!.count).toBe('1')

    const dimLine = await getPool().query<{
      dimensions: Record<string, string>
      cost_center: string | null
      project: string | null
    }>(
      `SELECT l.dimensions, l.cost_center, l.project
         FROM public.journal_entry_lines l
         JOIN public.journal_entries je ON je.id = l.journal_entry_id
        WHERE je.company_id = $1 AND l.account_number = '5010'`,
      [companyId],
    )
    expect(dimLine.rows[0]!.dimensions).toEqual({ '1': 'CC-10', '6': 'PROJ-X' })
    // GENERATED mirrors derive from the jsonb: both must be populated.
    expect(dimLine.rows[0]!.cost_center).not.toBeNull()
    expect(dimLine.rows[0]!.project).not.toBeNull()
  })

  it('rejects an unbalanced voucher and rolls the whole import back', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    const payload = [
      {
        sourceId: 'A1',
        series: 'A',
        date: '2026-02-01',
        description: 'Unbalanced import',
        sourceType: 'import',
        lines: [
          { account_number: '5010', debit_amount: 100, credit_amount: 0, currency: 'SEK', sort_order: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 90, currency: 'SEK', sort_order: 1 },
        ],
      },
    ]

    await expect(
      getPool().query(
        `SELECT public.import_sie_journal_entries($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
        [companyId, userId, fiscalPeriodId, JSON.stringify(payload)],
      ),
    ).rejects.toThrow(/unbalanced/i)

    const headers = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.journal_entries
        WHERE company_id = $1 AND description = 'Unbalanced import'`,
      [companyId],
    )
    expect(headers.rows[0]!.count).toBe('0')
  })

  it('rejects a fiscal period that belongs to another company', async () => {
    const a = await seedCompany()
    const b = await seedCompany()

    const payload = [
      {
        sourceId: 'A1',
        series: 'A',
        date: '2026-02-01',
        description: 'Foreign fiscal period',
        sourceType: 'import',
        lines: [
          { account_number: '5010', debit_amount: 100, credit_amount: 0, currency: 'SEK', sort_order: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 100, currency: 'SEK', sort_order: 1 },
        ],
      },
    ]

    // company A's id + user, but company B's fiscal period.
    await expect(
      getPool().query(
        `SELECT public.import_sie_journal_entries($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
        [a.companyId, a.userId, b.fiscalPeriodId, JSON.stringify(payload)],
      ),
    ).rejects.toThrow(/does not belong to company/i)
  })
  // Migration 20260909132618 (#2427): #BTRANS/#RTRANS history rides on the
  // payload as `corrections` and lands as ONE rättelselogg row per voucher,
  // source='sie_import'. The ledger insert is unchanged.
  it('writes source-system correction history to the rättelselogg without touching the lines', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const sieImportId = await insertSieImport(companyId, userId)

    const payload = [
      {
        sourceId: 'A7',
        series: 'A',
        date: '2026-03-01',
        description: 'Corrected in source',
        sourceSeries: 'A',
        sourceNumber: 7,
        sourceType: 'import',
        sieImportId,
        corrections: {
          struck: [
            { account_number: '5010', debit_amount: 1200, credit_amount: 0, line_description: 'Lokalhyra', sort_order: 0, signature: 'EL' },
          ],
          added: [
            { account_number: '6540', debit_amount: 1200, credit_amount: 0, line_description: 'IT', sort_order: 0, signature: 'AB' },
          ],
          signature: 'EL',
        },
        lines: [
          { account_number: '6540', debit_amount: 1200, credit_amount: 0, currency: 'SEK', line_description: 'IT', sort_order: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 1200, currency: 'SEK', line_description: 'Bank', sort_order: 1 },
        ],
      },
      {
        sourceId: 'A8',
        series: 'A',
        date: '2026-03-02',
        description: 'Plain voucher',
        sourceSeries: 'A',
        sourceNumber: 8,
        sourceType: 'import',
        lines: [
          { account_number: '5010', debit_amount: 100, credit_amount: 0, currency: 'SEK', line_description: null, sort_order: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 100, currency: 'SEK', line_description: null, sort_order: 1 },
        ],
      },
    ]

    const res = await getPool().query<{ import_sie_journal_entries: { inserted_entries: Array<{ id: string; sourceId: string }> } }>(
      `SELECT public.import_sie_journal_entries($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
      [companyId, userId, fiscalPeriodId, JSON.stringify(payload)],
    )
    const inserted = res.rows[0]!.import_sie_journal_entries.inserted_entries
    expect(inserted).toHaveLength(2)
    const correctedId = inserted.find((e) => e.sourceId === 'A7')!.id

    // Ledger: exactly the #TRANS rows, posted and balanced. History never
    // becomes a line.
    const lines = await getPool().query<{ account_number: string; debit_amount: string; credit_amount: string }>(
      `SELECT account_number, debit_amount::text, credit_amount::text
         FROM public.journal_entry_lines
        WHERE journal_entry_id = $1
        ORDER BY sort_order`,
      [correctedId],
    )
    expect(lines.rows.map((r) => r.account_number)).toEqual(['6540', '1930'])

    // One log row for the corrected voucher, none for the plain one.
    const logs = await getPool().query<{
      journal_entry_id: string
      rattelse_type: string
      source: string
      sie_import_id: string | null
      external_signature: string | null
      actor: string | null
      struck_lines: Array<Record<string, unknown>>
      added_lines: Array<Record<string, unknown>>
    }>(
      `SELECT journal_entry_id, rattelse_type, source, sie_import_id, external_signature, actor, struck_lines, added_lines
         FROM public.journal_entry_rattelse_log
        WHERE company_id = $1`,
      [companyId],
    )
    expect(logs.rows).toHaveLength(1)
    const log = logs.rows[0]!
    expect(log).toMatchObject({
      journal_entry_id: correctedId,
      rattelse_type: 'lines',
      source: 'sie_import',
      sie_import_id: sieImportId,
      external_signature: 'EL',
      actor: null,
    })
    // Snapshot shape matches what correct_entry_lines_inline stores, so the
    // verifikat page renders both the same way.
    expect(log.struck_lines).toHaveLength(1)
    expect(log.struck_lines[0]).toMatchObject({
      journal_entry_id: correctedId,
      account_number: '5010',
      debit_amount: 1200,
      credit_amount: 0,
      line_description: 'Lokalhyra',
      sort_order: 0,
      currency: 'SEK',
      signature: 'EL',
    })
    expect(typeof log.struck_lines[0]!.id).toBe('string')
    // Per-line signatures survive: the added row names a different corrector.
    expect(log.added_lines[0]).toMatchObject({ account_number: '6540', debit_amount: 1200, signature: 'AB' })

    // The log stays WORM for imported rows too.
    await expect(
      getPool().query(`DELETE FROM public.journal_entry_rattelse_log WHERE company_id = $1`, [companyId]),
    ).rejects.toThrow(/oföränderlig/)
  })

  it('rejects correction history whose sie_import_id belongs to another company', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const other = await seedCompany()
    const foreignImportId = await insertSieImport(other.companyId, other.userId)

    const payload = [
      {
        sourceId: 'A1',
        series: 'A',
        date: '2026-03-01',
        description: 'Foreign provenance',
        sourceSeries: 'A',
        sourceNumber: 1,
        sourceType: 'import',
        sieImportId: foreignImportId,
        corrections: {
          struck: [{ account_number: '5010', debit_amount: 100, credit_amount: 0, line_description: null, sort_order: 0 }],
          added: [],
          signature: null,
        },
        lines: [
          { account_number: '6540', debit_amount: 100, credit_amount: 0, currency: 'SEK', line_description: null, sort_order: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 100, currency: 'SEK', line_description: null, sort_order: 1 },
        ],
      },
    ]

    await expect(
      getPool().query(
        `SELECT public.import_sie_journal_entries($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
        [companyId, userId, fiscalPeriodId, JSON.stringify(payload)],
      ),
    ).rejects.toThrow(/does not belong to company/)

    // Fail closed: the whole import rolled back, nothing posted, no log row.
    const posted = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.journal_entries WHERE company_id = $1`,
      [companyId],
    )
    expect(posted.rows[0]!.count).toBe('0')
    const logs = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.journal_entry_rattelse_log WHERE company_id = $1`,
      [companyId],
    )
    expect(logs.rows[0]!.count).toBe('0')
  })

  it('rejects an imported history row that claims an actor (provenance check)', async () => {
    const { companyId } = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.journal_entry_rattelse_log
           (company_id, journal_entry_id, rattelse_type, struck_lines, added_lines, actor, source)
         VALUES ($1, gen_random_uuid(), 'lines', '[]', '[]', gen_random_uuid(), 'sie_import')`,
        [companyId],
      ),
    ).rejects.toThrow(/journal_entry_rattelse_log_import_provenance_check/)
  })
})
