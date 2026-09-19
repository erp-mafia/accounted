import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for migration 20260919200000_pending_operations_batch_id.
 *
 * Locks in:
 *   - batch_id exists as a nullable uuid column.
 *   - The partial index idx_pending_operations_batch_id exists and only covers
 *     rows that carry a batch_id (the WHERE clause is part of the definition).
 *   - Two rows in two different companies can share one batch_id. That is the
 *     whole point of the column (one stage-across-companies call = one batch),
 *     so nothing may make it unique, per company or otherwise.
 *   - A row inserted without batch_id still lands: every staging path other
 *     than stage-across-companies leaves it NULL.
 *
 * Inserts go through the pool (superuser, RLS-bypassing): this is a schema
 * smoke, not an RLS or authorization test. Authorization never reads
 * batch_id; membership is checked per row through company_id.
 */

async function insertPendingOperation(params: {
  userId: string
  companyId: string
  batchId?: string | null
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.pending_operations
       (user_id, company_id, operation_type, title, batch_id)
     VALUES ($1, $2, 'lock_period', 'batch-id pg test', $3)
     RETURNING id`,
    [params.userId, params.companyId, params.batchId ?? null],
  )
  return rows[0]!.id
}

describe('pending_operations.batch_id (migration 20260919200000)', () => {
  it('exposes batch_id as a nullable uuid column', async () => {
    const { rows } = await getPool().query<{
      data_type: string
      is_nullable: string
    }>(
      `SELECT data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'pending_operations'
         AND column_name = 'batch_id'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.data_type).toBe('uuid')
    expect(rows[0]?.is_nullable).toBe('YES')
  })

  it('has the partial index on batch_id (rows with a batch only)', async () => {
    const { rows } = await getPool().query<{ indexdef: string }>(
      `SELECT indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'pending_operations'
         AND indexname = 'idx_pending_operations_batch_id'`,
    )
    expect(rows).toHaveLength(1)
    const def = rows[0]!.indexdef
    expect(def).toMatch(/\(batch_id\)/)
    expect(def).toMatch(/WHERE \(?batch_id IS NOT NULL\)?/)
    // Batches are shared across rows by design: the index must not be unique.
    expect(def).not.toMatch(/UNIQUE/i)
  })

  it('lets two rows in two different companies share one batch_id', async () => {
    const first = await seedCompany()
    const second = await seedCompany()
    expect(first.companyId).not.toBe(second.companyId)

    const batchId = randomUUID()
    const firstOp = await insertPendingOperation({
      userId: first.userId,
      companyId: first.companyId,
      batchId,
    })
    const secondOp = await insertPendingOperation({
      userId: second.userId,
      companyId: second.companyId,
      batchId,
    })

    const { rows } = await getPool().query<{ id: string; company_id: string }>(
      `SELECT id, company_id
       FROM public.pending_operations
       WHERE batch_id = $1
       ORDER BY created_at, id`,
      [batchId],
    )
    expect(rows.map((r) => r.id).sort()).toEqual([firstOp, secondOp].sort())
    expect(new Set(rows.map((r) => r.company_id))).toEqual(
      new Set([first.companyId, second.companyId]),
    )
  })

  it('still inserts a row with NULL batch_id (every other staging path)', async () => {
    const { userId, companyId } = await seedCompany()
    const id = await insertPendingOperation({ userId, companyId })

    const { rows } = await getPool().query<{ batch_id: string | null }>(
      `SELECT batch_id FROM public.pending_operations WHERE id = $1`,
      [id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.batch_id).toBeNull()
  })
})
