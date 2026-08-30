import { beforeAll, describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * The pending_operations_operation_type_check constraint must accept the
 * 'ignore_transaction' op type added by migration 20260830100000 (validated
 * in 20260830100001, issue #1661). Without the constraint expansion,
 * gnubok_ignore_transaction's staging INSERT fails with check_violation on
 * every real call while dry_run (which skips the INSERT) previews clean: the
 * exact bug class the op-type audit test documents. The second case pins that
 * the re-created constraint is still a closed list.
 */
describe('pending_operations operation_type CHECK: ignore_transaction', () => {
  let userId: string
  let companyId: string

  beforeAll(async () => {
    const seeded = await seedCompany()
    userId = seeded.userId
    companyId = seeded.companyId
  })

  it('accepts ignore_transaction (constraint expanded in 20260830100000)', async () => {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title)
         VALUES ($1, $2, 'ignore_transaction', 'regression: ignorera transaktion')`,
        [userId, companyId],
      )
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('still rejects an unknown op type (the list stays closed)', async () => {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await expect(
        client.query(
          `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title)
           VALUES ($1, $2, 'no_such_operation', 'must fail')`,
          [userId, companyId],
        ),
      ).rejects.toMatchObject({ code: '23514' })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
})
