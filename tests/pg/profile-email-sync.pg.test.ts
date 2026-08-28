import { describe, it, expect, afterAll } from 'vitest'
import { getPool } from './setup'
import { insertAuthUser } from './fixtures'

// 20260828191950_sync_profile_email_on_auth_email_change.sql:
// auth.users.email changes (self-service change, admin API, SQL) must mirror
// into public.profiles.email, which member lists, notification recipients,
// and AGI/KU contact fields read.

const createdUsers: string[] = []

async function seedUser(): Promise<string> {
  const id = await insertAuthUser()
  createdUsers.push(id)
  return id
}

afterAll(async () => {
  if (createdUsers.length > 0) {
    await getPool().query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [
      createdUsers,
    ])
  }
})

describe('sync_profile_email trigger', () => {
  it('mirrors an auth.users email change into profiles.email', async () => {
    const userId = await seedUser()

    const before = await getPool().query(
      `SELECT email FROM public.profiles WHERE id = $1`,
      [userId],
    )
    expect(before.rows[0].email).toBe(`pg-real-${userId}@test.invalid`)

    await getPool().query(`UPDATE auth.users SET email = $2 WHERE id = $1`, [
      userId,
      `changed-${userId}@test.invalid`,
    ])

    const after = await getPool().query(
      `SELECT email FROM public.profiles WHERE id = $1`,
      [userId],
    )
    expect(after.rows[0].email).toBe(`changed-${userId}@test.invalid`)
  })

  it('does not clobber profiles on unrelated auth.users updates', async () => {
    const userId = await seedUser()

    // A user-managed profile email divergence must survive updates that do
    // not touch auth.users.email (the trigger fires on UPDATE OF email only).
    await getPool().query(
      `UPDATE public.profiles SET email = $2 WHERE id = $1`,
      [userId, `manual-${userId}@test.invalid`],
    )
    await getPool().query(
      `UPDATE auth.users SET updated_at = now() WHERE id = $1`,
      [userId],
    )

    const res = await getPool().query(
      `SELECT email FROM public.profiles WHERE id = $1`,
      [userId],
    )
    expect(res.rows[0].email).toBe(`manual-${userId}@test.invalid`)
  })

  it('syncs even when profiles.email was already divergent', async () => {
    const userId = await seedUser()

    await getPool().query(
      `UPDATE public.profiles SET email = $2 WHERE id = $1`,
      [userId, `stale-${userId}@test.invalid`],
    )
    await getPool().query(`UPDATE auth.users SET email = $2 WHERE id = $1`, [
      userId,
      `fresh-${userId}@test.invalid`,
    ])

    const res = await getPool().query(
      `SELECT email FROM public.profiles WHERE id = $1`,
      [userId],
    )
    expect(res.rows[0].email).toBe(`fresh-${userId}@test.invalid`)
  })
})
