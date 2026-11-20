import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { seedCompany } from './fixtures'

/**
 * 20260930100000: one LIVE delivery per exact document. The same XML while
 * its delivery is live answers that delivery; after a failed or no_route
 * delivery it stages a new one (a resend of an issued invoice, whose XML is
 * deterministic); after the buyer's business_rejected it answers the refused
 * delivery, which the send refuses to transmit again.
 */
const XML = '<Invoice><cbc:ID>F-2026-77</cbc:ID></Invoice>'
const XML_SHA = createHash('sha256').update(XML).digest('hex')

async function insertInvoice(userId: string, companyId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, invoice_number, invoice_date, due_date,
        status, currency, total)
     VALUES ($1, $2, $3, 'F-2026-77', '2026-08-13', '2026-09-12',
             'sent', 'SEK', 125)`,
    [id, userId, companyId],
  )
  return id
}

interface StagedRow {
  id: string
  idempotency_key: string
  status: string
  provider_submission_id: string | null
}

const AS_ACTOR_SQL = `
  SELECT (public.stage_peppol_delivery_as_actor(
    $1, $2, $3, '0007', '5566778899',
    'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0',
    'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0',
    'peppol-invoice-F-2026-77.xml', $4, $5
  )).*`

const SESSION_SQL = `
  SELECT (public.stage_peppol_delivery(
    $1, $2, '0007', '5566778899',
    'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0',
    'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0',
    'peppol-invoice-F-2026-77.xml', $3, $4
  )).*`

async function stage(seeded: { userId: string; companyId: string }, invoiceId: string): Promise<StagedRow> {
  const { rows } = await runAsServiceRole((client) =>
    client.query<StagedRow>(AS_ACTOR_SQL, [seeded.userId, seeded.companyId, invoiceId, XML, XML_SHA]),
  )
  return rows[0]
}

/** The send's accepted submission, then the provider's final word on it. */
async function submitThenEnd(
  companyId: string,
  idempotencyKey: string,
  submissionId: string,
  status: 'failed' | 'no_route' | 'business_rejected' | 'business_accepted',
) {
  const eventSql = `SELECT public.record_peppol_delivery_event(
    $1, $2, 'connector', 'connector', $3, NULL, $4, $5, $6, $7,
    '{}'::jsonb, $8, 'provider_poll', $9::timestamptz
  )`
  const fingerprint = (value: string) => createHash('sha256').update(`${idempotencyKey}|${value}`).digest('hex')
  await runAsServiceRole(async (client) => {
    await client.query(eventSql, [
      companyId, idempotencyKey, submissionId, 'submit_accepted', 'submission_accepted', false, null,
      fingerprint('accepted'), '2026-09-30T10:00:00Z',
    ])
    await client.query(eventSql, [
      companyId, idempotencyKey, submissionId, 'status_poll', status, true, `${status}: provider reason`,
      fingerprint(status), '2026-09-30T10:05:00Z',
    ])
  })
}

async function deliveriesOf(invoiceId: string): Promise<StagedRow[]> {
  const { rows } = await getPool().query<StagedRow>(
    `SELECT id, idempotency_key, status, provider_submission_id
       FROM public.peppol_deliveries WHERE invoice_id = $1 ORDER BY created_at, id`,
    [invoiceId],
  )
  return rows
}

describe('Peppol resend after a failed delivery (one live delivery per document)', () => {
  it('answers the live delivery for the same XML, before and after the access point took it', async () => {
    const seeded = await seedCompany()
    const invoiceId = await insertInvoice(seeded.userId, seeded.companyId)

    const first = await stage(seeded, invoiceId)
    expect(first.status).toBe('staged')
    expect((await stage(seeded, invoiceId)).id).toBe(first.id)

    await runAsServiceRole((client) => client.query(
      `SELECT public.record_peppol_delivery_event(
        $1, $2, 'connector', 'connector', 'sub-live', NULL, 'submit_accepted', 'submission_accepted',
        false, NULL, '{}'::jsonb, $3, 'accounted_route', now()
      )`,
      [seeded.companyId, first.idempotency_key, 'a'.repeat(64)],
    ))
    const again = await stage(seeded, invoiceId)
    expect(again).toMatchObject({ id: first.id, status: 'submission_accepted', provider_submission_id: 'sub-live' })
    expect(await deliveriesOf(invoiceId)).toHaveLength(1)
  })

  it.each(['failed', 'no_route'] as const)(
    'stages a new delivery with a new idempotency key after %s, and keeps the old one as history',
    async (terminal) => {
      const seeded = await seedCompany()
      const invoiceId = await insertInvoice(seeded.userId, seeded.companyId)
      const first = await stage(seeded, invoiceId)
      await submitThenEnd(seeded.companyId, first.idempotency_key, `sub-${terminal}`, terminal)

      const resend = await stage(seeded, invoiceId)

      expect(resend.id).not.toBe(first.id)
      expect(resend.idempotency_key).not.toBe(first.idempotency_key)
      expect(resend).toMatchObject({ status: 'staged', provider_submission_id: null })
      expect(await deliveriesOf(invoiceId)).toEqual([
        expect.objectContaining({ id: first.id, status: terminal, provider_submission_id: `sub-${terminal}` }),
        expect.objectContaining({ id: resend.id, status: 'staged' }),
      ])
      // The new row is the live one now: staging again answers it.
      expect((await stage(seeded, invoiceId)).id).toBe(resend.id)
      // Its own staged event, like every new delivery.
      const events = await getPool().query(
        `SELECT normalized_status FROM public.peppol_delivery_events WHERE delivery_id = $1`,
        [resend.id],
      )
      expect(events.rows).toEqual([{ normalized_status: 'staged' }])
    },
  )

  it('follows the same rule on the session variant, which delegates to it', async () => {
    const seeded = await seedCompany()
    const invoiceId = await insertInvoice(seeded.userId, seeded.companyId)
    const first = await stage(seeded, invoiceId)
    await submitThenEnd(seeded.companyId, first.idempotency_key, 'sub-session', 'failed')

    const resend = await withUserContext(seeded.userId, async (client) => {
      const { rows } = await client.query<StagedRow>(SESSION_SQL, [seeded.companyId, invoiceId, XML, XML_SHA])
      return rows[0]
    })

    expect(resend.id).not.toBe(first.id)
    expect(resend.status).toBe('staged')
  })

  it.each(['business_rejected', 'business_accepted'] as const)(
    'answers the %s delivery itself: the buyer\'s response is not a failure to resend',
    async (terminal) => {
      const seeded = await seedCompany()
      const invoiceId = await insertInvoice(seeded.userId, seeded.companyId)
      const first = await stage(seeded, invoiceId)
      await submitThenEnd(seeded.companyId, first.idempotency_key, `sub-${terminal}`, terminal)

      const again = await stage(seeded, invoiceId)

      expect(again).toMatchObject({ id: first.id, status: terminal })
      expect(await deliveriesOf(invoiceId)).toHaveLength(1)
    },
  )

  it('never lets two live deliveries of one document exist', async () => {
    const seeded = await seedCompany()
    const invoiceId = await insertInvoice(seeded.userId, seeded.companyId)
    const first = await stage(seeded, invoiceId)

    await expect(getPool().query(
      `INSERT INTO public.peppol_deliveries (
         company_id, user_id, invoice_id, recipient_scheme, recipient_identifier,
         customization_id, profile_id, filename, xml_payload, xml_sha256, retention_expires_at
       )
       SELECT company_id, user_id, invoice_id, recipient_scheme, recipient_identifier,
              customization_id, profile_id, filename, xml_payload, xml_sha256, retention_expires_at
         FROM public.peppol_deliveries WHERE id = $1`,
      [first.id],
    )).rejects.toThrow(/idx_peppol_deliveries_staged_document/)
  })
})
