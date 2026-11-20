import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember, seedCompany } from '@/tests/pg/fixtures'
import { getClient, getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

const hashOf = (seed: string) => createHash('sha256').update(seed).digest('hex')

async function seedInvoice(companyId: string, userId: string): Promise<string> {
  const supplierId = randomUUID()
  await getPool().query(`INSERT INTO public.suppliers (id, user_id, company_id, name) VALUES ($1, $2, $3, 'Kontorsvaror AB')`, [supplierId, userId, companyId])
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date, subtotal, vat_amount, total)
     VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int, $5, '2026-10-01', '2026-10-31', 8000, 2000, 10000)`,
    [id, userId, companyId, supplierId, `F-${id.slice(0, 8)}`],
  )
  return id
}

async function asAnon(sql: string) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL ROLE anon')
    return await client.query(sql)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

describe('company_attest_policies.pg: members read, owners and admins write', () => {
  it('lets every member read the policy and only an owner or admin save it', async () => {
    const { userId: ownerId, companyId } = await seedCompany()
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })
    const adminId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: adminId, role: 'admin' })

    // An owner creates the row from a session (rolled back after the context).
    await withUserContext(ownerId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO public.company_attest_policies (company_id, enabled, threshold_amount, mode, attesters, updated_by)
         VALUES ($1, true, 5000, 'any', ARRAY[$2::uuid], $3) RETURNING company_id`,
        [companyId, memberId, ownerId],
      )
      expect(inserted.rowCount).toBe(1)
    })
    // A member cannot create one.
    await withUserContext(memberId, async (client) => {
      await expect(
        client.query(`INSERT INTO public.company_attest_policies (company_id, enabled, attesters) VALUES ($1, false, '{}')`, [companyId]),
      ).rejects.toThrow(/row-level security/i)
    })

    await getPool().query(
      `INSERT INTO public.company_attest_policies (company_id, enabled, threshold_amount, mode, attesters, updated_by)
       VALUES ($1, true, 5000, 'any', ARRAY[$2::uuid], $3)`,
      [companyId, memberId, ownerId],
    )
    await withUserContext(memberId, async (client) => {
      const read = await client.query<{ threshold_amount: string }>(`SELECT threshold_amount FROM public.company_attest_policies WHERE company_id = $1`, [companyId])
      expect(read.rows[0]!.threshold_amount).toBe('5000.00')
      // RLS refuses a member's update silently: zero rows.
      const updated = await client.query(`UPDATE public.company_attest_policies SET enabled = false WHERE company_id = $1`, [companyId])
      expect(updated.rowCount).toBe(0)
    })
    await withUserContext(adminId, async (client) => {
      const updated = await client.query(`UPDATE public.company_attest_policies SET mode = 'all' WHERE company_id = $1`, [companyId])
      expect(updated.rowCount).toBe(1)
      await expect(client.query(`DELETE FROM public.company_attest_policies WHERE company_id = $1`, [companyId])).rejects.toThrow(/permission denied/i)
    })
  })

  it("hides a company's policy from another company and from anon", async () => {
    const { userId: ownerId, companyId } = await seedCompany()
    await getPool().query(`INSERT INTO public.company_attest_policies (company_id, enabled, attesters) VALUES ($1, true, ARRAY[$2::uuid])`, [companyId, ownerId])
    const otherOwner = await insertAuthUser()
    const otherCompany = await insertCompany({ createdBy: otherOwner })
    await insertCompanyMember({ companyId: otherCompany, userId: otherOwner, role: 'owner' })
    await withUserContext(otherOwner, async (client) => {
      const read = await client.query<{ count: string }>(`SELECT count(*) FROM public.company_attest_policies WHERE company_id = $1`, [companyId])
      expect(Number(read.rows[0]!.count)).toBe(0)
    })
    await expect(asAnon(`SELECT company_id FROM public.company_attest_policies`)).rejects.toThrow(/permission denied/i)
  })

  it('needs an attester when on, a known mode, a non-negative threshold and no null attester', async () => {
    const insert = async (columns: string, values: string) => {
      const { companyId } = await seedCompany()
      return getPool().query(`INSERT INTO public.company_attest_policies (company_id, ${columns}) VALUES ($1, ${values})`, [companyId])
    }
    await expect(insert('enabled, attesters', `true, '{}'::uuid[]`)).rejects.toThrow(/check constraint/i)
    await expect(insert('mode', `'some'`)).rejects.toThrow(/check constraint/i)
    await expect(insert('threshold_amount', '-1')).rejects.toThrow(/check constraint/i)
    await expect(insert('attesters', `ARRAY[gen_random_uuid(), NULL]::uuid[]`)).rejects.toThrow(/check constraint/i)
    await expect(insert('enabled, attesters', `false, '{}'::uuid[]`)).resolves.toBeTruthy()
  })
})

describe('supplier_invoice_attestations.pg: an append-only trail the server writes', () => {
  it('lets members read the trail, never write it, and the service role only add to it', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await seedInvoice(companyId, userId)
    const { rows } = await runAsServiceRole((service) =>
      service.query<{ id: string }>(
        `INSERT INTO public.supplier_invoice_attestations (company_id, supplier_invoice_id, user_id, decision, comment, source)
         VALUES ($1, $2, $3, 'rejected', 'Fel belopp', 'email_link') RETURNING id`,
        [companyId, invoiceId, userId],
      ),
    )
    const attestationId = rows[0]!.id

    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })
    await withUserContext(viewerId, async (client) => {
      const read = await client.query<{ decision: string; comment: string }>(`SELECT decision, comment FROM public.supplier_invoice_attestations WHERE supplier_invoice_id = $1`, [invoiceId])
      expect(read.rows).toEqual([{ decision: 'rejected', comment: 'Fel belopp' }])
    })
    await withUserContext(userId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.supplier_invoice_attestations (company_id, supplier_invoice_id, user_id, decision) VALUES ($1, $2, $3, 'approved')`,
          [companyId, invoiceId, userId],
        ),
      ).rejects.toThrow(/permission denied/i)
    })
    await runAsServiceRole(async (service) => {
      await expect(service.query(`UPDATE public.supplier_invoice_attestations SET decision = 'approved' WHERE id = $1`, [attestationId])).rejects.toThrow(/permission denied/i)
    })
    await runAsServiceRole(async (service) => {
      await expect(service.query(`DELETE FROM public.supplier_invoice_attestations WHERE id = $1`, [attestationId])).rejects.toThrow(/permission denied/i)
    })
    await expect(asAnon(`SELECT id FROM public.supplier_invoice_attestations`)).rejects.toThrow(/permission denied/i)
  })

  it('takes only approved or rejected, a known source and a short comment', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await seedInvoice(companyId, userId)
    const insert = (decision: string, source: string, comment: string) =>
      getPool().query(
        `INSERT INTO public.supplier_invoice_attestations (company_id, supplier_invoice_id, user_id, decision, source, comment)
         VALUES ($1, $2, $3, ${decision}, ${source}, ${comment})`,
        [companyId, invoiceId, userId],
      )
    await expect(insert(`'maybe'`, `'app'`, 'NULL')).rejects.toThrow(/check constraint/i)
    await expect(insert(`'approved'`, `'fax'`, 'NULL')).rejects.toThrow(/check constraint/i)
    await expect(insert(`'approved'`, `'app'`, `repeat('x', 1001)`)).rejects.toThrow(/check constraint/i)
    await expect(insert(`'approved'`, `'mcp'`, `repeat('x', 1000)`)).resolves.toBeTruthy()
  })
})

describe('supplier_invoice_attest_links.pg: token credentials for the service role only', () => {
  it('keeps the links away from every session and anon, defaults to 7 days, and holds one open link per attester and invoice', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await seedInvoice(companyId, userId)
    const insert = () =>
      getPool().query<{ id: string }>(
        `INSERT INTO public.supplier_invoice_attest_links (company_id, supplier_invoice_id, attester_user_id, token_hash)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [companyId, invoiceId, userId, hashOf(randomUUID())],
      )
    const first = (await insert()).rows[0]!.id
    await expect(insert()).rejects.toThrow(/duplicate key|unique/i)
    await getPool().query(`UPDATE public.supplier_invoice_attest_links SET consumed_at = now() WHERE id = $1`, [first])
    await expect(insert()).resolves.toBeTruthy()

    const { rows } = await getPool().query<{ days: string }>(
      `SELECT extract(epoch FROM (expires_at - created_at)) / 86400 AS days FROM public.supplier_invoice_attest_links WHERE id = $1`,
      [first],
    )
    expect(Math.round(Number(rows[0]!.days))).toBe(7)

    await withUserContext(userId, async (client) => {
      await expect(client.query(`SELECT id FROM public.supplier_invoice_attest_links`)).rejects.toThrow(/permission denied/i)
    })
    await expect(asAnon(`SELECT id FROM public.supplier_invoice_attest_links`)).rejects.toThrow(/permission denied/i)
    await runAsServiceRole(async (service) => {
      const read = await service.query(`SELECT id FROM public.supplier_invoice_attest_links WHERE company_id = $1`, [companyId])
      expect(read.rowCount).toBe(2)
    })
    await expect(
      getPool().query(
        `INSERT INTO public.supplier_invoice_attest_links (company_id, supplier_invoice_id, attester_user_id, token_hash) VALUES ($1, $2, $3, 'clear-token')`,
        [companyId, invoiceId, userId],
      ),
    ).rejects.toThrow(/check constraint/i)
  })
})

describe('supplier_invoices.approved_by and notification_settings.attest_request_email_enabled', () => {
  it('records who attested and defaults the attest mail to on', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await seedInvoice(companyId, userId)
    await getPool().query(`UPDATE public.supplier_invoices SET approved_at = now(), approved_by = $2, status = 'approved' WHERE id = $1`, [invoiceId, userId])
    const { rows } = await getPool().query<{ approved_by: string }>(`SELECT approved_by FROM public.supplier_invoices WHERE id = $1`, [invoiceId])
    expect(rows[0]!.approved_by).toBe(userId)

    const someone = await insertAuthUser()
    await withUserContext(someone, async (client) => {
      await client.query(`INSERT INTO public.notification_settings (user_id) VALUES ($1)`, [someone])
      const read = await client.query<{ attest_request_email_enabled: boolean }>(`SELECT attest_request_email_enabled FROM public.notification_settings WHERE user_id = $1`, [someone])
      expect(read.rows[0]!.attest_request_email_enabled).toBe(true)
    })
  })
})
