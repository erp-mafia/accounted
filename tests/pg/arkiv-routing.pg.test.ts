import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

/**
 * Arkiv phase 7. One document's next step can be claimed on its own for the
 * person watching an upload (service only), and an inbox item remembers
 * that Arkiv routed it elsewhere.
 */
async function insertDocument(userId: string, companyId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source)
     VALUES ($1, $2, $3, 'kvitto.jpg', 'image/jpeg', 1024, $4, $5, 'file_upload')`,
    [id, userId, companyId, `documents/${companyId}/${id}.jpg`, randomUUID().replace(/-/g, '').padEnd(64, '0')],
  )
  return id
}

describe('claim_document_job_for', () => {
  it('claims the one due job of that document, a failed one at once, and nothing of another document', async () => {
    const { userId, companyId } = await seedCompany()
    const doc = await insertDocument(userId, companyId)
    const other = await insertDocument(userId, companyId)
    await getPool().query(
      `INSERT INTO public.document_jobs (company_id, document_id, kind, status, attempts, run_after) VALUES
         ($1, $2, 'read', 'failed', 1, now() + interval '30 minutes'),
         ($1, $3, 'read', 'queued', 0, now() - interval '1 minute')`,
      [companyId, doc, other],
    )
    const claim = async () => (await getPool().query(`SELECT document_id, kind, attempts FROM public.claim_document_job_for($1, 'pipeline:test')`, [doc])).rows
    expect(await claim()).toEqual([{ document_id: doc, kind: 'read', attempts: 2 }])
    expect(await claim()).toEqual([])
    const { rows } = await getPool().query(`SELECT status, locked_by FROM public.document_jobs WHERE document_id = $1`, [doc])
    expect(rows).toEqual([{ status: 'running', locked_by: 'pipeline:test' }])
    const untouched = await getPool().query(`SELECT status FROM public.document_jobs WHERE document_id = $1`, [other])
    expect(untouched.rows).toEqual([{ status: 'queued' }])
    await expect(withUserContext(userId, (client) => client.query(`SELECT * FROM public.claim_document_job_for($1, 'member')`, [doc]))).rejects.toThrow(/permission denied/)
  })
})

describe('invoice_inbox_items routing columns', () => {
  it('records where Arkiv sent an item and lets members read it', async () => {
    const { userId, companyId } = await seedCompany()
    const doc = await insertDocument(userId, companyId)
    const { rows } = await getPool().query(
      `INSERT INTO public.invoice_inbox_items (company_id, user_id, status, source, document_id, routed_to_arkiv_at, routed_doc_type)
       VALUES ($1, $2, 'received', 'upload', $3, now(), 'agreement.loan') RETURNING id`,
      [companyId, userId, doc],
    )
    const seen = await withUserContext(
      userId,
      async (client) => (await client.query(`SELECT routed_doc_type, routed_to_arkiv_at IS NOT NULL AS routed FROM public.invoice_inbox_items WHERE id = $1`, [rows[0].id])).rows,
    )
    expect(seen).toEqual([{ routed_doc_type: 'agreement.loan', routed: true }])
  })
})

describe('activities after phase 8', () => {
  it('records a question asked of a document as its own kind of activity', async () => {
    const { userId, companyId } = await seedCompany()
    const doc = await insertDocument(userId, companyId)
    const agent = await getPool().query(`INSERT INTO public.agents (kind, name, version) VALUES ('software', 'mcp.ask', $1) RETURNING id`, [`test-${randomUUID()}`])
    const { rows } = await getPool().query(
      `INSERT INTO public.activities (company_id, document_id, agent_id, kind, started_at, ended_at, outcome, detail)
       VALUES ($1, $2, $3, 'ask', now(), now(), 'settled', '{"question": "Vad är uppsägningstiden?", "answered": true}') RETURNING kind`,
      [companyId, doc, agent.rows[0].id],
    )
    expect(rows).toEqual([{ kind: 'ask' }])
    await expect(
      getPool().query(
        `INSERT INTO public.activities (company_id, document_id, agent_id, kind, started_at, ended_at, outcome) VALUES ($1, $2, $3, 'guess', now(), now(), 'settled')`,
        [companyId, doc, agent.rows[0].id],
      ),
    ).rejects.toThrow(/activities_kind_check/)
  })
})
