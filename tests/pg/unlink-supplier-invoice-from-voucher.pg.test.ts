/**
 * pg-real test for unlink_supplier_invoice_from_voucher
 * (20260916150000_unlink_supplier_invoice_from_voucher.sql).
 *
 * The function undoes link_supplier_invoice_to_voucher: it removes the
 * supplier_invoice_payments row and restores the payable. What matters is the
 * boundary, so that is what these cases pin: it must refuse a payment whose
 * verifikat is one Accounted booked itself (storno owns those, and removing the
 * row alone would leave the ledger and the subledger disagreeing), it must miss
 * when addressed through the wrong invoice, and it must never touch a journal
 * entry.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import {
  insertAuthUser,
  insertCompanyMember,
  insertPostedJournalEntry,
  seedCompany,
} from './fixtures'

let arrivalSeq = 0

async function seedSupplierInvoice(params: {
  userId: string
  companyId: string
  total?: number
}): Promise<string> {
  const supplierId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers
       (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
     VALUES ($1, $2, $3, 'Leverantör AB', 'swedish_business', 'SE', 30, 'SEK')`,
    [supplierId, params.userId, params.companyId],
  )
  const id = randomUUID()
  const total = params.total ?? 1000
  const arrivalNumber = (Date.now() % 1_000_000) * 1000 + arrivalSeq++
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-04-01', '2999-05-01', '2026-04-01', 'approved', 'SEK',
             $7, 0, $7, 0, $7, 'standard_25', false, false, now())`,
    [id, params.userId, params.companyId, supplierId, arrivalNumber, `LF-${arrivalNumber}`, total],
  )
  return id
}

/** An AP-debiting voucher, i.e. one the link RPC accepts as a settlement. */
async function seedApVoucher(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  amount: number
  sourceType?: string
}): Promise<string> {
  return insertPostedJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    entryDate: '2026-04-15',
    description: 'Levbet',
    sourceType: params.sourceType ?? 'import',
    lines: [
      { accountNumber: '2440', debitAmount: params.amount, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: params.amount },
    ],
  })
}

async function link(invoiceId: string, entryId: string, userId: string, companyId: string) {
  const { rows } = await getPool().query(
    `SELECT public.link_supplier_invoice_to_voucher($1, $2, $3, $4, $5) AS result`,
    [invoiceId, entryId, userId, companyId, 'Auto-länkad vid avstämning (99% säkerhet)'],
  )
  return rows[0].result as { ok: boolean; payment_id?: string; code?: string }
}

async function unlink(paymentId: string, invoiceId: string, companyId: string) {
  const { rows } = await getPool().query(
    `SELECT public.unlink_supplier_invoice_from_voucher($1, $2, $3) AS result`,
    [paymentId, invoiceId, companyId],
  )
  return rows[0].result as Record<string, unknown>
}

async function invoiceRow(id: string) {
  const { rows } = await getPool().query(
    `SELECT status, paid_amount, remaining_amount, paid_at, payment_journal_entry_id
       FROM public.supplier_invoices WHERE id = $1`,
    [id],
  )
  return rows[0]
}

describe('unlink_supplier_invoice_from_voucher', () => {
  it('removes the payment row and restores the payable', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const invoiceId = await seedSupplierInvoice({ userId, companyId, total: 3500 })
    const entryId = await seedApVoucher({ userId, companyId, fiscalPeriodId, amount: 859 })

    const linked = await link(invoiceId, entryId, userId, companyId)
    expect(linked.ok).toBe(true)
    expect((await invoiceRow(invoiceId)).status).toBe('partially_paid')

    const result = await unlink(linked.payment_id!, invoiceId, companyId)
    expect(result.ok).toBe(true)
    expect(Number(result.payment_amount)).toBe(859)

    const after = await invoiceRow(invoiceId)
    expect(after.status).toBe('approved')
    expect(Number(after.paid_amount)).toBe(0)
    expect(Number(after.remaining_amount)).toBe(3500)
    expect(after.paid_at).toBeNull()

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.supplier_invoice_payments WHERE id = $1`,
      [linked.payment_id],
    )
    expect(rows[0].n).toBe(0)

    // The verifikat is untouched: it is a real payment to someone, it was only
    // pointed at the wrong payable.
    const { rows: entry } = await getPool().query(
      `SELECT status FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(entry[0].status).toBe('posted')
  })

  it('leaves the invoice partially paid when another link remains', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const invoiceId = await seedSupplierInvoice({ userId, companyId, total: 3500 })
    const first = await seedApVoucher({ userId, companyId, fiscalPeriodId, amount: 500 })
    const second = await seedApVoucher({ userId, companyId, fiscalPeriodId, amount: 859 })

    await link(invoiceId, first, userId, companyId)
    const wrong = await link(invoiceId, second, userId, companyId)

    const result = await unlink(wrong.payment_id!, invoiceId, companyId)
    expect(result.ok).toBe(true)

    const after = await invoiceRow(invoiceId)
    expect(after.status).toBe('partially_paid')
    expect(Number(after.paid_amount)).toBe(500)
    expect(Number(after.remaining_amount)).toBe(3000)
  })

  it('refuses a payment whose verifikat is a payment Accounted booked', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const invoiceId = await seedSupplierInvoice({ userId, companyId, total: 1000 })
    const entryId = await seedApVoucher({
      userId,
      companyId,
      fiscalPeriodId,
      amount: 1000,
      sourceType: 'supplier_invoice_paid',
    })

    const linked = await link(invoiceId, entryId, userId, companyId)
    expect(linked.ok).toBe(true)

    const result = await unlink(linked.payment_id!, invoiceId, companyId)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('UNLINK_SI_PAYMENT_BOOKED_PAYMENT')

    // Refused means nothing moved: storno owns this row and would restore both
    // halves together.
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.supplier_invoice_payments WHERE id = $1`,
      [linked.payment_id],
    )
    expect(rows[0].n).toBe(1)
    expect((await invoiceRow(invoiceId)).status).toBe('paid')
  })

  it('misses when addressed through a different invoice in the same company', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const invoiceId = await seedSupplierInvoice({ userId, companyId, total: 1000 })
    const otherInvoiceId = await seedSupplierInvoice({ userId, companyId, total: 1000 })
    const entryId = await seedApVoucher({ userId, companyId, fiscalPeriodId, amount: 400 })

    const linked = await link(invoiceId, entryId, userId, companyId)
    const result = await unlink(linked.payment_id!, otherInvoiceId, companyId)

    expect(result.ok).toBe(false)
    expect(result.code).toBe('UNLINK_SI_PAYMENT_NOT_FOUND')
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.supplier_invoice_payments WHERE id = $1`,
      [linked.payment_id],
    )
    expect(rows[0].n).toBe(1)
  })

  it('refuses a member whose role is read-only', async () => {
    // EXECUTE is granted to `authenticated`, so a viewer can reach the RPC over
    // PostgREST without passing the route's requireWrite. The gate has to live
    // here too, or the only thing standing between a viewer and a deleted
    // payment row is the application.
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const invoiceId = await seedSupplierInvoice({ userId, companyId, total: 1000 })
    const entryId = await seedApVoucher({ userId, companyId, fiscalPeriodId, amount: 400 })
    const linked = await link(invoiceId, entryId, userId, companyId)

    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })

    const result = await withUserContext(viewerId, async (client) => {
      const { rows } = await client.query(
        `SELECT public.unlink_supplier_invoice_from_voucher($1, $2, $3) AS result`,
        [linked.payment_id, invoiceId, companyId],
      )
      return rows[0].result as Record<string, unknown>
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('UNLINK_SI_PAYMENT_FORBIDDEN')
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.supplier_invoice_payments WHERE id = $1`,
      [linked.payment_id],
    )
    expect(rows[0].n).toBe(1)
  })

  it('refuses a caller who is not a member of the company', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const invoiceId = await seedSupplierInvoice({ userId, companyId, total: 1000 })
    const entryId = await seedApVoucher({ userId, companyId, fiscalPeriodId, amount: 400 })
    const linked = await link(invoiceId, entryId, userId, companyId)

    const outsider = await seedCompany()

    const result = await withUserContext(outsider.userId, async (client) => {
      const { rows } = await client.query(
        `SELECT public.unlink_supplier_invoice_from_voucher($1, $2, $3) AS result`,
        [linked.payment_id, invoiceId, companyId],
      )
      return rows[0].result as Record<string, unknown>
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('UNLINK_SI_PAYMENT_NOT_FOUND')
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.supplier_invoice_payments WHERE id = $1`,
      [linked.payment_id],
    )
    expect(rows[0].n).toBe(1)
  })
})
