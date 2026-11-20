/**
 * pg-real test for public.invoice_attachments (20261016224500, crm#1269):
 * the files emailed with a customer invoice after its PDF.
 *
 * What must hold:
 *   - a draft's attachments can be added and removed; removing one leaves the
 *     document in the archive;
 *   - a link names an invoice and a document of its own company, never
 *     another company's document (RLS for a member, the guard for everyone);
 *   - once the invoice is issued, or an email delivery of it went out, the
 *     links are fixed and the documents can no longer be deleted (BFL 7 kap
 *     retention), whoever asks;
 *   - deleting a draft takes its links with it, and deleting a document a
 *     draft holds takes the link with it;
 *   - the sandbox teardown window lets both go for a sandbox company.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { insertCompanyMember, seedCompany, setActiveCompany } from './fixtures'

async function insertInvoice(params: {
  userId: string
  companyId: string
  status?: string
}): Promise<string> {
  const id = randomUUID()
  const status = params.status ?? 'draft'
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, invoice_number, invoice_date, due_date,
        status, currency, total)
     VALUES ($1, $2, $3, $4, '2026-06-01', '2026-07-01', $5, 'SEK', 1250)`,
    [id, params.userId, params.companyId, status === 'draft' ? null : `F-${id.slice(0, 8)}`, status],
  )
  return id
}

async function insertDocument(params: { userId: string; companyId: string }): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, storage_path, file_name, sha256_hash, file_size_bytes, mime_type)
     VALUES ($1, $2, $3, $4, 'tidrapport.pdf', $5, 2048, 'application/pdf')`,
    [id, params.userId, params.companyId, `${params.companyId}/${id}.pdf`, id.replace(/-/g, '').padEnd(64, '0')],
  )
  return id
}

async function attach(companyId: string, invoiceId: string, documentId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.invoice_attachments (company_id, invoice_id, document_id) VALUES ($1, $2, $3)`,
    [companyId, invoiceId, documentId],
  )
}

async function linkCount(invoiceId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.invoice_attachments WHERE invoice_id = $1`,
    [invoiceId],
  )
  return Number(rows[0]!.n)
}

async function documentExists(documentId: string): Promise<boolean> {
  const { rows } = await getPool().query(`SELECT 1 FROM public.document_attachments WHERE id = $1`, [documentId])
  return rows.length === 1
}

async function seedMember() {
  const seeded = await seedCompany()
  await setActiveCompany(seeded.userId, seeded.companyId)
  return seeded
}

describe('invoice_attachments (pg)', () => {
  it('a member attaches to and detaches from a draft; detaching keeps the document', async () => {
    const { userId, companyId } = await seedMember()
    const invoiceId = await insertInvoice({ userId, companyId })
    const documentId = await insertDocument({ userId, companyId })

    await withUserContext(userId, async (client) => {
      await client.query(
        `INSERT INTO public.invoice_attachments (company_id, invoice_id, document_id) VALUES ($1, $2, $3)`,
        [companyId, invoiceId, documentId],
      )
      const { rows: visible } = await client.query(
        `SELECT document_id FROM public.invoice_attachments WHERE invoice_id = $1`,
        [invoiceId],
      )
      expect(visible).toEqual([{ document_id: documentId }])

      const { rowCount } = await client.query(
        `DELETE FROM public.invoice_attachments WHERE invoice_id = $1 AND document_id = $2`,
        [invoiceId, documentId],
      )
      expect(rowCount).toBe(1)
      const { rows: doc } = await client.query(`SELECT 1 FROM public.document_attachments WHERE id = $1`, [documentId])
      expect(doc).toHaveLength(1)
    })
  })

  it('never links a document of another company', async () => {
    const a = await seedMember()
    const b = await seedCompany()
    const invoiceId = await insertInvoice({ userId: a.userId, companyId: a.companyId })
    const foreignDocument = await insertDocument({ userId: b.userId, companyId: b.companyId })

    // The guard refuses it for any caller, the superuser seeding path included.
    await expect(attach(a.companyId, invoiceId, foreignDocument)).rejects.toThrow(
      /document\/company mismatch/,
    )
    // Nor can a row claim another company's invoice.
    const ownDocument = await insertDocument({ userId: b.userId, companyId: b.companyId })
    await expect(attach(b.companyId, invoiceId, ownDocument)).rejects.toThrow(/invoice\/company mismatch/)
  })

  it('a member of another company sees and changes nothing', async () => {
    const owner = await seedMember()
    const outsider = await seedMember()
    const invoiceId = await insertInvoice({ userId: owner.userId, companyId: owner.companyId })
    const documentId = await insertDocument({ userId: owner.userId, companyId: owner.companyId })
    await attach(owner.companyId, invoiceId, documentId)

    await withUserContext(outsider.userId, async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM public.invoice_attachments WHERE invoice_id = $1`, [invoiceId])
      expect(rows).toHaveLength(0)
      const { rowCount } = await client.query(`DELETE FROM public.invoice_attachments WHERE invoice_id = $1`, [invoiceId])
      expect(rowCount).toBe(0)
      await expect(
        client.query(
          `INSERT INTO public.invoice_attachments (company_id, invoice_id, document_id) VALUES ($1, $2, $3)`,
          [owner.companyId, invoiceId, documentId],
        ),
      ).rejects.toThrow(/row-level security/)
    })
    expect(await linkCount(invoiceId)).toBe(1)
  })

  it('a viewer cannot attach', async () => {
    const { userId, companyId } = await seedMember()
    const viewer = randomUUID()
    await getPool().query(
      `INSERT INTO auth.users (id, email, instance_id) VALUES ($1, $2, '00000000-0000-0000-0000-000000000000'::uuid)`,
      [viewer, `pg-real-${viewer}@test.invalid`],
    )
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    await setActiveCompany(viewer, companyId)
    const invoiceId = await insertInvoice({ userId, companyId })
    const documentId = await insertDocument({ userId, companyId })

    await withUserContext(viewer, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.invoice_attachments (company_id, invoice_id, document_id) VALUES ($1, $2, $3)`,
          [companyId, invoiceId, documentId],
        ),
      ).rejects.toThrow(/row-level security/)
    })
  })

  it('an issued invoice keeps its attachments and their documents (retention)', async () => {
    const { userId, companyId } = await seedMember()
    const invoiceId = await insertInvoice({ userId, companyId })
    const documentId = await insertDocument({ userId, companyId })
    const laterDocument = await insertDocument({ userId, companyId })
    await attach(companyId, invoiceId, documentId)
    await getPool().query(
      `UPDATE public.invoices SET status = 'sent', invoice_number = $2 WHERE id = $1`,
      [invoiceId, `F-${invoiceId.slice(0, 8)}`],
    )

    await expect(
      getPool().query(`DELETE FROM public.invoice_attachments WHERE invoice_id = $1`, [invoiceId]),
    ).rejects.toThrow(/retention: an issued or emailed invoice keeps the files/)
    await expect(
      getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [documentId]),
    ).rejects.toThrow(/retention: document was sent as an attachment/)
    await expect(attach(companyId, invoiceId, laterDocument)).rejects.toThrow(/fixed once the invoice is issued/)
    await expect(
      getPool().query(`UPDATE public.invoice_attachments SET created_at = now() WHERE invoice_id = $1`, [invoiceId]),
    ).rejects.toThrow(/never rewritten/)

    expect(await linkCount(invoiceId)).toBe(1)
    expect(await documentExists(documentId)).toBe(true)
  })

  it('a draft already emailed once keeps them too', async () => {
    const { userId, companyId } = await seedMember()
    const invoiceId = await insertInvoice({ userId, companyId })
    const documentId = await insertDocument({ userId, companyId })
    const pdfId = await insertDocument({ userId, companyId })
    await attach(companyId, invoiceId, documentId)
    await getPool().query(
      `INSERT INTO public.invoice_deliveries
         (company_id, user_id, invoice_id, channel, status, to_addresses, subject,
          body_text, body_html, document_attachment_id, attachment_filename,
          attachment_content_type, attachment_sha256, sent_at)
       VALUES ($1, $2, $3, 'email', 'sent', ARRAY['kund@example.com'], 'Faktura',
               'text', '<p>html</p>', $4, 'faktura.pdf', 'application/pdf', $5, now())`,
      [companyId, userId, invoiceId, pdfId, pdfId.replace(/-/g, '').padEnd(64, '0')],
    )

    await expect(
      getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [documentId]),
    ).rejects.toThrow(/retention: document was sent as an attachment/)
    expect(await linkCount(invoiceId)).toBe(1)
  })

  it('deleting a draft takes its links with it; deleting a draft-held document takes its link', async () => {
    const { userId, companyId } = await seedMember()
    const invoiceId = await insertInvoice({ userId, companyId })
    const kept = await insertDocument({ userId, companyId })
    const removed = await insertDocument({ userId, companyId })
    await attach(companyId, invoiceId, kept)
    await attach(companyId, invoiceId, removed)

    await getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [removed])
    expect(await linkCount(invoiceId)).toBe(1)

    await getPool().query(`DELETE FROM public.invoices WHERE id = $1`, [invoiceId])
    expect(await linkCount(invoiceId)).toBe(0)
    expect(await documentExists(kept)).toBe(true)
  })

  it('the sandbox teardown window releases both for a sandbox company only', async () => {
    const sandbox = await seedMember()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, is_sandbox) VALUES ($1, $2, true)`,
      [sandbox.userId, sandbox.companyId],
    )
    const real = await seedMember()

    const seedSent = async (companyId: string, userId: string) => {
      const invoiceId = await insertInvoice({ userId, companyId })
      const documentId = await insertDocument({ userId, companyId })
      await attach(companyId, invoiceId, documentId)
      await getPool().query(
        `UPDATE public.invoices SET status = 'sent', invoice_number = $2 WHERE id = $1`,
        [invoiceId, `F-${invoiceId.slice(0, 8)}`],
      )
      return { invoiceId, documentId }
    }
    const sandboxRows = await seedSent(sandbox.companyId, sandbox.userId)
    const realRows = await seedSent(real.companyId, real.userId)

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.sandbox_cleanup', 'true', true)`)
      await client.query(`DELETE FROM public.document_attachments WHERE id = $1`, [sandboxRows.documentId])
      await expect(
        client.query(`DELETE FROM public.document_attachments WHERE id = $1`, [realRows.documentId]),
      ).rejects.toThrow(/retention: document was sent as an attachment/)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
