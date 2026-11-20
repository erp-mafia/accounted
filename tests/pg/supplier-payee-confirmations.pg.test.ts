import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember, seedCompany, setActiveCompany } from '@/tests/pg/fixtures'
import { getClient, getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

async function insertSupplier(companyId: string, userId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name, bankgiro)
     VALUES ($1, $2, $3, 'Derome Bygg AB', '5050-1055')`,
    [id, userId, companyId],
  )
  return id
}

async function insertSupplierInvoice(companyId: string, userId: string, supplierId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date,
        subtotal, vat_amount, total, remaining_amount, status, currency, payee_bankgiro)
     VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int, $5, '2026-10-01', '2026-10-31',
             800, 200, 1000, 1000, 'approved', 'SEK', '9020-0001')`,
    [id, userId, companyId, supplierId, `PC-${id.slice(0, 8)}`],
  )
  return id
}

const INSERT = `INSERT INTO public.supplier_payee_confirmations
  (company_id, supplier_id, payee_key, decision, decided_by, source_supplier_invoice_id, supplier_card_updated)
  VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`

async function seedSupplierAndInvoice() {
  const { userId, companyId } = await seedCompany()
  await setActiveCompany(userId, companyId)
  const supplierId = await insertSupplier(companyId, userId)
  const invoiceId = await insertSupplierInvoice(companyId, userId, supplierId)
  return { userId, companyId, supplierId, invoiceId }
}

describe('supplier_payee_confirmations.pg: a person decides on a supplier account, in their own name, append-only', () => {
  it('lets a writing member of the active company record a decision in their own name and read it back', async () => {
    const { userId, companyId, supplierId, invoiceId } = await seedSupplierAndInvoice()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: member, role: 'member' })
    await setActiveCompany(member, companyId)
    for (const actor of [userId, member]) {
      await withUserContext(actor, async (client) => {
        const inserted = await client.query(INSERT, [companyId, supplierId, 'bankgiro:90200001', 'confirmed', actor, invoiceId, true])
        expect(inserted.rowCount).toBe(1)
        const read = await client.query<{ decision: string; decided_by: string }>(
          `SELECT decision, decided_by FROM public.supplier_payee_confirmations WHERE company_id = $1`,
          [companyId],
        )
        expect(read.rows.map((r) => r.decided_by)).toContain(actor)
      })
    }
  })

  it('refuses a viewer, a decision in someone else\'s name, and a company that is not the active one', async () => {
    const { userId, companyId, supplierId, invoiceId } = await seedSupplierAndInvoice()
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    await setActiveCompany(viewer, companyId)
    await withUserContext(viewer, async (client) => {
      await expect(client.query(INSERT, [companyId, supplierId, 'bankgiro:90200001', 'confirmed', viewer, invoiceId, false])).rejects.toThrow(
        /row-level security/i,
      )
    })
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: member, role: 'member' })
    await setActiveCompany(member, companyId)
    await withUserContext(member, async (client) => {
      await expect(client.query(INSERT, [companyId, supplierId, 'bankgiro:90200001', 'confirmed', userId, invoiceId, false])).rejects.toThrow(
        /row-level security/i,
      )
    })
    // The owner of a second company with the first one active cannot write into the second.
    const other = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId: other, userId, role: 'owner' })
    const otherSupplier = await insertSupplier(other, userId)
    await withUserContext(userId, async (client) => {
      await expect(client.query(INSERT, [other, otherSupplier, 'bankgiro:90200001', 'rejected', userId, null, false])).rejects.toThrow(
        /row-level security/i,
      )
    })
  })

  it('has no update or delete for a browser session, and hides a company\'s decisions from other companies', async () => {
    const { userId, companyId, supplierId, invoiceId } = await seedSupplierAndInvoice()
    const { rows } = await getPool().query<{ id: string }>(INSERT, [companyId, supplierId, 'bankgiro:90200001', 'confirmed', userId, invoiceId, false])
    const id = rows[0]!.id
    await withUserContext(userId, async (client) => {
      await expect(client.query(`UPDATE public.supplier_payee_confirmations SET decision = 'rejected' WHERE id = $1`, [id])).rejects.toThrow(
        /permission denied/i,
      )
    })
    await withUserContext(userId, async (client) => {
      await expect(client.query(`DELETE FROM public.supplier_payee_confirmations WHERE id = $1`, [id])).rejects.toThrow(/permission denied/i)
    })
    const outsider = await insertAuthUser()
    const outsiderCompany = await insertCompany({ createdBy: outsider })
    await insertCompanyMember({ companyId: outsiderCompany, userId: outsider, role: 'owner' })
    await withUserContext(outsider, async (client) => {
      const read = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.supplier_payee_confirmations`)
      expect(read.rows[0]!.n).toBe(0)
    })
    const anon = await getClient()
    try {
      await anon.query('BEGIN')
      await anon.query('SET LOCAL ROLE anon')
      await expect(anon.query(`SELECT id FROM public.supplier_payee_confirmations`)).rejects.toThrow(/permission denied/i)
    } finally {
      await anon.query('ROLLBACK').catch(() => {})
      anon.release()
    }
    // The server (an MCP approval, a cleanup) writes as the service role.
    await runAsServiceRole(async (service) => {
      const inserted = await service.query(INSERT, [companyId, supplierId, 'bankgiro:90200001', 'rejected', userId, invoiceId, false])
      expect(inserted.rowCount).toBe(1)
    })
  })

  it('keeps the account key, the decision and the card flag to their shapes, and audits each decision', async () => {
    const { userId, companyId, supplierId, invoiceId } = await seedSupplierAndInvoice()
    await expect(getPool().query(INSERT, [companyId, supplierId, 'BG 9020-0001', 'confirmed', userId, invoiceId, false])).rejects.toThrow(
      /check constraint/i,
    )
    await expect(getPool().query(INSERT, [companyId, supplierId, 'bankgiro:90200001', 'approved', userId, invoiceId, false])).rejects.toThrow(
      /check constraint/i,
    )
    await expect(getPool().query(INSERT, [companyId, supplierId, 'bankgiro:90200001', 'rejected', userId, invoiceId, true])).rejects.toThrow(
      /check constraint/i,
    )
    const ok = await getPool().query<{ id: string }>(INSERT, [companyId, supplierId, 'iban:SE4550000000058398257466', 'confirmed', userId, invoiceId, true])
    const audit = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.audit_log WHERE table_name = 'supplier_payee_confirmations' AND record_id = $1`,
      [ok.rows[0]!.id],
    )
    expect(audit.rows[0]!.n).toBe(1)
  })

  it('keeps a decision when the invoice that prompted it is removed, and lets the staged tool\'s type into pending_operations', async () => {
    const { userId, companyId, supplierId, invoiceId } = await seedSupplierAndInvoice()
    const { rows } = await getPool().query<{ id: string }>(INSERT, [companyId, supplierId, 'bankgiro:90200001', 'confirmed', userId, invoiceId, false])
    await getPool().query(`DELETE FROM public.supplier_invoices WHERE id = $1`, [invoiceId])
    const kept = await getPool().query<{ source_supplier_invoice_id: string | null }>(
      `SELECT source_supplier_invoice_id FROM public.supplier_payee_confirmations WHERE id = $1`,
      [rows[0]!.id],
    )
    expect(kept.rows[0]!.source_supplier_invoice_id).toBeNull()

    const staged = await getPool().query(
      `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title)
       VALUES ($1, $2, 'confirm_supplier_payee', 'Godkänn nya bankuppgifter') RETURNING id`,
      [userId, companyId],
    )
    expect(staged.rowCount).toBe(1)
  })
})
