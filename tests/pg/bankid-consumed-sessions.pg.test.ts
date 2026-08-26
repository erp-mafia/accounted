import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser } from './fixtures'

/**
 * bankid_consumed_sessions (migration 20260815120000) is the single-use guard
 * for a BankID identification.
 *
 * The flow now lives in a cookie, so every tab of a browser shares one session
 * and two of them can observe `status: complete` in the same poll tick. Both
 * would call generateLink(), and the second magic link invalidates the first,
 * so the tab the user is looking at may be the one that fails. Expiring the
 * cookie on the way out does not prevent that: a Set-Cookie only applies once a
 * response reaches the browser, and both requests already carried it.
 *
 * These pin the two properties the application actually relies on: the claim is
 * atomic, and the table is invisible to end users. A session id is a bearer
 * credential for a personnummer and for a Supabase session, and the row set is
 * a record of who authenticated and when.
 */
describe('bankid_consumed_sessions (pg)', () => {
  it('lets exactly one claim win for a given session id', async () => {
    const sessionId = `sess-${randomUUID()}`

    await getPool().query(
      'INSERT INTO public.bankid_consumed_sessions (session_id) VALUES ($1)',
      [sessionId],
    )

    await expect(
      getPool().query(
        'INSERT INTO public.bankid_consumed_sessions (session_id) VALUES ($1)',
        [sessionId],
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('does not collide across different sessions', async () => {
    const a = `sess-${randomUUID()}`
    const b = `sess-${randomUUID()}`
    await getPool().query(
      'INSERT INTO public.bankid_consumed_sessions (session_id) VALUES ($1), ($2)',
      [a, b],
    )

    const { rows } = await getPool().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public.bankid_consumed_sessions WHERE session_id IN ($1, $2)',
      [a, b],
    )
    expect(rows[0]!.n).toBe(2)
  })

  it('stamps consumed_at so spent sessions can be aged out', async () => {
    const sessionId = `sess-${randomUUID()}`
    await getPool().query(
      'INSERT INTO public.bankid_consumed_sessions (session_id) VALUES ($1)',
      [sessionId],
    )

    const { rows } = await getPool().query<{ consumed_at: Date }>(
      'SELECT consumed_at FROM public.bankid_consumed_sessions WHERE session_id = $1',
      [sessionId],
    )
    expect(rows[0]!.consumed_at).toBeInstanceOf(Date)
  })

  it('has RLS on with no policies, so authenticated users see nothing', async () => {
    const { rows: flags } = await getPool().query<{ relrowsecurity: boolean }>(
      `SELECT c.relrowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'bankid_consumed_sessions'`,
    )
    expect(flags[0]!.relrowsecurity).toBe(true)

    const { rows: policies } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'bankid_consumed_sessions'`,
    )
    expect(policies[0]!.n).toBe(0)

    // And the guard actually bites for a real user, not just on paper: the
    // handlers write through the service role, which bypasses RLS.
    const sessionId = `sess-${randomUUID()}`
    await getPool().query(
      'INSERT INTO public.bankid_consumed_sessions (session_id) VALUES ($1)',
      [sessionId],
    )

    const userId = await insertAuthUser()
    await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM public.bankid_consumed_sessions WHERE session_id = $1',
        [sessionId],
      )
      expect(rows[0]!.n).toBe(0)
    })
  })
})
