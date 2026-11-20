import { beforeAll, describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * The package switches of the Profiles and Suggestions design (step 3) as
 * pending operations: migration 20261016200000 adds enable_package and
 * disable_package to the operation type CHECK (validated in 20261016200100),
 * and 20261016200200 adds the actor type 'system' a suggestion is staged
 * with (validated in 20261016200300). Both lists are rebuilt from the live
 * constraint, so every value that was there before must still be accepted.
 */
describe('pending_operations: package switches and the system actor', () => {
  let userId: string
  let companyId: string

  beforeAll(async () => {
    const seeded = await seedCompany()
    userId = seeded.userId
    companyId = seeded.companyId
  })

  async function insertsCleanly(operationType: string, actorType: string): Promise<void> {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, actor_type, actor_label)
         VALUES ($1, $2, $3, 'regression: paketbyte', $4, 'Accounted')`,
        [userId, companyId, operationType, actorType],
      )
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  }

  it('accepts enable_package and disable_package and still accepts the types before them', async () => {
    for (const type of ['enable_package', 'disable_package', 'revoke_service_account', 'create_voucher', 'mark_vat_check_reviewed']) {
      await expect(insertsCleanly(type, 'user')).resolves.toBeUndefined()
    }
  })

  it("accepts the actor type 'system' and still accepts the actor types before it", async () => {
    for (const actor of ['system', 'user', 'api_key', 'mcp_oauth', 'cron', 'agent_chat', 'service_account']) {
      await expect(insertsCleanly('enable_package', actor)).resolves.toBeUndefined()
    }
  })

  it('still refuses an operation type and an actor type outside the lists', async () => {
    await expect(
      getPool().query(
        `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title)
         VALUES ($1, $2, 'apply_profile', 'not stageable yet')`,
        [userId, companyId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(
        `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, actor_type)
         VALUES ($1, $2, 'enable_package', 'no such actor', 'robot')`,
        [userId, companyId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('leaves both constraints validated', async () => {
    const { rows } = await getPool().query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid = 'public.pending_operations'::regclass
          AND conname IN ('pending_operations_operation_type_check', 'pending_operations_actor_type_check')
        ORDER BY conname`,
    )
    expect(rows).toEqual([
      { conname: 'pending_operations_actor_type_check', convalidated: true },
      { conname: 'pending_operations_operation_type_check', convalidated: true },
    ])
  })
})
