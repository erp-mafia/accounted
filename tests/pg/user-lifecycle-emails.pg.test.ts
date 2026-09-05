import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { getPool, getClient, runAsServiceRole } from './setup'
import { insertAuthUser, seedCompany } from './fixtures'

/**
 * Migration 20260905140000_user_lifecycle_emails.sql: the claim table behind
 * the welcome email plus list_users_awaiting_lifecycle_email, the SECURITY
 * DEFINER candidate query over auth.users. Both must stay service-role only
 * (the RPC returns addresses and names), and the eligibility rules are what
 * decides who gets a welcome mail, so they are locked in here.
 */

const KEY = 'welcome'
const FN = 'public.list_users_awaiting_lifecycle_email'

async function confirmedUser(at: Date = new Date()): Promise<string> {
  const id = await insertAuthUser()
  await getPool().query(`UPDATE auth.users SET email_confirmed_at = $2 WHERE id = $1`, [id, at])
  return id
}

// Only confirmations from the last minute qualify, so rows other suites left
// behind (confirmed or not) never crowd the result.
function recent(): Date {
  return new Date(Date.now() - 60_000)
}

async function awaiting(key = KEY, since: Date = recent()): Promise<string[]> {
  const res = await getPool().query<{ user_id: string }>(
    `SELECT user_id FROM ${FN}($1, $2, 200)`,
    [key, since],
  )
  return res.rows.map((r) => r.user_id)
}

async function claim(userId: string, key = KEY): Promise<void> {
  await getPool().query(
    `INSERT INTO public.user_lifecycle_emails (user_id, email_key) VALUES ($1, $2)`,
    [userId, key],
  )
}

describe('user_lifecycle_emails + list_users_awaiting_lifecycle_email (pg)', () => {
  it('returns a freshly confirmed user with profile name and locale, and not an unconfirmed one', async () => {
    const confirmed = await confirmedUser()
    const unconfirmed = await insertAuthUser()
    await getPool().query(`UPDATE public.profiles SET full_name = 'Anna Berg' WHERE id = $1`, [confirmed])
    await getPool().query(
      `INSERT INTO public.user_preferences (user_id, locale) VALUES ($1, 'en')`,
      [confirmed],
    )

    const res = await getPool().query<{
      user_id: string
      email: string
      full_name: string | null
      locale: string | null
    }>(`SELECT user_id, email, full_name, locale FROM ${FN}($1, $2, 200)`, [KEY, recent()])

    const row = res.rows.find((r) => r.user_id === confirmed)
    expect(row).toBeDefined()
    expect(row!.email).toBe(`pg-real-${confirmed}@test.invalid`)
    expect(row!.full_name).toBe('Anna Berg')
    expect(row!.locale).toBe('en')
    expect(res.rows.map((r) => r.user_id)).not.toContain(unconfirmed)
  })

  it('returns a user with no preferences row (locale null) rather than dropping them', async () => {
    const confirmed = await confirmedUser()
    const res = await getPool().query<{ user_id: string; locale: string | null }>(
      `SELECT user_id, locale FROM ${FN}($1, $2, 200)`,
      [KEY, recent()],
    )
    const row = res.rows.find((r) => r.user_id === confirmed)
    expect(row).toBeDefined()
    expect(row!.locale).toBeNull()
  })

  it('drops a user once the claim row for that key exists, other keys unaffected', async () => {
    const user = await confirmedUser()
    expect(await awaiting()).toContain(user)

    await claim(user)
    expect(await awaiting()).not.toContain(user)
    expect(await awaiting('day2_receipts')).toContain(user)
  })

  it('rejects a second claim for the same user and key (the atomic dedup)', async () => {
    const user = await confirmedUser()
    await claim(user)
    await expect(claim(user)).rejects.toMatchObject({ code: '23505' })
  })

  it('ignores confirmations older than the since bound', async () => {
    const old = await confirmedUser(new Date(Date.now() - 10 * 24 * 60 * 60 * 1000))
    expect(await awaiting()).not.toContain(old)
    expect(await awaiting(KEY, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))).toContain(old)
  })

  it('skips invitees: a pending or accepted company invitation on the address, any case', async () => {
    const { companyId, userId: ownerId } = await seedCompany()
    const pendingInvitee = await confirmedUser()
    const acceptedInvitee = await confirmedUser()
    const revokedInvitee = await confirmedUser()

    for (const [userId, status] of [
      [pendingInvitee, 'pending'],
      [acceptedInvitee, 'accepted'],
      [revokedInvitee, 'revoked'],
    ] as const) {
      await getPool().query(
        `INSERT INTO public.company_invitations
           (company_id, email, role, token_hash, invited_by, status, expires_at)
         VALUES ($1, $2, 'member', $3, $4, $5, now() + interval '7 days')`,
        [companyId, `PG-REAL-${userId}@TEST.INVALID`, randomUUID(), ownerId, status],
      )
    }

    const rows = await awaiting()
    expect(rows).not.toContain(pendingInvitee)
    expect(rows).not.toContain(acceptedInvitee)
    // A revoked invitation is not a membership path: the user signed up on
    // their own and gets the welcome.
    expect(rows).toContain(revokedInvitee)
  })

  it('skips team invitees too', async () => {
    const owner = await insertAuthUser()
    const teamId = randomUUID()
    await getPool().query(
      `INSERT INTO public.teams (id, name, created_by) VALUES ($1, 'Personal', $2)`,
      [teamId, owner],
    )
    const invitee = await confirmedUser()
    await getPool().query(
      `INSERT INTO public.team_invitations
         (team_id, email, role, token_hash, invited_by, status, expires_at)
       VALUES ($1, $2, 'member', $3, $4, 'accepted', now() + interval '7 days')`,
      [teamId, `pg-real-${invitee}@test.invalid`, randomUUID(), owner],
    )
    expect(await awaiting()).not.toContain(invitee)
  })

  it('skips anonymized or deleted profiles and users without an address (anonymous sandbox users)', async () => {
    const anonymized = await confirmedUser()
    await getPool().query(`UPDATE public.profiles SET anonymized_at = now() WHERE id = $1`, [anonymized])

    const deleted = await confirmedUser()
    await getPool().query(`UPDATE public.profiles SET deleted_at = now() WHERE id = $1`, [deleted])

    // GoTrue anonymous sign-ins create users with a NULL email; that absence is
    // the filter, not is_anonymous (which older self-hosted stacks lack).
    const anonymous = await confirmedUser()
    await getPool().query(`UPDATE auth.users SET email = NULL WHERE id = $1`, [anonymous])

    const rows = await awaiting()
    expect(rows).not.toContain(anonymized)
    expect(rows).not.toContain(deleted)
    expect(rows).not.toContain(anonymous)
  })

  it('orders oldest confirmation first and caps the batch', async () => {
    const later = await confirmedUser(new Date(Date.now() - 1_000))
    const earlier = await confirmedUser(new Date(Date.now() - 30_000))
    const rows = await awaiting()
    expect(rows.indexOf(earlier)).toBeLessThan(rows.indexOf(later))

    const capped = await getPool().query(`SELECT user_id FROM ${FN}($1, $2, 1)`, [KEY, recent()])
    expect(capped.rows).toHaveLength(1)
  })

  it('cascades the claim row when the auth user is deleted', async () => {
    const user = await confirmedUser()
    await claim(user)
    await getPool().query(`DELETE FROM auth.users WHERE id = $1`, [user])
    const res = await getPool().query(
      `SELECT 1 FROM public.user_lifecycle_emails WHERE user_id = $1`,
      [user],
    )
    expect(res.rowCount).toBe(0)
  })

  async function expectDenied(role: 'anon' | 'authenticated', sql: string) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL ROLE ${role}`)
      await expect(client.query(sql)).rejects.toThrow(/permission denied/i)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  }

  it('denies the RPC to anon and authenticated (it returns addresses)', async () => {
    const probe = `SELECT * FROM ${FN}('welcome', now() - interval '1 day', 10)`
    await expectDenied('anon', probe)
    await expectDenied('authenticated', probe)
  })

  it('denies the table to anon and authenticated (no policies, privileges revoked)', async () => {
    const probe = `SELECT * FROM public.user_lifecycle_emails LIMIT 1`
    await expectDenied('anon', probe)
    await expectDenied('authenticated', probe)
  })

  it('allows the service role to query candidates and write claims', async () => {
    const user = await confirmedUser()
    const found = await runAsServiceRole(async (client) => {
      const res = await client.query<{ user_id: string }>(
        `SELECT user_id FROM ${FN}($1, $2, 200)`,
        [KEY, recent()],
      )
      await client.query(
        `INSERT INTO public.user_lifecycle_emails (user_id, email_key) VALUES ($1, $2)`,
        [user, KEY],
      )
      return res.rows.map((r) => r.user_id)
    })
    expect(found).toContain(user)
    expect(await awaiting()).not.toContain(user)
  })
})
