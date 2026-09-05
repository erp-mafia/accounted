import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'
import { insertAuthUser } from '@/tests/pg/fixtures'

// revoke_user_sessions (20260905160000_revoke_user_sessions.sql): the
// service-role "sign this user out everywhere" used when a pending BankID
// link is revoked because the address owner adopted the account. Every
// auth.sessions row of the user goes (refresh tokens cascade), except the one
// session the caller names, which is the address owner's own fresh session.

async function hasSessionsTable(): Promise<boolean> {
  const { rows } = await getPool().query<{ present: boolean }>(
    `SELECT to_regclass('auth.sessions') IS NOT NULL AS present`,
  )
  return rows[0]?.present === true
}

async function insertSession(userId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES ($1, $2, now(), now())`,
    [id, userId],
  )
  await getPool().query(
    `INSERT INTO auth.refresh_tokens (instance_id, token, user_id, revoked, created_at, updated_at, session_id)
     VALUES ('00000000-0000-0000-0000-000000000000', $1, $2, false, now(), now(), $3)`,
    [`pg-real-${id}`, userId, id],
  )
  return id
}

async function sessionIds(userId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM auth.sessions WHERE user_id = $1 ORDER BY id`,
    [userId],
  )
  return rows.map((r) => r.id)
}

async function refreshTokenCount(userId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM auth.refresh_tokens WHERE user_id = $1`,
    [userId],
  )
  return Number(rows[0]?.n ?? 0)
}

describe('revoke_user_sessions', () => {
  it('removes every session of the user and their refresh tokens', async () => {
    if (!(await hasSessionsTable())) return
    const userId = await insertAuthUser()
    await insertSession(userId)
    await insertSession(userId)
    expect(await refreshTokenCount(userId)).toBe(2)

    const removed = await runAsServiceRole(async (client) => {
      const { rows } = await client.query<{ n: number }>(
        `SELECT public.revoke_user_sessions($1, NULL) AS n`,
        [userId],
      )
      return rows[0]?.n
    })

    expect(removed).toBe(2)
    expect(await sessionIds(userId)).toEqual([])
    expect(await refreshTokenCount(userId)).toBe(0)
  })

  it('keeps the named session (the address owner just signed in) and nothing else', async () => {
    if (!(await hasSessionsTable())) return
    const userId = await insertAuthUser()
    const stale = await insertSession(userId)
    const keep = await insertSession(userId)

    const removed = await runAsServiceRole(async (client) => {
      const { rows } = await client.query<{ n: number }>(
        `SELECT public.revoke_user_sessions($1, $2) AS n`,
        [userId, keep],
      )
      return rows[0]?.n
    })

    expect(removed).toBe(1)
    expect(await sessionIds(userId)).toEqual([keep])
    expect(await sessionIds(userId)).not.toContain(stale)
  })

  it('never touches another user', async () => {
    if (!(await hasSessionsTable())) return
    const victim = await insertAuthUser()
    const other = await insertAuthUser()
    await insertSession(victim)
    const otherSession = await insertSession(other)

    await runAsServiceRole(async (client) => {
      await client.query(`SELECT public.revoke_user_sessions($1, NULL)`, [victim])
    })

    expect(await sessionIds(other)).toEqual([otherSession])
  })

  it('is not callable from a browser session (authenticated role)', async () => {
    const userId = await insertAuthUser()
    await expect(
      withUserContext(userId, async (client) => {
        await client.query(`SELECT public.revoke_user_sessions($1, NULL)`, [userId])
      }),
    ).rejects.toMatchObject({ code: '42501' })
  })
})
