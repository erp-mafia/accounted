import { randomUUID } from 'crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, seedCompany } from './fixtures'

/**
 * Arkiv phase 4: agreements, their obligations and document links are
 * readable by members only and written by the service role only; one
 * agreement per document; one obligation per (agreement, kind, date); a
 * link names exactly one target and is unique while live; derived deadlines
 * carry a unique source key; everything goes with its document.
 */
async function insertDocument(userId: string, companyId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source, doc_type, page_count)
     VALUES ($1, $2, $3, 'hyresavtal.pdf', 'application/pdf', 1024, $4, $5, 'file_upload', 'agreement.rental', 3)`,
    [id, userId, companyId, `documents/${companyId}/${id}.pdf`, randomUUID().replace(/-/g, '').padEnd(64, '0')],
  )
  return id
}

async function insertParty(userId: string, companyId: string): Promise<string> {
  const { rows } = await getPool().query(
    `INSERT INTO public.parties (company_id, user_id, display_name, org_number, origin) VALUES ($1, $2, 'Fastighets AB Kvarnen', '5560167452', 'document') RETURNING id`,
    [companyId, userId],
  )
  return rows[0].id
}

async function insertAgreement(companyId: string, documentId: string, partyId: string | null): Promise<string> {
  const { rows } = await getPool().query(
    `INSERT INTO public.agreements (company_id, kind, title, counterparty_party_id, amount, period, starts_on, ends_on, source_document_id)
     VALUES ($1, 'rental', 'Hyresavtal Vasagatan 12', $2, 12500, 'monthly', '2026-01-01', '2028-12-31', $3) RETURNING id`,
    [companyId, partyId, documentId],
  )
  return rows[0].id
}

describe('agreements, obligations and links', () => {
  let userId: string
  let companyId: string
  let strangerId: string
  let documentId: string
  let partyId: string
  let agreementId: string

  beforeAll(async () => {
    ;({ userId, companyId } = await seedCompany())
    strangerId = await insertAuthUser()
    documentId = await insertDocument(userId, companyId)
    partyId = await insertParty(userId, companyId)
    agreementId = await insertAgreement(companyId, documentId, partyId)
  })

  it('allows one agreement per document and a counterparty only from the same company', async () => {
    await expect(insertAgreement(companyId, documentId, null)).rejects.toThrow(/agreements_source_document_id_key/)
    const other = await seedCompany()
    const otherDoc = await insertDocument(other.userId, other.companyId)
    await expect(insertAgreement(other.companyId, otherDoc, partyId)).rejects.toThrow(/agreements_counterparty_party_id_company_id_fkey/)
  })

  it('keeps one obligation per kind and date, and ties matched to a transaction', async () => {
    const insert = (kind: string, dueOn: string, status = 'expected') =>
      getPool().query(`INSERT INTO public.agreement_obligations (company_id, agreement_id, kind, due_on, amount, status) VALUES ($1, $2, $3, $4, 12500, $5)`, [companyId, agreementId, kind, dueOn, status])
    await insert('payment', '2026-10-01')
    await expect(insert('payment', '2026-10-01')).rejects.toThrow(/agreement_obligations_agreement_id_kind_due_on_key/)
    await expect(insert('payment', '2026-11-01', 'matched')).rejects.toThrow(/agreement_obligations_check/)
    await expect(insert('rent', '2026-12-01')).rejects.toThrow(/agreement_obligations_kind_check/)
  })

  it('names exactly one link target, keeps live links unique, and lets the same link return after retirement', async () => {
    const link = (kind: string, party: string | null, agreement: string | null) =>
      getPool().query(
        `INSERT INTO public.document_links (company_id, document_id, target_kind, party_id, agreement_id, basis, method)
         VALUES ($1, $2, $3, $4, $5, 'proven', 'org_number') RETURNING id, target_id`,
        [companyId, documentId, kind, party, agreement],
      )
    await expect(link('party', partyId, agreementId)).rejects.toThrow(/document_links_check/)
    await expect(link('agreement', partyId, null)).rejects.toThrow(/document_links_check/)
    const { rows } = await link('party', partyId, null)
    expect(rows[0].target_id).toBe(partyId)
    await expect(link('party', partyId, null)).rejects.toThrow(/idx_document_links_live/)
    await getPool().query(`UPDATE public.document_links SET retired_at = now(), retired_reason = 'test' WHERE id = $1`, [rows[0].id])
    await expect(link('party', partyId, null)).resolves.toBeTruthy()
    await expect(link('agreement', null, agreementId)).resolves.toBeTruthy()
  })

  it('lets members read, shows strangers nothing, and lets only the service write', async () => {
    const read = (user: string) =>
      withUserContext(user, async (client) => ({
        agreements: (await client.query(`SELECT title FROM public.agreements WHERE id = $1`, [agreementId])).rows,
        obligations: (await client.query(`SELECT due_on FROM public.agreement_obligations WHERE agreement_id = $1`, [agreementId])).rows.length,
        links: (await client.query(`SELECT target_kind FROM public.document_links WHERE document_id = $1 AND retired_at IS NULL ORDER BY target_kind`, [documentId])).rows,
      }))
    expect(await read(userId)).toEqual({ agreements: [{ title: 'Hyresavtal Vasagatan 12' }], obligations: 1, links: [{ target_kind: 'agreement' }, { target_kind: 'party' }] })
    expect(await read(strangerId)).toEqual({ agreements: [], obligations: 0, links: [] })
    const updated = await withUserContext(userId, (client) => client.query(`UPDATE public.agreements SET amount = 1 WHERE id = $1`, [agreementId]))
    expect(updated.rowCount).toBe(0)
    const inserted = withUserContext(userId, (client) =>
      client.query(`INSERT INTO public.agreement_obligations (company_id, agreement_id, kind, due_on, amount) VALUES ($1, $2, 'deposit', '2026-01-01', 1)`, [companyId, agreementId]),
    )
    await expect(inserted).rejects.toThrow(/row-level security/)
  })

  it('accepts derive jobs and derive activities', async () => {
    await expect(getPool().query(`INSERT INTO public.document_jobs (company_id, document_id, kind) VALUES ($1, $2, 'derive')`, [companyId, documentId])).resolves.toBeTruthy()
    await expect(getPool().query(`INSERT INTO public.document_jobs (company_id, document_id, kind) VALUES ($1, $2, 'link')`, [companyId, documentId])).rejects.toThrow(/document_jobs_kind_check/)
    const agent = await getPool().query(`INSERT INTO public.agents (kind, name, version) VALUES ('software', 'arkiv.derive', $1) RETURNING id`, [`test-${randomUUID()}`])
    await expect(
      getPool().query(`INSERT INTO public.activities (company_id, document_id, agent_id, kind, started_at, ended_at, outcome) VALUES ($1, $2, $3, 'derive', now(), now(), 'settled')`, [companyId, documentId, agent.rows[0].id]),
    ).resolves.toBeTruthy()
  })

  it('gives a derived deadline one live row per source key and removes it with the document', async () => {
    const insert = () =>
      getPool().query(
        `INSERT INTO public.deadlines (company_id, title, due_date, deadline_type, source, is_auto_generated, source_document_id, source_key)
         VALUES ($1, 'Sista dag att säga upp hyresavtalet', '2028-03-31', 'other', 'system', true, $2, $3)`,
        [companyId, documentId, `agreement:${agreementId}:notice`],
      )
    await insert()
    await expect(insert()).rejects.toThrow(/idx_deadlines_source_key/)
    await getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [documentId])
    const { rows } = await getPool().query(
      `SELECT (SELECT count(*) FROM public.agreements WHERE id = $1)::int AS agreements,
              (SELECT count(*) FROM public.agreement_obligations WHERE agreement_id = $1)::int AS obligations,
              (SELECT count(*) FROM public.document_links WHERE document_id = $2)::int AS links,
              (SELECT count(*) FROM public.deadlines WHERE source_document_id = $2)::int AS deadlines`,
      [agreementId, documentId],
    )
    expect(rows[0]).toEqual({ agreements: 0, obligations: 0, links: 0, deadlines: 0 })
  })
})
