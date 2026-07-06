import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

async function insertOperation(params: {
  companyId: string
  userId: string
  status: OperationStatus
  result?: Record<string, unknown> | null
  error?: Record<string, unknown> | null
}): Promise<string> {
  const id = randomUUID()
  const isTerminal =
    params.status === 'succeeded' ||
    params.status === 'failed' ||
    params.status === 'cancelled'
  await getPool().query(
    `INSERT INTO public.operations
       (id, company_id, user_id, operation_type, status, started_at, completed_at, result, error)
     VALUES ($1, $2, $3, 'test.op', $4, now(), $5, $6, $7)`,
    [
      id,
      params.companyId,
      params.userId,
      params.status,
      isTerminal ? new Date() : null,
      params.result ? JSON.stringify(params.result) : null,
      params.error ? JSON.stringify(params.error) : null,
    ],
  )
  return id
}

describe('operations-immutability.pg: terminal-status rows are immutable', () => {
  // Sanity: the regular running → succeeded transition (the path used by
  // completeOperation in lib/api/v1/operations.ts) is NOT blocked. The
  // trigger reads OLD.status; the legitimate UPDATE has OLD.status='running'
  // which is non-terminal, so the RAISE is skipped.
  it('allows UPDATE that transitions running → succeeded', async () => {
    const { userId, companyId } = await seedCompany()
    const opId = await insertOperation({ companyId, userId, status: 'running' })

    await expect(
      getPool().query(
        `UPDATE public.operations
            SET status = 'succeeded',
                completed_at = now(),
                result = '{"ok": true}'::jsonb
          WHERE id = $1`,
        [opId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 })
  })

  it('allows UPDATE that transitions queued → running', async () => {
    const { userId, companyId } = await seedCompany()
    const opId = await insertOperation({ companyId, userId, status: 'queued' })

    await expect(
      getPool().query(
        `UPDATE public.operations
            SET status = 'running', started_at = now()
          WHERE id = $1`,
        [opId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 })
  })

  it('rejects UPDATE of result on a succeeded row', async () => {
    const { userId, companyId } = await seedCompany()
    const opId = await insertOperation({
      companyId,
      userId,
      status: 'succeeded',
      result: { ok: true },
    })

    await expect(
      getPool().query(
        `UPDATE public.operations SET result = '{"tampered": true}'::jsonb WHERE id = $1`,
        [opId],
      ),
    ).rejects.toThrow(/terminal status \(succeeded\) is immutable/i)
  })

  it('rejects UPDATE of status on a failed row (no failed → running reopen)', async () => {
    const { userId, companyId } = await seedCompany()
    const opId = await insertOperation({
      companyId,
      userId,
      status: 'failed',
      error: { code: 'X' },
    })

    await expect(
      getPool().query(
        `UPDATE public.operations SET status = 'running' WHERE id = $1`,
        [opId],
      ),
    ).rejects.toThrow(/terminal status \(failed\) is immutable/i)
  })

  it('rejects UPDATE of error on a cancelled row', async () => {
    const { userId, companyId } = await seedCompany()
    const opId = await insertOperation({ companyId, userId, status: 'cancelled' })

    await expect(
      getPool().query(
        `UPDATE public.operations SET error = '{"code": "REWRITTEN"}'::jsonb WHERE id = $1`,
        [opId],
      ),
    ).rejects.toThrow(/terminal status \(cancelled\) is immutable/i)
  })

  it('rejects DELETE on a succeeded row', async () => {
    const { userId, companyId } = await seedCompany()
    const opId = await insertOperation({
      companyId,
      userId,
      status: 'succeeded',
      result: { ok: true },
    })

    await expect(
      getPool().query(`DELETE FROM public.operations WHERE id = $1`, [opId]),
    ).rejects.toThrow(/terminal status \(succeeded\) cannot be deleted/i)
  })

  it('rejects DELETE on a failed row', async () => {
    const { userId, companyId } = await seedCompany()
    const opId = await insertOperation({
      companyId,
      userId,
      status: 'failed',
      error: { code: 'X' },
    })

    await expect(
      getPool().query(`DELETE FROM public.operations WHERE id = $1`, [opId]),
    ).rejects.toThrow(/terminal status \(failed\) cannot be deleted/i)
  })

  // Non-terminal rows remain deletable so operators can clear stuck/queued
  // entries (e.g. a worker that crashed before claiming the row, manual
  // cleanup of dev/test environments). The retention obligation kicks in
  // only once the row has recorded a terminal outcome.
  it('allows DELETE on a queued row', async () => {
    const { userId, companyId } = await seedCompany()
    const opId = await insertOperation({ companyId, userId, status: 'queued' })

    const result = await getPool().query(
      `DELETE FROM public.operations WHERE id = $1`,
      [opId],
    )
    expect(result.rowCount).toBe(1)
  })

  it('allows DELETE on a running row', async () => {
    const { userId, companyId } = await seedCompany()
    const opId = await insertOperation({ companyId, userId, status: 'running' })

    const result = await getPool().query(
      `DELETE FROM public.operations WHERE id = $1`,
      [opId],
    )
    expect(result.rowCount).toBe(1)
  })
})
