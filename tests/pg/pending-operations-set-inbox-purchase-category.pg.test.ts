import { beforeAll, describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * The staged purchase-category write (gnubok_set_inbox_purchase_category) as
 * a pending operation: migration 20261017030000 adds set_inbox_purchase_category
 * to the operation type CHECK, rebuilt from the live constraint, and
 * 20261017030100 validates it. Every value that was there before must still
 * be accepted, and a type outside the list is still refused.
 */
describe('pending_operations: set_inbox_purchase_category', () => {
  let userId: string
  let companyId: string

  beforeAll(async () => {
    const seeded = await seedCompany()
    userId = seeded.userId
    companyId = seeded.companyId
  })

  async function insertsCleanly(operationType: string): Promise<void> {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title)
         VALUES ($1, $2, $3, 'regression: kategori för inkorgspost')`,
        [userId, companyId, operationType],
      )
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  }

  it('accepts set_inbox_purchase_category and still accepts the types before it', async () => {
    for (const type of [
      'set_inbox_purchase_category',
      'enable_package',
      'disable_package',
      'unmatch_inbox_item_transaction',
      'mark_vat_check_reviewed',
      'create_voucher',
    ]) {
      await expect(insertsCleanly(type)).resolves.toBeUndefined()
    }
  })

  it('still refuses an operation type outside the list', async () => {
    await expect(
      getPool().query(
        `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title)
         VALUES ($1, $2, 'set_inbox_purchase_categories', 'no such type')`,
        [userId, companyId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('leaves the constraint validated', async () => {
    const { rows } = await getPool().query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint
        WHERE conrelid = 'public.pending_operations'::regclass
          AND conname = 'pending_operations_operation_type_check'`,
    )
    expect(rows).toEqual([{ convalidated: true }])
  })
})
