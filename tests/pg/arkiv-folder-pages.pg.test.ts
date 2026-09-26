import { randomUUID } from 'crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, seedCompany } from './fixtures'

/**
 * arkiv_document_type_counts and arkiv_document_page: the Dokument tree counts
 * and pages its folders over the whole archive, with the list's filters (no
 * structured archives, admitted or held) and its date (the date the inbox read
 * off a receipt or invoice, the upload day otherwise). A member sees their own
 * company only.
 */
async function insertDocument(p: { userId: string; companyId: string; docType: string | null; mime?: string; createdAt: string; invoiceDate?: string; admission?: string }): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source, doc_type, admission_state, extracted_data, created_at)
     VALUES ($1, $2, $3, 'f.pdf', $4, 1024, $5, $6, 'file_upload', $7, $8, $9, $10)`,
    [
      id,
      p.userId,
      p.companyId,
      p.mime ?? 'application/pdf',
      `documents/${p.companyId}/${id}.pdf`,
      randomUUID().replace(/-/g, '').padEnd(64, '0'),
      p.docType,
      p.admission ?? 'admitted',
      p.invoiceDate ? JSON.stringify({ invoice: { invoiceDate: p.invoiceDate } }) : null,
      p.createdAt,
    ],
  )
  return id
}

describe('arkiv_document_type_counts and arkiv_document_page', () => {
  let userId: string
  let companyId: string
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    ;({ userId, companyId } = await seedCompany())
    const c = { userId, companyId }
    // A receipt uploaded in 2026 but dated 2025: it counts in 2025.
    ids.receipt2025 = await insertDocument({ ...c, docType: 'receipt', createdAt: '2026-02-01T10:00:00Z', invoiceDate: '2025-12-30' })
    ids.receipt2026 = await insertDocument({ ...c, docType: 'receipt', createdAt: '2026-03-01T10:00:00Z', invoiceDate: '2026-02-28' })
    ids.loan = await insertDocument({ ...c, docType: 'agreement.loan', createdAt: '2026-01-15T10:00:00Z', invoiceDate: '2024-01-01' })
    ids.untyped = await insertDocument({ ...c, docType: null, createdAt: '2026-04-01T10:00:00Z' })
    ids.oddType = await insertDocument({ ...c, docType: 'something_new', createdAt: '2026-05-01T10:00:00Z' })
    ids.held = await insertDocument({ ...c, docType: 'receipt', createdAt: '2026-06-01T10:00:00Z', admission: 'held' })
    ids.bankJson = await insertDocument({ ...c, docType: null, mime: 'application/json', createdAt: '2026-07-01T10:00:00Z' })
  })

  const counts = (year: number | null) =>
    withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ doc_type: string | null; n: string }>(`SELECT doc_type, n FROM public.arkiv_document_type_counts($1, $2)`, [companyId, year])
      return Object.fromEntries(rows.map((r) => [r.doc_type ?? 'untyped', Number(r.n)]))
    })

  const page = (mode: string, types: string[] | null, year: number | null, offset = 0, limit = 25) =>
    withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ id: string; doc_day: string }>(`SELECT id, doc_day FROM public.arkiv_document_page($1, $2, $3, $4, $5, $6)`, [companyId, mode, types, year, offset, limit])
      return rows
    })

  it('counts every type over the whole archive, held included, structured archives left out', async () => {
    expect(await counts(null)).toEqual({ receipt: 3, 'agreement.loan': 1, untyped: 1, something_new: 1 })
  })

  it('counts a year by the date on the document, the upload day when it has none', async () => {
    expect(await counts(2025)).toEqual({ receipt: 1 })
    // The loan agreement's invoice date is ignored: only receipts and invoices take the inbox's date.
    expect(await counts(2026)).toEqual({ receipt: 2, 'agreement.loan': 1, untyped: 1, something_new: 1 })
  })

  it('pages a folder newest date first, and the other folder holds any type no folder names', async () => {
    const receipts = await page('in', ['receipt'], null)
    expect(receipts.map((r) => r.id)).toEqual([ids.held, ids.receipt2026, ids.receipt2025])
    expect(receipts.map((r) => r.doc_day)).toEqual(['2026-06-01', '2026-02-28', '2025-12-30'])
    expect((await page('in', ['receipt'], null, 1, 1)).map((r) => r.id)).toEqual([ids.receipt2026])
    expect((await page('not_in', ['receipt', 'agreement.loan'], null)).map((r) => r.id)).toEqual([ids.oddType])
    expect((await page('untyped', null, null)).map((r) => r.id)).toEqual([ids.untyped])
    expect((await page('in', ['receipt'], 2025)).map((r) => r.id)).toEqual([ids.receipt2025])
  })

  it('shows a stranger nothing of another company', async () => {
    const stranger = await insertAuthUser()
    const rows = await withUserContext(stranger, async (client) => {
      const a = await client.query(`SELECT * FROM public.arkiv_document_type_counts($1, NULL)`, [companyId])
      const b = await client.query(`SELECT * FROM public.arkiv_document_page($1, 'in', ARRAY['receipt'], NULL, 0, 25)`, [companyId])
      return [...a.rows, ...b.rows]
    })
    expect(rows).toEqual([])
  })
})
