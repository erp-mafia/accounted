import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertPostedJournalEntry, seedCompany } from './fixtures'

// record_bokio_upload runs once per Bokio receipt in the provider underlag
// import (arcim-migration/lib/import-documents.ts), as the signed-in user.
// A failure there counts the receipt as failed even though its file is
// already archived, so the function is exercised here against real Postgres
// before the import is offered to Bokio users (crm#190).

const PROVIDER_COMPANY_ID = 'bokio-company-1'

async function seedBokioCompany() {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const consentId = randomUUID()
  await getPool().query(
    `INSERT INTO provider_consents (id, company_id, name, status, provider)
     VALUES ($1, $2, $3, 1, 'bokio')`,
    [consentId, companyId, `pg-real-${consentId}`],
  )
  await getPool().query(
    `INSERT INTO provider_consent_tokens (consent_id, provider, access_token, provider_company_id)
     VALUES ($1, 'bokio', 'token', $2)`,
    [consentId, PROVIDER_COMPANY_ID],
  )
  const journalEntryId = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId })
  return { userId, companyId, consentId, journalEntryId }
}

async function insertDocument(params: {
  userId: string
  companyId: string
  journalEntryId: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, storage_path, file_name, sha256_hash, journal_entry_id, upload_source)
     VALUES ($1, $2, $3, $4, 'Kvitto.pdf', $5, $6, 'api')`,
    [id, params.userId, params.companyId, `documents/${params.companyId}/${id}.pdf`, randomUUID(), params.journalEntryId],
  )
  return id
}

function recordUpload(
  client: PoolClient,
  params: { companyId: string; consentId: string; uploadId: string; documentId: string },
) {
  return client.query('SELECT public.record_bokio_upload($1, $2, $3, $4)', [
    params.companyId,
    params.consentId,
    params.uploadId,
    params.documentId,
  ])
}

async function uploadMappings(client: PoolClient, companyId: string) {
  const { rows } = await client.query<{ source_id: string; target_id: string; account_key: string }>(
    `SELECT source_id, target_id, account_key FROM migration_source_records
      WHERE company_id = $1 AND provider = 'bokio' AND resource = 'uploads'`,
    [companyId],
  )
  return rows
}

describe('record_bokio_upload (pg-real)', () => {
  it('maps a Bokio upload to the linked document it was archived as, as the signed-in user', async () => {
    const seed = await seedBokioCompany()
    const documentId = await insertDocument({ ...seed, journalEntryId: seed.journalEntryId })

    await withUserContext(seed.userId, async (client) => {
      await recordUpload(client, { ...seed, uploadId: 'up-1', documentId })

      expect(await uploadMappings(client, seed.companyId)).toEqual([
        { source_id: 'up-1', target_id: documentId, account_key: PROVIDER_COMPANY_ID },
      ])
    })
  })

  it('is idempotent for the same upload and document (a re-run skip records it again)', async () => {
    const seed = await seedBokioCompany()
    const documentId = await insertDocument({ ...seed, journalEntryId: seed.journalEntryId })

    await withUserContext(seed.userId, async (client) => {
      await recordUpload(client, { ...seed, uploadId: 'up-1', documentId })
      await recordUpload(client, { ...seed, uploadId: 'up-1', documentId })

      expect(await uploadMappings(client, seed.companyId)).toHaveLength(1)
    })
  })

  it('refuses a second document for an upload that is already mapped', async () => {
    const seed = await seedBokioCompany()
    const first = await insertDocument({ ...seed, journalEntryId: seed.journalEntryId })
    const second = await insertDocument({ ...seed, journalEntryId: seed.journalEntryId })

    await withUserContext(seed.userId, async (client) => {
      await recordUpload(client, { ...seed, uploadId: 'up-1', documentId: first })
      await expect(recordUpload(client, { ...seed, uploadId: 'up-1', documentId: second })).rejects.toThrow(
        'BOKIO_UPLOAD_IDENTITY_CONFLICT',
      )
    })
  })

  it('refuses a document that is not linked to a verifikat', async () => {
    const seed = await seedBokioCompany()
    const unlinked = await insertDocument({ ...seed, journalEntryId: null })

    await withUserContext(seed.userId, async (client) => {
      await expect(recordUpload(client, { ...seed, uploadId: 'up-1', documentId: unlinked })).rejects.toThrow(
        'BOKIO_UPLOAD_INVALID',
      )
    })
  })

  it('refuses a caller who is not a member of the company', async () => {
    const seed = await seedBokioCompany()
    const documentId = await insertDocument({ ...seed, journalEntryId: seed.journalEntryId })
    const outsider = await insertAuthUser()

    await withUserContext(outsider, async (client) => {
      await expect(recordUpload(client, { ...seed, uploadId: 'up-1', documentId })).rejects.toThrow('FORBIDDEN')
    })
  })

  it('completes a migrated supplier invoice once every upload it references maps to one document', async () => {
    const seed = await seedBokioCompany()
    const documentId = await insertDocument({ ...seed, journalEntryId: seed.journalEntryId })

    const supplierId = randomUUID()
    await getPool().query(
      `INSERT INTO public.suppliers
         (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
       VALUES ($1, $2, $3, 'Leverantör AB', 'swedish_business', 'SE', 30, 'SEK')`,
      [supplierId, seed.userId, seed.companyId],
    )
    const invoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.supplier_invoices
         (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
          invoice_date, due_date, received_date, status, currency,
          subtotal, vat_amount, total, paid_amount, remaining_amount,
          vat_treatment, reverse_charge, is_credit_note)
       VALUES ($1, $2, $3, $4, 1, 'F-1', '2026-04-01', '2026-05-01', '2026-04-01', 'approved', 'SEK',
               800, 200, 1000, 0, 1000, 'standard_25', false, false)`,
      [invoiceId, seed.userId, seed.companyId, supplierId],
    )
    // The Bokio migration recorded which uploads back this invoice.
    await getPool().query(
      `INSERT INTO migration_source_records
         (company_id, user_id, provider, account_key, resource, source_id, target_id, source_metadata)
       VALUES ($1, $2, 'bokio', $3, 'supplierInvoices', 'bokio-invoice-1', $4, $5::jsonb)`,
      [seed.companyId, seed.userId, PROVIDER_COMPANY_ID, invoiceId, JSON.stringify({ upload_ids: ['up-1', 'up-2'] })],
    )

    await withUserContext(seed.userId, async (client) => {
      const documentOf = async () =>
        (await client.query<{ document_id: string | null }>(
          'SELECT document_id FROM supplier_invoices WHERE id = $1',
          [invoiceId],
        )).rows[0].document_id

      // One of two references resolved: a partial import waits.
      await recordUpload(client, { ...seed, uploadId: 'up-1', documentId })
      expect(await documentOf()).toBeNull()

      // Both resolve to the same retained file: the invoice gets it.
      await recordUpload(client, { ...seed, uploadId: 'up-2', documentId })
      expect(await documentOf()).toBe(documentId)

      const { rows } = await client.query<{ event_type: string }>(
        `SELECT event_type FROM processing_history
          WHERE company_id = $1 AND aggregate_type = 'SupplierInvoice' AND aggregate_id = $2`,
        [seed.companyId, invoiceId],
      )
      expect(rows.map((row) => row.event_type)).toEqual(['SupplierInvoiceCompleted'])
    })
  })
})
