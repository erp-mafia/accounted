import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for 20260814060000_skatteverket_tokens_per_company.sql.
 *
 * Skatteverket connections are per (user, company). The table used to carry
 * BOTH UNIQUE(user_id) and UNIQUE(company_id) (two stacked half-migrations),
 * which made it impossible for a multi-company operator to hold a connection
 * for more than one of their companies: the root cause of the cross-company
 * "connected" leak on the Skattekonto page. This suite locks in the composite
 * key so neither single-column constraint can quietly come back.
 */

async function insertTokenRow(userId: string, companyId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.skatteverket_tokens
       (user_id, company_id, access_token, refresh_token, expires_at)
     VALUES ($1, $2, 'enc-access', 'enc-refresh', now() + interval '1 hour')`,
    [userId, companyId],
  )
}

describe('skatteverket_tokens per-company uniqueness', () => {
  it('allows the same user to hold one connection per company', async () => {
    const a = await seedCompany()
    // Second company owned by the same user: insert the membershipless
    // company row directly; the constraint only concerns (user_id, company_id).
    const b = await seedCompany()

    await expect(insertTokenRow(a.userId, a.companyId)).resolves.not.toThrow()
    // Different user, different company: must not collide with a's row
    // (UNIQUE(user_id) would have rejected a second row for the same user;
    // UNIQUE(company_id) would have rejected a second row for the company).
    await expect(insertTokenRow(a.userId, b.companyId)).resolves.not.toThrow()
    await expect(insertTokenRow(b.userId, a.companyId)).resolves.not.toThrow()
  })

  it('rejects a second row for the same (user, company) pair', async () => {
    const { userId, companyId } = await seedCompany()
    await insertTokenRow(userId, companyId)
    await expect(insertTokenRow(userId, companyId)).rejects.toThrow(
      /skatteverket_tokens_user_id_company_id_key/,
    )
  })
})
