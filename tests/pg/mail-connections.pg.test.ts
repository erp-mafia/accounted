/**
 * pg-real coverage for mail_connections (20260807090000_mail_connections.sql),
 * which that migration left to the feature that owns the table.
 *
 * A row carries a live, encrypted Gmail refresh token, so the table is
 * service-role only: RLS is on with no policies, and even a member of the
 * company the mailbox belongs to can neither read nor write it. Everything
 * the app does with it goes through the service role
 * (extensions/general/mail/lib/connections.ts).
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'

async function seedOwnerCompany(): Promise<{ userId: string; companyId: string }> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  return { userId, companyId }
}

async function insertConnection(params: {
  companyId: string
  connectedBy?: string | null
  provider?: string
  emailAddress?: string
  status?: string
  updatedAt?: string
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.mail_connections
       (company_id, provider, email_address, connected_by, encrypted_refresh_token, scopes, status, updated_at)
     VALUES ($1, $2, $3, $4, 'enc-refresh', ARRAY['https://www.googleapis.com/auth/gmail.readonly'], $5,
             COALESCE($6::timestamptz, now()))
     RETURNING id`,
    [
      params.companyId,
      params.provider ?? 'gmail',
      params.emailAddress ?? `ekonomi-${randomUUID().slice(0, 8)}@example.test`,
      params.connectedBy ?? null,
      params.status ?? 'active',
      params.updatedAt ?? null,
    ],
  )
  return rows[0]!.id
}

describe('mail_connections: service-role only', () => {
  it('has RLS enabled and no policies at all', async () => {
    const { rows: flags } = await getPool().query<{ relrowsecurity: boolean }>(
      `SELECT c.relrowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'mail_connections'`,
    )
    expect(flags[0]!.relrowsecurity).toBe(true)

    const { rows: policies } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'mail_connections'`,
    )
    expect(policies[0]!.n).toBe(0)
  })

  it('shows a member of the company none of its mailbox rows', async () => {
    const { userId, companyId } = await seedOwnerCompany()
    await insertConnection({ companyId, connectedBy: userId })

    const visible = await withUserContext(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, encrypted_refresh_token FROM public.mail_connections WHERE company_id = $1`,
        [companyId],
      )
      return rows
    })
    expect(visible).toEqual([])
  })

  it('refuses a member inserting a row, even for their own company', async () => {
    const { userId, companyId } = await seedOwnerCompany()

    await expect(
      withUserContext(userId, (client) =>
        client.query(
          `INSERT INTO public.mail_connections (company_id, provider, email_address, encrypted_refresh_token, connected_by)
           VALUES ($1, 'gmail', 'planted@example.test', 'enc', $2)`,
          [companyId, userId],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it('lets a member update or delete nothing, and leaves the row intact', async () => {
    const { userId, companyId } = await seedOwnerCompany()
    const id = await insertConnection({ companyId, connectedBy: userId })

    const counts = await withUserContext(userId, async (client) => {
      const updated = await client.query(
        `UPDATE public.mail_connections SET encrypted_refresh_token = 'swapped', status = 'revoked' WHERE id = $1`,
        [id],
      )
      const deleted = await client.query(`DELETE FROM public.mail_connections WHERE id = $1`, [id])
      return { updated: updated.rowCount, deleted: deleted.rowCount }
    })
    expect(counts).toEqual({ updated: 0, deleted: 0 })

    const { rows } = await getPool().query<{ encrypted_refresh_token: string; status: string }>(
      `SELECT encrypted_refresh_token, status FROM public.mail_connections WHERE id = $1`,
      [id],
    )
    expect(rows[0]).toEqual({ encrypted_refresh_token: 'enc-refresh', status: 'active' })
  })

  it('lets the service role read, write and delete, as the app does', async () => {
    const { userId, companyId } = await seedOwnerCompany()

    const id = await runAsServiceRole(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO public.mail_connections (company_id, provider, email_address, encrypted_refresh_token, connected_by)
         VALUES ($1, 'gmail', 'service@example.test', 'enc', $2) RETURNING id`,
        [companyId, userId],
      )
      await client.query(
        `UPDATE public.mail_connections SET status = 'needs_reconsent', last_error_code = 'scope_missing' WHERE id = $1`,
        [rows[0]!.id],
      )
      return rows[0]!.id
    })

    const seen = await runAsServiceRole(async (client) => {
      const { rows } = await client.query<{ status: string; last_error_code: string }>(
        `SELECT status, last_error_code FROM public.mail_connections WHERE id = $1`,
        [id],
      )
      return rows
    })
    expect(seen).toEqual([{ status: 'needs_reconsent', last_error_code: 'scope_missing' }])

    const deleted = await runAsServiceRole(async (client) => {
      const res = await client.query(`DELETE FROM public.mail_connections WHERE id = $1`, [id])
      return res.rowCount
    })
    expect(deleted).toBe(1)
  })
})

describe('mail_connections: schema', () => {
  it('bumps updated_at on every update', async () => {
    const { userId, companyId } = await seedOwnerCompany()
    const id = await insertConnection({
      companyId,
      connectedBy: userId,
      updatedAt: '2026-01-01T00:00:00Z',
    })

    await getPool().query(`UPDATE public.mail_connections SET last_searched_at = now() WHERE id = $1`, [id])

    const { rows } = await getPool().query<{ bumped: boolean }>(
      `SELECT updated_at > '2026-01-01T00:00:00Z'::timestamptz AS bumped FROM public.mail_connections WHERE id = $1`,
      [id],
    )
    expect(rows[0]!.bumped).toBe(true)
  })

  it('accepts only the providers and statuses the code knows', async () => {
    const { companyId } = await seedOwnerCompany()

    await expect(insertConnection({ companyId, provider: 'outlook' })).rejects.toThrow(/mail_connections_provider_check/)
    await expect(insertConnection({ companyId, status: 'paused' })).rejects.toThrow(/mail_connections_status_check/)

    for (const status of ['active', 'needs_reconsent', 'revoked']) {
      await expect(insertConnection({ companyId, status })).resolves.toBeTruthy()
    }
    await expect(insertConnection({ companyId, provider: 'microsoft' })).resolves.toBeTruthy()
  })

  it('holds one row per mailbox, provider and company, which the reconnect upsert relies on', async () => {
    const { companyId } = await seedOwnerCompany()
    const { companyId: otherCompanyId } = await seedOwnerCompany()
    const address = `shared-${randomUUID().slice(0, 8)}@example.test`
    await insertConnection({ companyId, emailAddress: address })

    await expect(insertConnection({ companyId, emailAddress: address })).rejects.toThrow(
      /idx_mail_connections_identity/,
    )
    // The same mailbox for another company, or under another provider, is a
    // different connection.
    await expect(insertConnection({ companyId: otherCompanyId, emailAddress: address })).resolves.toBeTruthy()
    await expect(
      insertConnection({ companyId, emailAddress: address, provider: 'microsoft' }),
    ).resolves.toBeTruthy()
  })

  it('makes the reconnect upsert refresh the existing row instead of adding a twin', async () => {
    const { userId, companyId } = await seedOwnerCompany()
    const address = `reconnect-${randomUUID().slice(0, 8)}@example.test`
    const id = await insertConnection({ companyId, emailAddress: address, status: 'needs_reconsent' })

    // saveConnection's ON CONFLICT target, byte for byte.
    await getPool().query(
      `INSERT INTO public.mail_connections (company_id, provider, email_address, encrypted_refresh_token, connected_by, status)
       VALUES ($1, 'gmail', $2, 'enc-new', $3, 'active')
       ON CONFLICT (company_id, provider, email_address)
       DO UPDATE SET encrypted_refresh_token = EXCLUDED.encrypted_refresh_token, status = EXCLUDED.status`,
      [companyId, address, userId],
    )

    const { rows } = await getPool().query<{ id: string; status: string; encrypted_refresh_token: string }>(
      `SELECT id, status, encrypted_refresh_token FROM public.mail_connections WHERE company_id = $1 AND email_address = $2`,
      [companyId, address],
    )
    expect(rows).toEqual([{ id, status: 'active', encrypted_refresh_token: 'enc-new' }])
  })
})
