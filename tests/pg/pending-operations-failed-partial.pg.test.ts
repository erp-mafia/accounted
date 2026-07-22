/**
 * pg-real coverage for migration 20260722134114_pending_operations_failed_partial_status.
 *
 * 'failed_partial' (issue #842) is the terminal state for a pending_operation
 * whose executor posted an irreversible side-effect (storno voucher, credit
 * note) and then failed a later step. These tests prove the schema semantics
 * the dispatcher relies on:
 *   - the CHECK constraint accepts the new status
 *   - committing -> failed_partial is a legal transition (the dispatcher
 *     always claims to 'committing' first)
 *   - failed_partial rows are immutable and undeletable (terminal, BFL 7 kap.)
 *   - the CAS claim (UPDATE ... WHERE status = 'pending') can never pick up a
 *     failed_partial row, so the op is not re-committable
 */
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

async function insertOp(
  userId: string,
  companyId: string,
  status: string,
  extra: { resolvedAt?: boolean; resultData?: Record<string, unknown> } = {},
): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO public.pending_operations
       (user_id, company_id, operation_type, status, title, params, preview_data, resolved_at, result_data)
     VALUES ($1, $2, 'match_transaction_invoice', $3, 'failed-partial pg test', '{}', '{}',
             ${extra.resolvedAt ? 'now()' : 'NULL'}, $4)
     RETURNING id`,
    [userId, companyId, status, JSON.stringify(extra.resultData ?? {})],
  )
  return result.rows[0]!.id
}

describe('pending_operations: failed_partial status (migration 20260722134114)', () => {
  it('CHECK constraint accepts failed_partial with posted ids in result_data', async () => {
    const { userId, companyId } = await seedCompany()
    const id = await insertOp(userId, companyId, 'failed_partial', {
      resolvedAt: true,
      resultData: {
        error: 'payment JE failed after storno',
        posted_ids: { reversal_journal_entry_id: '00000000-0000-0000-0000-000000000001' },
      },
    })

    const row = await getPool().query<{ status: string; result_data: { posted_ids?: Record<string, string> } }>(
      `SELECT status, result_data FROM public.pending_operations WHERE id = $1`,
      [id],
    )
    expect(row.rows[0]?.status).toBe('failed_partial')
    expect(row.rows[0]?.result_data.posted_ids?.reversal_journal_entry_id).toBe(
      '00000000-0000-0000-0000-000000000001',
    )
  })

  it('CHECK constraint still rejects unknown statuses', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(insertOp(userId, companyId, 'failed')).rejects.toThrow(
      /pending_operations_status_check|check constraint/i,
    )
  })

  it('allows the committing -> failed_partial transition the dispatcher performs', async () => {
    const { userId, companyId } = await seedCompany()
    const id = await insertOp(userId, companyId, 'committing')

    const upd = await getPool().query(
      `UPDATE public.pending_operations
         SET status = 'failed_partial',
             resolved_at = now(),
             result_data = '{"error":"second step failed","posted_ids":{"credit_note_id":"cn-1"}}'
       WHERE id = $1 RETURNING id, status`,
      [id],
    )
    expect(upd.rowCount).toBe(1)
    expect(upd.rows[0]?.status).toBe('failed_partial')
  })

  it('blocks UPDATE on failed_partial rows (terminal-state immutability trigger)', async () => {
    const { userId, companyId } = await seedCompany()
    const id = await insertOp(userId, companyId, 'failed_partial', { resolvedAt: true })

    await expect(
      getPool().query(
        `UPDATE public.pending_operations SET title = 'tampered' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/terminal state|BFL 7/i)

    // Including status rewrites: failed_partial can never go back to pending.
    await expect(
      getPool().query(
        `UPDATE public.pending_operations SET status = 'pending' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/terminal state|BFL 7/i)
  })

  it('blocks DELETE on failed_partial rows', async () => {
    const { userId, companyId } = await seedCompany()
    const id = await insertOp(userId, companyId, 'failed_partial', { resolvedAt: true })

    await expect(
      getPool().query(`DELETE FROM public.pending_operations WHERE id = $1`, [id]),
    ).rejects.toThrow(/terminal state|BFL 7/i)
  })

  it('CAS claim (status = pending guard) never picks up a failed_partial row', async () => {
    const { userId, companyId } = await seedCompany()
    const id = await insertOp(userId, companyId, 'failed_partial', { resolvedAt: true })

    const claim = await getPool().query(
      `UPDATE public.pending_operations SET status = 'committing'
       WHERE id = $1 AND status = 'pending' RETURNING id`,
      [id],
    )
    expect(claim.rowCount).toBe(0)
  })

  it('keeps committed and rejected terminal behavior intact (regression)', async () => {
    const { userId, companyId } = await seedCompany()
    const committedId = await insertOp(userId, companyId, 'committed', { resolvedAt: true })
    const rejectedId = await insertOp(userId, companyId, 'rejected', { resolvedAt: true })

    await expect(
      getPool().query(
        `UPDATE public.pending_operations SET title = 'tampered' WHERE id = $1`,
        [committedId],
      ),
    ).rejects.toThrow(/terminal state|BFL 7/i)
    await expect(
      getPool().query(
        `UPDATE public.pending_operations SET title = 'tampered' WHERE id = $1`,
        [rejectedId],
      ),
    ).rejects.toThrow(/terminal state|BFL 7/i)
  })
})
