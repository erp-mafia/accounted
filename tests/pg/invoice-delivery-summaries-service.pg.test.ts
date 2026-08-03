/**
 * pg-real test for public.list_invoice_delivery_summaries_for_service
 * (20260727100000_list_invoice_delivery_summaries_for_service.sql).
 *
 * The function is the service-role sibling of list_invoice_delivery_summaries:
 * the MCP server runs on a cookieless service client (auth.uid() IS NULL) and
 * routes to the API key's company, so the cookie-session function rejects every
 * MCP call. The sibling takes the acting user explicitly and re-verifies
 * membership server-side, mirroring authorize_invoice_delivery_service_actor.
 *
 * What must hold:
 *   - only auth.role() = 'service_role' may call it; authenticated/anon have no
 *     EXECUTE, and even a privileged caller without service-role claims is
 *     rejected in-function (42501).
 *   - a p_user_id that is not a member of p_company_id is rejected (42501);
 *     any member including a viewer is served (read path has no role filter,
 *     matching the cookie-session sibling's audience).
 *   - To/CC come back masked to ***@domain and the provider reason text has
 *     address local parts masked; body_html, body_text and bcc_addresses are
 *     never in the result shape at all.
 *
 * The service-role simulation is the shared runAsServiceRole helper
 * (tests/pg/setup.ts). A claims-JSON-only simulation (the
 * gl_lines_rpc_tenant_guard technique) is NOT enough here: that guard parses
 * `request.jwt.claims` itself, while this function asks auth.role(), which in
 * the CI image's legacy auth shim reads only `request.jwt.claim.role`. The
 * helper sets both GUC styles and fails loudly if auth.role() does not
 * resolve.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

const FN = `SELECT * FROM public.list_invoice_delivery_summaries_for_service($1, $2, $3)`

// All calls inside the service context are reads (seeding happens over the
// plain pool), so the shared helper's commit-on-success semantics are
// equivalent to the rolled-back local helper this file used to carry.
const withServiceRoleContext = runAsServiceRole

async function insertInvoice(params: {
  userId: string
  companyId: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, invoice_number, invoice_date, due_date,
        status, currency, total)
     VALUES ($1, $2, $3, $4, '2026-06-01', '2026-07-01', 'sent', 'SEK', 1250)`,
    [id, params.userId, params.companyId, `F-${id.slice(0, 8)}`],
  )
  return id
}

async function insertDocumentAttachment(params: {
  userId: string
  companyId: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, storage_path, file_name, sha256_hash)
     VALUES ($1, $2, $3, $4, 'faktura-1042.pdf', $5)`,
    [
      id,
      params.userId,
      params.companyId,
      `test/${id}.pdf`,
      // 64-char hex string: sha256 placeholder for the test.
      id.replace(/-/g, '').padEnd(64, '0'),
    ],
  )
  return id
}

// Seed a terminal 'sent' email delivery directly (INSERTs are the append path
// of the WORM table; immutability triggers guard UPDATE/DELETE). Payload and
// BCC use SECRET markers so a leak through the summary is detectable.
async function insertSentEmailDelivery(params: {
  companyId: string
  userId: string
  invoiceId: string
  documentAttachmentId: string
  providerStatus?: 'delayed' | 'delivered' | 'complained' | 'bounced' | 'failed' | 'suppressed' | null
  providerStatusDetail?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoice_deliveries
       (id, company_id, user_id, invoice_id, channel, status,
        to_addresses, cc_addresses, bcc_addresses, from_name, subject,
        body_text, body_html, provider, provider_message_id,
        document_attachment_id, attachment_filename, attachment_content_type,
        attachment_sha256, sent_at,
        provider_status, provider_status_at, provider_status_detail)
     VALUES ($1, $2, $3, $4, 'email', 'sent',
             $5::text[], $6::text[], $7::text[], 'Test AB', 'Faktura F-1042',
             'SECRET-BODY-TEXT', '<p>SECRET-BODY-HTML</p>', 'resend', $8,
             $9, 'faktura-1042.pdf', 'application/pdf', $10, now(),
             $11, CASE WHEN $11::text IS NULL THEN NULL ELSE now() END, $12)`,
    [
      id,
      params.companyId,
      params.userId,
      params.invoiceId,
      ['kund.betalare@example.com'],
      ['ekonomi.kopia@example.org'],
      ['dold.kopia@example.net'],
      `msg-${id}`,
      params.documentAttachmentId,
      id.replace(/-/g, '').padEnd(64, '0'),
      params.providerStatus ?? null,
      params.providerStatusDetail ?? null,
    ],
  )
  return id
}

async function seedSentDeliveryWithBounce(): Promise<{
  companyId: string
  userId: string
  invoiceId: string
  deliveryId: string
}> {
  const a = await seedCompany()
  const invoiceId = await insertInvoice({ userId: a.userId, companyId: a.companyId })
  const documentAttachmentId = await insertDocumentAttachment({
    userId: a.userId,
    companyId: a.companyId,
  })
  const deliveryId = await insertSentEmailDelivery({
    companyId: a.companyId,
    userId: a.userId,
    invoiceId,
    documentAttachmentId,
    providerStatus: 'bounced',
    providerStatusDetail: 'smtp; 550 5.1.1 kund.betalare@example.com recipient rejected',
  })
  return { companyId: a.companyId, userId: a.userId, invoiceId, deliveryId }
}

describe('list_invoice_delivery_summaries_for_service: definition contract', () => {
  it('is SECURITY DEFINER, STABLE, search_path-pinned, EXECUTE-able by service_role only', async () => {
    const meta = await getPool().query<{
      prosecdef: boolean
      provolatile: string
      proconfig: string[] | null
      anon_exec: boolean
      authenticated_exec: boolean
      service_exec: boolean
    }>(
      `SELECT p.prosecdef, p.provolatile, p.proconfig,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'list_invoice_delivery_summaries_for_service'`,
    )
    expect(meta.rows).toHaveLength(1)
    const row = meta.rows[0]
    expect(row.prosecdef).toBe(true)
    expect(row.provolatile).toBe('s')
    expect(row.proconfig ?? []).toContain('search_path=pg_catalog, public')
    expect(row.anon_exec).toBe(false)
    expect(row.authenticated_exec).toBe(false)
    expect(row.service_exec).toBe(true)
  })
})

describe('list_invoice_delivery_summaries_for_service: authorization', () => {
  it('rejects a caller without service-role claims even when EXECUTE succeeds', async () => {
    const seeded = await seedSentDeliveryWithBounce()
    // Bare superuser pool: EXECUTE is not the barrier here, but auth.role()
    // is NULL, so the in-function check must fire.
    await expect(
      getPool().query(FN, [seeded.companyId, seeded.userId, seeded.invoiceId]),
    ).rejects.toThrow(/service role/)
  })

  it('rejects an authenticated session at the privilege layer', async () => {
    const seeded = await seedSentDeliveryWithBounce()
    await expect(
      withUserContext(seeded.userId, (client) =>
        client.query(FN, [seeded.companyId, seeded.userId, seeded.invoiceId]),
      ),
    ).rejects.toThrow(/permission denied/i)
  })

  it('rejects a p_user_id that is not a member of p_company_id', async () => {
    const seeded = await seedSentDeliveryWithBounce()
    const outsider = await seedCompany() // member of another company only
    await withServiceRoleContext(async (client) => {
      await expect(
        client.query(FN, [seeded.companyId, outsider.userId, seeded.invoiceId]),
      ).rejects.toThrow(/not a company member/)
    })
  })

  it('rejects a NULL p_user_id', async () => {
    const seeded = await seedSentDeliveryWithBounce()
    await withServiceRoleContext(async (client) => {
      await expect(
        client.query(FN, [seeded.companyId, null, seeded.invoiceId]),
      ).rejects.toThrow(/not a company member/)
    })
  })
})

describe('list_invoice_delivery_summaries_for_service: masked result', () => {
  it('returns the bounce with masked recipients and reason, and no payload columns', async () => {
    const seeded = await seedSentDeliveryWithBounce()

    await withServiceRoleContext(async (client) => {
      const res = await client.query(FN, [seeded.companyId, seeded.userId, seeded.invoiceId])
      expect(res.rows).toHaveLength(1)
      const row = res.rows[0]

      expect(row.id).toBe(seeded.deliveryId)
      expect(row.channel).toBe('email')
      expect(row.status).toBe('sent')
      expect(row.provider).toBe('resend')
      expect(row.provider_status).toBe('bounced')
      expect(row.provider_status_at).not.toBeNull()
      expect(row.provider_recipient_statuses).toEqual({})
      expect(row.attachment_filename).toBe('faktura-1042.pdf')
      expect(row.sent_at).not.toBeNull()
      expect(row.failed_at).toBeNull()

      // Recipients masked to ***@domain, in order.
      expect(row.to_addresses).toEqual(['***@example.com'])
      expect(row.cc_addresses).toEqual(['***@example.org'])
      // Provider reason keeps the diagnostic but masks the address local part.
      expect(row.provider_status_detail).toBe(
        'smtp; 550 5.1.1 ***@example.com recipient rejected',
      )

      // Exactly the sibling's masked shape: the payload and BCC columns are
      // absent by construction, not filtered.
      expect(Object.keys(row).sort()).toEqual(
        [
          'id',
          'channel',
          'status',
          'to_addresses',
          'cc_addresses',
          'provider',
          'provider_status',
          'provider_status_at',
          'provider_status_detail',
          'provider_recipient_statuses',
          'error_code',
          'document_attachment_id',
          'attachment_filename',
          'sent_at',
          'failed_at',
          'created_at',
        ].sort(),
      )
      const serialized = JSON.stringify(res.rows)
      expect(serialized).not.toContain('SECRET-BODY-TEXT')
      expect(serialized).not.toContain('SECRET-BODY-HTML')
      expect(serialized).not.toContain('dold.kopia')
      expect(serialized).not.toContain('kund.betalare')
    })
  })

  it('serves every company member including viewers, and excludes preparing rows', async () => {
    const seeded = await seedSentDeliveryWithBounce()
    // A crashed-render reservation: payload-free and must stay invisible.
    await getPool().query(
      `INSERT INTO public.invoice_deliveries
         (company_id, user_id, invoice_id, channel, status)
       VALUES ($1, $2, $3, 'email', 'preparing')`,
      [seeded.companyId, seeded.userId, seeded.invoiceId],
    )
    const viewerId = await insertAuthUser()
    await insertCompanyMember({
      companyId: seeded.companyId,
      userId: viewerId,
      role: 'viewer',
    })

    await withServiceRoleContext(async (client) => {
      const res = await client.query(FN, [seeded.companyId, viewerId, seeded.invoiceId])
      expect(res.rows).toHaveLength(1)
      expect(res.rows[0].id).toBe(seeded.deliveryId)
      expect(res.rows[0].status).toBe('sent')
    })
  })

  it("returns nothing for another company's invoice id", async () => {
    const seeded = await seedSentDeliveryWithBounce()
    const other = await seedSentDeliveryWithBounce()

    await withServiceRoleContext(async (client) => {
      // Member of company A probing with company A but company B's invoice:
      // the company_id + invoice_id conjunction must yield nothing.
      const res = await client.query(FN, [seeded.companyId, seeded.userId, other.invoiceId])
      expect(res.rows).toHaveLength(0)
    })
  })
})
