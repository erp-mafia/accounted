import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

// Migration 20260929172450_webhook_endpoint_verification (ADA CASA 7.1.2):
// the verification columns and the webhooks_verification_guard trigger.
//
//   1. A changed webhook_url resets verification and ends any grace window,
//      whoever writes it (service role or superuser).
//   2. Client roles cannot write the verification columns: without this a
//      company writer could mark an endpoint verified without the handshake.
//      Since 20260929173432 client roles hold no INSERT or UPDATE on webhooks
//      at all, so the privilege check refuses them first; the guard is the
//      second layer should that grant ever return.
//   3. The service role (the v1 routes and the dispatcher) records outcomes.

async function insertWebhook(companyId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  const columns = ['id', 'company_id', 'name', 'event_type', 'webhook_url', 'secret', 'active', ...Object.keys(overrides)]
  const values = [
    id,
    companyId,
    'pg-test',
    'invoice.paid',
    'https://example.com/hook',
    `whsec_${randomUUID().replace(/-/g, '')}`,
    true,
    ...Object.values(overrides),
  ]
  await getPool().query(
    `INSERT INTO public.webhooks (${columns.join(', ')})
     VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')})`,
    values,
  )
  return id
}

interface VerificationRow {
  webhook_url: string
  verified_at: Date | null
  verification_grace_ends_at: Date | null
  verification_attempts: number
  verification_last_attempt_at: Date | null
  verification_last_error: string | null
  verification_next_attempt_at: Date | null
  next_attempt_age_seconds: number | null
}

async function readVerification(id: string): Promise<VerificationRow> {
  const { rows } = await getPool().query<VerificationRow>(
    `SELECT webhook_url, verified_at, verification_grace_ends_at, verification_attempts,
            verification_last_attempt_at, verification_last_error, verification_next_attempt_at,
            extract(epoch FROM (now() - verification_next_attempt_at))::float AS next_attempt_age_seconds
       FROM public.webhooks WHERE id = $1`,
    [id],
  )
  return rows[0]
}

async function markVerified(id: string): Promise<void> {
  await getPool().query(
    `UPDATE public.webhooks
        SET verified_at = now() - interval '1 day',
            verification_grace_ends_at = now() + interval '20 days',
            verification_attempts = 3,
            verification_last_attempt_at = now() - interval '1 day',
            verification_last_error = NULL,
            verification_next_attempt_at = NULL
      WHERE id = $1`,
    [id],
  )
}

async function setActiveCompany(userId: string, companyId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.user_preferences (user_id, active_company_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id`,
    [userId, companyId],
  )
}

async function expectInsufficientPrivilege(run: () => Promise<unknown>): Promise<void> {
  await expect(run()).rejects.toMatchObject({ code: '42501' })
}

/** The guard's own refusal, as opposed to the table privilege check's. */
async function expectGuardRefusal(run: () => Promise<unknown>): Promise<void> {
  await expect(run()).rejects.toMatchObject({
    code: '42501',
    message: expect.stringContaining('recorded by the verification handshake'),
  })
}

/**
 * Gives client roles back the INSERT and UPDATE on webhooks that
 * 20260929173432 revoked, inside the caller's transaction only
 * (withUserContext always rolls back), so the guard itself is exercised.
 */
async function restoreClientWrites(client: PoolClient): Promise<void> {
  await client.query('RESET ROLE')
  await client.query('GRANT INSERT, UPDATE ON public.webhooks TO authenticated')
  await client.query('SET LOCAL ROLE authenticated')
}

describe('webhooks verification columns: defaults for a new endpoint', () => {
  it('starts unverified, without grace, due for an automatic attempt now', async () => {
    const { companyId } = await seedCompany()
    const id = await insertWebhook(companyId)

    const row = await readVerification(id)
    expect(row.verified_at).toBeNull()
    // No grace for a new endpoint: it must verify before any delivery.
    expect(row.verification_grace_ends_at).toBeNull()
    expect(row.verification_attempts).toBe(0)
    expect(row.verification_last_error).toBeNull()
    expect(row.verification_next_attempt_at).not.toBeNull()
    expect(row.next_attempt_age_seconds).toBeGreaterThanOrEqual(0)
    expect(row.next_attempt_age_seconds).toBeLessThan(60)
  })

  it('refuses a negative attempt count and an oversized error', async () => {
    const { companyId } = await seedCompany()
    const id = await insertWebhook(companyId)
    await expect(
      getPool().query(`UPDATE public.webhooks SET verification_attempts = -1 WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(`UPDATE public.webhooks SET verification_last_error = repeat('x', 501) WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe('webhooks_verification_guard: a changed URL is a new endpoint', () => {
  it('resets verification and ends the grace window on a URL change', async () => {
    const { companyId } = await seedCompany()
    const id = await insertWebhook(companyId)
    await markVerified(id)

    await getPool().query(`UPDATE public.webhooks SET webhook_url = 'https://moved.example.com/hook' WHERE id = $1`, [id])

    const row = await readVerification(id)
    expect(row.webhook_url).toBe('https://moved.example.com/hook')
    expect(row.verified_at).toBeNull()
    expect(row.verification_grace_ends_at).toBeNull()
    expect(row.verification_attempts).toBe(0)
    expect(row.verification_last_attempt_at).toBeNull()
    expect(row.verification_last_error).toBeNull()
    expect(row.next_attempt_age_seconds).toBeLessThan(60)
  })

  it('resets even when the same statement tries to keep the endpoint verified', async () => {
    const { companyId } = await seedCompany()
    const id = await insertWebhook(companyId)
    await markVerified(id)

    await runAsServiceRole((client) =>
      client.query(
        `UPDATE public.webhooks
            SET webhook_url = 'https://moved.example.com/hook', verified_at = now()
          WHERE id = $1`,
        [id],
      ),
    )

    expect((await readVerification(id)).verified_at).toBeNull()
  })

  it('keeps verification through updates that leave the URL alone', async () => {
    const { companyId } = await seedCompany()
    const id = await insertWebhook(companyId)
    await markVerified(id)

    await getPool().query(`UPDATE public.webhooks SET name = 'renamed', active = false WHERE id = $1`, [id])
    // Rewriting the identical URL is not a change either.
    await getPool().query(`UPDATE public.webhooks SET webhook_url = 'https://example.com/hook' WHERE id = $1`, [id])

    const row = await readVerification(id)
    expect(row.verified_at).not.toBeNull()
    expect(row.verification_grace_ends_at).not.toBeNull()
    expect(row.verification_attempts).toBe(3)
  })
})

describe('webhooks_verification_guard: only the service role records outcomes', () => {
  it('lets the service role record a verification', async () => {
    const { companyId } = await seedCompany()
    const id = await insertWebhook(companyId)

    await runAsServiceRole((client) =>
      client.query(
        `UPDATE public.webhooks
            SET verified_at = now(), verification_attempts = 1, verification_next_attempt_at = NULL
          WHERE id = $1`,
        [id],
      ),
    )

    const row = await readVerification(id)
    expect(row.verified_at).not.toBeNull()
    expect(row.verification_attempts).toBe(1)
  })

  it('refuses a company writer any direct write: client roles hold no INSERT or UPDATE', async () => {
    const { userId, companyId } = await seedCompany()
    await setActiveCompany(userId, companyId)
    const id = await insertWebhook(companyId)

    await withUserContext(userId, async (client) => {
      await expectInsufficientPrivilege(() =>
        client.query(`UPDATE public.webhooks SET name = 'mine' WHERE id = $1`, [id]),
      )
    })
    await withUserContext(userId, async (client) => {
      await expectInsufficientPrivilege(() =>
        client.query(
          `INSERT INTO public.webhooks (company_id, name, event_type, webhook_url, secret)
           VALUES ($1, 'x', 'invoice.paid', 'https://example.com/h', 'whsec_x')`,
          [companyId],
        ),
      )
    })
  })

  it('refuses a company writer who marks an endpoint verified without the handshake', async () => {
    const { userId, companyId } = await seedCompany()
    await setActiveCompany(userId, companyId)
    const id = await insertWebhook(companyId)

    await withUserContext(userId, async (client) => {
      await restoreClientWrites(client)
      // The writer does reach the row under RLS: a harmless column updates.
      const renamed = await client.query(`UPDATE public.webhooks SET name = 'mine' WHERE id = $1`, [id])
      expect(renamed.rowCount).toBe(1)
      await expectGuardRefusal(() =>
        client.query(`UPDATE public.webhooks SET verified_at = now() WHERE id = $1`, [id]),
      )
    })
    await withUserContext(userId, async (client) => {
      await restoreClientWrites(client)
      await expectGuardRefusal(() =>
        client.query(
          `UPDATE public.webhooks SET verification_grace_ends_at = now() + interval '1 year' WHERE id = $1`,
          [id],
        ),
      )
    })
    await withUserContext(userId, async (client) => {
      await restoreClientWrites(client)
      await expectGuardRefusal(() =>
        client.query(`UPDATE public.webhooks SET verification_next_attempt_at = now() WHERE id = $1`, [id]),
      )
    })
  })

  it('refuses a company writer who inserts an endpoint as already verified or in grace', async () => {
    const { userId, companyId } = await seedCompany()
    await setActiveCompany(userId, companyId)

    for (const column of ['verified_at', 'verification_grace_ends_at']) {
      await withUserContext(userId, async (client) => {
        await restoreClientWrites(client)
        await expectGuardRefusal(() =>
          client.query(
            `INSERT INTO public.webhooks (company_id, name, event_type, webhook_url, secret, ${column})
             VALUES ($1, 'x', 'invoice.paid', 'https://example.com/h', 'whsec_x', now())`,
            [companyId],
          ),
        )
      })
    }
  })

  it('resets verification when a company writer changes the URL', async () => {
    const { userId, companyId } = await seedCompany()
    await setActiveCompany(userId, companyId)
    const id = await insertWebhook(companyId)
    await markVerified(id)

    const after = await withUserContext(userId, async (client) => {
      await restoreClientWrites(client)
      await client.query(
        `UPDATE public.webhooks SET webhook_url = 'https://moved.example.com/hook' WHERE id = $1`,
        [id],
      )
      const { rows } = await client.query<{ verified_at: Date | null; verification_grace_ends_at: Date | null }>(
        `SELECT verified_at, verification_grace_ends_at FROM public.webhooks WHERE id = $1`,
        [id],
      )
      return rows[0]
    })

    expect(after).toEqual({ verified_at: null, verification_grace_ends_at: null })
  })
})
