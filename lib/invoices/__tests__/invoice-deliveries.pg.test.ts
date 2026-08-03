import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from '@/tests/pg/fixtures'

async function withServiceRoleContext<T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'service_role' }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query(`SELECT set_config('request.jwt.claim.role', 'service_role', true)`)
    await client.query(`SET LOCAL ROLE service_role`)
    const result = await fn(client)
    await client.query('ROLLBACK')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function insertInvoice(userId: string, companyId: string): Promise<string> {
  const customerId = randomUUID()
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name)
     VALUES ($1, $2, $3, 'Delivery History Customer')`,
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

async function insertDocument(userId: string, companyId: string): Promise<string> {
  const documentId = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, storage_path, file_name, file_size_bytes,
        mime_type, sha256_hash)
     VALUES ($1, $2, $3, $4, 'invoice.pdf', 1024, 'application/pdf', $5)`,
    [
      documentId,
      userId,
      companyId,
      `documents/${userId}/${documentId}.pdf`,
      'a'.repeat(64),
    ],
  )
  return documentId
}

async function insertManualDelivery(params: {
  userId: string
  companyId: string
  invoiceId: string
}): Promise<string> {
  const deliveryId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoice_deliveries
       (id, user_id, company_id, invoice_id, channel, status, sent_at)
     VALUES ($1, $2, $3, $4, 'manual', 'marked_sent', now())`,
    [deliveryId, params.userId, params.companyId, params.invoiceId],
  )
  return deliveryId
}

async function insertPendingEmailDelivery(params: {
  userId: string
  companyId: string
  invoiceId: string
  documentId: string
  retentionExpiresAt?: string
  toAddresses?: string[]
  ccAddresses?: string[]
  bccAddresses?: string[]
}): Promise<string> {
  const deliveryId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoice_deliveries
       (id, user_id, company_id, invoice_id, channel, status,
        to_addresses, cc_addresses, bcc_addresses, reply_to, from_name, subject,
        body_text, body_html, document_attachment_id, attachment_filename,
        attachment_content_type, attachment_sha256, retention_expires_at)
     VALUES ($1, $2, $3, $4, 'email', 'pending',
             $8::text[], $9::text[], $10::text[],
             'sender@example.com', 'Example AB', 'Faktura F-1001',
             'Exact plain text', '<p>Exact HTML</p>', $5,
             'invoice.pdf', 'application/pdf', $6, $7)`,
    [
      deliveryId,
      params.userId,
      params.companyId,
      params.invoiceId,
      params.documentId,
      'a'.repeat(64),
      params.retentionExpiresAt ?? null,
      params.toAddresses ?? ['customer@example.com'],
      params.ccAddresses ?? ['copy@example.com'],
      params.bccAddresses ?? ['archive@example.com'],
    ],
  )
  return deliveryId
}

/**
 * A delivery that has already been handed to the provider: this is the only
 * state a provider delivery report can attach to, and the provider message id
 * is the key the report is matched on.
 */
async function insertSentEmailDelivery(params: {
  userId: string
  companyId: string
  invoiceId: string
  documentId: string
  retentionExpiresAt?: string
  toAddresses?: string[]
  ccAddresses?: string[]
  bccAddresses?: string[]
}): Promise<{ deliveryId: string; providerMessageId: string }> {
  const deliveryId = await insertPendingEmailDelivery(params)
  const providerMessageId = `provider-${randomUUID()}`
  await getPool().query(
    `UPDATE public.invoice_deliveries
        SET status = 'sent', provider = 'resend',
            provider_message_id = $2, sent_at = now()
      WHERE id = $1`,
    [deliveryId, providerMessageId],
  )
  return { deliveryId, providerMessageId }
}

describe('invoice_deliveries.pg: immutable delivery evidence', () => {
  it('allows only a pending to terminal transition and then locks the row', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)
    const deliveryId = await insertPendingEmailDelivery({
      userId,
      companyId,
      invoiceId,
      documentId,
    })

    await getPool().query(
      `UPDATE public.invoice_deliveries
          SET status = 'sent', provider = 'resend',
              provider_message_id = 'provider-1', sent_at = now()
        WHERE id = $1`,
      [deliveryId],
    )

    await expect(
      getPool().query(
        `UPDATE public.invoice_deliveries SET body_text = 'tampered' WHERE id = $1`,
        [deliveryId],
      ),
    ).rejects.toThrow(/terminal invoice delivery.*immutable/i)
    await getPool().query(`DELETE FROM public.invoice_deliveries WHERE id = $1`, [deliveryId])
    const retained = await getPool().query(
      `SELECT id FROM public.invoice_deliveries WHERE id = $1`,
      [deliveryId],
    )
    const deleteAudit = await getPool().query(
      `SELECT old_state
         FROM public.audit_log
        WHERE table_name = 'invoice_deliveries'
          AND record_id = $1
          AND action = 'SECURITY_EVENT'
        ORDER BY created_at DESC
        LIMIT 1`,
      [deliveryId],
    )
    expect(retained.rowCount).toBe(1)
    expect(deleteAudit.rowCount).toBe(1)
    expect(deleteAudit.rows[0].old_state).not.toHaveProperty('body_text')
    expect(deleteAudit.rows[0].old_state).not.toHaveProperty('to_addresses')
  })

  it('blocks payload changes while finalizing a pending email', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)
    const deliveryId = await insertPendingEmailDelivery({
      userId,
      companyId,
      invoiceId,
      documentId,
    })

    await expect(
      getPool().query(
        `UPDATE public.invoice_deliveries
            SET status = 'sent', sent_at = now(), subject = 'Changed subject'
          WHERE id = $1`,
        [deliveryId],
      ),
    ).rejects.toThrow(/invoice delivery payload is immutable/i)

    await expect(
      getPool().query(
        `UPDATE public.invoice_deliveries
            SET status = 'sent', sent_at = now(),
                bcc_addresses = ARRAY['changed@example.com']
          WHERE id = $1`,
        [deliveryId],
      ),
    ).rejects.toThrow(/invoice delivery payload is immutable/i)
  })

  it('rejects invoice and document references from another company', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const invoiceA = await insertInvoice(a.userId, a.companyId)
    const documentB = await insertDocument(b.userId, b.companyId)

    await expect(
      insertManualDelivery({
        userId: b.userId,
        companyId: b.companyId,
        invoiceId: invoiceA,
      }),
    ).rejects.toThrow(/invoice delivery invoice\/company mismatch/i)

    await expect(
      insertPendingEmailDelivery({
        userId: a.userId,
        companyId: a.companyId,
        invoiceId: invoiceA,
        documentId: documentB,
      }),
    ).rejects.toThrow(/invoice delivery document\/company mismatch/i)
  })

  it('prevents deletion of the exact PDF after a successful send', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)
    const deliveryId = await insertPendingEmailDelivery({
      userId,
      companyId,
      invoiceId,
      documentId,
    })
    await getPool().query(
      `UPDATE public.invoice_deliveries SET status = 'sent', sent_at = now() WHERE id = $1`,
      [deliveryId],
    )

    await expect(
      getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [documentId]),
    ).rejects.toThrow(/exact PDF sent with a customer invoice/i)
  })

  it('isolates delivery history by company through RLS', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const deliveryA = await insertManualDelivery({
      userId: a.userId,
      companyId: a.companyId,
      invoiceId: await insertInvoice(a.userId, a.companyId),
    })
    await insertManualDelivery({
      userId: b.userId,
      companyId: b.companyId,
      invoiceId: await insertInvoice(b.userId, b.companyId),
    })

    const visibleIds = await withUserContext(a.userId, async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id FROM public.invoice_deliveries WHERE company_id = ANY($1::uuid[])`,
        [[a.companyId, b.companyId]],
      )
      return result.rows.map((row) => row.id)
    })

    expect(visibleIds).toEqual([deliveryA])
  })

  it('keeps exact payload sender-only and exposes masked summaries to members', async () => {
    const { userId, companyId } = await seedCompany()
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)
    const deliveryId = await insertPendingEmailDelivery({
      userId,
      companyId,
      invoiceId,
      documentId,
    })
    await getPool().query(
      `UPDATE public.invoice_deliveries SET status = 'sent', sent_at = now() WHERE id = $1`,
      [deliveryId],
    )

    const directRows = await withUserContext(memberId, async (client) => {
      return client.query(
        `SELECT id, bcc_addresses, body_text
           FROM public.invoice_deliveries
          WHERE id = $1`,
        [deliveryId],
      )
    })
    expect(directRows.rowCount).toBe(0)

    const summary = await withUserContext(memberId, async (client) => {
      return client.query<Record<string, unknown>>(
        `SELECT *
           FROM public.list_invoice_delivery_summaries($1, $2)`,
        [companyId, invoiceId],
      )
    })
    expect(summary.rows).toEqual([
      expect.objectContaining({
        id: deliveryId,
        to_addresses: ['***@example.com'],
        cc_addresses: ['***@example.com'],
        attachment_filename: 'invoice.pdf',
      }),
    ])
    expect(summary.rows[0]).not.toHaveProperty('bcc_addresses')
    expect(summary.rows[0]).not.toHaveProperty('body_text')

    const documentLookup = await withUserContext(memberId, (client) => client.query<{ id: string }>(
      `SELECT public.latest_sent_invoice_delivery_document($1, $2)::text AS id`,
      [companyId, invoiceId],
    ))
    expect(documentLookup.rows[0].id).toBe(documentId)

    const other = await seedCompany()
    const otherInvoiceId = await insertInvoice(other.userId, other.companyId)
    const otherDocumentId = await insertDocument(other.userId, other.companyId)
    const otherDeliveryId = await insertPendingEmailDelivery({
      userId: other.userId,
      companyId: other.companyId,
      invoiceId: otherInvoiceId,
      documentId: otherDocumentId,
    })
    await getPool().query(
      `UPDATE public.invoice_deliveries SET status = 'sent', sent_at = now() WHERE id = $1`,
      [otherDeliveryId],
    )

    const mismatchedInvoiceLookup = await withUserContext(memberId, (client) =>
      client.query<{ id: string | null }>(
        `SELECT public.latest_sent_invoice_delivery_document($1, $2)::text AS id`,
        [companyId, otherInvoiceId],
      ),
    )
    expect(mismatchedInvoiceLookup.rows[0].id).toBeNull()
    await expect(
      withUserContext(memberId, (client) => client.query(
        `SELECT public.latest_sent_invoice_delivery_document($1, $2)`,
        [other.companyId, otherInvoiceId],
      )),
    ).rejects.toThrow(/not authorized to find delivered invoice document/i)

    await expect(
      withUserContext(memberId, (client) => client.query(
        `SELECT id FROM public.export_invoice_delivery_evidence($1)`,
        [companyId],
      )),
    ).rejects.toThrow(/owner or admin role required/i)

    const ownerExport = await withUserContext(userId, (client) => client.query<{
      id: string
      bcc_addresses: string[]
    }>(
      `SELECT id, bcc_addresses
         FROM public.export_invoice_delivery_evidence($1)
        WHERE id = $2`,
      [companyId, deliveryId],
    ))
    expect(ownerExport.rows[0]).toEqual({
      id: deliveryId,
      bcc_addresses: ['archive@example.com'],
    })

    const senderPayload = await withUserContext(userId, async (client) => {
      return client.query<{ bcc_addresses: string[]; body_text: string }>(
        `SELECT bcc_addresses, body_text
           FROM public.invoice_deliveries
          WHERE id = $1`,
        [deliveryId],
      )
    })
    expect(senderPayload.rows[0]).toEqual({
      bcc_addresses: ['archive@example.com'],
      body_text: 'Exact plain text',
    })
  })

  it('denies inserts to a viewer', async () => {
    const { userId, companyId } = await seedCompany()
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })
    const invoiceId = await insertInvoice(userId, companyId)

    await expect(
      withUserContext(viewerId, async (client) => {
        await client.query(
          `INSERT INTO public.invoice_deliveries
             (user_id, company_id, invoice_id, channel, status, sent_at)
           VALUES ($1, $2, $3, 'manual', 'marked_sent', now())`,
          [viewerId, companyId, invoiceId],
        )
      }),
    ).rejects.toThrow(/row-level security|policy/i)
  })

  it('denies direct delivery writes and RPC execution to authenticated members', async () => {
    const { userId, companyId } = await seedCompany()
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)
    const deliveryId = await insertPendingEmailDelivery({
      userId,
      companyId,
      invoiceId,
      documentId,
    })

    await expect(
      withUserContext(memberId, (client) => client.query(
        `INSERT INTO public.invoice_deliveries
           (user_id, company_id, invoice_id, channel, status, sent_at)
         VALUES ($1, $2, $3, 'manual', 'marked_sent', now())`,
        [memberId, companyId, invoiceId],
      )),
    ).rejects.toThrow(/row-level security|policy/i)

    const directUpdate = await withUserContext(userId, (client) => client.query(
      `UPDATE public.invoice_deliveries
          SET status = 'sent', sent_at = now()
        WHERE id = $1`,
      [deliveryId],
    ))
    expect(directUpdate.rowCount).toBe(0)

    await expect(
      withUserContext(memberId, (client) => client.query(
        `SELECT public.reserve_invoice_delivery($1, $2, $3)`,
        [companyId, invoiceId, userId],
      )),
    ).rejects.toThrow(/permission denied/i)

    await expect(
      withServiceRoleContext(userId, (client) => client.query(
        `SELECT public.apply_invoice_delivery_provider_event(
                  'resend', 'msg-1', 'opened', now(), NULL,
                  ARRAY['customer@example.com']
                )`,
      )),
    ).rejects.toThrow(/unsupported invoice delivery provider status/i)

    await expect(
      withUserContext(memberId, (client) => client.query(
        `SELECT public.apply_invoice_delivery_provider_event(
                  'resend', 'msg-1', 'delivered', now(), NULL,
                  ARRAY['customer@example.com']
                )`,
      )),
    ).rejects.toThrow(/permission denied/i)
  })

  it('uses server-only RPCs for reservation, payload capture, and finalization', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)

    await withServiceRoleContext(userId, async (client) => {
      const reserved = await client.query<{ id: string }>(
        `SELECT public.reserve_invoice_delivery($1, $2, $3)::text AS id`,
        [companyId, invoiceId, userId],
      )
      const deliveryId = reserved.rows[0].id

      const reused = await client.query<{ id: string }>(
        `SELECT public.reserve_invoice_delivery($1, $2, $3)::text AS id`,
        [companyId, invoiceId, userId],
      )
      expect(reused.rows[0].id).toBe(deliveryId)

      const captured = await client.query<{ id: string }>(
        `SELECT public.capture_invoice_delivery_payload(
           $1, $2, $3, $4,
           ARRAY['customer@example.com'], ARRAY['copy@example.com'], ARRAY['archive@example.com'],
           'sender@example.com', 'Example AB', 'Faktura F-1001',
           'Exact plain text', '<p>Exact HTML</p>', $5,
           'invoice.pdf', 'application/pdf', $6
         )::text AS id`,
        [deliveryId, companyId, invoiceId, userId, documentId, 'a'.repeat(64)],
      )
      expect(captured.rows[0].id).toBe(deliveryId)

      const finalized = await client.query<{ id: string }>(
        `SELECT public.finalize_invoice_delivery(
           $1, $2, $3, 'sent', 'resend', 'provider-message-1', NULL
         )::text AS id`,
        [deliveryId, companyId, userId],
      )
      expect(finalized.rows[0].id).toBe(deliveryId)

      const row = await client.query(
        `SELECT status, bcc_addresses, body_text
           FROM public.invoice_deliveries
          WHERE id = $1`,
        [deliveryId],
      )
      expect(row.rows[0]).toMatchObject({
        status: 'sent',
        bcc_addresses: ['archive@example.com'],
        body_text: 'Exact plain text',
      })
    })
  })

  it('rejects service-role delivery writes for a non-member or mismatched tenant', async () => {
    const first = await seedCompany()
    const second = await seedCompany()
    const outsiderId = await insertAuthUser()
    const invoiceId = await insertInvoice(first.userId, first.companyId)

    await expect(
      withServiceRoleContext(outsiderId, (client) => client.query(
        `SELECT public.reserve_invoice_delivery($1, $2, $3)`,
        [first.companyId, invoiceId, outsiderId],
      )),
    ).rejects.toThrow(/writable company member/i)

    await expect(
      withServiceRoleContext(second.userId, (client) => client.query(
        `SELECT public.reserve_invoice_delivery($1, $2, $3)`,
        [second.companyId, invoiceId, second.userId],
      )),
    ).rejects.toThrow(/invoice not found/i)
  })

  it('reclaims only stale payload-free reservations for another sender', async () => {
    const { userId, companyId } = await seedCompany()
    const otherUserId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: otherUserId, role: 'admin' })
    const invoiceId = await insertInvoice(userId, companyId)
    const staleId = randomUUID()

    await getPool().query(
      `INSERT INTO public.invoice_deliveries
         (id, user_id, company_id, invoice_id, channel, status, created_at)
       VALUES ($1, $2, $3, $4, 'email', 'preparing', now() - interval '16 minutes')`,
      [staleId, userId, companyId, invoiceId],
    )

    await withServiceRoleContext(otherUserId, async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT public.reserve_invoice_delivery($1, $2, $3)::text AS id`,
        [companyId, invoiceId, otherUserId],
      )
      expect(result.rows[0].id).not.toBe(staleId)

      const stale = await client.query(
        `SELECT id FROM public.invoice_deliveries WHERE id = $1`,
        [staleId],
      )
      expect(stale.rowCount).toBe(0)
    })
  })

  it('restricts fixed invoice email recipient settings to owners and admins', async () => {
    const { userId, companyId } = await seedCompany()
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id)
       VALUES ($1, $2)`,
      [userId, companyId],
    )

    const memberUpdate = await withUserContext(memberId, (client) => client.query(
      `UPDATE public.company_settings
          SET invoice_email_bcc_addresses = ARRAY['archive@example.com']
        WHERE company_id = $1`,
      [companyId],
    ))
    expect(memberUpdate.rowCount).toBe(0)

    const ownerUpdate = await withUserContext(userId, (client) => client.query(
      `UPDATE public.company_settings
          SET invoice_email_bcc_addresses = ARRAY['archive@example.com']
        WHERE company_id = $1`,
      [companyId],
    ))
    expect(ownerUpdate.rowCount).toBe(1)
  })

  it('reserves one preparing attempt and promotes it to the exact pending payload', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)
    const deliveryId = randomUUID()

    await getPool().query(
      `INSERT INTO public.invoice_deliveries
         (id, user_id, company_id, invoice_id, channel, status)
       VALUES ($1, $2, $3, $4, 'email', 'preparing')`,
      [deliveryId, userId, companyId, invoiceId],
    )

    await expect(
      getPool().query(
        `INSERT INTO public.invoice_deliveries
           (user_id, company_id, invoice_id, channel, status)
         VALUES ($1, $2, $3, 'email', 'preparing')`,
        [userId, companyId, invoiceId],
      ),
    ).rejects.toThrow(/duplicate key|unique constraint/i)

    await getPool().query(
      `UPDATE public.invoice_deliveries
          SET status = 'pending',
              to_addresses = ARRAY['customer@example.com'],
              subject = 'Faktura F-1001',
              body_text = 'Exact plain text',
              body_html = '<p>Exact HTML</p>',
              document_attachment_id = $2,
              attachment_filename = 'invoice.pdf',
              attachment_content_type = 'application/pdf',
              attachment_sha256 = $3
        WHERE id = $1`,
      [deliveryId, documentId, 'a'.repeat(64)],
    )

    const result = await getPool().query(
      `SELECT status, retention_expires_at
         FROM public.invoice_deliveries
        WHERE id = $1`,
      [deliveryId],
    )
    expect(result.rows[0].status).toBe('pending')
    expect(new Date(result.rows[0].retention_expires_at).toISOString().slice(0, 10)).toBe(
      '2034-01-01',
    )

    const nextReservationId = await withServiceRoleContext(userId, async (client) => {
      const reservation = await client.query<{ id: string }>(
        `SELECT public.reserve_invoice_delivery($1, $2, $3)::text AS id`,
        [companyId, invoiceId, userId],
      )
      const states = await client.query<{ id: string; status: string }>(
        `SELECT id, status
           FROM public.invoice_deliveries
          WHERE company_id = $1 AND invoice_id = $2
          ORDER BY created_at`,
        [companyId, invoiceId],
      )
      expect(states.rows).toEqual(expect.arrayContaining([
        { id: deliveryId, status: 'pending' },
        { id: reservation.rows[0].id, status: 'preparing' },
      ]))
      return reservation.rows[0].id
    })
    expect(nextReservationId).not.toBe(deliveryId)
  })

  it('allows a failed attempt to release and delete its unsent PDF', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)
    const deliveryId = await insertPendingEmailDelivery({
      userId,
      companyId,
      invoiceId,
      documentId,
    })

    await getPool().query(
      `UPDATE public.invoice_deliveries
          SET status = 'failed', failed_at = now(),
              error_code = 'provider_failed', document_attachment_id = NULL
        WHERE id = $1`,
      [deliveryId],
    )
    await getPool().query(
      `DELETE FROM public.document_attachments WHERE id = $1`,
      [documentId],
    )

    const document = await getPool().query(
      `SELECT id FROM public.document_attachments WHERE id = $1`,
      [documentId],
    )
    expect(document.rowCount).toBe(0)
  })

  it('redacts expired delivery PII and keeps metadata-only audit state', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)
    const deliveryId = await insertPendingEmailDelivery({
      userId,
      companyId,
      invoiceId,
      documentId,
      retentionExpiresAt: '2000-01-01',
    })
    await getPool().query(
      `UPDATE public.invoice_deliveries SET status = 'sent', sent_at = now() WHERE id = $1`,
      [deliveryId],
    )

    await getPool().query(`SELECT public.redact_expired_invoice_delivery_pii()`)

    const delivery = await getPool().query(
      `SELECT to_addresses, cc_addresses, bcc_addresses, body_text, subject, provider_message_id,
              attachment_filename, attachment_sha256, pii_redacted_at
         FROM public.invoice_deliveries
        WHERE id = $1`,
      [deliveryId],
    )
    expect(delivery.rows[0]).toMatchObject({
      to_addresses: [],
      cc_addresses: [],
      bcc_addresses: [],
      body_text: null,
      subject: null,
      provider_message_id: null,
      attachment_filename: null,
      attachment_sha256: null,
    })
    expect(delivery.rows[0].pii_redacted_at).toBeTruthy()

    const audit = await getPool().query(
      `SELECT new_state
         FROM public.audit_log
        WHERE table_name = 'invoice_deliveries'
          AND record_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [deliveryId],
    )
    expect(audit.rows[0].new_state).not.toHaveProperty('body_text')
    expect(audit.rows[0].new_state).not.toHaveProperty('to_addresses')
  })

  it('uses restrictive parent foreign keys for immutable delivery evidence', async () => {
    const constraints = await getPool().query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype
         FROM pg_constraint
        WHERE conrelid = 'public.invoice_deliveries'::regclass
          AND conname IN (
            'invoice_deliveries_company_id_fkey',
            'invoice_deliveries_user_id_fkey'
          )
        ORDER BY conname`,
    )

    expect(constraints.rows).toEqual([
      { conname: 'invoice_deliveries_company_id_fkey', confdeltype: 'r' },
      { conname: 'invoice_deliveries_user_id_fkey', confdeltype: 'r' },
    ])
  })
})

describe('invoice_deliveries.pg: provider delivery outcome', () => {
  it('tracks independent To and CC outcomes on one provider message', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)
    const { deliveryId, providerMessageId } = await insertSentEmailDelivery({
      userId,
      companyId,
      invoiceId,
      documentId,
      toAddresses: ['primary@example.com', 'secondary@example.com'],
      ccAddresses: ['copy@example.org'],
    })

    await withServiceRoleContext(userId, async (client) => {
      await client.query(
        `SELECT public.apply_invoice_delivery_provider_event(
                  'resend', $1, 'delivered', '2026-08-03T08:00:00Z', NULL,
                  ARRAY['secondary@example.com', 'COPY@example.org']
                )`,
        [providerMessageId],
      )
      await client.query(
        `SELECT public.apply_invoice_delivery_provider_event(
                  'resend', $1, 'bounced', '2026-08-03T08:01:00Z', 'Mailbox unavailable',
                  ARRAY['primary@example.com']
                )`,
        [providerMessageId],
      )

      const row = await client.query<{
        provider_status: string
        provider_recipient_statuses: Record<string, { status: string; status_at: string }>
      }>(
        `SELECT provider_status, provider_recipient_statuses
           FROM public.invoice_deliveries
          WHERE id = $1`,
        [deliveryId],
      )

      expect(row.rows[0].provider_status).toBe('bounced')
      expect(row.rows[0].provider_recipient_statuses).toMatchObject({
        'to:1': { status: 'bounced' },
        'to:2': { status: 'delivered' },
        'cc:1': { status: 'delivered' },
      })
      expect(Object.keys(row.rows[0].provider_recipient_statuses).sort()).toEqual([
        'cc:1',
        'to:1',
        'to:2',
      ])
    })
  })

  it('never downgrades one recipient on late or repeated reports', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)
    const { deliveryId, providerMessageId } = await insertSentEmailDelivery({
      userId,
      companyId,
      invoiceId,
      documentId,
    })

    await withServiceRoleContext(userId, async (client) => {
      const apply = (status: string, occurredAt: string) => client.query(
        `SELECT public.apply_invoice_delivery_provider_event(
                  'resend', $1, $2, $3::timestamptz, NULL,
                  ARRAY['customer@example.com']
                )`,
        [providerMessageId, status, occurredAt],
      )

      await apply('bounced', '2026-08-03T08:02:00Z')
      await apply('delivered', '2026-08-03T08:03:00Z')
      await apply('bounced', '2026-08-03T08:01:00Z')

      const row = await client.query<{
        provider_recipient_statuses: Record<string, { status: string; status_at: string }>
      }>(
        `SELECT provider_recipient_statuses
           FROM public.invoice_deliveries
          WHERE id = $1`,
        [deliveryId],
      )
      expect(row.rows[0].provider_recipient_statuses['to:1']).toMatchObject({
        status: 'bounced',
        status_at: '2026-08-03T08:02:00+00:00',
      })
    })
  })

  it('keeps unknown and BCC recipients out of visible recipient state', async () => {
    const { userId, companyId } = await seedCompany()
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)
    const { providerMessageId } = await insertSentEmailDelivery({
      userId,
      companyId,
      invoiceId,
      documentId,
      bccAddresses: ['archive.secret@example.net'],
    })

    // The applied event must survive into the member's read below, so this
    // uses the committing service-role helper: the rollback-scoped
    // withServiceRoleContext only supports asserting inside its own callback.
    await runAsServiceRole((client) => client.query(
      `SELECT public.apply_invoice_delivery_provider_event(
                'resend', $1, 'bounced', now(), NULL,
                ARRAY['archive.secret@example.net', 'unknown@example.org']
              )`,
      [providerMessageId],
    ))

    const summary = await withUserContext(memberId, (client) => client.query<{
      provider_status: string
      provider_recipient_statuses: Record<string, unknown>
    }>(
      `SELECT provider_status, provider_recipient_statuses
         FROM public.list_invoice_delivery_summaries($1, $2)`,
      [companyId, invoiceId],
    ))

    expect(summary.rows[0]).toEqual({
      provider_status: 'bounced',
      provider_recipient_statuses: {},
    })
    expect(JSON.stringify(summary.rows[0])).not.toContain('archive.secret')
  })

  it('records the provider outcome on a sent email and keeps the rest locked', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)
    const { deliveryId, providerMessageId } = await insertSentEmailDelivery({
      userId,
      companyId,
      invoiceId,
      documentId,
    })

    await withServiceRoleContext(userId, async (client) => {
      const applied = await client.query<{ id: string | null }>(
        `SELECT public.apply_invoice_delivery_provider_status(
                  'resend', $1, 'bounced', '2026-07-24T08:00:00Z'::timestamptz, $2
                )::text AS id`,
        [providerMessageId, '550 5.1.1 <customer@example.com>: Recipient address rejected'],
      )
      expect(applied.rows[0].id).toBe(deliveryId)

      const row = await client.query<{
        provider_status: string
        provider_status_detail: string
        body_text: string
        subject: string
      }>(
        `SELECT provider_status, provider_status_detail, body_text, subject
           FROM public.invoice_deliveries
          WHERE id = $1`,
        [deliveryId],
      )
      expect(row.rows[0]).toMatchObject({
        provider_status: 'bounced',
        provider_status_detail: '550 5.1.1 <customer@example.com>: Recipient address rejected',
        body_text: 'Exact plain text',
        subject: 'Faktura F-1001',
      })
    })
  })

  it('never downgrades an observed failure on a late or repeated report', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)
    const { deliveryId, providerMessageId } = await insertSentEmailDelivery({
      userId,
      companyId,
      invoiceId,
      documentId,
    })

    await withServiceRoleContext(userId, async (client) => {
      const apply = (status: string, occurredAt: string) =>
        client.query(
          `SELECT public.apply_invoice_delivery_provider_status(
                    'resend', $1, $2, $3::timestamptz, NULL
                  )`,
          [providerMessageId, status, occurredAt],
        )
      const currentStatus = async () => {
        const row = await client.query<{ provider_status: string }>(
          `SELECT provider_status FROM public.invoice_deliveries WHERE id = $1`,
          [deliveryId],
        )
        return row.rows[0].provider_status
      }

      await apply('delayed', '2026-07-24T08:00:00Z')
      expect(await currentStatus()).toBe('delayed')

      await apply('delivered', '2026-07-24T08:01:00Z')
      expect(await currentStatus()).toBe('delivered')

      await apply('bounced', '2026-07-24T08:02:00Z')
      expect(await currentStatus()).toBe('bounced')

      // Retried and out-of-order events must not undo the bounce.
      await apply('delayed', '2026-07-24T08:03:00Z')
      await apply('delivered', '2026-07-24T08:04:00Z')
      expect(await currentStatus()).toBe('bounced')
    })
  })

  it('ignores reports for messages that are not tracked invoice deliveries', async () => {
    const { userId } = await seedCompany()

    await withServiceRoleContext(userId, async (client) => {
      const applied = await client.query<{ id: string | null }>(
        `SELECT public.apply_invoice_delivery_provider_status(
                  'resend', 'payslip-message-id', 'delivered', now(), NULL
                )::text AS id`,
      )
      expect(applied.rows[0].id).toBeNull()
    })
  })

  it('rejects an unsupported outcome and non-service callers', async () => {
    const { userId, companyId } = await seedCompany()
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })

    await expect(
      withServiceRoleContext(userId, (client) => client.query(
        `SELECT public.apply_invoice_delivery_provider_status(
                  'resend', 'msg-1', 'opened', now(), NULL
                )`,
      )),
    ).rejects.toThrow(/unsupported invoice delivery provider status/i)

    await expect(
      withUserContext(memberId, (client) => client.query(
        `SELECT public.apply_invoice_delivery_provider_status(
                  'resend', 'msg-1', 'delivered', now(), NULL
                )`,
      )),
    ).rejects.toThrow(/permission denied/i)
  })

  it('blocks a provider outcome from smuggling in other changes', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)
    const { deliveryId } = await insertSentEmailDelivery({
      userId,
      companyId,
      invoiceId,
      documentId,
    })

    await expect(
      getPool().query(
        `UPDATE public.invoice_deliveries
            SET provider_status = 'delivered', provider_status_at = now(),
                subject = 'tampered'
          WHERE id = $1`,
        [deliveryId],
      ),
    ).rejects.toThrow(/terminal invoice delivery.*immutable/i)

    await expect(
      getPool().query(
        `UPDATE public.invoice_deliveries
            SET provider_status = 'delivered', provider_status_at = now(),
                provider_recipient_statuses = jsonb_build_object(
                  'to:1', jsonb_build_object('status', 'delivered', 'status_at', now()),
                  'bcc:1', jsonb_build_object('status', 'bounced', 'status_at', now())
                )
          WHERE id = $1`,
        [deliveryId],
      ),
    ).rejects.toThrow(/invoice_deliveries_recipient_statuses_shape/i)

    await expect(
      getPool().query(
        `UPDATE public.invoice_deliveries
            SET provider_status = 'delivered', provider_status_at = now(),
                provider_recipient_statuses = jsonb_build_object(
                  'to:999', jsonb_build_object(
                    'status', 'delivered',
                    'status_at', now()
                  )
                )
          WHERE id = $1`,
        [deliveryId],
      ),
    ).rejects.toThrow(/invoice_deliveries_recipient_statuses_shape/i)

    await expect(
      getPool().query(
        `UPDATE public.invoice_deliveries
            SET provider_status = 'delivered', provider_status_at = now(),
                provider_recipient_statuses = jsonb_build_object(
                  'to:1', jsonb_build_object(
                    'status', 'delivered',
                    'status_at', now(),
                    'unexpected', 'not allowed'
                  )
                )
          WHERE id = $1`,
        [deliveryId],
      ),
    ).rejects.toThrow(/invoice_deliveries_recipient_statuses_shape/i)

    await getPool().query(
      `UPDATE public.invoice_deliveries
          SET provider_status = 'bounced', provider_status_at = now()
        WHERE id = $1`,
      [deliveryId],
    )

    await expect(
      getPool().query(
        `UPDATE public.invoice_deliveries
            SET provider_status = NULL, provider_status_at = NULL,
                provider_status_detail = NULL
          WHERE id = $1`,
        [deliveryId],
      ),
    ).rejects.toThrow(/terminal invoice delivery.*immutable/i)
  })

  it('refuses a provider outcome before the send is terminal', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)
    const deliveryId = await insertPendingEmailDelivery({
      userId,
      companyId,
      invoiceId,
      documentId,
    })

    await expect(
      getPool().query(
        `UPDATE public.invoice_deliveries
            SET status = 'sent', sent_at = now(),
                provider_status = 'delivered', provider_status_at = now()
          WHERE id = $1`,
        [deliveryId],
      ),
    ).rejects.toThrow(/invoice delivery payload is immutable/i)
  })

  it('redacts provider recipient details with the rest of the expired PII', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)
    const { deliveryId } = await insertSentEmailDelivery({
      userId,
      companyId,
      invoiceId,
      documentId,
      retentionExpiresAt: '2000-01-01',
    })
    await getPool().query(
      `UPDATE public.invoice_deliveries
          SET provider_status = 'bounced', provider_status_at = now(),
              provider_status_detail = '550 5.1.1 <customer@example.com> rejected',
              provider_recipient_statuses = jsonb_build_object(
                'to:1', jsonb_build_object('status', 'bounced', 'status_at', now())
              )
        WHERE id = $1`,
      [deliveryId],
    )

    await getPool().query(`SELECT public.redact_expired_invoice_delivery_pii()`)

    const delivery = await getPool().query<{
      provider_status: string
      provider_status_detail: string | null
      provider_recipient_statuses: Record<string, unknown>
      pii_redacted_at: string | null
    }>(
      `SELECT provider_status, provider_status_detail, provider_recipient_statuses,
              pii_redacted_at
         FROM public.invoice_deliveries
        WHERE id = $1`,
      [deliveryId],
    )
    expect(delivery.rows[0].provider_status).toBe('bounced')
    expect(delivery.rows[0].provider_status_detail).toBeNull()
    expect(delivery.rows[0].provider_recipient_statuses).toEqual({})
    expect(delivery.rows[0].pii_redacted_at).toBeTruthy()
  })

  it('masks recipient addresses quoted in the reason text of a summary', async () => {
    const { userId, companyId } = await seedCompany()
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })
    const invoiceId = await insertInvoice(userId, companyId)
    const documentId = await insertDocument(userId, companyId)
    const { deliveryId } = await insertSentEmailDelivery({
      userId,
      companyId,
      invoiceId,
      documentId,
    })
    await getPool().query(
      `UPDATE public.invoice_deliveries
          SET provider_status = 'bounced', provider_status_at = now(),
              provider_status_detail = '550 5.1.1 <customer@example.com> unknown'
        WHERE id = $1`,
      [deliveryId],
    )

    const summary = await withUserContext(memberId, (client) => client.query<{
      id: string
      provider_status: string
      provider_status_detail: string
    }>(
      `SELECT id::text, provider_status, provider_status_detail
         FROM public.list_invoice_delivery_summaries($1, $2)`,
      [companyId, invoiceId],
    ))

    expect(summary.rows[0]).toEqual({
      id: deliveryId,
      provider_status: 'bounced',
      provider_status_detail: '550 5.1.1 <***@example.com> unknown',
    })
  })
})
