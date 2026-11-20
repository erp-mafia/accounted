import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

// pg-real coverage for 20261109170300_manual_accrual_schedules.sql
// (accounted#164): a third source, 'manual', that names no invoice, keeps the
// 17xx/29xx balance-account range, and dissolves into a resultatkonto only.

async function schedule(params: {
  companyId: string
  userId: string
  direction?: 'expense' | 'revenue'
  sourceKind?: string
  supplierInvoiceId?: string | null
  balanceAccount?: string
  targetAccount?: string
}) {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.accrual_schedules
       (id, user_id, company_id, direction, source_kind, supplier_invoice_id,
        balance_account, target_account, total_amount, period_start, period_end, months)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1200, '2026-01-01', '2026-12-31', 12)`,
    [
      id,
      params.userId,
      params.companyId,
      params.direction ?? 'expense',
      params.sourceKind ?? 'manual',
      params.supplierInvoiceId ?? null,
      params.balanceAccount ?? '1790',
      params.targetAccount ?? '6540',
    ],
  )
  return id
}

async function supplierInvoice(companyId: string, userId: string): Promise<string> {
  const supplierId = randomUUID()
  const invoiceId = randomUUID()
  await getPool().query(`INSERT INTO public.suppliers (id, user_id, company_id, name) VALUES ($1, $2, $3, 'Leverantör')`, [
    supplierId,
    userId,
    companyId,
  ])
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, subtotal, vat_amount, total)
     VALUES ($1, $2, $3, $4, 1, 'F-1', '2026-01-01', '2026-01-31', 1000, 250, 1250)`,
    [invoiceId, userId, companyId, supplierId],
  )
  return invoiceId
}

describe('manual accrual schedule source constraints', () => {
  it('accepts a manual plan without an invoice or origin entry, in either direction', async () => {
    const company = await seedCompany()
    await expect(schedule(company)).resolves.toBeDefined()
    await expect(schedule({ ...company, direction: 'revenue', balanceAccount: '2970', targetAccount: '3041' })).resolves.toBeDefined()
  })

  it('refuses a manual plan that also names a supplier invoice', async () => {
    const company = await seedCompany()
    const invoiceId = await supplierInvoice(company.companyId, company.userId)
    await expect(schedule({ ...company, supplierInvoiceId: invoiceId })).rejects.toThrow(/one_source|source_kind_matches_invoice/i)
  })

  it('refuses an invoice plan that names no invoice', async () => {
    const company = await seedCompany()
    await expect(schedule({ ...company, sourceKind: 'invoice' })).rejects.toThrow(/one_source|source_kind_matches_invoice|direction_matches_source/i)
  })

  it('keeps the balance account range on manual plans', async () => {
    const company = await seedCompany()
    await expect(schedule({ ...company, balanceAccount: '1510' })).rejects.toThrow(/balance_account_range/i)
  })

  it('refuses a manual plan dissolving into a balance-sheet account; an invoice plan keeps its wider range', async () => {
    const company = await seedCompany()
    await expect(schedule({ ...company, targetAccount: '1930' })).rejects.toThrow(/manual_target_result_account/i)

    const invoiceId = await supplierInvoice(company.companyId, company.userId)
    await expect(
      schedule({ ...company, sourceKind: 'invoice', supplierInvoiceId: invoiceId, targetAccount: '1460' }),
    ).resolves.toBeDefined()
  })
})
