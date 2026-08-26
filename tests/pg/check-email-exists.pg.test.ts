import { describe, it, expect, beforeAll } from 'vitest'
import { getPool, getClient, runAsServiceRole } from './setup'
import { insertAuthUser } from './fixtures'

/**
 * Migration 20260804140000_restore_check_email_exists_rpc.sql restores
 * public.check_email_exists, which shipped in PR #229 and was lost in the
 * #244 migration consolidation before it ever reached prod. The invite flow
 * (app/api/team/accept and app/api/company/members/invite) calls it via the
 * service client to decide whether an invitee already has an account. It
 * reads auth.users under SECURITY DEFINER, so execution must stay
 * service-role only: exposing it to anon or authenticated would be an email
 * enumeration oracle. These tests lock both the semantics and the grants in.
 */
describe('check_email_exists RPC (pg)', () => {
  let seededUserId: string
  let seededEmail: string

  beforeAll(async () => {
    seededUserId = await insertAuthUser()
    // insertAuthUser stores the email as pg-real-<uuid>@test.invalid.
    seededEmail = `pg-real-${seededUserId}@test.invalid`
  })

  it('exists in the schema (regression: lost in the #244 consolidation)', async () => {
    const res = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'check_email_exists'`,
    )
    expect(res.rows[0]!.n).toBe(1)
  })

  it('returns true for an existing auth user', async () => {
    const res = await getPool().query<{ found: boolean }>(
      `SELECT public.check_email_exists($1) AS found`,
      [seededEmail],
    )
    expect(res.rows[0]!.found).toBe(true)
  })

  it('matches case-insensitively on both sides', async () => {
    const res = await getPool().query<{ found: boolean }>(
      `SELECT public.check_email_exists($1) AS found`,
      [seededEmail.toUpperCase()],
    )
    expect(res.rows[0]!.found).toBe(true)
  })

  it('returns false for an unknown email', async () => {
    const res = await getPool().query<{ found: boolean }>(
      `SELECT public.check_email_exists($1) AS found`,
      ['nobody-here@test.invalid'],
    )
    expect(res.rows[0]!.found).toBe(false)
  })

  async function expectExecutionDenied(role: 'anon' | 'authenticated') {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL ROLE ${role}`)
      await expect(
        client.query(`SELECT public.check_email_exists('probe@test.invalid')`),
      ).rejects.toThrow(/permission denied/i)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  }

  it('denies execution to the anon role', async () => {
    await expectExecutionDenied('anon')
  })

  it('denies execution to the authenticated role', async () => {
    await expectExecutionDenied('authenticated')
  })

  it('allows execution to the service_role role', async () => {
    const found = await runAsServiceRole(async (client) => {
      const res = await client.query<{ found: boolean }>(
        `SELECT public.check_email_exists($1) AS found`,
        [seededEmail],
      )
      return res.rows[0]!.found
    })
    expect(found).toBe(true)
  })
})
