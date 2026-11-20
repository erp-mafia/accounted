import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany, setActiveCompany } from './fixtures'

/**
 * Autogiro v1 (migration 20261025084700_autogiro.sql): members reach their
 * own company's rows only, one active mandate per customer, one live debit
 * per invoice, and invoices.autogiro_payer_number: a draft follows its
 * customer's active mandate and the value freezes at issue.
 */

async function insertCustomer(companyId: string, userId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type) VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [id, userId, companyId],
  )
  return id
}

async function insertMandate(params: {
  companyId: string
  customerId: string | null
  payerNumber?: string
  status?: string
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.autogiro_mandates (company_id, customer_id, payer_number, status, source)
     VALUES ($1, $2, $3, $4, 'manual') RETURNING id`,
    [params.companyId, params.customerId, params.payerNumber ?? String(Math.floor(Math.random() * 1e9)), params.status ?? 'active'],
  )
  return rows[0]!.id
}

async function insertDraft(params: {
  companyId: string
  userId: string
  customerId: string
  currency?: string
  documentType?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, total, currency, document_type, status, creation_complete)
     VALUES ($1, $2, $3, $4, $5, '2026-11-02', '2026-12-02', 1250, $6, $7, 'draft', true)`,
    [id, params.userId, params.companyId, params.customerId, `F-${id.slice(0, 8)}`, params.currency ?? 'SEK', params.documentType ?? 'invoice'],
  )
  return id
}

async function payerNumberOf(invoiceId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ autogiro_payer_number: string | null }>(
    `SELECT autogiro_payer_number FROM public.invoices WHERE id = $1`,
    [invoiceId],
  )
  return rows[0]!.autogiro_payer_number
}

describe('autogiro tables (pg)', () => {
  it('lets members reach their own company only', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const customerA = await insertCustomer(a.companyId, a.userId)
    const customerB = await insertCustomer(b.companyId, b.userId)
    const mandateA = await insertMandate({ companyId: a.companyId, customerId: customerA })
    await insertMandate({ companyId: b.companyId, customerId: customerB })

    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: member, role: 'admin' })
    await setActiveCompany(member, a.companyId)

    await withUserContext(member, async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM public.autogiro_mandates`)
      expect(rows.map((r) => r.id)).toEqual([mandateA])
    })
    await withUserContext(member, async (client) => {
      await expect(
        client.query(`INSERT INTO public.autogiro_settings (company_id, customer_number, bankgiro) VALUES ($1, '123456', '9912346')`, [
          b.companyId,
        ]),
      ).rejects.toThrow(/row-level security/)
    })
    await withUserContext(member, async (client) => {
      await client.query(`INSERT INTO public.autogiro_settings (company_id, customer_number, bankgiro) VALUES ($1, '123456', '9912346')`, [
        a.companyId,
      ])
      const { rows } = await client.query(`SELECT company_id FROM public.autogiro_settings`)
      expect(rows).toHaveLength(1)
    })
  })

  it('lets a viewer read but not write', async () => {
    const a = await seedCompany()
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: viewer, role: 'viewer' })
    await setActiveCompany(viewer, a.companyId)
    await withUserContext(viewer, async (client) => {
      await expect(
        client.query(`INSERT INTO public.autogiro_settings (company_id, customer_number, bankgiro) VALUES ($1, '123456', '9912346')`, [a.companyId]),
      ).rejects.toThrow(/row-level security/)
    })
  })

  it('refuses a report read twice, and members never delete a file', async () => {
    const a = await seedCompany()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: member, role: 'admin' })
    await setActiveCompany(member, a.companyId)
    const hash = 'a'.repeat(64)
    await withUserContext(member, async (client) => {
      const insert = () =>
        client.query(
          `INSERT INTO public.autogiro_files (company_id, direction, kind, file_hash) VALUES ($1, 'from_bankgirot', 'payment_specification', $2)`,
          [a.companyId, hash],
        )
      await insert()
      await expect(insert()).rejects.toThrow(/autogiro_files_report_once/)
    })
    await withUserContext(member, async (client) => {
      await expect(client.query(`DELETE FROM public.autogiro_files`)).rejects.toThrow(/permission denied/)
    })
  })

  it('allows one active mandate per customer and one live debit per invoice', async () => {
    const a = await seedCompany()
    const customer = await insertCustomer(a.companyId, a.userId)
    await insertMandate({ companyId: a.companyId, customerId: customer, payerNumber: '1001' })
    await expect(insertMandate({ companyId: a.companyId, customerId: customer, payerNumber: '1002' })).rejects.toThrow(
      /autogiro_mandates_one_active_per_customer/,
    )
    await expect(insertMandate({ companyId: a.companyId, customerId: null, payerNumber: '1001' })).rejects.toThrow(
      /autogiro_mandates_company_payer_key/,
    )
    await expect(insertMandate({ companyId: a.companyId, customerId: null, payerNumber: '0042' })).rejects.toThrow(/payer_number_check/)

    const invoiceId = await insertDraft({ companyId: a.companyId, userId: a.userId, customerId: customer })
    const debit = (status: string) =>
      getPool().query(
        `INSERT INTO public.autogiro_debits (company_id, invoice_id, payer_number, amount, debit_date, reference, status)
         VALUES ($1, $2, '1001', 1250, '2026-12-02', '12345', $3)`,
        [a.companyId, invoiceId, status],
      )
    await debit('failed')
    await debit('sent')
    await expect(debit('sent')).rejects.toThrow(/autogiro_debits_one_live_per_invoice/)
    await expect(debit('debited')).rejects.toThrow(/autogiro_debits_one_live_per_invoice/)
  })

  it('grants: members read and write, never delete; service_role everything; anon nothing', async () => {
    const tables = ['autogiro_settings', 'autogiro_mandates', 'autogiro_files', 'autogiro_debits']
    const { rows } = await getPool().query<{ grantee: string; table_name: string; privilege_type: string }>(
      `SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND table_name = ANY($1) AND grantee IN ('anon', 'authenticated', 'service_role')`,
      [tables],
    )
    const of = (table: string, grantee: string) =>
      rows
        .filter((r) => r.table_name === table && r.grantee === grantee)
        .map((r) => r.privilege_type)
        .sort()
    for (const table of tables) {
      expect(of(table, 'service_role')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
      expect(of(table, 'anon')).toEqual([])
    }
    expect(of('autogiro_files', 'authenticated')).toEqual(['INSERT', 'SELECT'])
    for (const table of ['autogiro_settings', 'autogiro_mandates', 'autogiro_debits']) {
      expect(of(table, 'authenticated')).toEqual(['INSERT', 'SELECT', 'UPDATE'])
    }
  })
})

describe('invoices.autogiro_payer_number (pg)', () => {
  it('follows the customer\'s active mandate while a draft, and freezes at issue', async () => {
    const a = await seedCompany()
    const customer = await insertCustomer(a.companyId, a.userId)
    const draft = await insertDraft({ companyId: a.companyId, userId: a.userId, customerId: customer })
    expect(await payerNumberOf(draft)).toBeNull()

    // The mandate becomes active: the open draft learns it without a save.
    const mandate = await insertMandate({ companyId: a.companyId, customerId: customer, payerNumber: '556677' })
    expect(await payerNumberOf(draft)).toBe('556677')

    // A new draft for the customer gets it at insert.
    const second = await insertDraft({ companyId: a.companyId, userId: a.userId, customerId: customer })
    expect(await payerNumberOf(second)).toBe('556677')

    // Issued: the value stands, even after the mandate ends.
    await getPool().query(`UPDATE public.invoices SET status = 'sent' WHERE id = $1`, [draft])
    await getPool().query(`UPDATE public.autogiro_mandates SET status = 'cancelled' WHERE id = $1`, [mandate])
    expect(await payerNumberOf(draft)).toBe('556677')
    // The draft still open follows the cancellation.
    expect(await payerNumberOf(second)).toBeNull()

    // And nobody rewrites it on an issued invoice.
    await getPool().query(`UPDATE public.invoices SET autogiro_payer_number = NULL WHERE id = $1`, [draft])
    expect(await payerNumberOf(draft)).toBe('556677')
  })

  it('is never set on a non-SEK invoice, a quote, or one inserted already issued', async () => {
    const a = await seedCompany()
    const customer = await insertCustomer(a.companyId, a.userId)
    await insertMandate({ companyId: a.companyId, customerId: customer, payerNumber: '778899' })

    const eur = await insertDraft({ companyId: a.companyId, userId: a.userId, customerId: customer, currency: 'EUR' })
    expect(await payerNumberOf(eur)).toBeNull()

    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, total, status, autogiro_payer_number, creation_complete)
       VALUES ($1, $2, $3, $4, $5, '2026-01-02', '2026-02-02', 900, 'paid', '778899', true)`,
      [id, a.userId, a.companyId, customer, `F-${id.slice(0, 8)}`],
    )
    expect(await payerNumberOf(id)).toBeNull()
  })

  it('moves with the mandate when it is linked to another customer', async () => {
    const a = await seedCompany()
    const first = await insertCustomer(a.companyId, a.userId)
    const second = await insertCustomer(a.companyId, a.userId)
    const draftFirst = await insertDraft({ companyId: a.companyId, userId: a.userId, customerId: first })
    const draftSecond = await insertDraft({ companyId: a.companyId, userId: a.userId, customerId: second })
    const mandate = await insertMandate({ companyId: a.companyId, customerId: first, payerNumber: '4242' })
    expect(await payerNumberOf(draftFirst)).toBe('4242')

    await getPool().query(`UPDATE public.autogiro_mandates SET customer_id = $2 WHERE id = $1`, [mandate, second])
    expect(await payerNumberOf(draftFirst)).toBeNull()
    expect(await payerNumberOf(draftSecond)).toBe('4242')
  })
})
