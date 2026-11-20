/**
 * accounted#154: one live filing record per company and VAT period
 * (idx_deadlines_vat_filing_period_unique, migration 20261109060000).
 *
 * The index covers completed rows only. Pending rows of one period must keep
 * coexisting: the deadline generator inserts a period's replacement row
 * before it deletes the old one (src/lib/tax/deadline-generator.ts), and an
 * index over pending rows refused that insert for every VAT company.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getClient, getPool } from '@/tests/pg/setup'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'

const MIGRATION_PATH = 'supabase/migrations/20261109060000_vat_filing_period_unique.sql'

async function company(): Promise<{ companyId: string; userId: string }> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  return { companyId, userId }
}

function insertRow(
  companyId: string,
  userId: string,
  row: { completed: boolean; status: string; dueDate?: string; notes?: string | null },
) {
  return getPool().query<{ id: string }>(
    `INSERT INTO public.deadlines
       (company_id, user_id, title, due_date, deadline_type, tax_deadline_type,
        tax_period, is_completed, completed_at, status, notes, source)
     VALUES ($1, $2, 'Momsdeklaration Q2 2026', $3, 'tax', 'moms_quarterly', '2026-Q2',
             $4::boolean, CASE WHEN $4::boolean THEN now() END, $5, $6, 'system')
     RETURNING id`,
    [companyId, userId, row.dueDate ?? '2026-08-17', row.completed, row.status, row.notes ?? null],
  )
}

async function liveRows(companyId: string) {
  const { rows } = await getPool().query<{ id: string; is_completed: boolean; status: string }>(
    `SELECT id, is_completed, status FROM public.deadlines
      WHERE company_id = $1 AND tax_deadline_type = 'moms_quarterly' AND tax_period = '2026-Q2'
        AND dismissed_at IS NULL`,
    [companyId],
  )
  return rows
}

describe('VAT filing period uniqueness', () => {
  it('allows only one live completed row for concurrent confirmations of a company and period', async () => {
    const { companyId, userId } = await company()
    const results = await Promise.allSettled([
      insertRow(companyId, userId, { completed: true, status: 'confirmed' }),
      insertRow(companyId, userId, { completed: true, status: 'confirmed' }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: '23505', constraint: 'idx_deadlines_vat_filing_period_unique' },
    })
    expect(await liveRows(companyId)).toHaveLength(1)
  })

  it("lets the generator insert a pending replacement before it deletes the period's old pending row", async () => {
    const { companyId, userId } = await company()
    await insertRow(companyId, userId, { completed: false, status: 'upcoming', dueDate: '2026-07-13' })

    await expect(
      insertRow(companyId, userId, { completed: false, status: 'upcoming', dueDate: '2026-08-17' }),
    ).resolves.toBeDefined()
    expect(await liveRows(companyId)).toHaveLength(2)
  })

  it('lets a filing record stand next to a stale pending row of the same period', async () => {
    const { companyId, userId } = await company()
    await insertRow(companyId, userId, { completed: false, status: 'overdue', dueDate: '2026-07-13' })

    await expect(insertRow(companyId, userId, { completed: true, status: 'submitted' })).resolves.toBeDefined()
    await expect(insertRow(companyId, userId, { completed: true, status: 'confirmed' })).rejects.toMatchObject({
      code: '23505',
    })
  })

  it('keeps one record when the migration meets duplicate filing records, dismissing the rest', async () => {
    const { companyId, userId } = await company()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      // The state before the index: two completed rows of one period.
      await client.query('DROP INDEX public.idx_deadlines_vat_filing_period_unique')
      const insert = (status: string, createdAt: string, notes: string | null) =>
        client.query<{ id: string }>(
          `INSERT INTO public.deadlines
             (company_id, user_id, title, due_date, deadline_type, tax_deadline_type,
              tax_period, is_completed, completed_at, status, notes, source, created_at)
           VALUES ($1, $2, 'Momsdeklaration Q2 2026', '2026-08-17', 'tax', 'moms_quarterly',
                   '2026-Q2', true, now(), $3, $4, 'system', $5)
           RETURNING id`,
          [companyId, userId, status, notes, createdAt],
        )
      const confirmedOlder = (await insert('confirmed', '2026-07-01T00:00:00Z', null)).rows[0].id
      const submittedNewer = (await insert('submitted', '2026-08-01T00:00:00Z', 'Skatteverkets referens: KV-1')).rows[0].id

      await client.query(readFileSync(MIGRATION_PATH, 'utf8'))

      const { rows } = await client.query<{ id: string; dismissed: boolean }>(
        `SELECT id, dismissed_at IS NOT NULL AS dismissed FROM public.deadlines WHERE company_id = $1`,
        [companyId],
      )
      // A Skatteverket confirmation outranks a manual mark, however new.
      expect(Object.fromEntries(rows.map((row) => [row.id, row.dismissed]))).toEqual({
        [confirmedOlder]: false,
        [submittedNewer]: true,
      })
      const { rows: index } = await client.query(
        `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_deadlines_vat_filing_period_unique'`,
      )
      expect(index).toHaveLength(1)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
