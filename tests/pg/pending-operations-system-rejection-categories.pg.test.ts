/**
 * pg-real coverage for migration 20261012070931_pending_ops_system_rejection_categories.
 *
 * rejection_category now carries the system's reasons (expired, superseded,
 * failed) beside the five a person can pick, so a person's verdict is told
 * apart by value alone. These tests prove:
 *   - each system value is accepted on the transitions that write it
 *     (pending -> rejected for the expiry cron and a superseded proposal,
 *     committing -> rejected for a failed approval)
 *   - the five person values are still accepted
 *   - anything else is still refused by the CHECK
 */
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

async function insertOp(userId: string, companyId: string, status: 'pending' | 'committing'): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO public.pending_operations
       (user_id, company_id, operation_type, status, title, params, preview_data)
     VALUES ($1, $2, 'categorize_transaction', $3, 'rejection category pg test', '{}', '{}')
     RETURNING id`,
    [userId, companyId, status],
  )
  return result.rows[0]!.id
}

async function reject(id: string, category: string): Promise<string | null> {
  const upd = await getPool().query<{ rejection_category: string | null }>(
    `UPDATE public.pending_operations
        SET status = 'rejected', resolved_at = now(), rejection_category = $2
      WHERE id = $1
      RETURNING rejection_category`,
    [id, category],
  )
  return upd.rows[0]?.rejection_category ?? null
}

describe('pending_operations: system rejection categories (migration 20261012070931)', () => {
  it.each(['expired', 'superseded'])('accepts %s when the system closes a pending operation', async (category) => {
    const { userId, companyId } = await seedCompany()
    const id = await insertOp(userId, companyId, 'pending')
    expect(await reject(id, category)).toBe(category)
  })

  it('accepts failed when an approval that claimed the row does not complete', async () => {
    const { userId, companyId } = await seedCompany()
    const id = await insertOp(userId, companyId, 'committing')
    expect(await reject(id, 'failed')).toBe('failed')
  })

  it.each(['wrong_category', 'wrong_amount', 'duplicate', 'wrong_period', 'other'])(
    'still accepts the person value %s',
    async (category) => {
      const { userId, companyId } = await seedCompany()
      const id = await insertOp(userId, companyId, 'pending')
      expect(await reject(id, category)).toBe(category)
    },
  )

  it('still refuses a category outside the list', async () => {
    const { userId, companyId } = await seedCompany()
    const id = await insertOp(userId, companyId, 'pending')
    await expect(reject(id, 'timeout')).rejects.toThrow(/pending_operations_rejection_category_check/)
  })
})
