import { beforeAll, describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * The pending_operations_operation_type_check constraint must accept the
 * 'revoke_service_account' op type added by migration 20261016130200
 * (validated in 20261016130300), staged by gnubok_revoke_service_account.
 * Without it the staging INSERT fails with check_violation on every real
 * call while dry_run previews clean. The expansion reads the list from the
 * catalog, so it must also keep every value that was there before.
 */
describe('pending_operations operation_type CHECK: revoke_service_account', () => {
  let userId: string
  let companyId: string

  beforeAll(async () => {
    const seeded = await seedCompany()
    userId = seeded.userId
    companyId = seeded.companyId
  })

  it('accepts revoke_service_account and still accepts the types before it', async () => {
    const client = await getPool().connect()
    try {
      for (const type of ['revoke_service_account', 'mark_vat_check_reviewed', 'cancel_quote_or_proforma', 'create_voucher']) {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, actor_type)
           VALUES ($1, $2, $3, 'regression: återkalla tjänstekonto', 'api_key')`,
          [userId, companyId, type],
        )
        await client.query('ROLLBACK')
      }
    } finally {
      client.release()
    }
  })

  it('still refuses an operation type outside the list', async () => {
    await expect(
      getPool().query(
        `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title)
         VALUES ($1, $2, 'mint_service_account_key', 'never stageable')`,
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
