import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { insertDraftJournalEntry, seedCompany } from '@/tests/pg/fixtures'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'
import { TRACE_HEADER } from '@/lib/supabase/trace-header'

/**
 * Covers 20261128110000_audit_trace_and_rule_versions:
 *   - public.request_trace_id() reads the x-accounted-trace header PostgREST
 *     hands the transaction, and audit_log.trace_id takes it as its default,
 *     so every audited row a request writes names the request;
 *   - categorization_templates.version goes up when what the rule books
 *     changes, and only then.
 *
 * Each request is presented the way PostgREST presents it: a role, its JWT
 * claims and the request's headers in request.headers.
 * tests/tool-pg/audit-trace-header.tool.test.ts sends it through a real
 * PostgREST.
 */

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'

/** A request carrying these headers as the service role, as PostgREST runs it (committed). */
function serviceRoleRequest<T>(headers: Record<string, string>, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runAsServiceRole(async (client) => {
    await client.query(`SELECT set_config('request.headers', $1, true)`, [JSON.stringify(headers)])
    return fn(client)
  })
}

async function traceIdFor(headers: string | null): Promise<string | null> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    if (headers !== null) await client.query(`SELECT set_config('request.headers', $1, true)`, [headers])
    const { rows } = await client.query<{ t: string | null }>(`SELECT public.request_trace_id() AS t`)
    return rows[0]!.t
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

async function auditTraces(table: string, recordId: string, action: string): Promise<Array<string | null>> {
  const { rows } = await getPool().query<{ trace_id: string | null }>(
    `SELECT trace_id FROM public.audit_log
      WHERE table_name = $1 AND record_id = $2 AND action = $3
      ORDER BY created_at, id`,
    [table, recordId, action],
  )
  return rows.map((r) => r.trace_id)
}

async function insertRule(companyId: string, userId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.categorization_templates (id, user_id, company_id, counterparty_name, debit_account, credit_account)
     VALUES ($1, $2, $3, 'telia', '6212', '1930')`,
    [id, userId, companyId],
  )
  return id
}

async function versionOf(ruleId: string): Promise<number> {
  const { rows } = await getPool().query<{ version: number }>(
    `SELECT version FROM public.categorization_templates WHERE id = $1`,
    [ruleId],
  )
  return rows[0]!.version
}

describe('public.request_trace_id()', () => {
  it("reads the request's trace from the header PostgREST hands the transaction", async () => {
    expect(await traceIdFor(JSON.stringify({ [TRACE_HEADER]: TRACE, 'user-agent': 'supabase-js-node' }))).toBe(TRACE)
  })

  it('is null outside a request and without the header', async () => {
    expect(await traceIdFor(null)).toBeNull()
    expect(await traceIdFor(JSON.stringify({ 'user-agent': 'supabase-js-node' }))).toBeNull()
    expect(await traceIdFor('')).toBeNull()
  })

  it('takes only the trace id form: 32 lowercase hex', async () => {
    expect(await traceIdFor(JSON.stringify({ [TRACE_HEADER]: TRACE.toUpperCase() }))).toBeNull()
    expect(await traceIdFor(JSON.stringify({ [TRACE_HEADER]: TRACE.slice(1) }))).toBeNull()
    expect(await traceIdFor(JSON.stringify({ [TRACE_HEADER]: `${TRACE}0` }))).toBeNull()
    expect(await traceIdFor(JSON.stringify({ [TRACE_HEADER]: 'not-a-trace' }))).toBeNull()
  })

  it('never reads the key out of another header value', async () => {
    const forged = JSON.stringify({ 'x-other': `"${TRACE_HEADER}":"${TRACE}"` })
    expect(await traceIdFor(forged)).toBeNull()
  })
})

describe('audit_log.trace_id names the request that wrote the row', () => {
  it("a service-role request's audited write keeps its trace, a verifikat's included", async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const ruleId = await insertRule(companyId, userId)
    const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })

    await serviceRoleRequest({ [TRACE_HEADER]: TRACE }, async (client) => {
      await client.query(`UPDATE public.categorization_templates SET debit_account = '6540' WHERE id = $1`, [ruleId])
      await client.query(`UPDATE public.journal_entries SET description = 'Telia mobil' WHERE id = $1`, [entryId])
    })

    expect(await auditTraces('categorization_templates', ruleId, 'UPDATE')).toEqual([TRACE])
    expect(await auditTraces('journal_entries', entryId, 'UPDATE')).toEqual([TRACE])
  })

  it("a signed-in user's request keeps its trace too: it is a correlation hint, not an identity", async () => {
    const { userId, companyId } = await seedCompany()
    const ruleId = await insertRule(companyId, userId)

    // withUserContext rolls back, so the audit row is read in the same
    // transaction, after RESET ROLE.
    const traces = await withUserContext(userId, async (client) => {
      await client.query(`SELECT set_config('request.headers', $1, true)`, [JSON.stringify({ [TRACE_HEADER]: TRACE })])
      const written = await client.query(
        `UPDATE public.categorization_templates SET credit_account = '1940' WHERE id = $1 AND company_id = $2 RETURNING id`,
        [ruleId, companyId],
      )
      expect(written.rowCount).toBe(1)
      await client.query('RESET ROLE')
      const { rows } = await client.query<{ trace_id: string | null }>(
        `SELECT trace_id FROM public.audit_log WHERE table_name = 'categorization_templates' AND record_id = $1 AND action = 'UPDATE'`,
        [ruleId],
      )
      return rows.map((r) => r.trace_id)
    })

    expect(traces).toEqual([TRACE])
  })

  it('a write outside a request, or without the header, records no trace', async () => {
    const { userId, companyId } = await seedCompany()
    const ruleId = await insertRule(companyId, userId)

    await serviceRoleRequest({ 'user-agent': 'supabase-js-node' }, async (client) => {
      await client.query(`UPDATE public.categorization_templates SET debit_account = '6540' WHERE id = $1`, [ruleId])
    })

    expect(await auditTraces('categorization_templates', ruleId, 'INSERT')).toEqual([null])
    expect(await auditTraces('categorization_templates', ruleId, 'UPDATE')).toEqual([null])
  })

  it('refuses a trace that is not a trace id from a writer that names the column', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, trace_id)
         VALUES ($1, $2, 'UPDATE', 'companies', $2, 'NOT-A-TRACE')`,
        [userId, companyId],
      ),
    ).rejects.toThrow(/audit_log_trace_id_format/)
  })
})

describe('categorization_templates.version counts the changes to what the rule books', () => {
  it('starts at 1 and goes up by one for each change to accounts, moms, pattern or dimensions', async () => {
    const { userId, companyId } = await seedCompany()
    const ruleId = await insertRule(companyId, userId)
    expect(await versionOf(ruleId)).toBe(1)

    await getPool().query(`UPDATE public.categorization_templates SET debit_account = '6540' WHERE id = $1`, [ruleId])
    expect(await versionOf(ruleId)).toBe(2)

    await getPool().query(
      `UPDATE public.categorization_templates SET vat_treatment = 'standard_25', vat_account = '2641' WHERE id = $1`,
      [ruleId],
    )
    expect(await versionOf(ruleId)).toBe(3)

    await getPool().query(
      `UPDATE public.categorization_templates SET default_dimensions = '{"1": "100"}'::jsonb WHERE id = $1`,
      [ruleId],
    )
    expect(await versionOf(ruleId)).toBe(4)
  })

  it('keeps the version for learning, the ladder and the origin: they change who says yes, not what is booked', async () => {
    const { userId, companyId } = await seedCompany()
    const ruleId = await insertRule(companyId, userId)

    await getPool().query(
      `UPDATE public.categorization_templates
          SET occurrence_count = occurrence_count + 1, confidence = 0.9, last_seen_date = '2026-11-01',
              counterparty_aliases = ARRAY['TELIA SVERIGE'], corrections = 1, source = 'user_approved'
        WHERE id = $1`,
      [ruleId],
    )
    await getPool().query(`UPDATE public.categorization_templates SET mode = 'paused' WHERE id = $1`, [ruleId])
    await getPool().query(`UPDATE public.categorization_templates SET is_active = true, mode = 'propose' WHERE id = $1`, [ruleId])
    await getPool().query(`UPDATE public.categorization_templates SET always_review = true WHERE id = $1`, [ruleId])

    expect(await versionOf(ruleId)).toBe(1)
  })

  it('is owned by the trigger: a written version is ignored', async () => {
    const { userId, companyId } = await seedCompany()
    const ruleId = await insertRule(companyId, userId)

    await getPool().query(`UPDATE public.categorization_templates SET version = 99 WHERE id = $1`, [ruleId])
    expect(await versionOf(ruleId)).toBe(1)

    await getPool().query(
      `UPDATE public.categorization_templates SET version = 99, debit_account = '6540' WHERE id = $1`,
      [ruleId],
    )
    expect(await versionOf(ruleId)).toBe(2)
  })

  it('a change of what the rule books is audited with the new version', async () => {
    const { userId, companyId } = await seedCompany()
    const ruleId = await insertRule(companyId, userId)

    await getPool().query(`UPDATE public.categorization_templates SET debit_account = '6540' WHERE id = $1`, [ruleId])

    const { rows } = await getPool().query<{ before: number; after: number }>(
      `SELECT (old_state ->> 'version')::int AS before, (new_state ->> 'version')::int AS after
         FROM public.audit_log
        WHERE table_name = 'categorization_templates' AND record_id = $1 AND action = 'UPDATE'`,
      [ruleId],
    )
    expect(rows).toEqual([{ before: 1, after: 2 }])
  })
})
