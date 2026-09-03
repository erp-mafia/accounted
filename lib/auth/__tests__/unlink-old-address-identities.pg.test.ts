import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { insertAuthUser } from '@/tests/pg/fixtures'

// on_auth_user_email_updated_unlink_old_identities
// (20260903110000_unlink_old_address_identities_on_email_change.sql): when
// auth.users.email changes, social identities bound to the OLD address are
// removed and app_metadata.providers is recomputed. Everything else on the
// account (email identity, social identities on other addresses) stays.

async function insertIdentity(params: {
  userId: string
  provider: string
  email: string
  providerId?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO auth.identities
       (id, user_id, provider, provider_id, identity_data, created_at, updated_at, last_sign_in_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, now(), now(), now())`,
    [
      id,
      params.userId,
      params.provider,
      params.providerId ?? (params.provider === 'email' ? params.userId : randomUUID()),
      JSON.stringify({ sub: params.providerId ?? params.userId, email: params.email }),
    ],
  )
  return id
}

async function setProviders(userId: string, providers: string[]): Promise<void> {
  await getPool().query(
    `UPDATE auth.users
        SET raw_app_meta_data = jsonb_build_object('provider', $2::text, 'providers', $3::jsonb)
      WHERE id = $1`,
    [userId, providers[0] ?? 'email', JSON.stringify(providers)],
  )
}

async function changeEmail(userId: string, email: string): Promise<void> {
  await getPool().query(`UPDATE auth.users SET email = $2 WHERE id = $1`, [userId, email])
}

async function identities(userId: string): Promise<Array<{ provider: string; email: string }>> {
  const { rows } = await getPool().query<{ provider: string; email: string }>(
    `SELECT provider, lower(identity_data->>'email') AS email
       FROM auth.identities WHERE user_id = $1 ORDER BY provider, email`,
    [userId],
  )
  return rows
}

async function providers(userId: string): Promise<unknown> {
  const { rows } = await getPool().query<{ providers: unknown }>(
    `SELECT raw_app_meta_data->'providers' AS providers FROM auth.users WHERE id = $1`,
    [userId],
  )
  return rows[0]!.providers
}

async function currentEmail(userId: string): Promise<string> {
  const { rows } = await getPool().query<{ email: string }>(
    `SELECT email FROM auth.users WHERE id = $1`,
    [userId],
  )
  return rows[0]!.email
}

describe('unlink old-address identities on auth email change', () => {
  it('removes the social identity bound to the old address and keeps the rest', async () => {
    const userId = await insertAuthUser()
    const oldEmail = await currentEmail(userId)
    const newEmail = `pg-real-new-${userId}@test.invalid`
    await insertIdentity({ userId, provider: 'email', email: oldEmail })
    await insertIdentity({ userId, provider: 'google', email: oldEmail })
    await insertIdentity({ userId, provider: 'google', email: `other-${userId}@test.invalid` })
    await setProviders(userId, ['email', 'google'])

    await changeEmail(userId, newEmail)

    expect(await identities(userId)).toEqual([
      { provider: 'email', email: oldEmail },
      { provider: 'google', email: `other-${userId}@test.invalid` },
    ])
    // Still has a google identity (the other address), so the list is unchanged.
    expect(await providers(userId)).toEqual(['email', 'google'])
  })

  it('drops the provider from app_metadata when its last identity goes', async () => {
    const userId = await insertAuthUser()
    const oldEmail = await currentEmail(userId)
    await insertIdentity({ userId, provider: 'email', email: oldEmail })
    await insertIdentity({ userId, provider: 'google', email: oldEmail })
    await setProviders(userId, ['email', 'google'])

    await changeEmail(userId, `pg-real-new-${userId}@test.invalid`)

    expect(await identities(userId)).toEqual([{ provider: 'email', email: oldEmail }])
    expect(await providers(userId)).toEqual(['email'])
  })

  it('matches the old address case-insensitively', async () => {
    const userId = await insertAuthUser()
    const oldEmail = await currentEmail(userId)
    await insertIdentity({ userId, provider: 'google', email: oldEmail.toUpperCase() })
    await setProviders(userId, ['google'])

    await changeEmail(userId, `pg-real-new-${userId}@test.invalid`)

    expect(await identities(userId)).toEqual([])
    expect(await providers(userId)).toEqual([])
  })

  it('never touches the email identity, even though it carries the old address', async () => {
    // GoTrue moves the email identity itself as part of the change; the
    // trigger must not race it by deleting the row.
    const userId = await insertAuthUser()
    const oldEmail = await currentEmail(userId)
    await insertIdentity({ userId, provider: 'email', email: oldEmail })
    await setProviders(userId, ['email'])

    await changeEmail(userId, `pg-real-new-${userId}@test.invalid`)

    expect(await identities(userId)).toEqual([{ provider: 'email', email: oldEmail }])
    expect(await providers(userId)).toEqual(['email'])
  })

  it('leaves identities alone when the update does not change the email', async () => {
    const userId = await insertAuthUser()
    const oldEmail = await currentEmail(userId)
    await insertIdentity({ userId, provider: 'google', email: oldEmail })
    await setProviders(userId, ['google'])

    await getPool().query(`UPDATE auth.users SET updated_at = now() WHERE id = $1`, [userId])
    await changeEmail(userId, oldEmail)

    expect(await identities(userId)).toEqual([{ provider: 'google', email: oldEmail }])
    expect(await providers(userId)).toEqual(['google'])
  })

  it('does not touch other users with a social identity on the same address', async () => {
    const a = await insertAuthUser()
    const b = await insertAuthUser()
    const shared = `shared-${a}@test.invalid`
    await getPool().query(`UPDATE auth.users SET email = $2 WHERE id = $1`, [a, shared])
    await insertIdentity({ userId: a, provider: 'google', email: shared })
    await insertIdentity({ userId: b, provider: 'google', email: shared })

    await changeEmail(a, `pg-real-new-${a}@test.invalid`)

    expect(await identities(a)).toEqual([])
    expect(await identities(b)).toEqual([{ provider: 'google', email: shared }])
  })
})
