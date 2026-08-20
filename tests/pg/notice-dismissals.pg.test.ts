import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompanyMember, seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * pg-real coverage for 20260819190000_notice_dismissals.sql.
 *
 * Every policy on this table binds BOTH company membership and auth.uid(),
 * which is the property that separates it from the rest of the schema: a
 * dismissal is personal, so a colleague in the same company must keep seeing
 * a notice the other member dismissed. Company-only scoping would silence a
 * degraded-state notice for the whole company the moment one person hid it,
 * which is exactly the failure the notices work exists to avoid.
 *
 * Note on the helper: withUserContext ALWAYS rolls back (tests/pg/setup.ts),
 * so a write and its verification have to live inside the same callback.
 * Rows that must survive for a cross-user read are seeded on the pool
 * connection instead, which bypasses RLS as superuser.
 */

const NOTICE_ID = 'bank_connection_broken:11111111-1111-1111-1111-111111111111=error'

async function seedDismissal(
  companyId: string,
  userId: string,
  noticeId: string = NOTICE_ID,
): Promise<void> {
  await getPool().query(
    `INSERT INTO public.notice_dismissals (company_id, user_id, notice_id)
     VALUES ($1, $2, $3)`,
    [companyId, userId, noticeId],
  )
}

async function countRows(companyId: string, userId: string): Promise<number> {
  const res = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.notice_dismissals
      WHERE company_id = $1 AND user_id = $2`,
    [companyId, userId],
  )
  return Number(res.rows[0]!.n)
}

describe('notice_dismissals RLS', () => {
  it('lets a member dismiss a notice for themselves and read it back', async () => {
    const a = await seedCompany()

    await withUserContext(a.userId, async (client) => {
      const ins = await client.query(
        `INSERT INTO public.notice_dismissals (company_id, user_id, notice_id)
         VALUES ($1, $2, $3)`,
        [a.companyId, a.userId, NOTICE_ID],
      )
      expect(ins.rowCount).toBe(1)

      const read = await client.query<{ notice_id: string }>(
        `SELECT notice_id FROM public.notice_dismissals WHERE company_id = $1`,
        [a.companyId],
      )
      expect(read.rows.map((r) => r.notice_id)).toEqual([NOTICE_ID])
    })
  })

  it('re-stamps dismissed_at on a repeat dismissal (the upsert needs UPDATE)', async () => {
    const a = await seedCompany()
    await getPool().query(
      `INSERT INTO public.notice_dismissals (company_id, user_id, notice_id, dismissed_at)
       VALUES ($1, $2, $3, now() - interval '3 days')`,
      [a.companyId, a.userId, NOTICE_ID],
    )

    await withUserContext(a.userId, async (client) => {
      const res = await client.query<{ dismissed_at: Date }>(
        `INSERT INTO public.notice_dismissals (company_id, user_id, notice_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (company_id, user_id, notice_id)
         DO UPDATE SET dismissed_at = now()
         RETURNING dismissed_at`,
        [a.companyId, a.userId, NOTICE_ID],
      )
      expect(res.rowCount).toBe(1)
      // Without the UPDATE policy the ON CONFLICT branch is rejected outright,
      // so reaching a fresh timestamp is the assertion that pins it.
      const age = Date.now() - new Date(res.rows[0]!.dismissed_at).getTime()
      expect(age).toBeLessThan(60_000)
    })
  })

  it('keeps one member from seeing a colleague dismissal in the same company', async () => {
    const a = await seedCompany()
    const colleagueId = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: colleagueId, role: 'member' })
    await seedDismissal(a.companyId, a.userId)

    await withUserContext(colleagueId, async (client) => {
      const res = await client.query(
        `SELECT notice_id FROM public.notice_dismissals WHERE company_id = $1`,
        [a.companyId],
      )
      expect(res.rowCount).toBe(0)
    })

    // The owner still sees their own row: the colleague is filtered, not the row.
    await withUserContext(a.userId, async (client) => {
      const res = await client.query(
        `SELECT notice_id FROM public.notice_dismissals WHERE company_id = $1`,
        [a.companyId],
      )
      expect(res.rowCount).toBe(1)
    })
  })

  it('blocks dismissing on behalf of another user', async () => {
    const a = await seedCompany()
    const colleagueId = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: colleagueId, role: 'member' })

    await withUserContext(a.userId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.notice_dismissals (company_id, user_id, notice_id)
           VALUES ($1, $2, $3)`,
          [a.companyId, colleagueId, NOTICE_ID],
        ),
      ).rejects.toThrow(/row-level security/i)
    })
  })

  it('blocks a non-member from dismissing or reading another company notice', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    await seedDismissal(a.companyId, a.userId)

    await withUserContext(b.userId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.notice_dismissals (company_id, user_id, notice_id)
           VALUES ($1, $2, $3)`,
          [a.companyId, b.userId, NOTICE_ID],
        ),
      ).rejects.toThrow(/row-level security/i)
    })

    // A separate context: the rejected INSERT above aborts its transaction,
    // so the read has to happen in a fresh one.
    await withUserContext(b.userId, async (client) => {
      const read = await client.query(
        `SELECT notice_id FROM public.notice_dismissals WHERE company_id = $1`,
        [a.companyId],
      )
      expect(read.rowCount).toBe(0)
    })
  })

  it('deletes only the caller own rows, which is what reaping relies on', async () => {
    const a = await seedCompany()
    const colleagueId = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: colleagueId, role: 'member' })
    await seedDismissal(a.companyId, a.userId)
    await seedDismissal(a.companyId, colleagueId)

    await withUserContext(colleagueId, async (client) => {
      // An unqualified DELETE is still filtered to the caller's rows.
      const res = await client.query(
        `DELETE FROM public.notice_dismissals WHERE company_id = $1`,
        [a.companyId],
      )
      expect(res.rowCount).toBe(1)
    })

    // Rolled back by the helper, so both rows are still there for the check
    // that matters: the DELETE matched exactly one row, not both.
    expect(await countRows(a.companyId, a.userId)).toBe(1)
    expect(await countRows(a.companyId, colleagueId)).toBe(1)
  })

  it('scopes the primary key per (company, user, notice) so the same id can repeat', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const colleagueId = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: colleagueId, role: 'member' })

    await seedDismissal(a.companyId, a.userId)
    // Same notice id, different user in the same company: allowed.
    await expect(seedDismissal(a.companyId, colleagueId)).resolves.not.toThrow()
    // Same notice id, different company: allowed.
    await expect(seedDismissal(b.companyId, b.userId)).resolves.not.toThrow()
    // Exact same triple: rejected by the primary key.
    await expect(seedDismissal(a.companyId, a.userId)).rejects.toThrow(
      /notice_dismissals_pkey|duplicate key/i,
    )
  })
})
