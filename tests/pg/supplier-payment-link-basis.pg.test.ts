/**
 * pg-real test for 20261101045830_supplier_payment_rows_record_link_basis.sql.
 *
 * Every supplier payment row says why it is linked, as invoice_payments does.
 * The two SQL doors left link_basis NULL (157 rows in production since 2026-10-17,
 * none on the customer side): the Kopplingar view and the audit package then
 * read a link as unknown. A fixed basis would be worse: 40 of those rows came
 * from a rule or an import, so each door names its own.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getClient, getPool } from './setup'
import { insertPostedJournalEntry, seedCompany } from './fixtures'

type Seeded = Awaited<ReturnType<typeof seedCompany>>

let arrivalSeq = 0

async function accrualCompany(): Promise<Seeded> {
  const company = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, accounting_method) VALUES ($1, $2, 'accrual')`,
    [company.userId, company.companyId],
  )
  return company
}

async function supplierInvoice(company: Seeded, status: 'registered' | 'paid'): Promise<string> {
  const supplierId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers
       (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
     VALUES ($1, $2, $3, 'Leverantör AB', 'swedish_business', 'SE', 30, 'SEK')`,
    [supplierId, company.userId, company.companyId],
  )
  const id = randomUUID()
  const arrivalNumber = (Date.now() % 1_000_000) * 1000 + arrivalSeq++
  const paid = status === 'paid' ? 1000 : 0
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-04-01', '2026-05-01', '2026-04-01', $7, 'SEK',
             1000, 0, 1000, $8, $9, 'standard_25', false, false)`,
    [id, company.userId, company.companyId, supplierId, arrivalNumber, `LF-${arrivalNumber}`, status, paid, 1000 - paid],
  )
  return id
}

function payingVoucher(company: Seeded): Promise<string> {
  return insertPostedJournalEntry({
    userId: company.userId,
    companyId: company.companyId,
    fiscalPeriodId: company.fiscalPeriodId,
    voucherNumber: Math.floor(Math.random() * 1_000_000),
    entryDate: '2026-05-05',
    description: 'Betalning leverantör',
    sourceType: 'import',
    lines: [
      { accountNumber: '2440', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 1000 },
    ],
  })
}

async function basisOf(invoiceId: string): Promise<{ link_basis: string | null; link_evidence: unknown }> {
  const { rows } = await getPool().query<{ link_basis: string | null; link_evidence: unknown }>(
    `SELECT link_basis, link_evidence FROM public.supplier_invoice_payments WHERE supplier_invoice_id = $1`,
    [invoiceId],
  )
  expect(rows).toHaveLength(1)
  return rows[0]
}

describe('link_supplier_invoice_to_voucher records the basis of the link', () => {
  async function link(company: Seeded, invoiceId: string, voucherId: string, actorType: string | null) {
    const { rows } = await getPool().query<{ result: { ok: boolean } }>(
      `SELECT public.link_supplier_invoice_to_voucher($1, $2, $3, $4, NULL, NULL, $5) AS result`,
      [invoiceId, voucherId, company.userId, company.companyId, actorType],
    )
    expect(rows[0].result.ok).toBe(true)
  }

  it('a person names the verifikat: user_confirmed', async () => {
    const company = await accrualCompany()
    const invoiceId = await supplierInvoice(company, 'registered')
    await link(company, invoiceId, await payingVoucher(company), null)
    expect(await basisOf(invoiceId)).toEqual({ link_basis: 'user_confirmed', link_evidence: null })
  })

  it('an API key names it: the caller asserts, no person confirmed', async () => {
    const company = await accrualCompany()
    const invoiceId = await supplierInvoice(company, 'registered')
    await link(company, invoiceId, await payingVoucher(company), 'api_key')
    expect(await basisOf(invoiceId)).toMatchObject({ link_basis: 'client_asserted' })
  })

  it.each(['rule_ocr_reference', 'rule_counterparty', 'import_carried_over'])(
    'a door no person chose the pair on names %s, and it stays on an API key',
    async (basis) => {
      const company = await accrualCompany()
      const invoiceId = await supplierInvoice(company, 'registered')
      const voucherId = await payingVoucher(company)
      const { rows } = await getPool().query<{ result: { ok: boolean } }>(
        `SELECT public.link_supplier_invoice_to_voucher($1, $2, $3, $4, p_actor_type => 'api_key', p_link_basis => $5) AS result`,
        [invoiceId, voucherId, company.userId, company.companyId, basis],
      )
      expect(rows[0].result.ok).toBe(true)
      expect(await basisOf(invoiceId)).toEqual({ link_basis: basis, link_evidence: null })
    },
  )

  it('a call that names nothing still takes five positional arguments', async () => {
    const company = await accrualCompany()
    const invoiceId = await supplierInvoice(company, 'registered')
    const { rows } = await getPool().query<{ result: { ok: boolean } }>(
      `SELECT public.link_supplier_invoice_to_voucher($1, $2, $3, $4, 'En anteckning') AS result`,
      [invoiceId, await payingVoucher(company), company.userId, company.companyId],
    )
    expect(rows[0].result.ok).toBe(true)
    expect((await basisOf(invoiceId)).link_basis).toBe('user_confirmed')
  })

  it("the provider migration's settle phase records the rule its plan names, not a person", async () => {
    const client = await getClient()
    try {
      const sql = readFileSync(fileURLToPath(new URL('./sql/provider-migration-settle-link-basis.sql', import.meta.url)), 'utf8')
      await expect(client.query(sql)).resolves.toBeDefined()
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})

describe('attach_supplier_invoice_settlement_voucher records the basis of the link', () => {
  it('the person who named the pair: user_confirmed', async () => {
    const company = await accrualCompany()
    const invoiceId = await supplierInvoice(company, 'paid')
    const voucherId = await payingVoucher(company)
    const { rows } = await getPool().query<{ result: { ok: boolean } }>(
      `SELECT public.attach_supplier_invoice_settlement_voucher($1, $2, $3, $4, NULL, false) AS result`,
      [invoiceId, voucherId, company.userId, company.companyId],
    )
    expect(rows[0].result.ok).toBe(true)
    expect(await basisOf(invoiceId)).toEqual({ link_basis: 'user_confirmed', link_evidence: null })
  })

  it("the migration's linker names the import", async () => {
    const company = await accrualCompany()
    const invoiceId = await supplierInvoice(company, 'paid')
    const voucherId = await payingVoucher(company)
    const { rows } = await getPool().query<{ result: { ok: boolean } }>(
      `SELECT public.attach_supplier_invoice_settlement_voucher($1, $2, $3, $4, p_link_basis => 'import_carried_over') AS result`,
      [invoiceId, voucherId, company.userId, company.companyId],
    )
    expect(rows[0].result.ok).toBe(true)
    expect(await basisOf(invoiceId)).toEqual({ link_basis: 'import_carried_over', link_evidence: null })
  })
})

describe('the parameter replaced the old functions', () => {
  it.each(['link_supplier_invoice_to_voucher', 'attach_supplier_invoice_settlement_voucher'])(
    '%s has one definition, so PostgREST has one to pick',
    async (name) => {
      const { rows } = await getPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public' AND p.proname = $1`,
        [name],
      )
      expect(rows[0].n).toBe(1)
    },
  )
})
