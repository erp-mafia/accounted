/**
 * pg-real test for 20261109170000_imported_invoice_deliveries.sql (#165).
 *
 * The customer-invoice PDF imported from Fortnox is recorded as an invoice
 * delivery with channel 'import'. What must hold:
 *   - only the service-only RPC writes it, for a writable member, with the
 *     evidence columns read from the stored document;
 *   - one imported original per invoice: a second call answers NULL;
 *   - the row has no recipients or message, needs its document, and is
 *     immutable from its insert; its PDF cannot be deleted;
 *   - the rebuilt payload_shape and channel_check keep every email and manual
 *     shape the earlier migrations allowed.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { seedCompany } from './fixtures'

const RECORD = `SELECT public.record_imported_invoice_delivery($1, $2, $3, 'fortnox', $4, $5)::text AS id`

async function insertInvoice(userId: string, companyId: string): Promise<string> {
  const customerId = randomUUID()
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name)
     VALUES ($1, $2, $3, 'Imported Invoice Customer')`,
    [customerId, userId, companyId],
  )
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number,
        invoice_date, due_date, currency, subtotal, vat_amount, total,
        vat_treatment, vat_rate, moms_ruta, status)
     VALUES ($1, $2, $3, $4, $5,
             '2026-07-22', '2026-08-21', 'SEK', 1000, 250, 1250,
             'standard_25', 25, '10', 'sent')`,
    [invoiceId, userId, companyId, customerId, `F-${randomUUID().slice(0, 8)}`],
  )
  return invoiceId
}

async function insertDocument(userId: string, companyId: string, sha256 = 'b'.repeat(64)): Promise<string> {
  const documentId = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, storage_path, file_name, file_size_bytes,
        mime_type, sha256_hash)
     VALUES ($1, $2, $3, $4, 'Faktura 1001.pdf', 2048, 'application/pdf', $5)`,
    [documentId, userId, companyId, `documents/${userId}/${documentId}.pdf`, sha256],
  )
  return documentId
}

async function recordImport(params: {
  companyId: string
  invoiceId: string
  userId: string
  documentId: string
  reference?: string
}): Promise<string | null> {
  return runAsServiceRole(async (client) => {
    const { rows } = await client.query<{ id: string | null }>(RECORD, [
      params.companyId,
      params.invoiceId,
      params.userId,
      params.reference ?? `invoice:1001:${params.invoiceId}`,
      params.documentId,
    ])
    return rows[0].id
  })
}

describe('imported invoice deliveries (#165)', () => {
  it('records the imported original with the evidence read from the stored document', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)

    const deliveryId = await recordImport({ companyId, invoiceId, userId, documentId })

    expect(deliveryId).not.toBeNull()
    const { rows } = await getPool().query(
      `SELECT channel, status, user_id, provider, provider_message_id, document_attachment_id,
              attachment_filename, attachment_content_type, attachment_sha256,
              to_addresses, cc_addresses, bcc_addresses, subject, sent_at, retention_expires_at
         FROM public.invoice_deliveries WHERE id = $1`,
      [deliveryId],
    )
    expect(rows[0]).toMatchObject({
      channel: 'import',
      status: 'sent',
      user_id: userId,
      provider: 'fortnox',
      provider_message_id: `invoice:1001:${invoiceId}`,
      document_attachment_id: documentId,
      attachment_filename: 'Faktura 1001.pdf',
      attachment_content_type: 'application/pdf',
      attachment_sha256: 'b'.repeat(64),
      to_addresses: [],
      cc_addresses: [],
      bcc_addresses: [],
      subject: null,
    })
    expect(rows[0].sent_at).not.toBeNull()
    expect(rows[0].retention_expires_at).not.toBeNull()
  })

  it('keeps one imported original per invoice: a second run gets NULL and adds nothing', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(userId, companyId)
    const first = await insertDocument(userId, companyId)
    const rerendered = await insertDocument(userId, companyId, 'c'.repeat(64))

    expect(await recordImport({ companyId, invoiceId, userId, documentId: first })).not.toBeNull()
    expect(
      await recordImport({
        companyId,
        invoiceId,
        userId,
        documentId: rerendered,
        reference: `invoice:1001:${invoiceId}:again`,
      }),
    ).toBeNull()

    const { rows } = await getPool().query(
      `SELECT document_attachment_id FROM public.invoice_deliveries WHERE invoice_id = $1 AND channel = 'import'`,
      [invoiceId],
    )
    expect(rows).toEqual([{ document_attachment_id: first }])
  })

  it('refuses authenticated callers, non-members and a document from another company', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)
    const other = await seedCompany()
    const foreignDocument = await insertDocument(other.userId, other.companyId)

    await expect(
      withUserContext(userId, (client) =>
        client.query(RECORD, [companyId, invoiceId, userId, `invoice:1001:${invoiceId}`, documentId]),
      ),
    ).rejects.toThrow(/permission denied/i)

    await expect(
      recordImport({ companyId, invoiceId, userId: other.userId, documentId }),
    ).rejects.toThrow(/not a writable company member/i)

    await expect(
      recordImport({ companyId, invoiceId, userId, documentId: foreignDocument }),
    ).rejects.toThrow(/document not found in company/i)
  })

  it('keeps the imported row immutable and its PDF undeletable', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)
    const deliveryId = await recordImport({ companyId, invoiceId, userId, documentId })

    await expect(
      getPool().query(
        `UPDATE public.invoice_deliveries SET provider_message_id = 'changed' WHERE id = $1`,
        [deliveryId],
      ),
    ).rejects.toThrow(/immutable/i)

    // The delete trigger swallows the delete and logs it.
    await getPool().query(`DELETE FROM public.invoice_deliveries WHERE id = $1`, [deliveryId])
    const kept = await getPool().query(`SELECT id FROM public.invoice_deliveries WHERE id = $1`, [deliveryId])
    expect(kept.rowCount).toBe(1)

    await expect(
      getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [documentId]),
    ).rejects.toThrow(/exact PDF sent with a customer invoice/i)
  })

  it('refuses an import without its document, with a message payload, or in another status', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)

    await expect(
      getPool().query(
        `INSERT INTO public.invoice_deliveries
           (company_id, user_id, invoice_id, channel, status, provider, provider_message_id, sent_at)
         VALUES ($1, $2, $3, 'import', 'sent', 'fortnox', $4, now())`,
        [companyId, userId, invoiceId, `invoice:1:${randomUUID()}`],
      ),
    ).rejects.toThrow(/payload_shape/i)

    await expect(
      getPool().query(
        `INSERT INTO public.invoice_deliveries
           (company_id, user_id, invoice_id, channel, status, provider, provider_message_id,
            to_addresses, subject, document_attachment_id, attachment_filename,
            attachment_content_type, attachment_sha256, sent_at)
         VALUES ($1, $2, $3, 'import', 'sent', 'fortnox', $4,
                 ARRAY['customer@example.com'], 'Faktura', $5, 'Faktura 1001.pdf',
                 'application/pdf', $6, now())`,
        [companyId, userId, invoiceId, `invoice:2:${randomUUID()}`, documentId, 'b'.repeat(64)],
      ),
    ).rejects.toThrow(/payload_shape/i)

    await expect(
      getPool().query(
        `INSERT INTO public.invoice_deliveries
           (company_id, user_id, invoice_id, channel, status, provider, provider_message_id,
            document_attachment_id, attachment_filename, attachment_content_type, attachment_sha256)
         VALUES ($1, $2, $3, 'import', 'pending', 'fortnox', $4, $5,
                 'Faktura 1001.pdf', 'application/pdf', $6)`,
        [companyId, userId, invoiceId, `invoice:3:${randomUUID()}`, documentId, 'b'.repeat(64)],
      ),
    ).rejects.toThrow(/payload_shape/i)
  })

  it('keeps the email and manual shapes and refuses any other channel', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(userId, companyId)

    // An email reservation (the 'preparing' shape) and a manual mark.
    const reserved = await runAsServiceRole(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT public.reserve_invoice_delivery($1, $2, $3)::text AS id`,
        [companyId, invoiceId, userId],
      )
      return rows[0].id
    })
    expect(reserved).toBeTruthy()
    await getPool().query(
      `INSERT INTO public.invoice_deliveries (company_id, user_id, invoice_id, channel, status, sent_at)
       VALUES ($1, $2, $3, 'manual', 'marked_sent', now())`,
      [companyId, userId, invoiceId],
    )

    await expect(
      getPool().query(
        `INSERT INTO public.invoice_deliveries (company_id, user_id, invoice_id, channel, status, sent_at)
         VALUES ($1, $2, $3, 'peppol', 'marked_sent', now())`,
        [companyId, userId, invoiceId],
      ),
    ).rejects.toThrow(/channel_check/i)
  })
})
