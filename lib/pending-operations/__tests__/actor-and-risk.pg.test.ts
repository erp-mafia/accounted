/**
 * pg-real smoke tests for the migrations introduced by the AI-native streams
 * (actor model, expanded op types, idempotency).
 *
 * These don't replicate the unit-test coverage: they prove the schema and
 * constraints behave as the application code assumes when running against a
 * real Postgres with the migrations applied.
 */
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

describe('pending_operations: actor model + risk columns', () => {
  it('accepts the expanded actor_type and risk_level enums', async () => {
    const { userId, companyId } = await seedCompany()
    const pool = getPool()

    const result = await pool.query<{
      id: string
      actor_type: string
      risk_level: string
    }>(
      `INSERT INTO public.pending_operations (
         user_id, company_id, operation_type, title, params, preview_data,
         actor_type, actor_id, actor_label, risk_level
       ) VALUES ($1, $2, 'create_customer', 'pg-real test', '{}', '{}',
                 'api_key', NULL, 'Claude Desktop', 'low')
       RETURNING id, actor_type, risk_level`,
      [userId, companyId],
    )

    expect(result.rows[0]).toMatchObject({
      actor_type: 'api_key',
      risk_level: 'low',
    })
  })

  it('rejects invalid actor_type via CHECK constraint', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.pending_operations (
           user_id, company_id, operation_type, title, params, preview_data, actor_type, risk_level
         ) VALUES ($1, $2, 'create_customer', 'x', '{}', '{}', 'martian', 'low')`,
        [userId, companyId],
      ),
    ).rejects.toThrow(/check constraint|actor_type/i)
  })

  it('rejects invalid risk_level via CHECK constraint', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.pending_operations (
           user_id, company_id, operation_type, title, params, preview_data, actor_type, risk_level
         ) VALUES ($1, $2, 'create_customer', 'x', '{}', '{}', 'user', 'critical')`,
        [userId, companyId],
      ),
    ).rejects.toThrow(/check constraint|risk_level/i)
  })

  it('accepts the expanded operation_type enum (close_period, run_year_end, …)', async () => {
    const { userId, companyId } = await seedCompany()
    const expandedTypes = [
      'close_period', 'lock_period', 'unlock_period', 'run_year_end', 'set_opening_balances',
      'run_currency_revaluation', 'explain_voucher_gap', 'uncategorize_transaction',
      'approve_supplier_invoice', 'credit_supplier_invoice',
      'credit_invoice', 'convert_invoice', 'import_sie',
      // Phase 4: arbitrary-line bookkeeping primitives
      'create_voucher', 'correct_entry', 'reverse_entry',
      // Phase 5 + bokslut: supplier/inbox + planenlig avskrivning
      'create_supplier', 'create_supplier_invoice_from_inbox', 'post_annual_depreciation',
    ]

    for (const op of expandedTypes) {
      const result = await getPool().query<{ id: string }>(
        `INSERT INTO public.pending_operations (
           user_id, company_id, operation_type, title, params, preview_data
         ) VALUES ($1, $2, $3, 'pg-real test', '{}', '{}')
         RETURNING id`,
        [userId, companyId, op],
      )
      expect(result.rows[0]?.id).toBeTruthy()
    }
  })
})

describe('audit_log: actor_type + actor_label columns', () => {
  it('accepts INSERT with actor_type and actor_label', async () => {
    const { userId } = await seedCompany()
    const result = await getPool().query<{ id: string }>(
      `INSERT INTO public.audit_log (
         user_id, action, table_name, actor_type, actor_label, description
       ) VALUES ($1, 'INSERT', 'pending_operations', 'api_key', 'Claude Desktop', 'pg-real test')
       RETURNING id`,
      [userId],
    )
    expect(result.rows[0]?.id).toBeTruthy()
  })
})

describe('idempotency_keys table', () => {
  it('enforces unique (user_id, key) and 24h default expiry', async () => {
    const { userId, companyId } = await seedCompany()

    await getPool().query(
      `INSERT INTO public.idempotency_keys
         (user_id, company_id, key, request_hash, scope, response_status, response_body)
       VALUES ($1, $2, 'dup-key', 'hash-1', 'mcp_tool', 'success', '{}')`,
      [userId, companyId],
    )

    await expect(
      getPool().query(
        `INSERT INTO public.idempotency_keys
           (user_id, company_id, key, request_hash, scope, response_status, response_body)
         VALUES ($1, $2, 'dup-key', 'hash-2', 'mcp_tool', 'success', '{}')`,
        [userId, companyId],
      ),
    ).rejects.toThrow(/duplicate key|unique/i)

    const expiry = await getPool().query<{ expires_at: string; created_at: string }>(
      `SELECT expires_at, created_at FROM public.idempotency_keys
       WHERE user_id = $1 AND key = 'dup-key'`,
      [userId],
    )
    const created = new Date(expiry.rows[0]!.created_at).getTime()
    const expires = new Date(expiry.rows[0]!.expires_at).getTime()
    const hoursDelta = (expires - created) / 3_600_000
    // Expect the default ~24h gap (allow ±1 minute for clock skew).
    expect(hoursDelta).toBeGreaterThan(23.95)
    expect(hoursDelta).toBeLessThan(24.05)
  })

  it('rejects invalid response_status', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.idempotency_keys
           (user_id, company_id, key, request_hash, scope, response_status, response_body)
         VALUES ($1, $2, 'bad-status', 'hash-x', 'mcp_tool', 'maybe', '{}')`,
        [userId, companyId],
      ),
    ).rejects.toThrow(/check constraint|response_status/i)
  })

  it('rejects NULL company_id (multi-tenant scoping)', async () => {
    const { userId } = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.idempotency_keys
           (user_id, company_id, key, request_hash, scope, response_status, response_body)
         VALUES ($1, NULL, 'k1', 'h1', 'mcp_tool', 'success', '{}')`,
        [userId],
      ),
    ).rejects.toThrow(/null value|not.null/i)
  })

  it('allows the same key across two companies (scoped uniqueness)', async () => {
    const { userId, companyId: company1 } = await seedCompany()
    const { companyId: company2 } = await seedCompany()
    const sameKey = 'shared-key-abc'

    await getPool().query(
      `INSERT INTO public.idempotency_keys
         (user_id, company_id, key, request_hash, scope, response_status, response_body)
       VALUES ($1, $2, $3, 'h1', 'mcp_tool', 'success', '{}')`,
      [userId, company1, sameKey],
    )
    // Same user + same key but different company must NOT collide.
    await expect(
      getPool().query(
        `INSERT INTO public.idempotency_keys
           (user_id, company_id, key, request_hash, scope, response_status, response_body)
         VALUES ($1, $2, $3, 'h2', 'mcp_tool', 'success', '{}')`,
        [userId, company2, sameKey],
      ),
    ).resolves.toBeTruthy()
  })
})

describe('pending_operations: CAS + post-commit immutability', () => {
  it('accepts the new committing transient status', async () => {
    const { userId, companyId } = await seedCompany()
    const result = await getPool().query<{ id: string; status: string }>(
      `INSERT INTO public.pending_operations
         (user_id, company_id, operation_type, status, title, params, preview_data)
       VALUES ($1, $2, 'create_customer', 'committing', 'pg-real', '{}', '{}')
       RETURNING id, status`,
      [userId, companyId],
    )
    expect(result.rows[0]?.status).toBe('committing')
  })

  it('CAS pattern (UPDATE … WHERE status=pending) only claims unclaimed rows', async () => {
    const { userId, companyId } = await seedCompany()
    const ins = await getPool().query<{ id: string }>(
      `INSERT INTO public.pending_operations
         (user_id, company_id, operation_type, status, title, params, preview_data)
       VALUES ($1, $2, 'create_customer', 'pending', 'cas-test', '{}', '{}')
       RETURNING id`,
      [userId, companyId],
    )
    const id = ins.rows[0]!.id

    // First claim succeeds.
    const first = await getPool().query(
      `UPDATE public.pending_operations SET status = 'committing'
       WHERE id = $1 AND status = 'pending' RETURNING id`,
      [id],
    )
    expect(first.rowCount).toBe(1)

    // Second concurrent claim sees status='committing' and returns 0 rows.
    const second = await getPool().query(
      `UPDATE public.pending_operations SET status = 'committing'
       WHERE id = $1 AND status = 'pending' RETURNING id`,
      [id],
    )
    expect(second.rowCount).toBe(0)
  })

  it('blocks UPDATE on rows in terminal status (committed)', async () => {
    const { userId, companyId } = await seedCompany()
    const ins = await getPool().query<{ id: string }>(
      `INSERT INTO public.pending_operations
         (user_id, company_id, operation_type, status, title, params, preview_data, resolved_at)
       VALUES ($1, $2, 'create_customer', 'committed', 'imm-test', '{}', '{}', now())
       RETURNING id`,
      [userId, companyId],
    )
    const id = ins.rows[0]!.id

    await expect(
      getPool().query(
        `UPDATE public.pending_operations SET title = 'tampered' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/terminal state|BFL 7/i)
  })

  it('blocks UPDATE on rows in terminal status (rejected)', async () => {
    const { userId, companyId } = await seedCompany()
    const ins = await getPool().query<{ id: string }>(
      `INSERT INTO public.pending_operations
         (user_id, company_id, operation_type, status, title, params, preview_data, resolved_at)
       VALUES ($1, $2, 'create_customer', 'rejected', 'imm-test', '{}', '{}', now())
       RETURNING id`,
      [userId, companyId],
    )
    const id = ins.rows[0]!.id

    await expect(
      getPool().query(
        `UPDATE public.pending_operations SET params = '{"x":1}' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/terminal state|BFL 7/i)
  })

  it('blocks DELETE on rows in terminal status', async () => {
    const { userId, companyId } = await seedCompany()
    const ins = await getPool().query<{ id: string }>(
      `INSERT INTO public.pending_operations
         (user_id, company_id, operation_type, status, title, params, preview_data, resolved_at)
       VALUES ($1, $2, 'create_customer', 'committed', 'del-test', '{}', '{}', now())
       RETURNING id`,
      [userId, companyId],
    )
    const id = ins.rows[0]!.id

    await expect(
      getPool().query(`DELETE FROM public.pending_operations WHERE id = $1`, [id]),
    ).rejects.toThrow(/terminal state|BFL 7/i)
  })

  it('blocks UPDATE of params on non-terminal rows (BFL 7 underlag-immutability)', async () => {
    const { userId, companyId } = await seedCompany()
    const ins = await getPool().query<{ id: string }>(
      `INSERT INTO public.pending_operations
         (user_id, company_id, operation_type, status, title, params, preview_data)
       VALUES ($1, $2, 'create_customer', 'pending', 'frozen-test', '{"name":"original"}', '{}')
       RETURNING id`,
      [userId, companyId],
    )
    const id = ins.rows[0]!.id

    await expect(
      getPool().query(
        `UPDATE public.pending_operations SET params = '{"name":"tampered"}' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/frozen|underlag/i)
  })

  it('blocks UPDATE of operation_type on non-terminal rows', async () => {
    const { userId, companyId } = await seedCompany()
    const ins = await getPool().query<{ id: string }>(
      `INSERT INTO public.pending_operations
         (user_id, company_id, operation_type, status, title, params, preview_data)
       VALUES ($1, $2, 'create_customer', 'pending', 'op-type-frozen', '{}', '{}')
       RETURNING id`,
      [userId, companyId],
    )
    const id = ins.rows[0]!.id

    await expect(
      getPool().query(
        `UPDATE public.pending_operations SET operation_type = 'send_invoice' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/frozen/i)
  })

  it('allows committing → committed transition', async () => {
    const { userId, companyId } = await seedCompany()
    const ins = await getPool().query<{ id: string }>(
      `INSERT INTO public.pending_operations
         (user_id, company_id, operation_type, status, title, params, preview_data)
       VALUES ($1, $2, 'create_customer', 'committing', 'transition-test', '{}', '{}')
       RETURNING id`,
      [userId, companyId],
    )
    const id = ins.rows[0]!.id

    const upd = await getPool().query(
      `UPDATE public.pending_operations
         SET status = 'committed', resolved_at = now(), result_data = '{"ok":true}'
       WHERE id = $1 RETURNING id`,
      [id],
    )
    expect(upd.rowCount).toBe(1)
  })
})
