import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * stage_peppol_delivery_as_actor: the service-role twin of
 * stage_peppol_delivery for the v1 API and MCP approvals (operation
 * invoices.send-peppol), where auth.uid() is NULL.
 */
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

const AS_ACTOR_SQL = `
  SELECT (public.stage_peppol_delivery_as_actor(
    $1, $2, $3, '0007', '5566778899',
    'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0',
    'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0',
    'peppol-invoice-F-2026-42.xml', $4, $5
  )).*`

const SESSION_SQL = `
  SELECT (public.stage_peppol_delivery(
    $1, $2, '0007', '5566778899',
    'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0',
    'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0',
    'peppol-invoice-F-2026-42.xml', $3, $4
  )).*`

describe('stage_peppol_delivery_as_actor', () => {
  it('stages for the named member on service role, records the actor, and is idempotent with the session variant', async () => {
    const seeded = await seedCompany()
    const invoiceId = await insertInvoice(seeded.userId, seeded.companyId)

    const first = await runAsServiceRole((client) =>
      client.query(AS_ACTOR_SQL, [seeded.userId, seeded.companyId, invoiceId, XML, XML_SHA]),
    )
    expect(first.rows[0]).toMatchObject({
      company_id: seeded.companyId,
      user_id: seeded.userId,
      invoice_id: invoiceId,
      xml_sha256: XML_SHA,
      status: 'staged',
    })
    // The retention basis is the fiscal period's own retention date (20260813171856), compared
    // as text: pg returns a date as a local-midnight Date, which toISOString shifts a day.
    const retention = await getPool().query<{ delivery: string; period: string }>(
      `SELECT d.retention_expires_at::text AS delivery, p.retention_expires_at::text AS period
         FROM public.peppol_deliveries d, public.fiscal_periods p
        WHERE d.id = $1 AND p.id = $2`,
      [first.rows[0].id, seeded.fiscalPeriodId],
    )
    expect(retention.rows[0].delivery).toBe(retention.rows[0].period)

    // The same exact document staged from the dashboard is the same delivery.
    const again = await withUserContext(seeded.userId, (client) =>
      client.query(SESSION_SQL, [seeded.companyId, invoiceId, XML, XML_SHA]),
    )
    expect(again.rows[0].id).toBe(first.rows[0].id)

    const events = await getPool().query(
      `SELECT count(*)::int AS n FROM public.peppol_delivery_events WHERE delivery_id = $1`,
      [first.rows[0].id],
    )
    expect(events.rows[0].n).toBe(1)
  })

  it('refuses a viewer, a non-member and a missing actor', async () => {
    const seeded = await seedCompany()
    const other = await seedCompany()
    const invoiceId = await insertInvoice(seeded.userId, seeded.companyId)
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId: seeded.companyId, userId: viewerId, role: 'viewer' })

    for (const actor of [viewerId, other.userId, null]) {
      await expect(runAsServiceRole((client) =>
        client.query(AS_ACTOR_SQL, [actor, seeded.companyId, invoiceId, XML, XML_SHA]),
      )).rejects.toThrow(/not authorized/)
    }
  })

  it('cannot be called by an end user: the actor id is trusted input', async () => {
    const seeded = await seedCompany()
    const invoiceId = await insertInvoice(seeded.userId, seeded.companyId)
    await expect(withUserContext(seeded.userId, (client) =>
      client.query(AS_ACTOR_SQL, [seeded.userId, seeded.companyId, invoiceId, XML, XML_SHA]),
    )).rejects.toThrow(/permission denied/)
  })

  it('keeps the session variant refusing viewers and demanding a retention basis', async () => {
    const seeded = await seedCompany()
    const invoiceId = await insertInvoice(seeded.userId, seeded.companyId)
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId: seeded.companyId, userId: viewerId, role: 'viewer' })
    await expect(withUserContext(viewerId, (client) =>
      client.query(SESSION_SQL, [seeded.companyId, invoiceId, XML, XML_SHA]),
    )).rejects.toThrow(/not authorized/)

    await getPool().query('DELETE FROM public.fiscal_periods WHERE id = $1', [seeded.fiscalPeriodId])
    await expect(runAsServiceRole((client) =>
      client.query(AS_ACTOR_SQL, [seeded.userId, seeded.companyId, invoiceId, XML, XML_SHA]),
    )).rejects.toThrow(/requires a fiscal period retention basis/)
  })
})
