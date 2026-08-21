import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

const XML = '<Invoice><cbc:ID>20267497</cbc:ID></Invoice>'
const XML_SHA = createHash('sha256').update(XML).digest('hex')

async function insertRegistration(companyId: string, userId: string, identifier: string, status = 'registered') {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.peppol_registrations
       (id, company_id, user_id, provider, provider_account_reference,
        participant_scheme, participant_identifier, status, registered_at, deregistered_at)
     VALUES ($1, $2, $3, 'qvalia', 'SE5595386219', '0007', $4, $5,
             CASE WHEN $5 = 'registered' THEN now() ELSE NULL END,
             CASE WHEN $5 = 'deregistered' THEN now() ELSE NULL END)`,
    [id, companyId, userId, identifier, status],
  )
  return id
}

async function insertInbound(companyId: string | null, providerDocumentId = randomUUID()) {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.peppol_inbound_documents
       (id, provider, provider_document_id, document_type, document_id, issue_date,
        currency, payable_amount, sender_scheme, sender_identifier, sender_name,
        recipient_scheme, recipient_identifier, company_id, status, xml_payload, xml_sha256)
     VALUES ($1, 'qvalia', $2, 'Invoice', '20267497', '2026-08-21',
             'SEK', 112.00, '0007', '5567321707', 'Qvalia AB',
             '0007', '5595386219', $3, $4, $5, $6)`,
    [id, providerDocumentId, companyId, companyId ? 'routed' : 'received', XML, XML_SHA],
  )
  return id
}

describe('peppol_registrations', () => {
  it('allows one live registration per participant and per company, history rows aside', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    await insertRegistration(a.companyId, a.userId, '5595386219')

    await expect(insertRegistration(b.companyId, b.userId, '5595386219'))
      .rejects.toThrow(/peppol_registrations_live_participant/)
    await expect(insertRegistration(a.companyId, a.userId, '5560160680'))
      .rejects.toThrow(/peppol_registrations_live_company/)

    // A deregistered history row does not block a new live one.
    await insertRegistration(b.companyId, b.userId, '5567321707', 'deregistered')
    await expect(insertRegistration(b.companyId, b.userId, '5567321707')).resolves.toBeTruthy()
  })

  it('is readable by members of the company only and not writable by authenticated users', async () => {
    const own = await seedCompany()
    const other = await seedCompany()
    await insertRegistration(own.companyId, own.userId, '5590000001')
    await insertRegistration(other.companyId, other.userId, '5590000002')

    const visible = await withUserContext(own.userId, async (client) => {
      const { rows } = await client.query(
        `SELECT participant_identifier FROM public.peppol_registrations ORDER BY participant_identifier`,
      )
      return rows.map((row) => row.participant_identifier as string)
    })
    expect(visible).toEqual(['5590000001'])

    await expect(withUserContext(own.userId, (client) =>
      client.query(
        `INSERT INTO public.peppol_registrations (company_id, provider, participant_scheme, participant_identifier)
         VALUES ($1, 'qvalia', '0007', '5590000003')`,
        [own.companyId],
      ),
    )).rejects.toThrow(/permission denied|row-level security/)
  })
})

describe('peppol_inbound_documents', () => {
  it('keeps the received document immutable and undeletable while processing state may change', async () => {
    const seeded = await seedCompany()
    const id = await insertInbound(seeded.companyId)

    await expect(getPool().query(
      `UPDATE public.peppol_inbound_documents SET xml_payload = '<Invoice/>' WHERE id = $1`, [id],
    )).rejects.toThrow(/payload is immutable/)
    await expect(getPool().query(
      `UPDATE public.peppol_inbound_documents SET provider_document_id = 'other' WHERE id = $1`, [id],
    )).rejects.toThrow(/identity is immutable/)
    await expect(getPool().query(
      `DELETE FROM public.peppol_inbound_documents WHERE id = $1`, [id],
    )).rejects.toThrow(/cannot be deleted/)

    await expect(getPool().query(
      `UPDATE public.peppol_inbound_documents
         SET status = 'converted', processed_at = now(), summary = '{"ok":true}'::jsonb
       WHERE id = $1`, [id],
    )).resolves.toBeTruthy()
  })

  it('routes once: company_id may be set from null but never changed afterwards', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const id = await insertInbound(null)

    await getPool().query(
      `UPDATE public.peppol_inbound_documents SET company_id = $2, status = 'routed' WHERE id = $1`,
      [id, a.companyId],
    )
    await expect(getPool().query(
      `UPDATE public.peppol_inbound_documents SET company_id = $2 WHERE id = $1`, [id, b.companyId],
    )).rejects.toThrow(/cannot be re-routed/)
  })

  it('refuses a second copy of the same provider document and a routed status without a company', async () => {
    const seeded = await seedCompany()
    const providerDocumentId = randomUUID()
    await insertInbound(seeded.companyId, providerDocumentId)
    await expect(insertInbound(seeded.companyId, providerDocumentId))
      .rejects.toThrow(/peppol_inbound_documents_provider_document_unique/)

    await expect(getPool().query(
      `INSERT INTO public.peppol_inbound_documents (provider, provider_document_id, document_type, status)
       VALUES ('qvalia', $1, 'Invoice', 'routed')`, [randomUUID()],
    )).rejects.toThrow(/peppol_inbound_documents_routed_shape/)
  })

  it('is visible to members of the routed company only, never unrouted rows, and only the service role writes', async () => {
    const own = await seedCompany()
    const other = await seedCompany()
    const outsider = await insertAuthUser()
    await insertCompanyMember({ companyId: other.companyId, userId: outsider, role: 'owner' })
    const ownDoc = await insertInbound(own.companyId)
    await insertInbound(other.companyId)
    await insertInbound(null)

    const visible = await withUserContext(own.userId, async (client) => {
      const { rows } = await client.query(`SELECT id FROM public.peppol_inbound_documents`)
      return rows.map((row) => row.id as string)
    })
    expect(visible).toEqual([ownDoc])

    await expect(withUserContext(own.userId, (client) =>
      client.query(
        `INSERT INTO public.peppol_inbound_documents (provider, provider_document_id, document_type)
         VALUES ('qvalia', $1, 'Invoice')`, [randomUUID()],
      ),
    )).rejects.toThrow(/permission denied|row-level security/)

    const serviceCount = await runAsServiceRole(async (client) => {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM public.peppol_inbound_documents WHERE company_id IS NULL`,
      )
      return rows[0].n as number
    })
    expect(serviceCount).toBeGreaterThanOrEqual(1)
  })
})
