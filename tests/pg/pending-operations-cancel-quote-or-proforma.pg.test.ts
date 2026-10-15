import { beforeAll, describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * The pending_operations_operation_type_check constraint must accept the
 * 'cancel_quote_or_proforma' op type added by migration 20261015170000
 * (validated in 20261015170100), staged by gnubok_cancel_quote_or_proforma
 * (accounted#20). Without it the staging INSERT fails with check_violation on
 * every real call while dry_run previews clean. The expansion reads the list
 * from the catalog, so it must also keep every value that was there before.
 */
describe('pending_operations operation_type CHECK: cancel_quote_or_proforma', () => {
  let userId: string
  let companyId: string

  beforeAll(async () => {
    const seeded = await seedCompany()
    userId = seeded.userId
    companyId = seeded.companyId
  })

  it('accepts cancel_quote_or_proforma and still accepts the types before it', async () => {
    const client = await getPool().connect()
    try {
      for (const type of ['cancel_quote_or_proforma', 'confirm_supplier_payee', 'delete_draft_invoice']) {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title)
           VALUES ($1, $2, $3, 'regression: makulera offert')`,
          [userId, companyId, type],
        )
        await client.query('ROLLBACK')
      }
    } finally {
      client.release()
    }
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
