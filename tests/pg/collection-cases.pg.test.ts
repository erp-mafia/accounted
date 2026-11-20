import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * Collection cases (migration 20261012030200_collection_cases.sql): the
 * invoice guard, one open case per invoice, the case row shape, the
 * append-only trail, the list and Att göra functions, the connection guard
 * counting open cases, the cancel block on invoices, grants and the sandbox
 * teardown.
 */

type Db = Pick<PoolClient, 'query'>

interface Seed {
  companyId: string
  userId: string
}

async function insertConnection(seed: Seed, state = 'active', route: 'connect' | 'fake' = 'connect'): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.collection_connections
       (company_id, user_id, route, provider_ref, display_name, state, sub_status,
        catalogue_terms_version, consented_by, consented_at, activated_at, ladder_mode)
     VALUES ($1, $2, $3, 'acme-inkasso', 'Acme Inkasso', $4,
             CASE WHEN $4 = 'connecting' THEN 'in_review' END, 'v1', $2, now(),
             CASE WHEN $4 = 'active' THEN now() END, 'off')
     RETURNING id`,
    [seed.companyId, seed.userId, route, state],
  )
  return rows[0]!.id
}

async function insertCustomer(seed: Seed): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [id, seed.userId, seed.companyId],
  )
  return id
}

async function insertInvoice(seed: Seed, cols: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  const customerId = (cols.customer_id as string | undefined) ?? (await insertCustomer(seed))
  const status = (cols.status as string | undefined) ?? 'sent'
  const base: Record<string, unknown> = {
    id,
    user_id: seed.userId,
    company_id: seed.companyId,
    customer_id: customerId,
    invoice_date: '2026-06-01',
    due_date: '2026-06-30',
    currency: 'SEK',
    vat_treatment: 'standard_25',
    vat_rate: 25,
    subtotal: 8000,
    vat_amount: 2000,
    total: 10000,
    status,
    invoice_number: status === 'draft' ? null : `T-${id.slice(0, 8)}`,
    ...cols,
  }
  const keys = Object.keys(base)
  await getPool().query(
    `INSERT INTO public.invoices (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
    keys.map((k) => base[k]),
  )
  return id
}

interface CaseSeed {
  companyId: string
  invoiceId: string
  connectionId: string
  status?: 'preparing' | 'submitted' | 'registered' | 'failed'
  stage?: string
  ref?: string | null
}

async function insertCase(params: CaseSeed, db: Db = getPool()): Promise<string> {
  const status = params.status ?? 'registered'
  const open = status !== 'failed'
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.collection_cases
       (company_id, invoice_id, connection_id, origin, start_step, submission_status, provider_case_ref,
        stage, claim_amount, bank_check, is_open, closed_at)
     VALUES ($1, $2, $3, 'handover', 'reminder', $4, $5, $6, 10000, '{"outcome":"pass"}'::jsonb, $7,
             CASE WHEN $7 THEN NULL ELSE now() END)
     RETURNING id`,
    [
      params.companyId,
      params.invoiceId,
      params.connectionId,
      status,
      params.ref === undefined ? (status === 'registered' ? `ref-${randomUUID()}` : null) : params.ref,
      params.stage ?? 'registered',
      open,
    ],
  )
  return rows[0]!.id
}

async function insertEvent(companyId: string, caseId: string, ref: string | null = null, db: Db = getPool()): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.collection_case_events (company_id, case_id, occurred_at, kind, label, provider_event_ref)
     VALUES ($1, $2, now(), 'letter', 'Påminnelse skickad', $3) RETURNING id`,
    [companyId, caseId, ref],
  )
  return rows[0]!.id
}

async function inRollback(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

async function activeCompany(): Promise<Seed & { connectionId: string }> {
  const seed = await seedCompany()
  const connectionId = await insertConnection(seed)
  return { ...seed, connectionId }
}

describe('collection_cases (pg)', () => {
  it('opens a case only for an issued, owed customer invoice of the same company, through its active connection', async () => {
    const co = await activeCompany()
    const ok = await insertInvoice(co)
    await insertCase({ companyId: co.companyId, invoiceId: ok, connectionId: co.connectionId })

    const refused: Array<[string, Record<string, unknown>]> = [
      ['draft', { status: 'draft' }],
      ['paid', { status: 'paid', paid_amount: 10000, remaining_amount: 0 }],
      ['quote', { document_type: 'quote' }],
      ['self-billed', { is_self_billed: true, external_invoice_number: 'EXT-1', invoice_number: null }],
      ['ROT/RUT share refused by Skatteverket', { deduction_total: 3000, deduction_reclaimed_total: 1000 }],
    ]
    for (const [label, cols] of refused) {
      const invoiceId = await insertInvoice(co, cols).catch((err: Error) => {
        throw new Error(`fixture ${label}: ${err.message}`)
      })
      await expect(
        insertCase({ companyId: co.companyId, invoiceId, connectionId: co.connectionId }),
        label,
      ).rejects.toThrow(/COLLECTION_CASE_INVOICE_INVALID/)
    }

    // A credit note is not a claim.
    const creditNote = await insertInvoice(co, { credited_invoice_id: ok, total: -10000, subtotal: -8000, vat_amount: -2000 })
    await expect(
      insertCase({ companyId: co.companyId, invoiceId: creditNote, connectionId: co.connectionId }),
    ).rejects.toThrow(/COLLECTION_CASE_INVOICE_INVALID/)

    // Another company's invoice, or another company's connection.
    const other = await activeCompany()
    const foreign = await insertInvoice(other)
    await expect(
      insertCase({ companyId: co.companyId, invoiceId: foreign, connectionId: co.connectionId }),
    ).rejects.toThrow(/COLLECTION_CASE_INVOICE_INVALID/)
    const mine = await insertInvoice(co)
    await expect(
      insertCase({ companyId: co.companyId, invoiceId: mine, connectionId: other.connectionId }),
    ).rejects.toThrow(/COLLECTION_CASE_CONNECTION_INVALID/)

    // A connection still in review hands nothing over.
    const pending = await seedCompany()
    const connecting = await insertConnection(pending, 'connecting')
    const invoice = await insertInvoice(pending)
    await expect(
      insertCase({ companyId: pending.companyId, invoiceId: invoice, connectionId: connecting }),
    ).rejects.toThrow(/COLLECTION_CASE_CONNECTION_INVALID/)
  })

  it('keeps one open case per invoice; a failed submission closes its case and frees the slot', async () => {
    const co = await activeCompany()
    const invoiceId = await insertInvoice(co)
    const first = await insertCase({ companyId: co.companyId, invoiceId, connectionId: co.connectionId, status: 'submitted' })
    await expect(
      insertCase({ companyId: co.companyId, invoiceId, connectionId: co.connectionId }),
    ).rejects.toThrow(/collection_cases_one_open_per_invoice/)

    // Failed while still open: refused by the shape.
    await expect(
      getPool().query(`UPDATE public.collection_cases SET submission_status = 'failed' WHERE id = $1`, [first]),
    ).rejects.toThrow(/collection_cases_failed_closed/)
    await getPool().query(
      `UPDATE public.collection_cases SET submission_status = 'failed', is_open = false, closed_at = now(), sync_error = 'CONNECTOR_COLLECTIONS_DEBTOR_INVALID'
        WHERE id = $1`,
      [first],
    )
    const second = await insertCase({ companyId: co.companyId, invoiceId, connectionId: co.connectionId })
    expect(second).not.toBe(first)
  })

  it('enforces the case shape and keeps the case on its invoice', async () => {
    const co = await activeCompany()
    const invoiceId = await insertInvoice(co)
    const id = await insertCase({ companyId: co.companyId, invoiceId, connectionId: co.connectionId })
    const bad: Array<[string, RegExp]> = [
      [`UPDATE public.collection_cases SET is_open = false WHERE id = $1`, /collection_cases_open_shape/],
      [`UPDATE public.collection_cases SET stage = 'closed_paid' WHERE id = $1`, /collection_cases_closed_stage/],
      [`UPDATE public.collection_cases SET close_reason = 'paid' WHERE id = $1`, /collection_cases_close_reason_shape/],
      [`UPDATE public.collection_cases SET decision_kind = 'dispute' WHERE id = $1`, /collection_cases_decision_shape/],
      [`UPDATE public.collection_cases SET provider_case_ref = NULL WHERE id = $1`, /collection_cases_registered_ref/],
      [`UPDATE public.collection_cases SET submission_request = '{}'::jsonb WHERE id = $1`, /collection_cases_request_in_flight/],
      [`UPDATE public.collection_cases SET claim_amount = 0 WHERE id = $1`, /check/],
      [`UPDATE public.collection_cases SET stage = 'sent_to_moon' WHERE id = $1`, /check/],
    ]
    for (const [sql, error] of bad) {
      await expect(getPool().query(sql, [id]), sql).rejects.toThrow(error)
    }
    const otherInvoice = await insertInvoice(co)
    await expect(
      getPool().query(`UPDATE public.collection_cases SET invoice_id = $2 WHERE id = $1`, [id, otherInvoice]),
    ).rejects.toThrow(/keeps its company, invoice and connection/)

    // A decision, then a close as paid, are valid shapes.
    await getPool().query(
      `UPDATE public.collection_cases SET stage = 'awaiting_decision', decision_kind = 'approve_collection_notice' WHERE id = $1`,
      [id],
    )
    await getPool().query(
      `UPDATE public.collection_cases SET stage = 'closed_paid', decision_kind = NULL, is_open = false, closed_at = now(), close_reason = 'paid'
        WHERE id = $1`,
      [id],
    )
  })

  it('keeps the case trail append-only, one row per provider event, on its case\'s company', async () => {
    const co = await activeCompany()
    const invoiceId = await insertInvoice(co)
    const caseId = await insertCase({ companyId: co.companyId, invoiceId, connectionId: co.connectionId })
    const eventId = await insertEvent(co.companyId, caseId, 'prov-1')
    await expect(insertEvent(co.companyId, caseId, 'prov-1')).rejects.toThrow(/collection_case_events_provider_ref/)
    await insertEvent(co.companyId, caseId, null)
    await insertEvent(co.companyId, caseId, null)

    await expect(
      getPool().query(`UPDATE public.collection_case_events SET label = 'x' WHERE id = $1`, [eventId]),
    ).rejects.toThrow(/append-only/)
    await expect(getPool().query(`DELETE FROM public.collection_case_events WHERE id = $1`, [eventId])).rejects.toThrow(
      /append-only/,
    )
    // The teardown flag alone does not open the window: it needs the
    // teardown function's owner and a sandbox company.
    await inRollback(async (client) => {
      await client.query(`SELECT set_config('gnubok.sandbox_cleanup', 'true', true)`)
      await expect(client.query(`DELETE FROM public.collection_case_events WHERE id = $1`, [eventId])).rejects.toThrow(
        /append-only/,
      )
    })

    const other = await seedCompany()
    await expect(insertEvent(other.companyId, caseId)).rejects.toThrow(/belongs to its case's company/)

    // A case with a trail is not deleted (RESTRICT): the trail is the record.
    await expect(getPool().query(`DELETE FROM public.collection_cases WHERE id = $1`, [caseId])).rejects.toThrow(
      /violates foreign key constraint/,
    )
  })

  it('lets members read their own company\'s cases only, and write nothing', async () => {
    const a = await activeCompany()
    const b = await activeCompany()
    const caseA = await insertCase({ companyId: a.companyId, invoiceId: await insertInvoice(a), connectionId: a.connectionId })
    await insertEvent(a.companyId, caseA)
    const caseB = await insertCase({ companyId: b.companyId, invoiceId: await insertInvoice(b), connectionId: b.connectionId })
    await insertEvent(b.companyId, caseB)

    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: member, role: 'member' })
    await withUserContext(member, async (client) => {
      const cases = await client.query<{ id: string }>(`SELECT id FROM public.collection_cases`)
      expect(cases.rows.map((r) => r.id)).toEqual([caseA])
      const trail = await client.query(`SELECT 1 FROM public.collection_case_events`)
      expect(trail.rowCount).toBe(1)
      await expect(
        client.query(`UPDATE public.collection_cases SET stage = 'reminder' WHERE id = $1`, [caseA]),
      ).rejects.toThrow(/permission denied/)
    })
    await withUserContext(member, async (client) => {
      await expect(insertEvent(a.companyId, caseA, null, client)).rejects.toThrow(/permission denied/)
    })
  })

  it('grants: authenticated reads, service_role writes, anon nothing; the functions are not anon\'s', async () => {
    const { rows } = await getPool().query<{ grantee: string; table_name: string; privilege_type: string }>(
      `SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND table_name IN ('collection_cases', 'collection_case_events')
          AND grantee IN ('anon', 'authenticated', 'service_role')`,
    )
    const of = (table: string, grantee: string) =>
      rows
        .filter((r) => r.table_name === table && r.grantee === grantee)
        .map((r) => r.privilege_type)
        .sort()
    for (const table of ['collection_cases', 'collection_case_events']) {
      expect(of(table, 'authenticated')).toEqual(['SELECT'])
      expect(of(table, 'service_role')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
      expect(of(table, 'anon')).toEqual([])
    }
    for (const fn of ['collection_open_invoice_ids(uuid)', 'collection_attention_case_ids(uuid)', 'collection_obligation_counts(uuid)']) {
      const priv = await getPool().query<{ authenticated: boolean; anon: boolean }>(
        `SELECT has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
                has_function_privilege('anon', $1, 'EXECUTE') AS anon`,
        [`public.${fn}`],
      )
      expect(priv.rows[0], fn).toEqual({ authenticated: true, anon: false })
    }
  })

  it('collection_open_invoice_ids lists the open cases a member may see, "Hos inkasso" past delivery, a registered claim included', async () => {
    const co = await activeCompany()
    const registeredClaim = await insertInvoice(co)
    const reminded = await insertInvoice(co)
    const preparing = await insertInvoice(co)
    const closed = await insertInvoice(co)
    await insertCase({ companyId: co.companyId, invoiceId: registeredClaim, connectionId: co.connectionId, stage: 'registered' })
    await insertCase({ companyId: co.companyId, invoiceId: reminded, connectionId: co.connectionId, stage: 'reminder' })
    await insertCase({ companyId: co.companyId, invoiceId: preparing, connectionId: co.connectionId, status: 'preparing' })
    await insertCase({ companyId: co.companyId, invoiceId: closed, connectionId: co.connectionId, status: 'failed' })
    const other = await activeCompany()
    await insertCase({ companyId: other.companyId, invoiceId: await insertInvoice(other), connectionId: other.connectionId })

    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: co.companyId, userId: member, role: 'viewer' })
    await withUserContext(member, async (client) => {
      const { rows } = await client.query<{ invoice_id: string; stage: string; in_collection: boolean; display_name: string }>(
        `SELECT invoice_id, stage, in_collection, display_name FROM public.collection_open_invoice_ids($1)`,
        [co.companyId],
      )
      const byInvoice = new Map(rows.map((r) => [r.invoice_id, r]))
      expect(rows).toHaveLength(2)
      // A registered claim was handed over for collection: "Hos inkasso".
      expect(byInvoice.get(registeredClaim)).toMatchObject({ stage: 'registered', in_collection: true, display_name: 'Acme Inkasso' })
      expect(byInvoice.get(reminded)).toMatchObject({ stage: 'reminder', in_collection: true })
      // RLS: another company's id answers nothing.
      const foreign = await client.query(`SELECT 1 FROM public.collection_open_invoice_ids($1)`, [other.companyId])
      expect(foreign.rowCount).toBe(0)
    })
  })

  it('collection_attention_case_ids: a refused handover until a new one or the invoice is settled; an open case with a sync error', async () => {
    const co = await activeCompany()
    const refusedInvoice = await insertInvoice(co)
    const failed = await insertCase({ companyId: co.companyId, invoiceId: refusedInvoice, connectionId: co.connectionId, status: 'failed' })
    const syncInvoice = await insertInvoice(co)
    const syncCase = await insertCase({ companyId: co.companyId, invoiceId: syncInvoice, connectionId: co.connectionId })
    await getPool().query(`UPDATE public.collection_cases SET sync_error = 'CONNECTOR_UNREACHABLE' WHERE id = $1`, [syncCase])

    const attention = async () =>
      (
        await getPool().query<{ case_id: string; reason: string }>(
          `SELECT case_id, reason FROM public.collection_attention_case_ids($1) ORDER BY reason`,
          [co.companyId],
        )
      ).rows
    expect(await attention()).toEqual([
      { case_id: failed, reason: 'submission_failed' },
      { case_id: syncCase, reason: 'sync_error' },
    ])

    // A new handover of the refused invoice clears it; so does a good read.
    await insertCase({ companyId: co.companyId, invoiceId: refusedInvoice, connectionId: co.connectionId, status: 'submitted' })
    await getPool().query(`UPDATE public.collection_cases SET sync_error = NULL WHERE id = $1`, [syncCase])
    expect(await attention()).toEqual([])

    // A refused handover of an invoice that was paid meanwhile asks nothing.
    const paidInvoice = await insertInvoice(co)
    await insertCase({ companyId: co.companyId, invoiceId: paidInvoice, connectionId: co.connectionId, status: 'failed' })
    expect(await attention()).toHaveLength(1)
    await getPool().query(
      `UPDATE public.invoices SET status = 'paid', paid_amount = total, remaining_amount = 0, paid_at = now() WHERE id = $1`,
      [paidInvoice],
    )
    expect(await attention()).toEqual([])
  })

  it('counts submitted and registered cases as obligations, so the connection cannot end under them', async () => {
    const co = await activeCompany()
    const counts = async () =>
      (
        await getPool().query<{ open_cases: number }>(`SELECT open_cases FROM public.collection_obligation_counts($1)`, [
          co.companyId,
        ])
      ).rows[0]!.open_cases
    const preparingCase = await insertCase({
      companyId: co.companyId,
      invoiceId: await insertInvoice(co),
      connectionId: co.connectionId,
      status: 'preparing',
    })
    expect(await counts()).toBe(0)

    await getPool().query(`UPDATE public.collection_cases SET submission_status = 'submitted' WHERE id = $1`, [preparingCase])
    expect(await counts()).toBe(1)
    await expect(
      getPool().query(
        `UPDATE public.collection_connections SET state = 'disconnected', ended_at = now(), ended_by = $2 WHERE id = $1`,
        [co.connectionId, co.userId],
      ),
    ).rejects.toThrow(/COLLECTIONS_DISCONNECT_BLOCKED: 1 open cases/)

    await getPool().query(
      `UPDATE public.collection_cases SET submission_status = 'registered', provider_case_ref = 'r-1', stage = 'closed_other',
              is_open = false, closed_at = now(), close_reason = 'withdrawn'
        WHERE id = $1`,
      [preparingCase],
    )
    expect(await counts()).toBe(0)
    await getPool().query(
      `UPDATE public.collection_connections SET state = 'disconnected', ended_at = now(), ended_by = $2 WHERE id = $1`,
      [co.connectionId, co.userId],
    )
  })

  it('refuses to cancel an invoice while it has an open case', async () => {
    const co = await activeCompany()
    const invoiceId = await insertInvoice(co)
    const caseId = await insertCase({ companyId: co.companyId, invoiceId, connectionId: co.connectionId })
    await expect(
      getPool().query(`UPDATE public.invoices SET status = 'cancelled' WHERE id = $1`, [invoiceId]),
    ).rejects.toThrow(/COLLECTION_CASE_OPEN/)

    await getPool().query(
      `UPDATE public.collection_cases SET stage = 'closed_other', is_open = false, closed_at = now(), close_reason = 'withdrawn' WHERE id = $1`,
      [caseId],
    )
    // Past the case, the guard is out of the way (whatever else invoices allow).
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM public.collection_cases WHERE invoice_id = $1 AND is_open`,
      [invoiceId],
    )
    expect(Number(rows[0]!.n)).toBe(0)
  })

  it('tears down with a sandbox company and leaves a real one next to it alone', async () => {
    const sandbox = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, is_sandbox) VALUES ($1, $2, true)`,
      [sandbox.userId, sandbox.companyId],
    )
    const sandboxConnection = await insertConnection(sandbox, 'active', 'fake')
    const sandboxCase = await insertCase({
      companyId: sandbox.companyId,
      invoiceId: await insertInvoice(sandbox),
      connectionId: sandboxConnection,
    })
    await insertEvent(sandbox.companyId, sandboxCase, 'fake:1')
    await insertEvent(sandbox.companyId, sandboxCase, null)
    const op = await getPool().query<{ id: string }>(
      `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title)
       VALUES ($1, $2, 'collection_case_action', 'Pausa ärendet') RETURNING id`,
      [sandbox.userId, sandbox.companyId],
    )
    await getPool().query(`UPDATE public.collection_cases SET pending_operation_id = $2 WHERE id = $1`, [
      sandboxCase,
      op.rows[0]!.id,
    ])

    const real = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, is_sandbox) VALUES ($1, $2, false)`,
      [real.userId, real.companyId],
    )
    const realConnection = await insertConnection(real)
    const realCase = await insertCase({ companyId: real.companyId, invoiceId: await insertInvoice(real), connectionId: realConnection })
    await insertEvent(real.companyId, realCase)

    await getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [sandbox.userId])

    const left = await getPool().query<{ n: string }>(
      `SELECT (SELECT count(*) FROM public.collection_cases WHERE company_id = $1)
            + (SELECT count(*) FROM public.collection_case_events WHERE company_id = $1)
            + (SELECT count(*) FROM public.collection_connections WHERE company_id = $1) AS n`,
      [sandbox.companyId],
    )
    expect(Number(left.rows[0]!.n)).toBe(0)
    const kept = await getPool().query(`SELECT 1 FROM public.collection_case_events WHERE case_id = $1`, [realCase])
    expect(kept.rowCount).toBe(1)
  })
})
