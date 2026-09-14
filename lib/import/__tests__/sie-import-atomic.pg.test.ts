import { describe, expect, it } from 'vitest'
import { sieWriterFixture } from '@/tests/pg/sie-writer-fixture'
import { insertBalancedLines, insertDraftJournalEntry, seedCompany } from '@/tests/pg/fixtures'

// A completed sie_imports row the correction history can point at.
async function insertSieImport(companyId: string, userId: string): Promise<string> {
  const { rows } = await sieWriterFixture().query<{ id: string }>(
    `INSERT INTO public.sie_imports (company_id, user_id, filename, file_hash, sie_type, status)
     VALUES ($1, $2, 'fixture.se', md5(gen_random_uuid()::text), 4, 'completed')
     RETURNING id`,
    [companyId, userId],
  )
  return rows[0]!.id
}

describe('write_sie_job_entries RPC', () => {
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
      sieWriterFixture().query(
        `SELECT public.write_sie_job_entries($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
        [companyId, userId, fiscalPeriodId, JSON.stringify(payload)],
      ),
    ).rejects.toThrow(/null value in column "account_number"|violates not-null constraint/i)

    const headers = await sieWriterFixture().query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM public.journal_entries
        WHERE company_id = $1
          AND fiscal_period_id = $2
          AND description = 'Bad imported voucher'`,
      [companyId, fiscalPeriodId],
    )
    expect(headers.rows[0]!.count).toBe('0')

    const sequence = await sieWriterFixture().query<{ last_number: number }>(
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

    const res = await sieWriterFixture().query<{ write_sie_job_entries: { inserted_entries: unknown[] } }>(
      `SELECT public.write_sie_job_entries($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
      [companyId, userId, fiscalPeriodId, JSON.stringify(payload)],
    )
    expect(res.rows[0]!.write_sie_job_entries.inserted_entries).toHaveLength(1)

    const posted = await sieWriterFixture().query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM public.journal_entries
        WHERE company_id = $1 AND status = 'posted' AND description = 'Dimensioned import'`,
      [companyId],
    )
    expect(posted.rows[0]!.count).toBe('1')

    const dimLine = await sieWriterFixture().query<{
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
      sieWriterFixture().query(
        `SELECT public.write_sie_job_entries($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
        [companyId, userId, fiscalPeriodId, JSON.stringify(payload)],
      ),
    ).rejects.toThrow(/unbalanced/i)

    const headers = await sieWriterFixture().query<{ count: string }>(
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
      sieWriterFixture().query(
        `SELECT public.write_sie_job_entries($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
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

    const res = await sieWriterFixture().query<{ write_sie_job_entries: { inserted_entries: Array<{ id: string; sourceId: string }> } }>(
      `SELECT public.write_sie_job_entries($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
      [companyId, userId, fiscalPeriodId, JSON.stringify(payload)],
    )
    const inserted = res.rows[0]!.write_sie_job_entries.inserted_entries
    expect(inserted).toHaveLength(2)
    const correctedId = inserted.find((e) => e.sourceId === 'A7')!.id

    // Ledger: exactly the #TRANS rows, posted and balanced. History never
    // becomes a line.
    const lines = await sieWriterFixture().query<{ account_number: string; debit_amount: string; credit_amount: string }>(
      `SELECT account_number, debit_amount::text, credit_amount::text
         FROM public.journal_entry_lines
        WHERE journal_entry_id = $1
        ORDER BY sort_order`,
      [correctedId],
    )
    expect(lines.rows.map((r) => r.account_number)).toEqual(['6540', '1930'])

    // One log row for the corrected voucher, none for the plain one.
    const logs = await sieWriterFixture().query<{
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
      sieWriterFixture().query(`DELETE FROM public.journal_entry_rattelse_log WHERE company_id = $1`, [companyId]),
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
      sieWriterFixture().query(
        `SELECT public.write_sie_job_entries($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
        [companyId, userId, fiscalPeriodId, JSON.stringify(payload)],
      ),
    ).rejects.toThrow(/does not belong to company/)

    // Fail closed: the whole import rolled back, nothing posted, no log row.
    const posted = await sieWriterFixture().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.journal_entries WHERE company_id = $1`,
      [companyId],
    )
    expect(posted.rows[0]!.count).toBe('0')
    const logs = await sieWriterFixture().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.journal_entry_rattelse_log WHERE company_id = $1`,
      [companyId],
    )
    expect(logs.rows[0]!.count).toBe('0')
  })

  // Migration 20260910135510 (#2472): the RPC is set-based. These cases pin
  // what the per-entry loop used to guarantee row by row.
  function makeLines(amount: number) {
    return [
      { account_number: '5010', debit_amount: amount, credit_amount: 0, currency: 'SEK', sort_order: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: amount, currency: 'SEK', sort_order: 1 },
    ]
  }

  it('numbers each series contiguously in payload order within one call', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    const payload = [
      { sourceId: 'B1', series: 'B', date: '2026-02-01', description: 'b1', sourceType: 'import', lines: makeLines(10) },
      { sourceId: 'C1', series: 'C', date: '2026-02-01', description: 'c1', sourceType: 'import', lines: makeLines(20) },
      { sourceId: 'B2', series: 'B', date: '2026-02-02', description: 'b2', sourceType: 'import', lines: makeLines(30) },
      { sourceId: 'B3', series: 'B', date: '2026-02-03', description: 'b3', sourceType: 'import', lines: makeLines(40) },
      { sourceId: 'C2', series: 'C', date: '2026-02-02', description: 'c2', sourceType: 'import', lines: makeLines(50) },
    ]

    const res = await sieWriterFixture().query<{
      write_sie_job_entries: {
        inserted_entries: Array<{ id: string; sourceId: string; series: string; voucherNumber: number; sourceType: string }>
      }
    }>(
      `SELECT public.write_sie_job_entries($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
      [companyId, userId, fiscalPeriodId, JSON.stringify(payload)],
    )
    const inserted = res.rows[0]!.write_sie_job_entries.inserted_entries

    // Payload order is preserved and each series counts up from 1.
    expect(inserted.map((e) => [e.sourceId, e.series, e.voucherNumber])).toEqual([
      ['B1', 'B', 1],
      ['C1', 'C', 1],
      ['B2', 'B', 2],
      ['B3', 'B', 3],
      ['C2', 'C', 2],
    ])
    expect(inserted.every((e) => e.sourceType === 'import')).toBe(true)

    // The rows say the same as the return value, and every line landed on
    // the header that carries its source voucher.
    const rows = await sieWriterFixture().query<{ voucher_series: string; voucher_number: number; description: string; status: string; committed_at: string | null; total: string }>(
      `SELECT je.voucher_series, je.voucher_number, je.description, je.status, je.committed_at::text,
              sum(l.debit_amount)::text AS total
         FROM public.journal_entries je
         JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
        WHERE je.company_id = $1
        GROUP BY je.id
        ORDER BY je.voucher_series, je.voucher_number`,
      [companyId],
    )
    expect(rows.rows.map((r) => [r.voucher_series, r.voucher_number, r.description, r.total])).toEqual([
      ['B', 1, 'b1', '10'],
      ['B', 2, 'b2', '30'],
      ['B', 3, 'b3', '40'],
      ['C', 1, 'c1', '20'],
      ['C', 2, 'c2', '50'],
    ])
    expect(rows.rows.every((r) => r.status === 'posted' && r.committed_at !== null)).toBe(true)

    const sequences = await sieWriterFixture().query<{ voucher_series: string; last_number: number }>(
      `SELECT voucher_series, last_number FROM public.voucher_sequences
        WHERE company_id = $1 AND fiscal_period_id = $2 ORDER BY voucher_series`,
      [companyId, fiscalPeriodId],
    )
    expect(sequences.rows).toEqual([
      { voucher_series: 'B', last_number: 3 },
      { voucher_series: 'C', last_number: 2 },
    ])
  })

  it('interleaves with commit_journal_entry on the same series without gaps or reuse', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    // Engine commit first: A1.
    const draftBefore = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId, voucherSeries: 'A' })
    await insertBalancedLines(draftBefore)
    const first = await sieWriterFixture().query<{ voucher_number: number }>(
      `SELECT voucher_number FROM public.commit_journal_entry($1::uuid, $2::uuid)`,
      [companyId, draftBefore],
    )
    expect(first.rows[0]!.voucher_number).toBe(1)

    // Import two: A2, A3.
    const res = await sieWriterFixture().query<{ write_sie_job_entries: { inserted_entries: Array<{ voucherNumber: number }> } }>(
      `SELECT public.write_sie_job_entries($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
      [
        companyId,
        userId,
        fiscalPeriodId,
        JSON.stringify([
          { sourceId: 'A1', series: 'A', date: '2026-02-01', description: 'imp1', sourceType: 'import', lines: makeLines(10) },
          { sourceId: 'A2', series: 'A', date: '2026-02-02', description: 'imp2', sourceType: 'import', lines: makeLines(20) },
        ]),
      ],
    )
    expect(res.rows[0]!.write_sie_job_entries.inserted_entries.map((e) => e.voucherNumber)).toEqual([2, 3])

    // Engine commit after: A4.
    const draftAfter = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId, voucherSeries: 'A' })
    await insertBalancedLines(draftAfter)
    const last = await sieWriterFixture().query<{ voucher_number: number }>(
      `SELECT voucher_number FROM public.commit_journal_entry($1::uuid, $2::uuid)`,
      [companyId, draftAfter],
    )
    expect(last.rows[0]!.voucher_number).toBe(4)

    const numbers = await sieWriterFixture().query<{ voucher_number: number }>(
      `SELECT voucher_number FROM public.journal_entries
        WHERE company_id = $1 AND voucher_series = 'A' AND status = 'posted'
        ORDER BY voucher_number`,
      [companyId],
    )
    expect(numbers.rows.map((r) => r.voucher_number)).toEqual([1, 2, 3, 4])
  })

  it('keeps the 3741 öresutjämning line the importer adds for sub-krona rounding', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    // 100.00 debit against 99.63 credit; the importer closes the 0.37 gap on
    // 3741 rather than editing a source line (tiered rounding, sie-import.ts).
    const payload = [
      {
        sourceId: 'A1',
        series: 'A',
        date: '2026-02-01',
        description: 'Rounded in source',
        sourceType: 'import',
        lines: [
          { account_number: '5010', debit_amount: 100, credit_amount: 0, currency: 'SEK', sort_order: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 99.63, currency: 'SEK', sort_order: 1 },
          { account_number: '3741', debit_amount: 0, credit_amount: 0.37, currency: 'SEK', line_description: 'Öresutjämning', sort_order: 2 },
        ],
      },
    ]

    const res = await sieWriterFixture().query<{ write_sie_job_entries: { inserted_entries: Array<{ id: string }> } }>(
      `SELECT public.write_sie_job_entries($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
      [companyId, userId, fiscalPeriodId, JSON.stringify(payload)],
    )
    const entryId = res.rows[0]!.write_sie_job_entries.inserted_entries[0]!.id

    const lines = await sieWriterFixture().query<{ account_number: string; debit_amount: string; credit_amount: string; line_description: string | null; sort_order: number }>(
      `SELECT account_number, debit_amount::text, credit_amount::text, line_description, sort_order
         FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY sort_order`,
      [entryId],
    )
    expect(lines.rows).toEqual([
      { account_number: '5010', debit_amount: '100', credit_amount: '0', line_description: null, sort_order: 0 },
      { account_number: '1930', debit_amount: '0', credit_amount: '99.63', line_description: null, sort_order: 1 },
      { account_number: '3741', debit_amount: '0', credit_amount: '0.37', line_description: 'Öresutjämning', sort_order: 2 },
    ])
  })

  it('names the source voucher when an entry has no lines and writes nothing', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    const payload = [
      { sourceId: 'A1', series: 'A', date: '2026-02-01', description: 'ok', sourceType: 'import', lines: makeLines(10) },
      { sourceId: 'A2', series: 'A', date: '2026-02-02', description: 'empty', sourceType: 'import', lines: [] },
    ]

    await expect(
      sieWriterFixture().query(
        `SELECT public.write_sie_job_entries($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
        [companyId, userId, fiscalPeriodId, JSON.stringify(payload)],
      ),
    ).rejects.toThrow(/SIE journal entry A2 has no lines/)

    const headers = await sieWriterFixture().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.journal_entries WHERE company_id = $1`,
      [companyId],
    )
    expect(headers.rows[0]!.count).toBe('0')
    const sequence = await sieWriterFixture().query(
      `SELECT 1 FROM public.voucher_sequences WHERE company_id = $1 AND fiscal_period_id = $2`,
      [companyId, fiscalPeriodId],
    )
    expect(sequence.rowCount).toBe(0)
  })

  it('refuses a closed fiscal period before a draft can be posted', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany({ isClosed: true })

    await expect(
      sieWriterFixture().query(
        `SELECT public.write_sie_job_entries($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
        [
          companyId,
          userId,
          fiscalPeriodId,
          JSON.stringify([
            { sourceId: 'A1', series: 'A', date: '2026-02-01', description: 'Into closed period', sourceType: 'import', lines: makeLines(10) },
          ]),
        ],
      ),
    ).rejects.toThrow(/locked\/closed fiscal period/i)

    const headers = await sieWriterFixture().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.journal_entries WHERE company_id = $1`,
      [companyId],
    )
    expect(headers.rows[0]!.count).toBe('0')
    const sequence = await sieWriterFixture().query(
      `SELECT 1 FROM public.voucher_sequences WHERE company_id = $1 AND fiscal_period_id = $2`,
      [companyId, fiscalPeriodId],
    )
    expect(sequence.rowCount).toBe(0)
  })

  it('rejects an imported history row that claims an actor (provenance check)', async () => {
    const { companyId } = await seedCompany()
    await expect(
      sieWriterFixture().query(
        `INSERT INTO public.journal_entry_rattelse_log
           (company_id, journal_entry_id, rattelse_type, struck_lines, added_lines, actor, source)
         VALUES ($1, gen_random_uuid(), 'lines', '[]', '[]', gen_random_uuid(), 'sie_import')`,
        [companyId],
      ),
    ).rejects.toThrow(/journal_entry_rattelse_log_import_provenance_check/)
  })
})
