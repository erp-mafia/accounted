import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { insertAuthUser } from '@/tests/pg/fixtures'

describe('audit-log.pg: append-only immutability', () => {
  it('rejects UPDATE on audit_log rows', async () => {
    const userId = await insertAuthUser()
    const auditId = randomUUID()
    await getPool().query(
      `INSERT INTO public.audit_log (id, user_id, action, description)
       VALUES ($1, $2, 'SECURITY_EVENT', 'pg-real seed')`,
      [auditId, userId],
    )

    await expect(
      getPool().query(
        `UPDATE public.audit_log SET description = 'tampered' WHERE id = $1`,
        [auditId],
      ),
    ).rejects.toThrow(/cannot be modified or deleted/i)
  })

  it('rejects DELETE on audit_log rows', async () => {
    const userId = await insertAuthUser()
    const auditId = randomUUID()
    await getPool().query(
      `INSERT INTO public.audit_log (id, user_id, action, description)
       VALUES ($1, $2, 'SECURITY_EVENT', 'pg-real seed')`,
      [auditId, userId],
    )

    await expect(
      getPool().query(`DELETE FROM public.audit_log WHERE id = $1`, [auditId]),
    ).rejects.toThrow(/cannot be modified or deleted/i)
  })
})
