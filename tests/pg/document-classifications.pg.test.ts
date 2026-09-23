import { randomUUID } from 'crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, seedCompany } from './fixtures'

/**
 * Arkiv phase 2: classifications are readable by members only, written by the
 * service role only, one current per document, and admission defaults to
 * admitted for everything that was already in the archive.
 */
async function insertDocument(userId: string, companyId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source)
     VALUES ($1, $2, $3, 'skannat.pdf', 'application/pdf', 1024, $4, $5, 'file_upload')`,
    [id, userId, companyId, `documents/${companyId}/skannat.pdf`, randomUUID().replace(/-/g, '').padEnd(64, '0')],
  )
  return id
}

describe('document_classifications', () => {
  let userId: string
  let companyId: string
  let strangerId: string
  let documentId: string

  beforeAll(async () => {
    ;({ userId, companyId } = await seedCompany())
    strangerId = await insertAuthUser()
    documentId = await insertDocument(userId, companyId)
    await getPool().query(
      `INSERT INTO public.document_classifications (company_id, document_id, doc_type, confidence, relevance, decided_by)
       VALUES ($1, $2, 'receipt', 0.9, 'relevant', 'model')`,
      [companyId, documentId],
    )
  })

  it('defaults an existing document to admitted', async () => {
    const { rows } = await getPool().query(`SELECT admission_state FROM public.document_attachments WHERE id = $1`, [documentId])
    expect(rows[0].admission_state).toBe('admitted')
  })

  it('allows one current classification per document', async () => {
    await expect(
      getPool().query(
        `INSERT INTO public.document_classifications (company_id, document_id, doc_type, confidence, relevance, decided_by)
         VALUES ($1, $2, 'other', 0.5, 'ask', 'model')`,
        [companyId, documentId],
      ),
    ).rejects.toThrow(/idx_document_classifications_current/)
  })

  it('lets a member read and a stranger see nothing; members cannot write', async () => {
    const mine = await withUserContext(userId, async (client) => (await client.query(`SELECT doc_type FROM public.document_classifications WHERE document_id = $1`, [documentId])).rows)
    expect(mine).toEqual([{ doc_type: 'receipt' }])
    const theirs = await withUserContext(strangerId, async (client) => (await client.query(`SELECT doc_type FROM public.document_classifications WHERE document_id = $1`, [documentId])).rows)
    expect(theirs).toEqual([])
    await expect(
      withUserContext(userId, (client) =>
        client.query(`UPDATE public.document_classifications SET doc_type = 'other' WHERE document_id = $1`, [documentId]),
      ).then((r) => r.rowCount),
    ).resolves.toBe(0)
  })

  it('rejects an admission state outside held or admitted', async () => {
    await expect(getPool().query(`UPDATE public.document_attachments SET admission_state = 'lost' WHERE id = $1`, [documentId])).rejects.toThrow(/admission_state/)
  })
})
