import { describe, expect, it } from 'vitest'
import { insertAuthUser } from './fixtures'
import { getPool, withUserContext } from './setup'

/**
 * One active registration per user and redirect URI (migration
 * 20261104002931, crm#1654).
 *
 * Locks in:
 *   - two unrelated users can each register the same redirect URI, the way
 *     every customer of a tool with one fixed callback has to;
 *   - one user cannot hold two active registrations of the same URI, but may
 *     register it again after revoking the first;
 *   - the RLS boundary is unchanged: a user still sees only their own rows.
 */

const URI = 'https://tool.example/oauth/callback'

describe('oauth_client_registrations: per-user redirect URI', () => {
  it('lets two unrelated users register the same URI', async () => {
    const a = await insertAuthUser()
    const b = await insertAuthUser()
    await getPool().query(
      `INSERT INTO public.oauth_client_registrations (user_id, client_name, redirect_uri) VALUES ($1, 'A', $3), ($2, 'B', $3)`,
      [a, b, URI],
    )
    const { rows } = await getPool().query(
      `SELECT user_id FROM public.oauth_client_registrations WHERE redirect_uri = $1 AND user_id = ANY($2) AND revoked_at IS NULL`,
      [URI, [a, b]],
    )
    expect(rows.map((r) => r.user_id).sort()).toEqual([a, b].sort())
  })

  it('refuses a second active registration of the same URI by one user', async () => {
    const a = await insertAuthUser()
    await getPool().query(
      `INSERT INTO public.oauth_client_registrations (user_id, client_name, redirect_uri) VALUES ($1, 'A', $2)`,
      [a, URI],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.oauth_client_registrations (user_id, client_name, redirect_uri) VALUES ($1, 'A igen', $2)`,
        [a, URI],
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('allows the same user to register the URI again after revoking it', async () => {
    const a = await insertAuthUser()
    await getPool().query(
      `INSERT INTO public.oauth_client_registrations (user_id, client_name, redirect_uri, revoked_at) VALUES ($1, 'Gammal', $2, now())`,
      [a, URI],
    )
    await getPool().query(
      `INSERT INTO public.oauth_client_registrations (user_id, client_name, redirect_uri) VALUES ($1, 'Ny', $2)`,
      [a, URI],
    )
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.oauth_client_registrations WHERE user_id = $1 AND redirect_uri = $2`,
      [a, URI],
    )
    expect(rows[0].n).toBe(2)
  })

  it('still shows a user only their own registrations of a shared URI', async () => {
    const a = await insertAuthUser()
    const b = await insertAuthUser()
    await getPool().query(
      `INSERT INTO public.oauth_client_registrations (user_id, client_name, redirect_uri) VALUES ($1, 'B', $2)`,
      [b, URI],
    )
    // withUserContext rolls back, so insert and read in the same context.
    const seen = await withUserContext(a, async (client) => {
      await client.query(
        `INSERT INTO public.oauth_client_registrations (user_id, client_name, redirect_uri) VALUES ($1, 'A', $2)`,
        [a, URI],
      )
      const { rows } = await client.query(
        `SELECT user_id FROM public.oauth_client_registrations WHERE redirect_uri = $1`,
        [URI],
      )
      return rows.map((r) => r.user_id)
    })
    expect(seen).toEqual([a])
  })
})
