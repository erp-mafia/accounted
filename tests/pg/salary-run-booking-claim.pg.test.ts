/**
 * pg-real tests for 20260929220200_salary_run_booking_claim.sql and
 * 20260929220201_salary_run_booking_claim_forged_stale.sql (accounted#3251).
 *
 * Booking a salary run reads it as 'paid', posts its vouchers and flips it to
 * 'booked' in separate round trips, so two concurrent book calls both passed
 * the read and both posted. claim_salary_run_booking() is the conditional
 * write that lets exactly one of them post: these tests pin that it hands out
 * one token under real row locking, only for a paid run of the caller's
 * company, that a stale claim can be taken over, and that the release and the
 * paid -> booked flip the application issues honour only the holder's token.
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from '@/tests/pg/fixtures'

async function insertRun(companyId: string, userId: string, status: string, month = 6): Promise<string> {
  const runId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, $4, make_date(2026, $4, 25), $5)`,
    [runId, companyId, userId, month, status],
  )
  return runId
}

async function claim(client: PoolClient, companyId: string, runId: string): Promise<string | null> {
  const { rows } = await client.query<{ token: string | null }>(
    `SELECT public.claim_salary_run_booking($1, $2) AS token`,
    [companyId, runId],
  )
  return rows[0].token
}

async function readClaim(runId: string) {
  const { rows } = await getPool().query<{
    status: string
    booking_claim_id: string | null
    booking_claimed_at: Date | null
  }>(`SELECT status, booking_claim_id, booking_claimed_at FROM public.salary_runs WHERE id = $1`, [runId])
  return rows[0]
}

/** Open a transaction as the given user, the way PostgREST presents a session. */
async function beginAsUser(client: PoolClient, userId: string): Promise<void> {
  await client.query('BEGIN')
  await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ])
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
  await client.query('SET LOCAL ROLE authenticated')
}

/** Claim as the user and COMMIT, so later sessions see the claim. */
async function claimCommitted(userId: string, companyId: string, runId: string): Promise<string | null> {
  const client = await getClient()
  try {
    await beginAsUser(client, userId)
    const token = await claim(client, companyId, runId)
    await client.query('COMMIT')
    return token
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

describe('claim_salary_run_booking', () => {
  it('hands exactly one of two concurrent callers the claim', async () => {
    const { userId, companyId } = await seedCompany()
    const runId = await insertRun(companyId, userId, 'paid')

    const c1 = await getClient()
    const c2 = await getClient()
    try {
      await beginAsUser(c1, userId)
      await beginAsUser(c2, userId)

      // Session 1 claims but has not committed: it holds the row lock.
      const first = await claim(c1, companyId, runId)
      expect(first).toMatch(/^[0-9a-f-]{36}$/)

      // Session 2 makes the same call (a second tab, MCP, an agent retry).
      // It must wait on the row instead of reading the run as unclaimed.
      let settled = false
      const pending = claim(c2, companyId, runId).then((token) => {
        settled = true
        return token
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(settled).toBe(false)

      await c1.query('COMMIT')
      // Re-checked against the committed claim: no token, so it posts nothing.
      expect(await pending).toBeNull()
      await c2.query('COMMIT')
    } finally {
      await c1.query('ROLLBACK').catch(() => {})
      await c2.query('ROLLBACK').catch(() => {})
      c1.release()
      c2.release()
    }

    const row = await readClaim(runId)
    expect(row.status).toBe('paid')
    expect(row.booking_claim_id).not.toBeNull()
  })

  it('refuses a second claim while the first is live, even from the same user', async () => {
    const { userId, companyId } = await seedCompany()
    const runId = await insertRun(companyId, userId, 'paid')

    const first = await claimCommitted(userId, companyId, runId)
    const second = await claimCommitted(userId, companyId, runId)

    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect((await readClaim(runId)).booking_claim_id).toBe(first)
  })

  it('claims only a paid run', async () => {
    const { userId, companyId } = await seedCompany()
    const statuses = ['draft', 'review', 'approved', 'booked', 'corrected']
    for (const [index, status] of statuses.entries()) {
      const runId = await insertRun(companyId, userId, status, index + 1)
      expect(await claimCommitted(userId, companyId, runId)).toBeNull()
      expect((await readClaim(runId)).booking_claim_id).toBeNull()
    }
  })

  it('lets a caller take over a claim older than 15 minutes (its call died)', async () => {
    const { userId, companyId } = await seedCompany()
    const runId = await insertRun(companyId, userId, 'paid')
    const stale = randomUUID()
    await getPool().query(
      `UPDATE public.salary_runs
          SET booking_claim_id = $2, booking_claimed_at = clock_timestamp() - interval '16 minutes'
        WHERE id = $1`,
      [runId, stale],
    )

    const token = await claimCommitted(userId, companyId, runId)

    expect(token).not.toBeNull()
    expect(token).not.toBe(stale)
    const row = await readClaim(runId)
    expect(row.booking_claim_id).toBe(token)
    expect(Date.now() - row.booking_claimed_at!.getTime()).toBeLessThan(60_000)
  })

  it('does not take over a claim that is still inside its 15 minutes', async () => {
    const { userId, companyId } = await seedCompany()
    const runId = await insertRun(companyId, userId, 'paid')
    const live = randomUUID()
    await getPool().query(
      `UPDATE public.salary_runs
          SET booking_claim_id = $2, booking_claimed_at = clock_timestamp() - interval '14 minutes'
        WHERE id = $1`,
      [runId, live],
    )

    expect(await claimCommitted(userId, companyId, runId)).toBeNull()
    expect((await readClaim(runId)).booking_claim_id).toBe(live)
  })

  it('takes over a forged claim a writer set directly: no timestamp, or stamped in the future', async () => {
    const { userId, companyId } = await seedCompany()
    const forgedShapes = ['NULL', "clock_timestamp() + interval '100 years'"]
    for (const [index, claimedAt] of forgedShapes.entries()) {
      const runId = await insertRun(companyId, userId, 'paid', index + 1)
      const forged = randomUUID()
      // The salary_runs UPDATE policy lets a company writer PATCH these columns.
      // withUserContext rolls back, so this proves the write is allowed and the
      // pool write below commits the same forged state.
      const allowed = await withUserContext(userId, async (client) => {
        const { rowCount } = await client.query(
          `UPDATE public.salary_runs SET booking_claim_id = $2, booking_claimed_at = ${claimedAt} WHERE id = $1`,
          [runId, forged],
        )
        return rowCount
      })
      expect(allowed).toBe(1)
      await getPool().query(
        `UPDATE public.salary_runs SET booking_claim_id = $2, booking_claimed_at = ${claimedAt} WHERE id = $1`,
        [runId, forged],
      )

      const token = await claimCommitted(userId, companyId, runId)

      expect(token).not.toBeNull()
      expect(token).not.toBe(forged)
      const row = await readClaim(runId)
      expect(row.booking_claim_id).toBe(token)
      expect(Math.abs(Date.now() - row.booking_claimed_at!.getTime())).toBeLessThan(60_000)
    }
  })

  it('never claims across companies: wrong company id, non-member, viewer', async () => {
    const { userId, companyId } = await seedCompany()
    const other = await seedCompany()
    const runId = await insertRun(companyId, userId, 'paid')

    // A member of another company naming its own company id: no row matches.
    expect(await claimCommitted(other.userId, other.companyId, runId)).toBeNull()
    // Naming the right company without membership: RLS hides the row.
    expect(await claimCommitted(other.userId, companyId, runId)).toBeNull()
    // A viewer of the company may read the run but not claim it.
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    await expect(claimCommitted(viewer, companyId, runId)).rejects.toMatchObject({ code: '42501' })

    expect((await readClaim(runId)).booking_claim_id).toBeNull()
  })

  it('is callable by the service role (v1 and MCP doors) and not by anon', async () => {
    const { userId, companyId } = await seedCompany()
    const runId = await insertRun(companyId, userId, 'paid')

    const token = await runAsServiceRole((client) => claim(client, companyId, runId))
    expect(token).not.toBeNull()

    const { rows } = await getPool().query<{ anon: boolean; authenticated: boolean; service: boolean }>(
      `SELECT has_function_privilege('anon', 'public.claim_salary_run_booking(uuid,uuid)', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.claim_salary_run_booking(uuid,uuid)', 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', 'public.claim_salary_run_booking(uuid,uuid)', 'EXECUTE') AS service`,
    )
    expect(rows[0]).toEqual({ anon: false, authenticated: true, service: true })
  })
})

describe('salary run booking claim: release and flip (the statements book-run.ts issues)', () => {
  it('releases only for the holder token', async () => {
    const { userId, companyId } = await seedCompany()
    const runId = await insertRun(companyId, userId, 'paid')
    const token = await claimCommitted(userId, companyId, runId)

    const release = (claimId: string) =>
      withUserContext(userId, async (client) => {
        const { rowCount } = await client.query(
          `UPDATE public.salary_runs SET booking_claim_id = NULL, booking_claimed_at = NULL
            WHERE id = $1 AND company_id = $2 AND booking_claim_id = $3`,
          [runId, companyId, claimId],
        )
        return rowCount
      })

    // withUserContext rolls back, so each call sees the committed claim.
    expect(await release(randomUUID())).toBe(0)
    expect(await release(token!)).toBe(1)
  })

  it('lets only the holder flip the run to booked, clearing the claim, and then a new claim is refused', async () => {
    const { userId, companyId } = await seedCompany()
    const runId = await insertRun(companyId, userId, 'paid')
    const token = await claimCommitted(userId, companyId, runId)

    const flip = async (claimId: string) => {
      const client = await getClient()
      try {
        await beginAsUser(client, userId)
        const { rowCount } = await client.query(
          `UPDATE public.salary_runs
              SET status = 'booked', booked_at = now(), booked_by = $3,
                  booking_claim_id = NULL, booking_claimed_at = NULL
            WHERE id = $1 AND company_id = $2 AND status = 'paid' AND booking_claim_id = $4`,
          [runId, companyId, userId, claimId],
        )
        await client.query('COMMIT')
        return rowCount
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    }

    // A caller that lost the claim cannot flip the run behind the holder.
    expect(await flip(randomUUID())).toBe(0)
    expect((await readClaim(runId)).status).toBe('paid')

    expect(await flip(token!)).toBe(1)
    expect(await readClaim(runId)).toMatchObject({
      status: 'booked',
      booking_claim_id: null,
      booking_claimed_at: null,
    })

    // Booked: nothing left to claim, so a late call posts nothing.
    expect(await claimCommitted(userId, companyId, runId)).toBeNull()
  })
})
