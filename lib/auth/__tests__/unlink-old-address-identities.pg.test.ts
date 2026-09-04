import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { insertAuthUser } from '@/tests/pg/fixtures'

// on_auth_user_email_updated_unlink_old_identities
// (20260903110000_unlink_old_address_identities_on_email_change.sql): when
// auth.users.email changes, social identities bound to the OLD address are
// removed, app_metadata.providers is recomputed, an email identity for the
// new address is guaranteed, and the removal is written to GoTrue's audit
// table. Everything else on the account (email identity, social identities
// on other addresses) stays.

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

// Mirrors GoTrue's ConfirmEmailChange: the pending address becomes the
// address and the pending column is cleared in the same statement.
async function confirmEmailChange(userId: string, email: string): Promise<void> {
  await getPool().query(`UPDATE auth.users SET email_change = $2 WHERE id = $1`, [userId, email])
  await getPool().query(
    `UPDATE auth.users SET email = $2, email_change = '' WHERE id = $1`,
    [userId, email],
  )
}

// An admin-side or SQL change: no pending address involved.
async function adminSetEmail(userId: string, email: string): Promise<void> {
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

async function emailIdentity(
  userId: string,
): Promise<{ provider_id: string; identity_data: Record<string, unknown> } | undefined> {
  const { rows } = await getPool().query<{
    provider_id: string
    identity_data: Record<string, unknown>
  }>(`SELECT provider_id, identity_data FROM auth.identities WHERE user_id = $1 AND provider = 'email'`, [
    userId,
  ])
  return rows[0]
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

async function auditEntries(userId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await getPool().query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM auth.audit_log_entries
      WHERE payload->>'actor_id' = $1 AND payload->>'action' = 'identity_unlink'
      ORDER BY created_at`,
    [userId],
  )
  return rows.map((r) => r.payload)
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

    await confirmEmailChange(userId, newEmail)

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

    await confirmEmailChange(userId, `pg-real-new-${userId}@test.invalid`)

    expect(await identities(userId)).toEqual([{ provider: 'email', email: oldEmail }])
    expect(await providers(userId)).toEqual(['email'])
  })

  it('gives a Google-only account a verified email identity after a confirmed change', async () => {
    // Signed up with Google, never set a password: no 'email' identity.
    // Removing the Google identity must not leave zero identities; the email
    // identity is what Google with the new address links through and what
    // password recovery resolves. Old address matched case-insensitively.
    const userId = await insertAuthUser()
    const oldEmail = await currentEmail(userId)
    const newEmail = `pg-real-new-${userId}@test.invalid`
    await insertIdentity({ userId, provider: 'google', email: oldEmail.toUpperCase() })
    await setProviders(userId, ['google'])

    await confirmEmailChange(userId, newEmail)

    expect(await identities(userId)).toEqual([{ provider: 'email', email: newEmail }])
    const created = await emailIdentity(userId)
    expect(created?.provider_id).toBe(userId)
    expect(created?.identity_data).toMatchObject({
      sub: userId,
      email: newEmail,
      email_verified: true,
    })
    expect(await providers(userId)).toEqual(['email'])
  })

  it('creates the email identity unverified after an admin-side change', async () => {
    // No pending address was confirmed by the user, so the trigger must not
    // vouch for the new address.
    const userId = await insertAuthUser()
    const oldEmail = await currentEmail(userId)
    const newEmail = `pg-real-new-${userId}@test.invalid`
    await insertIdentity({ userId, provider: 'google', email: oldEmail })
    await setProviders(userId, ['google'])

    await adminSetEmail(userId, newEmail)

    expect(await identities(userId)).toEqual([{ provider: 'email', email: newEmail }])
    expect((await emailIdentity(userId))?.identity_data).toMatchObject({
      email: newEmail,
      email_verified: false,
    })
  })

  it('does not create a second email identity when one already exists', async () => {
    const userId = await insertAuthUser()
    const oldEmail = await currentEmail(userId)
    await insertIdentity({ userId, provider: 'email', email: oldEmail })
    await insertIdentity({ userId, provider: 'google', email: oldEmail })

    await confirmEmailChange(userId, `pg-real-new-${userId}@test.invalid`)

    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM auth.identities WHERE user_id = $1 AND provider = 'email'`,
      [userId],
    )
    expect(rows[0]!.n).toBe(1)
  })

  it('never touches the email identity, even though it carries the old address', async () => {
    // GoTrue moves the email identity itself as part of the change; the
    // trigger must not race it by deleting the row.
    const userId = await insertAuthUser()
    const oldEmail = await currentEmail(userId)
    await insertIdentity({ userId, provider: 'email', email: oldEmail })
    await setProviders(userId, ['email'])

    await confirmEmailChange(userId, `pg-real-new-${userId}@test.invalid`)

    expect(await identities(userId)).toEqual([{ provider: 'email', email: oldEmail }])
    expect(await providers(userId)).toEqual(['email'])
    expect(await auditEntries(userId)).toEqual([])
  })

  it('leaves identities alone when the update does not change the email', async () => {
    const userId = await insertAuthUser()
    const oldEmail = await currentEmail(userId)
    await insertIdentity({ userId, provider: 'google', email: oldEmail })
    await setProviders(userId, ['google'])

    await getPool().query(`UPDATE auth.users SET updated_at = now() WHERE id = $1`, [userId])
    await adminSetEmail(userId, oldEmail)

    expect(await identities(userId)).toEqual([{ provider: 'google', email: oldEmail }])
    expect(await providers(userId)).toEqual(['google'])
  })

  it('does not touch other users with a social identity on the same address', async () => {
    const a = await insertAuthUser()
    const b = await insertAuthUser()
    const shared = `shared-${a}@test.invalid`
    await adminSetEmail(a, shared)
    await insertIdentity({ userId: a, provider: 'google', email: shared })
    await insertIdentity({ userId: b, provider: 'google', email: shared })
    const newEmail = `pg-real-new-${a}@test.invalid`

    await confirmEmailChange(a, newEmail)

    // a lost its Google login and got an email identity for the new address.
    expect(await identities(a)).toEqual([{ provider: 'email', email: newEmail }])
    expect(await identities(b)).toEqual([{ provider: 'google', email: shared }])
  })

  it('writes an identity_unlink entry to the auth audit log', async () => {
    const userId = await insertAuthUser()
    const oldEmail = await currentEmail(userId)
    const newEmail = `pg-real-new-${userId}@test.invalid`
    await insertIdentity({ userId, provider: 'email', email: oldEmail })
    await insertIdentity({ userId, provider: 'google', email: oldEmail })

    await confirmEmailChange(userId, newEmail)

    const entries = await auditEntries(userId)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      action: 'identity_unlink',
      actor_id: userId,
      actor_username: oldEmail,
      log_type: 'user',
      traits: {
        reason: 'email_change',
        providers: ['google'],
        old_email: oldEmail,
        new_email: newEmail,
        confirmed: true,
      },
    })
  })
})
