import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'
import { insertPostedJournalEntry, seedCompany } from './fixtures'

/**
 * Sandbox cleanup RPCs (migration 20260807130000):
 *
 * The nightly cron was a silent no-op for months: cleanup_sandbox_user
 * deleted journal_entry_lines without setting the gnubok.allow_delete
 * bypass, so the BFL immutability trigger rejected the delete and the outer
 * loop swallowed the error as a WARNING. These tests pin the fixed behavior:
 * a sandbox company with posted vouchers and a booked salary run actually
 * deletes, non-sandbox users stay refused, immutability outside the RPC is
 * untouched, and the expired sweep also removes orphaned anonymous users
 * that never got a company_settings row.
 */

async function seedSandboxUser(settingsCreatedAt?: string): Promise<{
  userId: string
  companyId: string
  entryId: string
}> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, is_sandbox, created_at)
     VALUES ($1, $2, true, COALESCE($3::timestamptz, now()))`,
    [userId, companyId, settingsCreatedAt ?? null],
  )
  const entryId = await insertPostedJournalEntry({
    userId,
    companyId,
    fiscalPeriodId,
  })
  // The seed links a booked salary run to its vouchers with plain NO ACTION
  // FKs; recreate that so the test fails if the RPC forgets to clear them.
  await getPool().query(
    `INSERT INTO public.salary_runs
       (company_id, user_id, period_year, period_month, payment_date, salary_entry_id)
     VALUES ($1, $2, 2026, 1, '2026-01-25', $3)`,
    [companyId, userId, entryId],
  )
  // System dimensions (undeletable outside teardown) and a terminal-state
  // pending operation (delete-protected per BFL 7 kap.): both exist in every
  // modern sandbox and both blocked the auth.users cascade before the
  // gnubok.sandbox_cleanup bypass.
  await getPool().query(`SELECT public.ensure_company_dimensions($1)`, [companyId])
  await getPool().query(
    `INSERT INTO public.pending_operations
       (user_id, company_id, operation_type, title, status)
     VALUES ($1, $2, 'categorize_transaction', 'Sandbox cleanup test op', 'rejected')`,
    [userId, companyId],
  )
  // processing_history references companies with a plain NO ACTION FK and no
  // cascade; without the explicit delete (migration 20260807160000) a
  // sandbox that produced telemetry cannot be torn down.
  await getPool().query(
    `INSERT INTO public.processing_history
       (company_id, correlation_id, aggregate_type, aggregate_id, event_type, actor, occurred_at)
     VALUES ($1, $2, 'Document', $3, 'DocumentIngested', '{"type":"system"}', now())`,
    [companyId, randomUUID(), randomUUID()],
  )
  // invoice_deliveries has the same NO ACTION company FK AND a delete guard
  // that silently swallows deletes (RETURN NULL) outside the teardown
  // bypass; a marked_sent manual delivery is the minimal terminal row.
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices (id, user_id, company_id, invoice_date, due_date)
     VALUES ($1, $2, $3, '2026-01-10', '2026-02-10')`,
    [invoiceId, userId, companyId],
  )
  await getPool().query(
    `INSERT INTO public.invoice_deliveries
       (company_id, user_id, invoice_id, channel, status, sent_at, retention_expires_at)
     VALUES ($1, $2, $3, 'manual', 'marked_sent', now(), '2033-12-31')`,
    [companyId, userId, invoiceId],
  )
  // An API key with the SoD acknowledgement set: sod_acknowledged_by is a
  // plain NO ACTION FK to auth.users that blocked teardown for every keyed
  // sandbox until 20260807170000 deletes the keys explicitly.
  await getPool().query(
    `INSERT INTO public.api_keys
       (user_id, company_id, key_hash, key_prefix, sod_acknowledged_by, sod_acknowledged_at)
     VALUES ($1, $2, $3, 'gnubok_sk_pgtest', $1, now())`,
    [userId, companyId, randomUUID()],
  )
  // A WORM retag-log row (dimension_retag_log_immutable raises on DELETE
  // outside the teardown bypass).
  const { rows: lineRows } = await getPool().query<{ id: string }>(
    `SELECT id FROM public.journal_entry_lines WHERE journal_entry_id = $1 LIMIT 1`,
    [entryId],
  )
  await getPool().query(
    `INSERT INTO public.dimension_retag_log
       (company_id, journal_entry_id, line_id, old_dimensions, new_dimensions, reason)
     VALUES ($1, $2, $3, '{}', '{"1":"BUTIK"}', 'Sandbox cleanup test retag')`,
    [companyId, entryId, lineRows[0]!.id],
  )
  return { userId, companyId, entryId }
}

async function insertAnonymousAuthUser(createdAt: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO auth.users (id, email, instance_id, is_anonymous, created_at)
     VALUES ($1, NULL, '00000000-0000-0000-0000-000000000000'::uuid, true, $2::timestamptz)`,
    [id, createdAt],
  )
  return id
}

// auth.users.is_anonymous arrived with GoTrue anonymous sign-ins; the CI
// supabase/postgres image predates it. The RPC skips the orphan sweep on such
// stacks, so the test skips the matching assertions rather than fabricating a
// schema hosted Supabase would not have.
async function hasIsAnonymousColumn(): Promise<boolean> {
  const { rows } = await getPool().query<{ has: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'auth' AND table_name = 'users'
         AND column_name = 'is_anonymous'
     ) AS has`,
  )
  return rows[0]!.has
}

async function authUserExists(id: string): Promise<boolean> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM auth.users WHERE id = $1`,
    [id],
  )
  return rows[0]!.n > 0
}

describe('sandbox cleanup RPCs (pg)', () => {
  it('deletes a sandbox user whose books contain posted vouchers and a booked salary run', async () => {
    const { userId, entryId } = await seedSandboxUser()

    await getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [userId])

    expect(await authUserExists(userId)).toBe(false)
    const { rows: entries } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(entries[0]!.n).toBe(0)
    const { rows: lines } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.journal_entry_lines WHERE journal_entry_id = $1`,
      [entryId],
    )
    expect(lines[0]!.n).toBe(0)
  })

  it('refuses a user with no company_settings rows at all', async () => {
    const { userId } = await seedCompany()
    await expect(
      getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [userId]),
    ).rejects.toThrow(/is not a sandbox user/i)
    expect(await authUserExists(userId)).toBe(true)
  })

  it('refuses a user whose company is not a sandbox', async () => {
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, is_sandbox)
       VALUES ($1, $2, false)`,
      [userId, companyId],
    )

    await expect(
      getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [userId]),
    ).rejects.toThrow(/is not a sandbox user/i)
    expect(await authUserExists(userId)).toBe(true)
  })

  it('does not loosen posted-entry immutability outside the RPC', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId })

    const client = await getClient()
    try {
      await client.query('BEGIN')
      await expect(
        client.query(`DELETE FROM public.journal_entry_lines WHERE journal_entry_id = $1`, [
          entryId,
        ]),
      ).rejects.toThrow(/posted journal entry/i)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('the bypass flags are cleared before cleanup_sandbox_user returns', async () => {
    const { userId } = await seedSandboxUser()
    const client = await getClient()
    try {
      // Explicit transaction: a bare statement would end its own implicit
      // transaction and discard transaction-local GUCs regardless, which is
      // exactly the blind spot the old version of this test had.
      await client.query('BEGIN')
      await client.query(`SELECT public.cleanup_sandbox_user($1)`, [userId])
      const { rows } = await client.query<{ del: string | null; sc: string | null }>(
        `SELECT current_setting('gnubok.allow_delete', true) AS del,
                current_setting('gnubok.sandbox_cleanup', true) AS sc`,
      )
      expect(rows[0]!.del ?? '').not.toBe('true')
      expect(rows[0]!.sc ?? '').not.toBe('true')
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  })

  it('refuses a user who has both a sandbox and a non-sandbox company', async () => {
    const sandbox = await seedSandboxUser()
    const otherCompanyId = randomUUID()
    await getPool().query(
      `INSERT INTO public.companies (id, name, entity_type, created_by)
       VALUES ($1, 'Second Real Company', 'enskild_firma', $2)`,
      [otherCompanyId, sandbox.userId],
    )
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, is_sandbox)
       VALUES ($1, $2, false)`,
      [sandbox.userId, otherCompanyId],
    )

    await expect(
      getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [sandbox.userId]),
    ).rejects.toThrow(/is not a sandbox user/i)
    expect(await authUserExists(sandbox.userId)).toBe(true)

    // Clean up: replace the non-sandbox settings row with a sandbox one
    // (a direct DB session may insert is_sandbox = true), then the
    // sanctioned teardown removes everything.
    await getPool().query(
      `DELETE FROM public.company_settings WHERE company_id = $1`,
      [otherCompanyId],
    )
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, is_sandbox)
       VALUES ($1, $2, true)`,
      [sandbox.userId, otherCompanyId],
    )
    await getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [sandbox.userId])
    expect(await authUserExists(sandbox.userId)).toBe(false)
  })

  it('sweeps expired sandbox users and orphaned anonymous users, keeps fresh ones, reports counts', async () => {
    const anonSupported = await hasIsAnonymousColumn()

    // Ancient timestamps put our rows first in the ORDER BY created_at loops,
    // so a bounded p_limit still covers them even on a shared database that
    // has its own stale sandbox rows.
    const expired = await seedSandboxUser('2000-01-02T00:00:00Z')
    const fresh = await seedSandboxUser()
    const expiredOrphan = anonSupported
      ? await insertAnonymousAuthUser('2000-01-01T00:00:00Z')
      : null
    const freshOrphan = anonSupported
      ? await insertAnonymousAuthUser(new Date().toISOString())
      : null

    const { rows } = await getPool().query<{
      summary: { cleaned: number; failed: number; orphans_removed: number }
    }>(`SELECT public.cleanup_expired_sandbox_users(24, 25) AS summary`)
    const summary = rows[0]!.summary

    expect(await authUserExists(expired.userId)).toBe(false)
    expect(await authUserExists(fresh.userId)).toBe(true)
    expect(summary.cleaned).toBeGreaterThanOrEqual(1)
    expect(summary.failed).toBe(0)
    if (anonSupported && expiredOrphan && freshOrphan) {
      expect(await authUserExists(expiredOrphan)).toBe(false)
      expect(await authUserExists(freshOrphan)).toBe(true)
      expect(summary.orphans_removed).toBeGreaterThanOrEqual(1)
    } else {
      expect(summary.orphans_removed).toBe(0)
    }

    // Leave nothing behind on a shared database.
    await getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [fresh.userId])
    if (freshOrphan) {
      await getPool().query(`DELETE FROM auth.users WHERE id = $1`, [freshOrphan])
    }
  })

  it('company_settings.is_sandbox is write-once in both directions', async () => {
    const real = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, is_sandbox)
       VALUES ($1, $2, false)`,
      [real.userId, real.companyId],
    )
    await expect(
      getPool().query(
        `UPDATE public.company_settings SET is_sandbox = true WHERE company_id = $1`,
        [real.companyId],
      ),
    ).rejects.toThrow(/write-once/i)

    const sandbox = await seedSandboxUser()
    await expect(
      getPool().query(
        `UPDATE public.company_settings SET is_sandbox = false WHERE company_id = $1`,
        [sandbox.companyId],
      ),
    ).rejects.toThrow(/write-once/i)
    // Other columns stay updatable.
    await getPool().query(
      `UPDATE public.company_settings SET is_sandbox = is_sandbox, company_name = 'Still Updatable'
       WHERE company_id = $1`,
      [real.companyId],
    )
    await getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [sandbox.userId])
  })

  it('the orphan sweep never reaches an anonymous user who has a company but no settings row', async () => {
    if (!(await hasIsAnonymousColumn())) return

    const userId = await insertAnonymousAuthUser('2000-01-03T00:00:00Z')
    const companyId = randomUUID()
    await getPool().query(
      `INSERT INTO public.companies (id, name, entity_type, created_by)
       VALUES ($1, 'Orphan With Books', 'enskild_firma', $2)`,
      [companyId, userId],
    )
    const { rows: fpRows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.fiscal_periods (user_id, company_id, name, period_start, period_end)
       VALUES ($1, $2, 'Orphan 2026', '2026-01-01', '2026-12-31') RETURNING id`,
      [userId, companyId],
    )
    await insertPostedJournalEntry({
      userId,
      companyId,
      fiscalPeriodId: fpRows[0]!.id,
    })

    await getPool().query(`SELECT public.cleanup_expired_sandbox_users(24, 25)`)

    // Excluded from the sweep by the explicit companies/company_members
    // guards, not by an incidental downstream trigger failure.
    expect(await authUserExists(userId)).toBe(true)

    // Clean up via the sanctioned teardown: give the company a sandbox
    // settings row (a direct DB session may insert is_sandbox = true; only
    // flips and PostgREST-authenticated inserts are blocked).
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, is_sandbox)
       VALUES ($1, $2, true)`,
      [userId, companyId],
    )
    await getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [userId])
    expect(await authUserExists(userId)).toBe(false)
  })

  it('is_sandbox = true cannot be inserted by a regular authenticated user, but can by an anonymous one', async () => {
    const { userId, companyId } = await seedCompany()

    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: 'authenticated' }),
      ])
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`)
      await client.query(`SET LOCAL ROLE authenticated`)
      await expect(
        client.query(
          `INSERT INTO public.company_settings (user_id, company_id, is_sandbox)
           VALUES ($1, $2, true)`,
          [userId, companyId],
        ),
      ).rejects.toThrow(/anonymous sandbox users/i)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }

    const anonClient = await getClient()
    try {
      await anonClient.query('BEGIN')
      await anonClient.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: 'authenticated', is_anonymous: true }),
      ])
      await anonClient.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
      await anonClient.query(
        `SELECT set_config('request.jwt.claim.role', 'authenticated', true)`,
      )
      await anonClient.query(`SET LOCAL ROLE authenticated`)
      await anonClient.query(
        `INSERT INTO public.company_settings (user_id, company_id, is_sandbox)
         VALUES ($1, $2, true)`,
        [userId, companyId],
      )
      // Rolled back below: this test only proves the guard's allow path.
    } finally {
      await anonClient.query('ROLLBACK').catch(() => {})
      anonClient.release()
    }
  })

  it('cleanup_expired_sandbox_users carries its own statement_timeout', async () => {
    // PostgREST sessions inherit authenticator's 8s statement_timeout while
    // one sandbox teardown costs ~3s, so without a function-local override
    // the nightly batch times out and rolls back wholesale (migration
    // 20260807150000, same pattern as undo_sie_import).
    const { rows } = await getPool().query<{ proconfig: string[] | null }>(
      `SELECT p.proconfig
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'cleanup_expired_sandbox_users'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.proconfig ?? []).toContain('statement_timeout=290s')
  })

  it('is executable by service_role only', async () => {
    const { rows } = await getPool().query<{
      svc_user: boolean
      svc_expired: boolean
      anon_user: boolean
      anon_expired: boolean
      authed_expired: boolean
    }>(
      `SELECT
         has_function_privilege('service_role', 'public.cleanup_sandbox_user(uuid)', 'EXECUTE') AS svc_user,
         has_function_privilege('service_role', 'public.cleanup_expired_sandbox_users(int, int)', 'EXECUTE') AS svc_expired,
         has_function_privilege('anon', 'public.cleanup_sandbox_user(uuid)', 'EXECUTE') AS anon_user,
         has_function_privilege('anon', 'public.cleanup_expired_sandbox_users(int, int)', 'EXECUTE') AS anon_expired,
         has_function_privilege('authenticated', 'public.cleanup_expired_sandbox_users(int, int)', 'EXECUTE') AS authed_expired`,
    )
    expect(rows[0]!.svc_user).toBe(true)
    expect(rows[0]!.svc_expired).toBe(true)
    expect(rows[0]!.anon_user).toBe(false)
    expect(rows[0]!.anon_expired).toBe(false)
    expect(rows[0]!.authed_expired).toBe(false)
  })
})
