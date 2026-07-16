import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

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
})
