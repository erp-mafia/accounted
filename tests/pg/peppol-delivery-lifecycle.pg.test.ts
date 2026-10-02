import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

const XML = '<Invoice><cbc:ID>F-2026-42</cbc:ID></Invoice>'
const XML_SHA = createHash('sha256').update(XML).digest('hex')

async function insertInvoice(userId: string, companyId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, invoice_number, invoice_date, due_date,
        status, currency, total)
     VALUES ($1, $2, $3, 'F-2026-42', '2026-08-13', '2026-09-12',
             'sent', 'SEK', 125)`,
    [id, userId, companyId],
  )
  return id
}

const STAGE_SQL = `
  SELECT (public.stage_peppol_delivery(
    $1, $2, '0007', '5566778899',
    'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0',
    'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0',
    'peppol-invoice-F-2026-42.xml', $3, $4
  )).*`

async function seedStagedDelivery(): Promise<{
  companyId: string
  userId: string
  invoiceId: string
  deliveryId: string
  idempotencyKey: string
}> {
  const seeded = await seedCompany()
  const invoiceId = await insertInvoice(seeded.userId, seeded.companyId)
  const deliveryId = randomUUID()
  const idempotencyKey = randomUUID()
  await getPool().query(
    `INSERT INTO public.peppol_deliveries (
       id, company_id, user_id, invoice_id, idempotency_key,
       recipient_scheme, recipient_identifier, customization_id, profile_id,
       filename, xml_payload, xml_sha256, retention_expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, '0007', '5566778899',
       'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0',
       'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0',
       'peppol-invoice-F-2026-42.xml', $6, $7, '2034-01-01'
     )`,
    [
      deliveryId,
      seeded.companyId,
      seeded.userId,
      invoiceId,
      idempotencyKey,
      XML,
      XML_SHA,
    ],
  )
  return { ...seeded, invoiceId, deliveryId, idempotencyKey }
}

describe('stage_peppol_delivery', () => {
  it('stores one immutable exact-document snapshot and is idempotent for the same XML', async () => {
    const seeded = await seedCompany()
    const invoiceId = await insertInvoice(seeded.userId, seeded.companyId)

    await withUserContext(seeded.userId, async (client) => {
      const first = await client.query(STAGE_SQL, [seeded.companyId, invoiceId, XML, XML_SHA])
      const second = await client.query(STAGE_SQL, [seeded.companyId, invoiceId, XML, XML_SHA])

      expect(second.rows[0].id).toBe(first.rows[0].id)
      expect(first.rows[0]).toMatchObject({
        company_id: seeded.companyId,
        invoice_id: invoiceId,
        recipient_scheme: '0007',
        recipient_identifier: '5566778899',
        xml_payload: XML,
        xml_sha256: XML_SHA,
        status: 'staged',
      })
      expect(first.rows[0].idempotency_key).toMatch(/^[0-9a-f-]{36}$/)
      expect(first.rows[0].retention_expires_at.toISOString().slice(0, 10)).toBe('2034-01-01')

      await expect(client.query(
        `SELECT raw_payload FROM public.peppol_delivery_events WHERE delivery_id = $1`,
        [first.rows[0].id],
      )).rejects.toThrow(/permission denied/)
    })
  })

  it('rejects viewers and cross-company invoices', async () => {
    const seeded = await seedCompany()
    const other = await seedCompany()
    const invoiceId = await insertInvoice(seeded.userId, seeded.companyId)
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId: seeded.companyId, userId: viewerId, role: 'viewer' })

    await expect(withUserContext(viewerId, (client) =>
      client.query(STAGE_SQL, [seeded.companyId, invoiceId, XML, XML_SHA]),
    )).rejects.toThrow(/not authorized/)

    await expect(withUserContext(other.userId, (client) =>
      client.query(STAGE_SQL, [seeded.companyId, invoiceId, XML, XML_SHA]),
    )).rejects.toThrow(/not authorized/)
  })

  it('rejects a caller-supplied SHA-256 that does not match the XML', async () => {
    const seeded = await seedCompany()
    const invoiceId = await insertInvoice(seeded.userId, seeded.companyId)

    await expect(withUserContext(seeded.userId, (client) =>
      client.query(STAGE_SQL, [seeded.companyId, invoiceId, XML, 'b'.repeat(64)]),
    )).rejects.toThrow(/does not match the staged payload/)
  })

  it('refuses to guess a retention date when the invoice has no fiscal period', async () => {
    const seeded = await seedCompany()
    await getPool().query('DELETE FROM public.fiscal_periods WHERE id = $1', [
      seeded.fiscalPeriodId,
    ])
    const invoiceId = await insertInvoice(seeded.userId, seeded.companyId)

    await expect(withUserContext(seeded.userId, (client) =>
      client.query(STAGE_SQL, [seeded.companyId, invoiceId, XML, XML_SHA]),
    )).rejects.toThrow(/requires a fiscal period retention basis/)
  })
})

describe('Peppol delivery audit lifecycle', () => {
  it('keeps events append-only and does not let late events regress a terminal projection', async () => {
    const seeded = await seedStagedDelivery()
    const eventSql = `SELECT (public.record_peppol_delivery_event(
      $1, $2, 'storecove', 'tenant-42', $3, $4, $5, $6, $7, $8,
      $9::jsonb, $10, 'hmac-sha256', $11::timestamptz
    )).*`

    await runAsServiceRole(async (client) => {
      await client.query(eventSql, [
        seeded.companyId, seeded.idempotencyKey, 'submission-guid', 'event-1',
        'succeeded', 'transport_succeeded', false, 'Delivered to Corner 3',
        JSON.stringify({ event: 'succeeded' }), '1'.repeat(64), '2026-08-13T16:01:00Z',
      ])
      await client.query(eventSql, [
        seeded.companyId, seeded.idempotencyKey, 'submission-guid', 'event-2',
        'temporary_error', 'retryable_failure', false, 'Late retry notice',
        JSON.stringify({ event: 'temporary_error' }), '2'.repeat(64), '2026-08-13T16:00:00Z',
      ])
      await client.query(eventSql, [
        seeded.companyId, seeded.idempotencyKey, 'submission-guid', 'event-3',
        'accepted', 'business_accepted', true, 'Buyer accepted',
        JSON.stringify({ event: 'accepted' }), '3'.repeat(64), '2026-08-13T16:02:00Z',
      ])
      await client.query(eventSql, [
        seeded.companyId, seeded.idempotencyKey, 'submission-guid', 'event-4',
        'failed', 'failed', true, 'Late contradictory event',
        JSON.stringify({ event: 'failed' }), '4'.repeat(64), '2026-08-13T16:03:00Z',
      ])
      // Provider retry of event-3: same fingerprint and event id is a no-op.
      await client.query(eventSql, [
        seeded.companyId, seeded.idempotencyKey, 'submission-guid', 'event-3',
        'accepted', 'business_accepted', true, 'Buyer accepted',
        JSON.stringify({ event: 'accepted' }), '3'.repeat(64), '2026-08-13T16:02:00Z',
      ])
    })

    const delivery = await getPool().query(
      `SELECT provider, provider_tenant_id, provider_submission_id, status,
              terminal_at, status_detail
       FROM public.peppol_deliveries WHERE id = $1`,
      [seeded.deliveryId],
    )
    expect(delivery.rows[0]).toMatchObject({
      provider: 'storecove',
      provider_tenant_id: 'tenant-42',
      provider_submission_id: 'submission-guid',
      status: 'business_accepted',
      status_detail: 'Buyer accepted',
    })
    expect(delivery.rows[0].terminal_at).not.toBeNull()

    const events = await getPool().query(
      `SELECT provider_event_id FROM public.peppol_delivery_events
       WHERE delivery_id = $1 ORDER BY occurred_at`,
      [seeded.deliveryId],
    )
    expect(events.rows.map((row) => row.provider_event_id)).toEqual([
      'event-2', 'event-1', 'event-3', 'event-4',
    ])

    await expect(getPool().query(
      `UPDATE public.peppol_delivery_events SET detail = 'changed' WHERE delivery_id = $1`,
      [seeded.deliveryId],
    )).rejects.toThrow(/append-only/)
    await expect(getPool().query(
      `DELETE FROM public.peppol_deliveries WHERE id = $1`,
      [seeded.deliveryId],
    )).rejects.toThrow(/cannot be deleted/)
  })

  it('stores provider evidence idempotently and keeps its exact document immutable', async () => {
    const seeded = await seedStagedDelivery()
    await runAsServiceRole(async (client) => {
      await client.query(
        `SELECT public.record_peppol_delivery_event(
          $1, $2, 'storecove', 'tenant-42', $3, $4,
          'submission_accepted', 'submission_accepted', false, NULL,
          '{"event":"submission_accepted"}'::jsonb, $5, 'hmac-sha256', now()
        )`,
        [
          seeded.companyId,
          seeded.idempotencyKey,
          randomUUID(),
          randomUUID(),
          '5'.repeat(64),
        ],
      )
      const evidenceSql = `SELECT public.record_peppol_delivery_evidence(
        $1, $2, 'storecove', 'access_point_evidence', '{"receipt":"ok"}'::jsonb,
        $3, $4, $5, '2026-08-13T16:05:00Z'
      ) AS id`
      const first = await client.query(evidenceSql, [
        seeded.companyId, seeded.idempotencyKey, XML, XML_SHA, '6'.repeat(64),
      ])
      const second = await client.query(evidenceSql, [
        seeded.companyId, seeded.idempotencyKey, XML, XML_SHA, '6'.repeat(64),
      ])
      expect(second.rows[0].id).toBe(first.rows[0].id)
    })

    const evidence = await getPool().query(
      `SELECT document_payload, document_sha256
       FROM public.peppol_delivery_evidence WHERE delivery_id = $1`,
      [seeded.deliveryId],
    )
    expect(evidence.rows).toEqual([{ document_payload: XML, document_sha256: XML_SHA }])

    await expect(getPool().query(
      `UPDATE public.peppol_delivery_evidence SET document_payload = 'changed'
       WHERE delivery_id = $1`,
      [seeded.deliveryId],
    )).rejects.toThrow(/append-only/)
  })

  it('rejects provider evidence whose exact-document hash is inconsistent', async () => {
    const seeded = await seedStagedDelivery()
    await runAsServiceRole(async (client) => {
      await client.query(
        `SELECT public.record_peppol_delivery_event(
          $1, $2, 'storecove', 'tenant-42', $3, $4,
          'submission_accepted', 'submission_accepted', false, NULL,
          '{"event":"submission_accepted"}'::jsonb, $5, 'hmac-sha256', now()
        )`,
        [
          seeded.companyId,
          seeded.idempotencyKey,
          randomUUID(),
          randomUUID(),
          '7'.repeat(64),
        ],
      )

      await expect(client.query(
        `SELECT public.record_peppol_delivery_evidence(
          $1, $2, 'storecove', 'access_point_evidence', '{}'::jsonb,
          $3, $4, $5, now()
        )`,
        [seeded.companyId, seeded.idempotencyKey, XML, 'b'.repeat(64), '8'.repeat(64)],
      )).rejects.toThrow(/does not match the payload/)
    })
  })
})

/**
 * Connector mode: every lifecycle event of a delivery made through Accounted
 * Connect carries the connector transport's label, provider 'connector' and
 * tenant 'connector'. The send writes both on the row with its first event;
 * the status polls through the connector carry the same label because the
 * transport relabels what the service returns (transports/connector.ts).
 */
describe('Peppol delivery lifecycle in connector mode', () => {
  const CONNECTOR_EVENT_SQL = `SELECT (public.record_peppol_delivery_event(
    $1, $2, 'connector', $3, $4, $5, $6, $7, $8, $9,
    $10::jsonb, $11, $12, $13::timestamptz
  )).*`

  interface ConnectorEvent {
    tenant: string
    submissionId: string | null
    eventId: string | null
    code: string
    status: string
    terminal?: boolean
    detail?: string | null
    method: string
    occurredAt: string
  }

  function recordEvent(
    client: PoolClient,
    seeded: { companyId: string; idempotencyKey: string },
    event: ConnectorEvent,
  ) {
    return client.query(CONNECTOR_EVENT_SQL, [
      seeded.companyId,
      seeded.idempotencyKey,
      event.tenant,
      event.submissionId,
      event.eventId,
      event.code,
      event.status,
      event.terminal ?? false,
      event.detail ?? null,
      JSON.stringify({ source: event.method, code: event.code }),
      createHash('sha256').update(`${seeded.idempotencyKey}|${event.code}|${event.status}|${event.occurredAt}`).digest('hex'),
      event.method,
      event.occurredAt,
    ])
  }

  /** The three events the send records, all with the connector's own label. */
  async function sendThroughConnector(
    client: PoolClient,
    seeded: { companyId: string; idempotencyKey: string },
    submissionId: string,
  ) {
    const send = { tenant: 'connector', eventId: null, method: 'accounted_route' }
    await recordEvent(client, seeded, {
      ...send, submissionId: null, code: 'recipient_lookup', status: 'recipient_verified',
      detail: '0007:5566778899', occurredAt: '2026-09-29T10:00:01Z',
    })
    await recordEvent(client, seeded, {
      ...send, submissionId: null, code: 'submit_attempt', status: 'submitting', occurredAt: '2026-09-29T10:00:02Z',
    })
    await recordEvent(client, seeded, {
      ...send, submissionId, code: 'submit_accepted', status: 'submission_accepted', occurredAt: '2026-09-29T10:00:03Z',
    })
  }

  async function deliveryRow(deliveryId: string) {
    const { rows } = await getPool().query(
      `SELECT provider, provider_tenant_id, provider_submission_id, status, status_detail,
              submitted_at, terminal_at
       FROM public.peppol_deliveries WHERE id = $1`,
      [deliveryId],
    )
    return rows[0]
  }

  it('takes a delivery from staged to transport_succeeded when every event carries the connector label', async () => {
    const seeded = await seedStagedDelivery()
    const submissionId = randomUUID()

    await runAsServiceRole(async (client) => {
      await sendThroughConnector(client, seeded, submissionId)
      await recordEvent(client, seeded, {
        tenant: 'connector',
        submissionId,
        eventId: `document_delivery:${submissionId}:processed`,
        code: 'status_poll',
        status: 'transport_succeeded',
        detail: 'processed',
        method: 'provider_poll',
        occurredAt: '2026-09-29T10:05:00Z',
      })
    })

    const delivery = await deliveryRow(seeded.deliveryId)
    expect(delivery).toMatchObject({
      provider: 'connector',
      provider_tenant_id: 'connector',
      provider_submission_id: submissionId,
      status: 'transport_succeeded',
      status_detail: 'processed',
      terminal_at: null,
    })
    expect(delivery.submitted_at).not.toBeNull()

    const events = await getPool().query(
      `SELECT normalized_status FROM public.peppol_delivery_events
       WHERE delivery_id = $1 ORDER BY occurred_at`,
      [seeded.deliveryId],
    )
    expect(events.rows.map((row) => row.normalized_status)).toEqual([
      'recipient_verified', 'submitting', 'submission_accepted', 'transport_succeeded',
    ])
  })

  it('ends a connector delivery on a terminal failure after the access point accepted it', async () => {
    const seeded = await seedStagedDelivery()
    const submissionId = randomUUID()

    await runAsServiceRole(async (client) => {
      await sendThroughConnector(client, seeded, submissionId)
      await recordEvent(client, seeded, {
        tenant: 'connector',
        submissionId,
        eventId: `document_error:${submissionId}:error`,
        code: 'status_poll',
        status: 'failed',
        terminal: true,
        detail: 'error: receiver not registered',
        method: 'provider_poll',
        occurredAt: '2026-09-29T10:06:00Z',
      })
    })

    const delivery = await deliveryRow(seeded.deliveryId)
    expect(delivery).toMatchObject({
      provider: 'connector',
      provider_tenant_id: 'connector',
      status: 'failed',
      status_detail: 'error: receiver not registered',
    })
    expect(delivery.terminal_at?.toISOString()).toBe('2026-09-29T10:06:00.000Z')
  })

  // The tenant correlation guard: a row keeps the tenant its first event
  // wrote, and an event naming any other tenant is refused whole. This is
  // what dropped every status poll through the connector while the service's
  // events carried the access point's own account number.
  it('refuses an event carrying the access point account number on a connector row', async () => {
    const seeded = await seedStagedDelivery()
    const submissionId = randomUUID()
    await runAsServiceRole((client) => sendThroughConnector(client, seeded, submissionId))

    await expect(runAsServiceRole((client) => recordEvent(client, seeded, {
      tenant: 'SE5595386219',
      submissionId,
      eventId: `document_delivery:${submissionId}:processed`,
      code: 'status_poll',
      status: 'transport_succeeded',
      method: 'provider_poll',
      occurredAt: '2026-09-29T10:05:00Z',
    }))).rejects.toThrow(/Peppol provider tenant correlation mismatch/)

    expect(await deliveryRow(seeded.deliveryId)).toMatchObject({
      provider_tenant_id: 'connector',
      status: 'submission_accepted',
    })
    const events = await getPool().query(
      `SELECT count(*)::int AS n FROM public.peppol_delivery_events WHERE delivery_id = $1`,
      [seeded.deliveryId],
    )
    expect(events.rows[0].n).toBe(3)
  })

  it('lets a resend move a retryable failure back to submitting', async () => {
    const seeded = await seedStagedDelivery()
    const send = { tenant: 'connector', submissionId: null, eventId: null, method: 'accounted_route' }

    await runAsServiceRole(async (client) => {
      await recordEvent(client, seeded, {
        ...send, code: 'recipient_lookup', status: 'recipient_verified', occurredAt: '2026-09-29T10:00:01Z',
      })
      await recordEvent(client, seeded, {
        ...send, code: 'submit_attempt', status: 'submitting', occurredAt: '2026-09-29T10:00:02Z',
      })
      await recordEvent(client, seeded, {
        ...send, code: 'submit_failed', status: 'retryable_failure',
        detail: 'Connector: could not reach the hosted service', occurredAt: '2026-09-29T10:00:52Z',
      })
    })
    expect(await deliveryRow(seeded.deliveryId)).toMatchObject({ status: 'retryable_failure', terminal_at: null })

    await runAsServiceRole((client) => recordEvent(client, seeded, {
      ...send, code: 'submit_attempt', status: 'submitting', occurredAt: '2026-09-29T10:10:00Z',
    }))
    expect(await deliveryRow(seeded.deliveryId)).toMatchObject({
      provider_tenant_id: 'connector',
      status: 'submitting',
      status_detail: null,
      terminal_at: null,
    })
  })
})

describe('Peppol delivery RPC privileges', () => {
  it('keeps raw tables closed and provider writes service-role only', async () => {
    const privileges = await getPool().query<{
      authenticated_table_select: boolean
      anon_table_select: boolean
      authenticated_event_exec: boolean
      service_event_exec: boolean
    }>(`
      SELECT
        has_table_privilege('authenticated', 'public.peppol_deliveries', 'SELECT')
          AS authenticated_table_select,
        has_table_privilege('anon', 'public.peppol_deliveries', 'SELECT')
          AS anon_table_select,
        has_function_privilege(
          'authenticated',
          'public.record_peppol_delivery_event(uuid,uuid,text,text,text,text,text,text,boolean,text,jsonb,text,text,timestamptz)',
          'EXECUTE'
        ) AS authenticated_event_exec,
        has_function_privilege(
          'service_role',
          'public.record_peppol_delivery_event(uuid,uuid,text,text,text,text,text,text,boolean,text,jsonb,text,text,timestamptz)',
          'EXECUTE'
        ) AS service_event_exec
    `)
    expect(privileges.rows[0]).toEqual({
      authenticated_table_select: false,
      anon_table_select: false,
      authenticated_event_exec: false,
      service_event_exec: true,
    })
  })
})
