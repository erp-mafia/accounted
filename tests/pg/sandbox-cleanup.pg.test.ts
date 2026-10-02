import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'
import { insertPostedJournalEntry, insertTransaction, seedCompany } from './fixtures'

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
 *
 * Extended by 20260901120000 with the four blockers that stalled nine
 * sandboxes on prod (oldest 2026-07-22): a betalfil batch holding a supplier
 * invoice through ON DELETE RESTRICT, a fiscal period pointing at its IB and
 * bokslut vouchers through NO ACTION FKs, a terminal webhook delivery, and a
 * payment_match_log row with company_id NULL. The seed now carries all four,
 * and each relaxed guard gets a paired test proving it still refuses a
 * NON-sandbox tenant even when the teardown flag is set: that, not the happy
 * path, is the regression that matters.
 */

async function seedSandboxUser(settingsCreatedAt?: string): Promise<{
  userId: string
  companyId: string
  fiscalPeriodId: string
  entryId: string
  batchId: string
  supplierInvoiceId: string
  deliveryId: string
  matchLogId: string
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
  // A betalfil batch: supplier_payment_batch_items references the supplier
  // invoice with a composite ON DELETE RESTRICT FK, so the batch header must
  // be purged before the supplier_invoices delete (20260901120000).
  const supplierId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name, bankgiro)
     VALUES ($1, $2, $3, 'Derome Bygg AB', '5050-1055')`,
    [supplierId, userId, companyId],
  )
  const supplierInvoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number,
        supplier_invoice_number, invoice_date, due_date,
        subtotal, vat_amount, total, remaining_amount, status)
     VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int,
             $5, '2026-06-23', '2026-07-07',
             590, 147.5, 737.5, 737.5, 'approved')`,
    [supplierInvoiceId, userId, companyId, supplierId, `CD-${supplierInvoiceId.slice(0, 8)}`],
  )
  const batchId = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_payment_batches
       (id, company_id, user_id, format, total_amount, item_count, msg_id, debtor_snapshot)
     VALUES ($1, $2, $3, 'pain001', 737.5, 1, $4,
             '{"name":"Sandbox AB","org_number":"556677-8899","iban":"SE3550000000054910000003","bic":"ESSESESS"}')`,
    [batchId, companyId, userId, `ACCOUNTED-5566778899-B${batchId.slice(0, 8)}`],
  )
  await getPool().query(
    `INSERT INTO public.supplier_payment_batch_items
       (batch_id, company_id, supplier_invoice_id, amount, payment_date,
        payee_type, payee_bankgiro, payee_name, reference_type, reference)
     VALUES ($1, $2, $3, 737.5, '2026-08-15',
             'bankgiro', '50501055', 'Derome Bygg AB', 'invoice_number', 'CD3014794407')`,
    [batchId, companyId, supplierInvoiceId],
  )
  // A period that has both an IB link (write-once once opening_balances_set)
  // and a bokslut link: fiscal_periods_opening_balance_entry_id_fkey and
  // fiscal_periods_closing_entry_id_fkey are both NO ACTION, so the journal
  // delete fails until the teardown clears them, and clearing them is itself
  // blocked by enforce_opening_balance_immutability outside the bypass.
  const closingEntryId = await insertPostedJournalEntry({
    userId,
    companyId,
    fiscalPeriodId,
    voucherNumber: 1,
    sourceType: 'year_end',
    description: 'Sandbox bokslut',
  })
  await getPool().query(
    `UPDATE public.fiscal_periods
     SET opening_balance_entry_id = $2, opening_balances_set = true, closing_entry_id = $3
     WHERE id = $1`,
    [fiscalPeriodId, entryId, closingEntryId],
  )
  // A delivered webhook delivery: block_webhook_delivery_terminal_delete
  // raises on the auth.users -> companies cascade outside the bypass.
  const webhookId = randomUUID()
  await getPool().query(
    `INSERT INTO public.webhooks (id, company_id, event_type, webhook_url, secret)
     VALUES ($1, $2, 'journal_entry.committed', 'https://example.invalid/hook', $3)`,
    [webhookId, companyId, randomUUID()],
  )
  const deliveryId = randomUUID()
  await getPool().query(
    `INSERT INTO public.webhook_deliveries
       (id, webhook_id, company_id, event_type, payload, api_version, status, delivered_at)
     VALUES ($1, $2, $3, 'journal_entry.committed', '{"id":"demo"}', '2026-05-12',
             'delivered', now())`,
    [deliveryId, webhookId, companyId],
  )
  // A match-log row WITHOUT company_id: the shape lib/invoices/match-log.ts
  // has always written, and the one the shared audit_log_immutable() bypass
  // could not recognise as a sandbox row. It points at the supplier invoice
  // above on purpose: payment_match_log_supplier_invoice_id_fkey is ON DELETE
  // SET NULL, so a teardown that purges the match log after the supplier
  // invoices turns this row into an UPDATE, which the guard refuses even
  // during teardown. The order of the two deletes is what this row pins.
  const transactionId = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions
       (id, company_id, user_id, currency, amount, date, description, category)
     VALUES ($1, $2, $3, 'SEK', -737.5, '2026-06-24', 'Sandbox betalning', 'uncategorized')`,
    [transactionId, companyId, userId],
  )
  const { rows: matchRows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.payment_match_log
       (user_id, transaction_id, supplier_invoice_id, action)
     VALUES ($1, $2, $3, 'matched') RETURNING id`,
    [userId, transactionId, supplierInvoiceId],
  )
  return {
    userId,
    companyId,
    fiscalPeriodId,
    entryId,
    batchId,
    supplierInvoiceId,
    deliveryId,
    matchLogId: matchRows[0]!.id,
  }
}

async function countById(table: string, id: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE id = $1`,
    [id],
  )
  return rows[0]!.n
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

  it('clears the batch, IB/bokslut, webhook and match-log blockers and leaves no tenant rows', async () => {
    const seed = await seedSandboxUser()

    await getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [seed.userId])

    expect(await authUserExists(seed.userId)).toBe(false)
    // Each of these is one of the four blockers: before 20260901120000 the
    // RPC raised on the first of them and the whole teardown rolled back.
    expect(await countById('public.supplier_payment_batches', seed.batchId)).toBe(0)
    expect(await countById('public.supplier_invoices', seed.supplierInvoiceId)).toBe(0)
    expect(await countById('public.fiscal_periods', seed.fiscalPeriodId)).toBe(0)
    expect(await countById('public.webhook_deliveries', seed.deliveryId)).toBe(0)
    expect(await countById('public.payment_match_log', seed.matchLogId)).toBe(0)
    const { rows: items } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.supplier_payment_batch_items WHERE batch_id = $1`,
      [seed.batchId],
    )
    expect(items[0]!.n).toBe(0)
    const { rows: leftovers } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.company_settings WHERE company_id = $1`,
      [seed.companyId],
    )
    expect(leftovers[0]!.n).toBe(0)
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
         has_function_privilege('service_role', 'public.cleanup_expired_sandbox_users(int, int, int)', 'EXECUTE') AS svc_expired,
         has_function_privilege('anon', 'public.cleanup_sandbox_user(uuid)', 'EXECUTE') AS anon_user,
         has_function_privilege('anon', 'public.cleanup_expired_sandbox_users(int, int, int)', 'EXECUTE') AS anon_expired,
         has_function_privilege('authenticated', 'public.cleanup_expired_sandbox_users(int, int, int)', 'EXECUTE') AS authed_expired`,
    )
    expect(rows[0]!.svc_user).toBe(true)
    expect(rows[0]!.svc_expired).toBe(true)
    expect(rows[0]!.anon_user).toBe(false)
    expect(rows[0]!.anon_expired).toBe(false)
    expect(rows[0]!.authed_expired).toBe(false)
  })
})

/**
 * The regression half of 20260901120000: three guards were relaxed for
 * sandbox teardown, and each one still has to refuse a real tenant. Every
 * case runs twice, once plain and once with gnubok.sandbox_cleanup set by
 * hand, because a flag-only bypass would pass the first and fail the second.
 */
describe('sandbox teardown bypasses never reach a real tenant (pg)', () => {
  async function withTeardownFlag<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.sandbox_cleanup', 'true', true)`)
      return await fn(client)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  }

  async function seedRealCompany(): Promise<{
    userId: string
    companyId: string
    fiscalPeriodId: string
  }> {
    const ctx = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, is_sandbox)
       VALUES ($1, $2, false)`,
      [ctx.userId, ctx.companyId],
    )
    return ctx
  }

  it('enforce_opening_balance_immutability still refuses to unlink a real IB voucher', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedRealCompany()
    const entryId = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId })
    await getPool().query(
      `UPDATE public.fiscal_periods
       SET opening_balance_entry_id = $2, opening_balances_set = true
       WHERE id = $1`,
      [fiscalPeriodId, entryId],
    )

    await expect(
      getPool().query(
        `UPDATE public.fiscal_periods SET opening_balance_entry_id = NULL WHERE id = $1`,
        [fiscalPeriodId],
      ),
    ).rejects.toThrow(/opening balances are immutable once set/i)

    await withTeardownFlag(async (client) => {
      await expect(
        client.query(
          `UPDATE public.fiscal_periods SET opening_balance_entry_id = NULL WHERE id = $1`,
          [fiscalPeriodId],
        ),
      ).rejects.toThrow(/opening balances are immutable once set/i)
    })
  })

  it('enforce_opening_balance_immutability still refuses to detach a real bokslut voucher', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedRealCompany()
    const closingEntryId = await insertPostedJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      sourceType: 'year_end',
      description: 'Bokslut 2026',
    })
    await getPool().query(
      `UPDATE public.fiscal_periods SET closing_entry_id = $2 WHERE id = $1`,
      [fiscalPeriodId, closingEntryId],
    )

    await withTeardownFlag(async (client) => {
      await expect(
        client.query(
          `UPDATE public.fiscal_periods SET closing_entry_id = NULL WHERE id = $1`,
          [fiscalPeriodId],
        ),
      ).rejects.toThrow(/year-end closing is immutable/i)
    })
  })

  it('block_webhook_delivery_terminal_delete still refuses a real tenant terminal delivery', async () => {
    const { companyId } = await seedRealCompany()
    const deliveryId = randomUUID()
    await getPool().query(
      `INSERT INTO public.webhook_deliveries
         (id, company_id, event_type, payload, api_version, status, delivered_at)
       VALUES ($1, $2, 'journal_entry.committed', '{"id":"real"}', '2026-05-12',
               'delivered', now())`,
      [deliveryId, companyId],
    )

    await expect(
      getPool().query(`DELETE FROM public.webhook_deliveries WHERE id = $1`, [deliveryId]),
    ).rejects.toThrow(/terminal status/i)

    await withTeardownFlag(async (client) => {
      await expect(
        client.query(`DELETE FROM public.webhook_deliveries WHERE id = $1`, [deliveryId]),
      ).rejects.toThrow(/terminal status/i)
    })

    // Non-terminal rows stay deletable, flag or no flag: the guard's
    // predicate is unchanged for everyone outside a sandbox.
    const pendingId = randomUUID()
    await getPool().query(
      `INSERT INTO public.webhook_deliveries
         (id, company_id, event_type, payload, api_version, status)
       VALUES ($1, $2, 'journal_entry.committed', '{"id":"real"}', '2026-05-12', 'pending')`,
      [pendingId, companyId],
    )
    await getPool().query(`DELETE FROM public.webhook_deliveries WHERE id = $1`, [pendingId])
  })

  it('payment_match_log stays append-only for a real tenant, company_id set or NULL', async () => {
    const { userId, companyId } = await seedRealCompany()
    const transactionId = await insertTransaction({ companyId, userId })
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.payment_match_log (user_id, company_id, transaction_id, action)
       VALUES ($1, $2, $3, 'matched') RETURNING id`,
      [userId, companyId, transactionId],
    )
    const tenantedId = rows[0]!.id
    const { rows: untenanted } = await getPool().query<{ id: string }>(
      `INSERT INTO public.payment_match_log (user_id, transaction_id, action)
       VALUES ($1, $2, 'unmatched') RETURNING id`,
      [userId, transactionId],
    )
    const untenantedId = untenanted[0]!.id

    for (const id of [tenantedId, untenantedId]) {
      await expect(
        getPool().query(`DELETE FROM public.payment_match_log WHERE id = $1`, [id]),
      ).rejects.toThrow(/cannot be modified or deleted/i)
      // The company_id IS NULL branch is the one 20260901120000 added; it
      // must resolve through company_settings.user_id, not through the flag.
      await withTeardownFlag(async (client) => {
        await expect(
          client.query(`DELETE FROM public.payment_match_log WHERE id = $1`, [id]),
        ).rejects.toThrow(/cannot be modified or deleted/i)
      })
    }

    await expect(
      getPool().query(
        `UPDATE public.payment_match_log SET action = 'unmatched' WHERE id = $1`,
        [tenantedId],
      ),
    ).rejects.toThrow(/cannot be modified or deleted/i)
  })

  it('payment_match_log UPDATE stays forbidden even inside a sandbox teardown', async () => {
    const seed = await seedSandboxUser()

    await withTeardownFlag(async (client) => {
      await expect(
        client.query(
          `UPDATE public.payment_match_log SET action = 'unmatched' WHERE id = $1`,
          [seed.matchLogId],
        ),
      ).rejects.toThrow(/cannot be modified or deleted/i)
    })

    await getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [seed.userId])
    expect(await authUserExists(seed.userId)).toBe(false)
  })
})

/**
 * #2837 (20260927220000). On 2026-09-27 the nightly cron had not removed a
 * single sandbox since 2026-09-23: ten users at the head of the queue failed
 * every night on account_reconciliations.signed_by (RESTRICT into
 * auth.users), transactions.document_id (RESTRICT into document_attachments),
 * the rättelse log's WORM trigger, and a committed pending operation in a
 * company that was not a sandbox at all. The issue's own case, posted
 * depreciation and a disposal (RESTRICT into journal_entries), had not hit
 * prod yet. The seed below carries every one of them plus the other
 * registers a sandbox visitor can reach, and the assertion is not a list of
 * ids but "no public table holds a row of this company any more".
 */
async function insertDocument(userId: string, companyId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, file_name, mime_type, file_size_bytes,
        storage_path, sha256_hash, upload_source)
     VALUES ($1, $2, $3, 'kvitto.pdf', 'application/pdf', 1024, $4, $5, 'file_upload')`,
    [id, userId, companyId, `${companyId}/${id}.pdf`, randomUUID().replace(/-/g, '').padEnd(64, '0')],
  )
  return id
}

async function seedRegisters(seed: Awaited<ReturnType<typeof seedSandboxUser>>): Promise<void> {
  const { userId, companyId, fiscalPeriodId, entryId, supplierInvoiceId } = seed
  const q = (sql: string, params: unknown[]) => getPool().query(sql, params)
  const voucher = (description: string) =>
    insertPostedJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      description,
      voucherNumber: Math.floor(Math.random() * 1_000_000) + 10,
    })

  // Posted depreciation: depreciation_schedules.journal_entry_id is RESTRICT.
  const depreciationEntry = await voucher('Avskrivning inventarier')
  const assetId = randomUUID()
  await q(
    `INSERT INTO public.assets
       (id, user_id, company_id, name, category, acquisition_date, acquisition_cost,
        useful_life_months, bas_asset_account, bas_accumulated_account, bas_expense_account)
     VALUES ($1, $2, $3, 'Laptop', 'equipment', '2026-01-01', 60000, 60, '1220', '1229', '7832')`,
    [assetId, userId, companyId],
  )
  await q(
    `INSERT INTO public.depreciation_schedules
       (user_id, company_id, asset_id, fiscal_period_id, planned_depreciation, journal_entry_id, posted_at)
     VALUES ($1, $2, $3, $4, 12000, $5, now())`,
    [userId, companyId, assetId, fiscalPeriodId, depreciationEntry],
  )
  // A disposal: assets.disposal_journal_entry_id is RESTRICT.
  const disposalEntry = await voucher('Avyttring maskin')
  await q(
    `INSERT INTO public.assets
       (user_id, company_id, name, category, acquisition_date, acquisition_cost,
        useful_life_months, bas_asset_account, bas_accumulated_account, bas_expense_account,
        disposed_at, disposed_proceeds, disposal_type, disposal_journal_entry_id)
     VALUES ($1, $2, 'Maskin', 'equipment', '2025-01-01', 40000, 60, '1220', '1229', '7832',
             '2026-06-30', 10000, 'sale', $3)`,
    [userId, companyId, disposalEntry],
  )
  // A signed account reconciliation (signed_by RESTRICT into auth.users) and
  // its WORM attachment (uploaded_by RESTRICT, delete guard).
  await q(
    `INSERT INTO public.account_reconciliations (company_id, account_key, through_date, signed_by)
     VALUES ($1, 'manual:2350', '2026-06-30', $2)`,
    [companyId, userId],
  )
  await q(
    `INSERT INTO public.account_reconciliation_attachments
       (company_id, account_key, through_date, file_name, mime_type, size_bytes,
        storage_bucket, storage_path, sha256, uploaded_by)
     VALUES ($1, 'manual:2350', '2026-06-30', 'kontoutdrag.pdf', 'application/pdf', 10,
             'documents', $2, repeat('b', 64), $3)`,
    [companyId, `documents/${companyId}/reconciliation/${randomUUID()}.pdf`, userId],
  )
  // A bank row holding the receipt of a posted voucher:
  // transactions_document_id_fkey is RESTRICT, and the detach is refused
  // while the document still sits on the voucher.
  const receiptId = await insertDocument(userId, companyId)
  await q(`UPDATE public.document_attachments SET journal_entry_id = $2 WHERE id = $1`, [receiptId, entryId])
  await q(
    `INSERT INTO public.transactions
       (company_id, user_id, currency, amount, date, description, category, document_id)
     VALUES ($1, $2, 'SEK', -1000, '2026-06-01', 'Kortköp', 'uncategorized', $3)`,
    [companyId, userId, receiptId],
  )
  // Inline rättelse log row: WORM, no teardown window before 20260927220000.
  await q(
    `INSERT INTO public.journal_entry_rattelse_log
       (company_id, journal_entry_id, rattelse_type, old_description, new_description, actor, source)
     VALUES ($1, $2, 'metadata', 'Test entry', 'Rättad text', $3, 'user')`,
    [companyId, entryId, userId],
  )
  // A booked mileage trip on a voucher: delete guard, and journal_entry_id
  // is SET NULL, which a booked trip refuses as an UPDATE.
  await q(
    `INSERT INTO public.mileage_trips
       (company_id, user_id, trip_date, distance_km, from_location, to_location, purpose,
        status, journal_entry_id)
     VALUES ($1, $2, '2026-06-01', 42, 'Kontoret', 'Kund AB', 'Kundbesök', 'booked', $3)`,
    [companyId, userId, entryId],
  )
  // An Arkiv fact sourced from a document: never deleted outside teardown,
  // and source_document_id is SET NULL, which the guard refuses as an UPDATE.
  const factSource = await insertDocument(userId, companyId)
  await q(
    `INSERT INTO public.company_facts
       (company_id, subject_kind, subject_id, predicate, value, value_text, source_kind, source_document_id)
     VALUES ($1, 'company', $1, 'vat_period', '"kvartal"', 'kvartal', 'extraction', $2)`,
    [companyId, factSource],
  )
  // Periodisering: schedule and installment hold RESTRICT references to the
  // origin voucher, the installment voucher and the supplier invoice.
  const accrualEntry = await voucher('Periodisering hyra')
  const { rows: schedules } = await q(
    `INSERT INTO public.accrual_schedules
       (user_id, company_id, direction, supplier_invoice_id, balance_account, target_account,
        total_amount, period_start, period_end, months, origin_journal_entry_id)
     VALUES ($1, $2, 'expense', $3, '1730', '5010', 12000, '2026-01-01', '2026-12-31', 12, $4)
     RETURNING id`,
    [userId, companyId, supplierInvoiceId, accrualEntry],
  )
  await q(
    `INSERT INTO public.accrual_schedule_installments
       (user_id, company_id, schedule_id, period_month, amount, status, journal_entry_id)
     VALUES ($1, $2, $3, '2026-01-01', 1000, 'posted', $4)`,
    [userId, companyId, (schedules[0] as { id: string }).id, accrualEntry],
  )
  // Tax adjustment in a period that is closed afterwards: RESTRICT into
  // fiscal_periods, and the guard refuses a delete in a closed period.
  const { rows: periods } = await q(
    `INSERT INTO public.fiscal_periods (user_id, company_id, name, period_start, period_end)
     VALUES ($1, $2, '2025', '2025-01-01', '2025-12-31') RETURNING id`,
    [userId, companyId],
  )
  const closedPeriodId = (periods[0] as { id: string }).id
  await q(
    `INSERT INTO public.fiscal_period_tax_adjustments
       (company_id, user_id, fiscal_period_id, adjustment_type, source, source_key, description, amount)
     VALUES ($1, $2, $3, 'non_deductible_expense', 'manual', 'representation', 'Representation', 1200)`,
    [companyId, userId, closedPeriodId],
  )
  await q(`UPDATE public.fiscal_periods SET is_closed = true, closed_at = now() WHERE id = $1`, [closedPeriodId])
  // Annual report: a draft version and its validation run (RESTRICT into
  // the version, the period and the company; the version is WORM).
  const { rows: versions } = await q(
    `INSERT INTO public.annual_report_versions
       (company_id, fiscal_period_id, user_id, version_number, schema_version, framework,
        report_data, content_hash)
     VALUES ($1, $2, $3, 1, '1', 'k2', '{}', repeat('c', 64)) RETURNING id`,
    [companyId, fiscalPeriodId, userId],
  )
  await q(
    `INSERT INTO public.annual_report_validation_runs
       (company_id, fiscal_period_id, version_id, validation_layer, status)
     VALUES ($1, $2, $3, 'local', 'passed')`,
    [companyId, fiscalPeriodId, (versions[0] as { id: string }).id],
  )
  // Payroll: an employee on a run (salary_run_employees.employee_id RESTRICT)
  // and an utlägg paid through the run (salary_line_items to expense_claims,
  // RESTRICT; expense_claims.user_id RESTRICT into auth.users).
  const { rows: employees } = await q(
    `INSERT INTO public.employees
       (company_id, user_id, first_name, last_name, personnummer, personnummer_last4,
        employment_type, employment_start, employment_degree, salary_type)
     VALUES ($1, $2, 'Anna', 'Anställd', '199001011234', '1234', 'employee', '2026-01-01', 100, 'monthly')
     RETURNING id`,
    [companyId, userId],
  )
  const employeeId = (employees[0] as { id: string }).id
  const { rows: runs } = await q(
    `SELECT id FROM public.salary_runs WHERE company_id = $1 LIMIT 1`,
    [companyId],
  )
  const { rows: sres } = await q(
    `INSERT INTO public.salary_run_employees
       (salary_run_id, employee_id, company_id, employment_degree, monthly_salary, salary_type)
     VALUES ($1, $2, $3, 100, 30000, 'monthly') RETURNING id`,
    [(runs[0] as { id: string }).id, employeeId, companyId],
  )
  const claimId = randomUUID()
  await q(
    `INSERT INTO public.expense_claims
       (id, company_id, user_id, employee_id, claimant_name, description, expense_date,
        amount_sek, vat_sek, expense_account, liability_account, status)
     VALUES ($1, $2, $3, $4, 'Anna Anställd', 'Kabel', '2026-06-10', 199, 0, '5410', '2820', 'registered')`,
    [claimId, companyId, userId, employeeId],
  )
  await q(
    `INSERT INTO public.salary_line_items
       (salary_run_employee_id, company_id, item_type, description, amount,
        is_taxable, is_avgift_basis, is_vacation_basis, account_number, source_expense_claim_id)
     VALUES ($1, $2, 'expense_reimbursement', 'Utlägg: Kabel', 199, false, false, false, '2820', $3)`,
    [(sres[0] as { id: string }).id, companyId, claimId],
  )
  // Sales: a recurring schedule (customer_id RESTRICT) and an invoice made
  // from a kundorder (invoices.sales_order_id RESTRICT).
  const customerId = randomUUID()
  await q(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [customerId, userId, companyId],
  )
  await q(
    `INSERT INTO public.recurring_invoice_schedules
       (company_id, user_id, customer_id, name, day_of_month, next_run_date, period_start)
     VALUES ($1, $2, $3, 'Retainer', 1, '2026-10-01', '2026-10-01')`,
    [companyId, userId, customerId],
  )
  const orderId = randomUUID()
  await q(
    `INSERT INTO public.sales_orders (id, company_id, user_id, customer_id, status, order_date)
     VALUES ($1, $2, $3, $4, 'confirmed', '2026-09-01')`,
    [orderId, companyId, userId, customerId],
  )
  await q(
    `INSERT INTO public.invoices
       (user_id, company_id, customer_id, document_type, invoice_date, due_date, currency,
        subtotal, vat_amount, total, vat_treatment, vat_rate, moms_ruta, status, sales_order_id)
     VALUES ($1, $2, $3, 'invoice', '2026-09-01', '2026-10-01', 'SEK',
             1000, 250, 1250, 'standard_25', 25, '10', 'draft', $4)`,
    [userId, companyId, customerId, orderId],
  )
}

/** Every public table with a company_id column that still holds a row of `companyId`. */
async function leftoverTenantRows(companyId: string): Promise<Record<string, number>> {
  const { rows: tables } = await getPool().query<{ tbl: string }>(
    `SELECT format('%I.%I', c.table_schema, c.table_name) AS tbl
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'company_id'
        AND t.table_type = 'BASE TABLE'`,
  )
  const left: Record<string, number> = {}
  for (const { tbl } of tables) {
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${tbl} WHERE company_id = $1`,
      [companyId],
    )
    if (rows[0]!.n > 0) left[tbl] = rows[0]!.n
  }
  const { rows: company } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.companies WHERE id = $1`,
    [companyId],
  )
  if (company[0]!.n > 0) left['public.companies'] = company[0]!.n
  return left
}

describe('sandbox teardown with posted registers (pg, #2837)', () => {
  it('tears down a sandbox with posted depreciation, a disposal and every register a visitor reaches', async () => {
    const seed = await seedSandboxUser()
    await seedRegisters(seed)

    await getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [seed.userId])

    expect(await authUserExists(seed.userId)).toBe(false)
    expect(await leftoverTenantRows(seed.companyId)).toEqual({})
  })

  it('leaves a real company untouched when a sandbox is torn down next to it', async () => {
    const real = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, is_sandbox) VALUES ($1, $2, false)`,
      [real.userId, real.companyId],
    )
    const realEntry = await insertPostedJournalEntry({
      userId: real.userId,
      companyId: real.companyId,
      fiscalPeriodId: real.fiscalPeriodId,
    })
    await getPool().query(
      `INSERT INTO public.journal_entry_rattelse_log
         (company_id, journal_entry_id, rattelse_type, old_description, new_description, actor, source)
       VALUES ($1, $2, 'metadata', 'Test entry', 'Rättad text', $3, 'user')`,
      [real.companyId, realEntry, real.userId],
    )
    await getPool().query(
      `INSERT INTO public.account_reconciliations (company_id, account_key, through_date, signed_by)
       VALUES ($1, 'manual:2350', '2026-06-30', $2)`,
      [real.companyId, real.userId],
    )
    const before = await leftoverTenantRows(real.companyId)

    const sandbox = await seedSandboxUser()
    await seedRegisters(sandbox)
    await getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [sandbox.userId])

    expect(await leftoverTenantRows(sandbox.companyId)).toEqual({})
    expect(await leftoverTenantRows(real.companyId)).toEqual(before)
    expect(await authUserExists(real.userId)).toBe(true)
  })

  it('refuses a sandbox user who owns a company that is not a sandbox, and touches neither', async () => {
    // Prod shape: an anonymous sandbox visitor created a second, non-sandbox
    // company and posted there. The account delete would cascade into it
    // (companies_created_by_fkey) with the delete bypass set.
    const sandbox = await seedSandboxUser()
    const ownCompanyId = randomUUID()
    await getPool().query(
      `INSERT INTO public.companies (id, name, entity_type, created_by)
       VALUES ($1, 'Riktiga Bolaget AB', 'aktiebolag', $2)`,
      [ownCompanyId, sandbox.userId],
    )
    await getPool().query(
      `INSERT INTO public.company_members (company_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [ownCompanyId, sandbox.userId],
    )
    // Settings row without user_id, as on prod: invisible to the old
    // "every settings row of this user is a sandbox" check.
    await getPool().query(
      `INSERT INTO public.company_settings (company_id, is_sandbox) VALUES ($1, false)`,
      [ownCompanyId],
    )
    const { rows: fp } = await getPool().query<{ id: string }>(
      `INSERT INTO public.fiscal_periods (user_id, company_id, name, period_start, period_end)
       VALUES ($1, $2, '2026', '2026-01-01', '2026-12-31') RETURNING id`,
      [sandbox.userId, ownCompanyId],
    )
    const ownEntry = await insertPostedJournalEntry({
      userId: sandbox.userId,
      companyId: ownCompanyId,
      fiscalPeriodId: fp[0]!.id,
    })
    const ownBefore = await leftoverTenantRows(ownCompanyId)
    const sandboxBefore = await leftoverTenantRows(sandbox.companyId)

    await expect(
      getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [sandbox.userId]),
    ).rejects.toThrow(/has data in a company that is not a sandbox/)

    expect(await authUserExists(sandbox.userId)).toBe(true)
    expect(await countById('public.journal_entries', ownEntry)).toBe(1)
    expect(await leftoverTenantRows(ownCompanyId)).toEqual(ownBefore)
    expect(await leftoverTenantRows(sandbox.companyId)).toEqual(sandboxBefore)

    // The same refusal holds for vouchers written in a company the user is
    // no longer a member of.
    await getPool().query(
      `DELETE FROM public.company_members WHERE company_id = $1 AND user_id = $2`,
      [ownCompanyId, sandbox.userId],
    )
    await getPool().query(
      `UPDATE public.companies SET created_by = $2 WHERE id = $1`,
      [ownCompanyId, await insertAuthUserId()],
    )
    await expect(
      getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [sandbox.userId]),
    ).rejects.toThrow(/has data in a company that is not a sandbox/)
    expect(await countById('public.journal_entries', ownEntry)).toBe(1)
  })

  it('a user whose teardown fails keeps its place and the next batch starts after it', async () => {
    // Ten failing users at the head of the queue stalled the prod cron from
    // 2026-09-23: every batch of ten was all failures and the route stopped.
    // Fixtures sort first by an older created_at than any other test's.
    const blocked = await seedSandboxUser('1990-01-01T00:00:00Z')
    const bareRealCompany = randomUUID()
    const realOwner = await insertAuthUserId()
    await getPool().query(
      `INSERT INTO public.companies (id, name, entity_type, created_by)
       VALUES ($1, 'Annat Bolag AB', 'aktiebolag', $2)`,
      [bareRealCompany, realOwner],
    )
    await getPool().query(
      `INSERT INTO public.company_members (company_id, user_id, role) VALUES ($1, $2, 'member')`,
      [bareRealCompany, blocked.userId],
    )
    const next = await seedSandboxUser('1990-01-02T00:00:00Z')

    try {
      const first = await getPool().query<{ s: Record<string, number> }>(
        `SELECT public.cleanup_expired_sandbox_users(24, 1) AS s`,
      )
      expect(first.rows[0]!.s).toMatchObject({ cleaned: 0, failed: 1, attempted: 1, next_offset: 1 })
      expect(await authUserExists(blocked.userId)).toBe(true)
      expect(await authUserExists(next.userId)).toBe(true)

      const second = await getPool().query<{ s: Record<string, number> }>(
        `SELECT public.cleanup_expired_sandbox_users(24, 1, 1) AS s`,
      )
      expect(second.rows[0]!.s).toMatchObject({ cleaned: 1, failed: 0, attempted: 1, next_offset: 1 })
      expect(await authUserExists(next.userId)).toBe(false)
      expect(await authUserExists(blocked.userId)).toBe(true)
    } finally {
      await getPool().query(
        `DELETE FROM public.company_members WHERE company_id = $1 AND user_id = $2`,
        [bareRealCompany, blocked.userId],
      )
      await getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [blocked.userId])
      if (await authUserExists(next.userId)) {
        await getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [next.userId])
      }
    }
  })
})

async function insertAuthUserId(): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO auth.users (id, email, instance_id)
     VALUES ($1, $2, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [id, `pg-real-${id}@test.invalid`],
  )
  return id
}

/**
 * The six WORM guards that gained the teardown window in 20260927220000 must
 * still refuse a real tenant with the flag set by hand: the per-row
 * company_settings.is_sandbox check, not the flag, is what opens them.
 */
describe('new teardown windows never reach a real tenant (pg, #2837)', () => {
  async function realCompany() {
    const ctx = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, is_sandbox) VALUES ($1, $2, false)`,
      [ctx.userId, ctx.companyId],
    )
    return ctx
  }

  async function refusesWithFlag(sql: string, params: unknown[], pattern: RegExp): Promise<void> {
    await expect(getPool().query(sql, params)).rejects.toThrow(pattern)
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.sandbox_cleanup', 'true', true)`)
      await client.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
      await expect(client.query(sql, params)).rejects.toThrow(pattern)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  }

  it('journal_entry_rattelse_log stays WORM', async () => {
    const { userId, companyId, fiscalPeriodId } = await realCompany()
    const entryId = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId })
    await getPool().query(
      `INSERT INTO public.journal_entry_rattelse_log
         (company_id, journal_entry_id, rattelse_type, old_description, new_description, actor, source)
       VALUES ($1, $2, 'metadata', 'a', 'b', $3, 'user')`,
      [companyId, entryId, userId],
    )
    await refusesWithFlag(
      `DELETE FROM public.journal_entry_rattelse_log WHERE company_id = $1`,
      [companyId],
      /oföränderlig/,
    )
    await refusesWithFlag(
      `UPDATE public.journal_entry_rattelse_log SET new_description = 'c' WHERE company_id = $1`,
      [companyId],
      /oföränderlig/,
    )
  })

  it('account_reconciliation_attachments stay undeletable', async () => {
    const { userId, companyId } = await realCompany()
    await getPool().query(
      `INSERT INTO public.account_reconciliation_attachments
         (company_id, account_key, through_date, file_name, mime_type, size_bytes,
          storage_bucket, storage_path, sha256, uploaded_by)
       VALUES ($1, 'manual:2350', '2026-06-30', 'k.pdf', 'application/pdf', 10, 'documents', $2, repeat('b', 64), $3)`,
      [companyId, `documents/${companyId}/reconciliation/${randomUUID()}.pdf`, userId],
    )
    await refusesWithFlag(
      `DELETE FROM public.account_reconciliation_attachments WHERE company_id = $1`,
      [companyId],
      /never deleted/,
    )
  })

  it('a booked mileage trip stays undeletable', async () => {
    const { userId, companyId } = await realCompany()
    await getPool().query(
      `INSERT INTO public.mileage_trips
         (company_id, user_id, trip_date, distance_km, from_location, to_location, purpose, status)
       VALUES ($1, $2, '2026-06-01', 10, 'A', 'B', 'Kundbesök', 'booked')`,
      [companyId, userId],
    )
    await refusesWithFlag(
      `DELETE FROM public.mileage_trips WHERE company_id = $1`,
      [companyId],
      /booked mileage trip/,
    )
  })

  it('company_facts stay undeletable', async () => {
    const { companyId } = await realCompany()
    await getPool().query(
      `INSERT INTO public.company_facts (company_id, subject_kind, subject_id, predicate, value, value_text, source_kind)
       VALUES ($1, 'company', $1, 'vat_period', '"månad"', 'månad', 'person')`,
      [companyId],
    )
    await refusesWithFlag(
      `DELETE FROM public.company_facts WHERE company_id = $1`,
      [companyId],
      /never deleted/,
    )
  })

  it('a tax adjustment in a closed period stays undeletable', async () => {
    const { userId, companyId, fiscalPeriodId } = await realCompany()
    await getPool().query(
      `INSERT INTO public.fiscal_period_tax_adjustments
         (company_id, user_id, fiscal_period_id, adjustment_type, source, source_key, description, amount)
       VALUES ($1, $2, $3, 'non_deductible_expense', 'manual', 'representation', 'Representation', 100)`,
      [companyId, userId, fiscalPeriodId],
    )
    await getPool().query(
      `UPDATE public.fiscal_periods SET is_closed = true, closed_at = now() WHERE id = $1`,
      [fiscalPeriodId],
    )
    await refusesWithFlag(
      `DELETE FROM public.fiscal_period_tax_adjustments WHERE company_id = $1`,
      [companyId],
      /locked for tax adjustments/,
    )
  })

  it('annual report versions stay undeletable', async () => {
    const { userId, companyId, fiscalPeriodId } = await realCompany()
    await getPool().query(
      `INSERT INTO public.annual_report_versions
         (company_id, fiscal_period_id, user_id, version_number, schema_version, framework, report_data, content_hash)
       VALUES ($1, $2, $3, 1, '1', 'k2', '{}', repeat('d', 64))`,
      [companyId, fiscalPeriodId, userId],
    )
    await refusesWithFlag(
      `DELETE FROM public.annual_report_versions WHERE company_id = $1`,
      [companyId],
      /retained as immutable/,
    )
  })
})
