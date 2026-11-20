/**
 * pg-real test for public.invoice_underlag (20261108073541, accounted#42):
 * the archived documents a customer invoice rests on.
 *
 * What must hold:
 *   - a member links and unlinks underlag in any state of the invoice, a sent
 *     one included; unlinking leaves the document in the archive;
 *   - a link is a reference: a document on a posted verifikat (a supplier
 *     invoice's) is linked as it is and keeps its own journal_entry_id;
 *   - a link names an invoice and a document of its own company, never
 *     another company's (RLS for a member, the guard for every caller, the
 *     service role of the v1 and MCP doors included);
 *   - a viewer and a member of another company change nothing;
 *   - a link is never rewritten;
 *   - deleting a draft or an unlinked document takes the link with it.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { insertCompanyMember, insertPostedJournalEntry, seedCompany, setActiveCompany } from './fixtures'

async function insertInvoice(params: { userId: string; companyId: string; status?: string }): Promise<string> {
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

async function insertDocument(params: { userId: string; companyId: string; journalEntryId?: string }): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, storage_path, file_name, sha256_hash, file_size_bytes, mime_type, journal_entry_id)
     VALUES ($1, $2, $3, $4, 'dahl-faktura.pdf', $5, 2048, 'application/pdf', $6)`,
    [
      id,
      params.userId,
      params.companyId,
      `${params.companyId}/${id}.pdf`,
      id.replace(/-/g, '').padEnd(64, '0'),
      params.journalEntryId ?? null,
    ],
  )
  return id
}

async function link(companyId: string, invoiceId: string, documentId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.invoice_underlag (company_id, invoice_id, document_id) VALUES ($1, $2, $3)`,
    [companyId, invoiceId, documentId],
  )
}

async function linkCount(invoiceId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.invoice_underlag WHERE invoice_id = $1`,
    [invoiceId],
  )
  return Number(rows[0]!.n)
}

async function seedMember() {
  const seeded = await seedCompany()
  await setActiveCompany(seeded.userId, seeded.companyId)
  return seeded
}

describe('invoice_underlag (pg)', () => {
  it('a member links and unlinks underlag on a sent invoice; unlinking keeps the document', async () => {
    const { userId, companyId } = await seedMember()
    const invoiceId = await insertInvoice({ userId, companyId, status: 'sent' })
    const documentId = await insertDocument({ userId, companyId })

    await withUserContext(userId, async (client) => {
      await client.query(
        `INSERT INTO public.invoice_underlag (company_id, invoice_id, document_id) VALUES ($1, $2, $3)`,
        [companyId, invoiceId, documentId],
      )
      const { rows: visible } = await client.query(
        `SELECT document_id FROM public.invoice_underlag WHERE invoice_id = $1`,
        [invoiceId],
      )
      expect(visible).toEqual([{ document_id: documentId }])

      const { rowCount } = await client.query(
        `DELETE FROM public.invoice_underlag WHERE invoice_id = $1 AND document_id = $2`,
        [invoiceId, documentId],
      )
      expect(rowCount).toBe(1)
      const { rows: doc } = await client.query(`SELECT 1 FROM public.document_attachments WHERE id = $1`, [documentId])
      expect(doc).toHaveLength(1)
    })
  })

  it('links a document on a posted verifikat as a reference: its own verifikat link stays', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedMember()
    const entryId = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, entryDate: '2026-05-20' })
    const supplierDocument = await insertDocument({ userId, companyId, journalEntryId: entryId })
    const first = await insertInvoice({ userId, companyId, status: 'sent' })
    const second = await insertInvoice({ userId, companyId, status: 'paid' })

    // withUserContext rolls back at the end: every check runs inside it.
    await withUserContext(userId, async (client) => {
      // One wholesaler invoice can back two customer invoices.
      for (const invoiceId of [first, second]) {
        await client.query(
          `INSERT INTO public.invoice_underlag (company_id, invoice_id, document_id) VALUES ($1, $2, $3)`,
          [companyId, invoiceId, supplierDocument],
        )
      }
      await client.query(`DELETE FROM public.invoice_underlag WHERE invoice_id = $1`, [first])

      const { rows: links } = await client.query<{ invoice_id: string }>(
        `SELECT invoice_id FROM public.invoice_underlag WHERE document_id = $1`,
        [supplierDocument],
      )
      expect(links).toEqual([{ invoice_id: second }])
      const { rows } = await client.query<{ journal_entry_id: string }>(
        `SELECT journal_entry_id FROM public.document_attachments WHERE id = $1`,
        [supplierDocument],
      )
      expect(rows).toEqual([{ journal_entry_id: entryId }])
    })
  })

  it('never links across companies, whoever writes', async () => {
    const a = await seedMember()
    const b = await seedCompany()
    const invoiceId = await insertInvoice({ userId: a.userId, companyId: a.companyId })
    const foreignDocument = await insertDocument({ userId: b.userId, companyId: b.companyId })

    // The guard refuses it for any caller, the service-role doors included.
    await expect(link(a.companyId, invoiceId, foreignDocument)).rejects.toThrow(/document\/company mismatch/)
    // Nor can a row claim another company's invoice.
    const ownDocument = await insertDocument({ userId: b.userId, companyId: b.companyId })
    await expect(link(b.companyId, invoiceId, ownDocument)).rejects.toThrow(/invoice\/company mismatch/)
  })

  it('a member of another company sees and changes nothing', async () => {
    const owner = await seedMember()
    const outsider = await seedMember()
    const invoiceId = await insertInvoice({ userId: owner.userId, companyId: owner.companyId })
    const documentId = await insertDocument({ userId: owner.userId, companyId: owner.companyId })
    await link(owner.companyId, invoiceId, documentId)

    await withUserContext(outsider.userId, async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM public.invoice_underlag WHERE invoice_id = $1`, [invoiceId])
      expect(rows).toHaveLength(0)
      const { rowCount } = await client.query(`DELETE FROM public.invoice_underlag WHERE invoice_id = $1`, [invoiceId])
      expect(rowCount).toBe(0)
      await expect(
        client.query(
          `INSERT INTO public.invoice_underlag (company_id, invoice_id, document_id) VALUES ($1, $2, $3)`,
          [owner.companyId, invoiceId, documentId],
        ),
      ).rejects.toThrow(/row-level security/)
    })
    expect(await linkCount(invoiceId)).toBe(1)
  })

  it('a viewer reads but cannot link or unlink', async () => {
    const { userId, companyId } = await seedMember()
    const viewer = randomUUID()
    await getPool().query(
      `INSERT INTO auth.users (id, email, instance_id) VALUES ($1, $2, '00000000-0000-0000-0000-000000000000'::uuid)`,
      [viewer, `pg-real-${viewer}@test.invalid`],
    )
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    await setActiveCompany(viewer, companyId)
    const invoiceId = await insertInvoice({ userId, companyId })
    const linked = await insertDocument({ userId, companyId })
    const other = await insertDocument({ userId, companyId })
    await link(companyId, invoiceId, linked)

    await withUserContext(viewer, async (client) => {
      const { rows } = await client.query(`SELECT document_id FROM public.invoice_underlag WHERE invoice_id = $1`, [invoiceId])
      expect(rows).toEqual([{ document_id: linked }])
      const { rowCount } = await client.query(`DELETE FROM public.invoice_underlag WHERE invoice_id = $1`, [invoiceId])
      expect(rowCount).toBe(0)
      // Last: the refusal aborts the transaction.
      await expect(
        client.query(
          `INSERT INTO public.invoice_underlag (company_id, invoice_id, document_id) VALUES ($1, $2, $3)`,
          [companyId, invoiceId, other],
        ),
      ).rejects.toThrow(/row-level security/)
    })
    expect(await linkCount(invoiceId)).toBe(1)
  })

  it('a link is never rewritten and never doubled', async () => {
    const { userId, companyId } = await seedMember()
    const invoiceId = await insertInvoice({ userId, companyId })
    const documentId = await insertDocument({ userId, companyId })
    await link(companyId, invoiceId, documentId)

    await expect(
      getPool().query(`UPDATE public.invoice_underlag SET created_at = now() WHERE invoice_id = $1`, [invoiceId]),
    ).rejects.toThrow(/never rewritten/)
    await expect(link(companyId, invoiceId, documentId)).rejects.toThrow(/invoice_underlag_invoice_document_key/)
    expect(await linkCount(invoiceId)).toBe(1)
  })

  it('deleting a draft or an unlinked document takes the link with it', async () => {
    const { userId, companyId } = await seedMember()
    const invoiceId = await insertInvoice({ userId, companyId })
    const kept = await insertDocument({ userId, companyId })
    const removed = await insertDocument({ userId, companyId })
    await link(companyId, invoiceId, kept)
    await link(companyId, invoiceId, removed)

    await getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [removed])
    expect(await linkCount(invoiceId)).toBe(1)

    await getPool().query(`DELETE FROM public.invoices WHERE id = $1`, [invoiceId])
    expect(await linkCount(invoiceId)).toBe(0)
    const { rows } = await getPool().query(`SELECT 1 FROM public.document_attachments WHERE id = $1`, [kept])
    expect(rows).toHaveLength(1)
  })
})
