import { randomUUID } from 'crypto'
import type { PoolClient } from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany, insertDraftJournalEntry, insertTransaction } from './fixtures'

/**
 * pg-real coverage for the stuck-'committing' recovery sweep (issue #843,
 * lib/pending-operations/recover-stuck-committing.ts).
 *
 * The sweep itself runs through the app-layer Supabase client, so what must
 * be proven against real Postgres is the substrate the module relies on:
 *
 *  1. Row selection: status='committing' AND updated_at older than the
 *     threshold picks exactly the stuck rows, never fresh claims or
 *     pending/terminal rows.
 *  2. The threshold anchor is trustworthy: the claim CAS
 *     (pending -> committing) bumps updated_at via the
 *     update_updated_at_column() BEFORE UPDATE trigger.
 *  3. Transition legality: the CAS-guarded committing -> committed and
 *     committing -> rejected writes (the exact payload shapes
 *     buildRecoveryUpdate emits) pass the immutability + input-frozen
 *     triggers; terminal rows are untouchable both via the CAS (0 rows) and
 *     outright (trigger exception).
 *  4. The evidence probe substrate: is_transaction_booked(uuid) exists and
 *     distinguishes a booked transaction from an unbooked one.
 */

const THRESHOLD_SQL = `now() - make_interval(mins => 15)`

async function insertPendingOp(
  client: PoolClient,
  params: {
    userId: string
    companyId: string
    status: string
    updatedAtSql?: string
    operationType?: string
    opParams?: Record<string, unknown>
    resolvedAtSql?: string
  },
): Promise<string> {
  const id = randomUUID()
  await client.query(
    `INSERT INTO public.pending_operations
       (id, user_id, company_id, operation_type, status, title, params, resolved_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'committing-recovery test', $6,
             ${params.resolvedAtSql ?? 'NULL'}, ${params.updatedAtSql ?? 'now()'})`,
    [
      id,
      params.userId,
      params.companyId,
      params.operationType ?? 'categorize_transaction',
      params.status,
      JSON.stringify(params.opParams ?? {}),
    ],
  )
  return id
}

describe('pending_operations stuck-committing recovery (pg-real)', () => {
  let userId: string
  let companyId: string
  let fiscalPeriodId: string

  beforeAll(async () => {
    const seeded = await seedCompany()
    userId = seeded.userId
    companyId = seeded.companyId
    fiscalPeriodId = seeded.fiscalPeriodId
  })

  it('selects only committing rows older than the threshold', async () => {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')

      const stale = await insertPendingOp(client, {
        userId,
        companyId,
        status: 'committing',
        updatedAtSql: `now() - interval '20 minutes'`,
      })
      // Fresh claim: an in-flight executor may still be running.
      await insertPendingOp(client, {
        userId,
        companyId,
        status: 'committing',
        updatedAtSql: `now() - interval '5 minutes'`,
      })
      // Old but not committing: expiry's problem or already terminal.
      await insertPendingOp(client, {
        userId,
        companyId,
        status: 'pending',
        updatedAtSql: `now() - interval '20 minutes'`,
      })
      await insertPendingOp(client, {
        userId,
        companyId,
        status: 'committed',
        updatedAtSql: `now() - interval '20 minutes'`,
        resolvedAtSql: 'now()',
      })
      await insertPendingOp(client, {
        userId,
        companyId,
        status: 'rejected',
        updatedAtSql: `now() - interval '20 minutes'`,
        resolvedAtSql: 'now()',
      })

      // Mirrors the module's listing query (status + updated_at cutoff).
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM public.pending_operations
         WHERE company_id = $1
           AND status = 'committing'
           AND updated_at < ${THRESHOLD_SQL}
         ORDER BY id`,
        [companyId],
      )

      expect(rows.map((r) => r.id)).toEqual([stale])
      await client.query('ROLLBACK')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  })

  it('claim CAS (pending -> committing) bumps updated_at, so the threshold anchor is trustworthy', async () => {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')

      const id = await insertPendingOp(client, {
        userId,
        companyId,
        status: 'pending',
        updatedAtSql: `now() - interval '1 hour'`,
      })

      const before = await client.query<{ updated_at: Date }>(
        `SELECT updated_at FROM public.pending_operations WHERE id = $1`,
        [id],
      )

      // The dispatcher's atomic claim (commit.ts).
      const claim = await client.query(
        `UPDATE public.pending_operations
         SET status = 'committing'
         WHERE id = $1 AND status = 'pending'`,
        [id],
      )
      expect(claim.rowCount).toBe(1)

      const after = await client.query<{ updated_at: Date }>(
        `SELECT updated_at FROM public.pending_operations WHERE id = $1`,
        [id],
      )

      // update_updated_at_column() sets updated_at = now() on the claim, so a
      // 'committing' row's updated_at IS its claim timestamp.
      expect(after.rows[0].updated_at.getTime()).toBeGreaterThan(
        before.rows[0].updated_at.getTime(),
      )
      await client.query('ROLLBACK')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  })

  it('finalizes a stuck committing row to committed through the real triggers', async () => {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')

      const id = await insertPendingOp(client, {
        userId,
        companyId,
        status: 'committing',
        updatedAtSql: `now() - interval '20 minutes'`,
      })

      // Exact payload shape from buildRecoveryUpdate(evidence != null).
      const resultData = {
        recovered: true,
        recovery: {
          reason: 'stuck_committing',
          evidence: 'transaction_booked',
          stuck_since: '2026-07-22T00:00:00.000Z',
          swept_at: '2026-07-22T02:30:00.000Z',
        },
      }
      const update = await client.query(
        `UPDATE public.pending_operations
         SET status = 'committed', resolved_at = now(), result_data = $2
         WHERE id = $1 AND status = 'committing'`,
        [id, JSON.stringify(resultData)],
      )
      expect(update.rowCount).toBe(1)

      const { rows } = await client.query(
        `SELECT status, resolved_at, result_data FROM public.pending_operations WHERE id = $1`,
        [id],
      )
      expect(rows[0].status).toBe('committed')
      expect(rows[0].resolved_at).not.toBeNull()
      expect(rows[0].result_data).toEqual(resultData)
      await client.query('ROLLBACK')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  })

  it('finalizes a stuck committing row to rejected through the real triggers', async () => {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')

      const id = await insertPendingOp(client, {
        userId,
        companyId,
        status: 'committing',
        updatedAtSql: `now() - interval '20 minutes'`,
        operationType: 'create_customer',
      })

      // Exact payload shape from buildRecoveryUpdate(evidence == null).
      const resultData = {
        auto_rejected: true,
        reason: 'stuck_committing',
        recovery: {
          reason: 'stuck_committing',
          evidence: null,
          stuck_since: '2026-07-22T00:00:00.000Z',
          swept_at: '2026-07-22T02:30:00.000Z',
          note: 'Operation was stuck in committing and no trace of posted side effects was found.',
        },
      }
      const update = await client.query(
        `UPDATE public.pending_operations
         SET status = 'rejected', resolved_at = now(), result_data = $2
         WHERE id = $1 AND status = 'committing'`,
        [id, JSON.stringify(resultData)],
      )
      expect(update.rowCount).toBe(1)

      const { rows } = await client.query(
        `SELECT status, resolved_at, result_data FROM public.pending_operations WHERE id = $1`,
        [id],
      )
      expect(rows[0].status).toBe('rejected')
      expect(rows[0].resolved_at).not.toBeNull()
      expect(rows[0].result_data).toEqual(resultData)
      await client.query('ROLLBACK')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  })

  it('never touches terminal rows: CAS matches zero, unconditional update raises', async () => {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')

      const committedId = await insertPendingOp(client, {
        userId,
        companyId,
        status: 'committed',
        updatedAtSql: `now() - interval '20 minutes'`,
        resolvedAtSql: 'now()',
      })

      // The sweep's CAS guard: a terminal row matches zero rows, so the
      // immutability trigger never even fires.
      const cas = await client.query(
        `UPDATE public.pending_operations
         SET status = 'rejected', resolved_at = now(), result_data = '{}'
         WHERE id = $1 AND status = 'committing'`,
        [committedId],
      )
      expect(cas.rowCount).toBe(0)

      // And if anything DID try to update a terminal row, the DB blocks it.
      await client.query('SAVEPOINT terminal_update')
      await expect(
        client.query(
          `UPDATE public.pending_operations SET result_data = '{"x":1}' WHERE id = $1`,
          [committedId],
        ),
      ).rejects.toThrow(/terminal state/)
      await client.query('ROLLBACK TO SAVEPOINT terminal_update')

      const { rows } = await client.query(
        `SELECT status FROM public.pending_operations WHERE id = $1`,
        [committedId],
      )
      expect(rows[0].status).toBe('committed')
      await client.query('ROLLBACK')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  })

  it('is_transaction_booked(uuid) distinguishes booked from unbooked (evidence probe substrate)', async () => {
    const journalEntryId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'posted',
      voucherNumber: 9001,
      committedAt: new Date().toISOString(),
    })
    const bookedTx = await insertTransaction({
      companyId,
      userId,
      journalEntryId,
      externalId: `recovery-booked-${randomUUID()}`,
    })
    const unbookedTx = await insertTransaction({
      companyId,
      userId,
      externalId: `recovery-unbooked-${randomUUID()}`,
    })

    const client = await getPool().connect()
    try {
      const booked = await client.query<{ b: boolean }>(
        `SELECT public.is_transaction_booked($1) AS b`,
        [bookedTx],
      )
      expect(booked.rows[0].b).toBe(true)

      const unbooked = await client.query<{ b: boolean }>(
        `SELECT public.is_transaction_booked($1) AS b`,
        [unbookedTx],
      )
      expect(unbooked.rows[0].b).toBe(false)
    } finally {
      client.release()
    }
  })
})
