import { randomUUID } from 'crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, seedCompany } from './fixtures'

/**
 * Arkiv phase 1: document_pages is readable only by the company's members
 * (RLS), never writable by them (service role only), and
 * search_document_pages() answers Swedish full-text queries for one company.
 */
async function insertDocument(userId: string, companyId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source)
     VALUES ($1, $2, $3, 'hyresavtal.pdf', 'application/pdf', 1024, $4, $5, 'file_upload')`,
    [id, userId, companyId, `documents/${companyId}/hyresavtal.pdf`, randomUUID().replace(/-/g, '').padEnd(64, '0')],
  )
  return id
}

async function insertPage(companyId: string, documentId: string, pageNo: number, text: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.document_pages (company_id, document_id, page_no, text, reader, has_text_layer)
     VALUES ($1, $2, $3, $4, 'pdf_text', true)`,
    [companyId, documentId, pageNo, text],
  )
}

describe('document_pages and search_document_pages', () => {
  let userId: string
  let companyId: string
  let strangerId: string
  let documentId: string

  beforeAll(async () => {
    ;({ userId, companyId } = await seedCompany())
    strangerId = await insertAuthUser()
    documentId = await insertDocument(userId, companyId)
    await insertPage(companyId, documentId, 1, 'Hyresavtal för lokalen på Vasagatan 12.')
    await insertPage(companyId, documentId, 2, 'Hyran uppgår till 19 300 kronor per månad exklusive moms.')
  })

  it('lets a member read the pages and a stranger see none', async () => {
    const mine = await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ page_no: number }>(
        `SELECT page_no FROM public.document_pages WHERE document_id = $1 ORDER BY page_no`,
        [documentId],
      )
      return rows.map((r) => r.page_no)
    })
    expect(mine).toEqual([1, 2])
    const theirs = await withUserContext(strangerId, async (client) => {
      const { rows } = await client.query(`SELECT page_no FROM public.document_pages WHERE document_id = $1`, [documentId])
      return rows
    })
    expect(theirs).toEqual([])
  })

  it('refuses page writes from a member (service role only)', async () => {
    await expect(
      withUserContext(userId, (client) =>
        client.query(
          `INSERT INTO public.document_pages (company_id, document_id, page_no, text, reader, has_text_layer)
           VALUES ($1, $2, 3, 'x', 'pdf_text', true)`,
          [companyId, documentId],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it('finds the page by a Swedish stemmed query with a highlighted snippet', async () => {
    const hits = await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ document_id: string; page_no: number; file_name: string; headline: string }>(
        `SELECT * FROM public.search_document_pages($1, $2, 10)`,
        [companyId, 'hyran månad'],
      )
      return rows
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ document_id: documentId, page_no: 2, file_name: 'hyresavtal.pdf' })
    expect(hits[0].headline).toContain('<b>')
  })

  it('answers nothing for another company, even with the company id in hand', async () => {
    const hits = await withUserContext(strangerId, async (client) => {
      const { rows } = await client.query(`SELECT * FROM public.search_document_pages($1, $2, 10)`, [companyId, 'hyran'])
      return rows
    })
    expect(hits).toEqual([])
  })
})
