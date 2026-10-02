import { createHash, randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { getClient, getPool, runAsServiceRole, withUserContext } from './setup'

/**
 * pg-real coverage for migration 20260929200000_peppol_alerts.
 *
 * peppol_alerts is the claim ledger of the Peppol health check
 * (lib/invoices/peppol-health.ts): one row per problem already reported.
 * Locks in:
 *   - service role only: RLS on, no policies, no privileges for anon or
 *     authenticated, so a member can neither read nor write a claim;
 *   - the claim the check relies on: INSERT ... ON CONFLICT (kind, ref_id)
 *     DO NOTHING RETURNING returns the row once and nothing the second time,
 *     and a released (deleted) claim can be claimed again;
 *   - the shape: known kinds only, and a company on every delivery claim (an
 *     inbound document that reached no company is the one claim without one);
 *   - the company foreign key cascades, like every tenant table.
 *
 * And peppol_failed_invoice_ids(), the one definition behind the Att göra
 * row and the invoice list chip: a member gets their company's ids and a
 * non-member (or a caller without auth.uid()) nothing, the newest delivery
 * decides, only sent or overdue invoices count, the cap holds, and anon
 * cannot execute it.
 */

const CLAIM_SQL = `
  INSERT INTO public.peppol_alerts (kind, ref_id, company_id)
  VALUES ($1, $2, $3)
  ON CONFLICT (kind, ref_id) DO NOTHING
  RETURNING kind, ref_id::text AS ref_id`

describe('peppol_alerts (migration 20260929200000)', () => {
  it('has RLS enabled, no policies, and no privileges for anon or authenticated', async () => {
    const rls = await getPool().query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.peppol_alerts'::regclass`,
    )
    expect(rls.rows[0]?.relrowsecurity).toBe(true)

    const policies = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'peppol_alerts'`,
    )
    expect(policies.rows[0]?.n).toBe('0')

    const grants = await getPool().query<{ role: string; can_select: boolean; can_insert: boolean; can_delete: boolean }>(
      `SELECT r.role,
              has_table_privilege(r.role, 'public.peppol_alerts', 'SELECT') AS can_select,
              has_table_privilege(r.role, 'public.peppol_alerts', 'INSERT') AS can_insert,
              has_table_privilege(r.role, 'public.peppol_alerts', 'DELETE') AS can_delete
       FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)
       ORDER BY r.role`,
    )
    expect(grants.rows).toEqual([
      { role: 'anon', can_select: false, can_insert: false, can_delete: false },
      { role: 'authenticated', can_select: false, can_insert: false, can_delete: false },
      { role: 'service_role', can_select: true, can_insert: true, can_delete: true },
    ])
  })

  it('lets a company member neither read nor write a claim, not even for their own company', async () => {
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.peppol_alerts (kind, ref_id, company_id) VALUES ('delivery_failed', $1, $2)`,
      [randomUUID(), companyId],
    )

    await expect(
      withUserContext(userId, (client) => client.query(`SELECT * FROM public.peppol_alerts WHERE company_id = $1`, [companyId])),
    ).rejects.toThrow(/permission denied/)
    await expect(
      withUserContext(userId, (client) => client.query(CLAIM_SQL, ['delivery_failed', randomUUID(), companyId])),
    ).rejects.toThrow(/permission denied/)
    await expect(
      withUserContext(userId, (client) => client.query(`DELETE FROM public.peppol_alerts WHERE company_id = $1`, [companyId])),
    ).rejects.toThrow(/permission denied/)
  })

  it('claims once: the service role inserts, a second claim for the same problem returns nothing, a released claim can be claimed again', async () => {
    const { companyId } = await seedCompany()
    const deliveryId = randomUUID()

    const first = await runAsServiceRole((client) => client.query(CLAIM_SQL, ['delivery_failed', deliveryId, companyId]))
    expect(first.rows).toEqual([{ kind: 'delivery_failed', ref_id: deliveryId }])

    // An overlapping run sees the same problem: nothing comes back, nothing is mailed.
    const second = await runAsServiceRole((client) => client.query(CLAIM_SQL, ['delivery_failed', deliveryId, companyId]))
    expect(second.rows).toEqual([])

    // The same id under another kind is another problem.
    const otherKind = await runAsServiceRole((client) => client.query(CLAIM_SQL, ['delivery_stuck', deliveryId, companyId]))
    expect(otherKind.rows).toHaveLength(1)

    // A failed mail releases its claim; the next run claims it again.
    await runAsServiceRole((client) =>
      client.query(`DELETE FROM public.peppol_alerts WHERE kind = 'delivery_failed' AND ref_id = $1`, [deliveryId]),
    )
    const again = await runAsServiceRole((client) => client.query(CLAIM_SQL, ['delivery_failed', deliveryId, companyId]))
    expect(again.rows).toHaveLength(1)
  })

  it('claims several problems in one statement and returns only the new ones', async () => {
    const { companyId } = await seedCompany()
    const known = randomUUID()
    const fresh = randomUUID()
    await runAsServiceRole((client) => client.query(CLAIM_SQL, ['delivery_stuck', known, companyId]))

    const { rows } = await runAsServiceRole((client) =>
      client.query<{ ref_id: string }>(
        `INSERT INTO public.peppol_alerts (kind, ref_id, company_id)
         VALUES ('delivery_stuck', $1, $3), ('delivery_stuck', $2, $3)
         ON CONFLICT (kind, ref_id) DO NOTHING
         RETURNING ref_id::text AS ref_id`,
        [known, fresh, companyId],
      ),
    )
    expect(rows).toEqual([{ ref_id: fresh }])
  })

  it('knows four kinds and requires a company on every claim but an inbound document that reached none', async () => {
    const { companyId } = await seedCompany()

    await expect(
      getPool().query(`INSERT INTO public.peppol_alerts (kind, ref_id, company_id) VALUES ('delivery_lost', $1, $2)`, [randomUUID(), companyId]),
    ).rejects.toThrow(/peppol_alerts_kind_check/)

    for (const kind of ['delivery_failed', 'delivery_stuck', 'delivery_retry_stuck']) {
      await expect(
        getPool().query(`INSERT INTO public.peppol_alerts (kind, ref_id, company_id) VALUES ($1, $2, NULL)`, [kind, randomUUID()]),
      ).rejects.toThrow(/peppol_alerts_company_shape/)
    }

    const unrouted = await runAsServiceRole((client) => client.query(CLAIM_SQL, ['inbound_unrouted', randomUUID(), null]))
    expect(unrouted.rows).toHaveLength(1)
  })

  it('cascades from companies and indexes company_id', async () => {
    const { rows } = await getPool().query<{ column: string; foreign_table: string; on_delete: string }>(
      `SELECT a.attname AS column, c.confrelid::regclass::text AS foreign_table, c.confdeltype AS on_delete
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.conrelid = 'public.peppol_alerts'::regclass AND c.contype = 'f'`,
    )
    // confdeltype 'c' = CASCADE.
    expect(rows).toEqual([{ column: 'company_id', foreign_table: 'companies', on_delete: 'c' }])

    const index = await getPool().query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'peppol_alerts' AND indexname = 'idx_peppol_alerts_company_id'`,
    )
    expect(index.rowCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// peppol_failed_invoice_ids
// ---------------------------------------------------------------------------

const FAILED_IDS_SQL = `SELECT f.id::text AS id FROM public.peppol_failed_invoice_ids($1) AS f(id)`
const FAILED_IDS_LIMIT_SQL = `SELECT f.id::text AS id FROM public.peppol_failed_invoice_ids($1, $2) AS f(id)`

/** The staging RPCs take the retention date from the invoice's fiscal period; a direct insert must match it. */
async function retentionOf(fiscalPeriodId: string): Promise<string> {
  const { rows } = await getPool().query<{ d: string }>(
    `SELECT retention_expires_at::text AS d FROM public.fiscal_periods WHERE id = $1`,
    [fiscalPeriodId],
  )
  return rows[0]!.d
}

async function insertInvoice(userId: string, companyId: string, status: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, invoice_number, invoice_date, due_date, status, currency, total)
     VALUES ($1, $2, $3, $4, '2026-08-13', '2026-09-12', $5, 'SEK', 125)`,
    [id, userId, companyId, `F-${id.slice(0, 8)}`, status],
  )
  return id
}

async function insertDelivery(args: {
  companyId: string
  userId: string
  invoiceId: string
  retention: string
  status: string
  createdAt: string
}): Promise<void> {
  // A resend stages a new row only for new content: every row here has its own XML.
  const xml = `<Invoice><cbc:ID>${randomUUID()}</cbc:ID></Invoice>`
  const terminal = ['failed', 'no_route'].includes(args.status)
  await getPool().query(
    `INSERT INTO public.peppol_deliveries (
       company_id, user_id, invoice_id, recipient_scheme, recipient_identifier,
       customization_id, profile_id, filename, xml_payload, xml_sha256,
       retention_expires_at, status, status_at, terminal_at, created_at
     ) VALUES ($1, $2, $3, '0007', '5566778899', 'urn:test:customization', 'urn:test:profile',
               'invoice.xml', $4, $5, $6, $7, $8, $9, $8)`,
    [
      args.companyId, args.userId, args.invoiceId, xml, createHash('sha256').update(xml).digest('hex'),
      args.retention, args.status, args.createdAt, terminal ? args.createdAt : null,
    ],
  )
}

async function seedFailedDeliveries() {
  const own = await seedCompany()
  const retention = await retentionOf(own.fiscalPeriodId)
  const at = (minute: number) => `2026-09-01T10:0${minute}:00Z`
  const deliver = (invoiceId: string, status: string, minute: number) =>
    insertDelivery({ companyId: own.companyId, userId: own.userId, invoiceId, retention, status, createdAt: at(minute) })

  const failed = await insertInvoice(own.userId, own.companyId, 'sent')
  await deliver(failed, 'failed', 1)
  // A resend that went through hides the earlier failure.
  const resentOk = await insertInvoice(own.userId, own.companyId, 'sent')
  await deliver(resentOk, 'failed', 2)
  await deliver(resentOk, 'transport_succeeded', 3)
  // A delivery that failed after an earlier one went through counts, and no_route is a failure.
  const failedAfterOk = await insertInvoice(own.userId, own.companyId, 'overdue')
  await deliver(failedAfterOk, 'transport_succeeded', 4)
  await deliver(failedAfterOk, 'no_route', 5)
  // Paid and credited invoices have nothing left to deliver.
  const paid = await insertInvoice(own.userId, own.companyId, 'paid')
  await deliver(paid, 'failed', 6)
  const credited = await insertInvoice(own.userId, own.companyId, 'credited')
  await deliver(credited, 'failed', 7)

  return { own, failed, failedAfterOk }
}

describe('peppol_failed_invoice_ids (migration 20260929200000)', () => {
  it("gives a member their company's invoices whose latest delivery failed, sent or overdue, newest failure first", async () => {
    const { own, failed, failedAfterOk } = await seedFailedDeliveries()

    const { rows } = await withUserContext(own.userId, (client) => client.query<{ id: string }>(FAILED_IDS_SQL, [own.companyId]))

    expect(rows.map((row) => row.id)).toEqual([failedAfterOk, failed])
  })

  it('gives a non-member nothing, and a caller without auth.uid() (the service role) nothing either', async () => {
    const { own } = await seedFailedDeliveries()
    const stranger = await seedCompany()

    const asStranger = await withUserContext(stranger.userId, (client) => client.query(FAILED_IDS_SQL, [own.companyId]))
    expect(asStranger.rows).toEqual([])

    const asService = await runAsServiceRole((client) => client.query(FAILED_IDS_SQL, [own.companyId]))
    expect(asService.rows).toEqual([])
  })

  it('applies the cap: at least 1, the newest failures first, at most 500 whatever is asked for', async () => {
    const { own, failedAfterOk } = await seedFailedDeliveries()

    const one = await withUserContext(own.userId, (client) => client.query<{ id: string }>(FAILED_IDS_LIMIT_SQL, [own.companyId, 1]))
    expect(one.rows.map((row) => row.id)).toEqual([failedAfterOk])
    const zero = await withUserContext(own.userId, (client) => client.query(FAILED_IDS_LIMIT_SQL, [own.companyId, 0]))
    expect(zero.rows).toHaveLength(1)

    const bulk = await seedCompany()
    const retention = await retentionOf(bulk.fiscalPeriodId)
    await getPool().query(
      `WITH invoice AS (
         INSERT INTO public.invoices
           (id, user_id, company_id, invoice_number, invoice_date, due_date, status, currency, total)
         SELECT gen_random_uuid(), $1, $2, 'B-' || g, '2026-08-13', '2026-09-12', 'sent', 'SEK', 125
         FROM generate_series(1, 501) AS g
         RETURNING id, invoice_number
       )
       INSERT INTO public.peppol_deliveries (
         company_id, user_id, invoice_id, recipient_scheme, recipient_identifier,
         customization_id, profile_id, filename, xml_payload, xml_sha256,
         retention_expires_at, status, status_at, terminal_at
       )
       SELECT $2, $1, invoice.id, '0007', '5566778899', 'urn:test:customization', 'urn:test:profile',
              'invoice.xml', '<Invoice>' || invoice.invoice_number || '</Invoice>',
              encode(extensions.digest('<Invoice>' || invoice.invoice_number || '</Invoice>', 'sha256'), 'hex'),
              $3::date, 'failed', now(), now()
       FROM invoice`,
      [bulk.userId, bulk.companyId, retention],
    )
    const counted = await withUserContext(bulk.userId, async (client) => {
      const capped = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.peppol_failed_invoice_ids($1, 1000)`,
        [bulk.companyId],
      )
      const byDefault = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.peppol_failed_invoice_ids($1)`,
        [bulk.companyId],
      )
      return { capped: capped.rows[0]!.n, byDefault: byDefault.rows[0]!.n }
    })
    expect(counted).toEqual({ capped: 500, byDefault: 200 })
  })

  it('is executable by authenticated and service_role only; anon is refused', async () => {
    const { rows } = await getPool().query<{ anon_can: boolean; auth_can: boolean; service_can: boolean; definer: boolean }>(
      `SELECT has_function_privilege('anon', 'public.peppol_failed_invoice_ids(uuid,integer)', 'EXECUTE') AS anon_can,
              has_function_privilege('authenticated', 'public.peppol_failed_invoice_ids(uuid,integer)', 'EXECUTE') AS auth_can,
              has_function_privilege('service_role', 'public.peppol_failed_invoice_ids(uuid,integer)', 'EXECUTE') AS service_can,
              (SELECT prosecdef FROM pg_proc WHERE oid = 'public.peppol_failed_invoice_ids(uuid,integer)'::regprocedure) AS definer`,
    )
    expect(rows[0]).toEqual({ anon_can: false, auth_can: true, service_can: true, definer: true })

    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE anon')
      await expect(client.query(FAILED_IDS_SQL, [randomUUID()])).rejects.toThrow(/permission denied/)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})
