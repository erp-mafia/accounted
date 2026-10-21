/**
 * pg-real test for kontantmetoden partial payments (buildInvoiceCashPartialLines).
 *
 * The builder is pure, so its own suite pins the arithmetic. What only a real
 * Postgres can pin is that the installments it produces survive the ledger:
 *
 *   1. every installment passes the posting guards (balance, period) as one
 *      invoice_cash_payment verifikat each, several per invoice;
 *   2. the AR sub-ledger takes one transaction-less row per installment and
 *      the rows add up to the invoice;
 *   3. get_vat_declaration_totals reports each installment's moms in the
 *      month it was received (bokslutsmetoden), and over the year exactly the
 *      invoice's moms per rate and its revenue per account.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { insertPostedJournalEntry, seedCompany } from './fixtures'
import { buildInvoiceCashPartialLines } from '@/lib/bookkeeping/invoice-lines'
import { roundOre } from '@/lib/money'
import type { Invoice, InvoiceItem } from '@/types'

const REVENUE_AND_VAT = ['3001', '3002', '3003', '2611', '2621', '2631']
const NET_ACCOUNTS = ['2650', '1650']

function item(id: string, net: number, rate: number, vat: number): InvoiceItem {
  return {
    id,
    invoice_id: 'inv',
    description: `Rad ${id}`,
    quantity: 1,
    unit: 'st',
    unit_price: net,
    line_total: net,
    vat_rate: rate,
    vat_amount: vat,
    sort_order: 0,
    created_at: '2026-02-01',
  }
}

async function seedCashInvoice(params: { userId: string; companyId: string }): Promise<Invoice> {
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Delbetalare AB', 'swedish_business')`,
    [customerId, params.userId, params.companyId],
  )
  const id = randomUUID()
  // 25 %: 1 000 + 250; 12 %: 500 + 60; 6 %: 199,99 + 12 = 2 021,99.
  const invoice = {
    id,
    invoice_number: `F-${id.slice(0, 8)}`,
    currency: 'SEK',
    exchange_rate: null,
    vat_treatment: 'standard_25',
    subtotal: 1699.99,
    vat_amount: 322,
    total: 2021.99,
    deduction_total: 0,
    items: [item('a', 1000, 25, 250), item('b', 500, 12, 60), item('c', 199.99, 6, 12)],
  } as unknown as Invoice
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status,
        paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-02-15', '2026-03-15', 'SEK',
             $6, $7, $8, 'standard_25', 25, 'sent', 0, $8)`,
    [id, params.userId, params.companyId, customerId, invoice.invoice_number, invoice.subtotal, invoice.vat_amount, invoice.total],
  )
  return invoice
}

async function vatTotals(companyId: string, start: string, end: string) {
  const { rows } = await getPool().query(
    `SELECT public.get_vat_declaration_totals($1, $2, $3, $4, $5, $6) AS payload`,
    [companyId, start, end, [...REVENUE_AND_VAT, ...NET_ACCOUNTS], REVENUE_AND_VAT, NET_ACCOUNTS],
  )
  const totals = rows[0].payload.totals as Array<{ account_number: string; debit: number; credit: number }>
  return Object.fromEntries(
    totals.map((t) => [t.account_number, roundOre(Number(t.credit) - Number(t.debit))]),
  )
}

describe('kontantmetoden installments in the ledger', () => {
  it('books each installment in its own month and the year adds up to the invoice', async () => {
    const seeded = await seedCompany()
    const invoice = await seedCashInvoice(seeded)
    const installments = [
      { date: '2026-03-10', amount: 700 },
      { date: '2026-04-20', amount: 1000 },
      { date: '2026-06-05', amount: 321.99 },
    ]

    let paid = 0
    const booked: Array<Record<string, number>> = []
    for (const [index, installment] of installments.entries()) {
      const result = buildInvoiceCashPartialLines(
        invoice,
        'aktiebolag',
        { priorPaid: paid, amount: installment.amount },
        'Delbetalare AB',
      )
      if (!result.ok) throw new Error(result.reason)
      const entryId = await insertPostedJournalEntry({
        userId: seeded.userId,
        companyId: seeded.companyId,
        fiscalPeriodId: seeded.fiscalPeriodId,
        entryDate: installment.date,
        description: result.description,
        sourceType: 'invoice_cash_payment',
        sourceId: invoice.id,
        voucherNumber: 100 + index,
        lines: result.lines.map((line) => ({
          accountNumber: line.account_number,
          debitAmount: line.debit_amount,
          creditAmount: line.credit_amount,
          dimensions: line.dimensions,
        })),
      })
      await getPool().query(
        `INSERT INTO public.invoice_payments
           (user_id, company_id, invoice_id, payment_date, amount, currency, journal_entry_id)
         VALUES ($1, $2, $3, $4, $5, 'SEK', $6)`,
        [seeded.userId, seeded.companyId, invoice.id, installment.date, installment.amount, entryId],
      )
      booked.push(
        Object.fromEntries(
          result.lines
            .filter((line) => line.account_number !== '1930')
            .map((line) => [line.account_number, roundOre(line.credit_amount - line.debit_amount)]),
        ),
      )
      paid = result.paidAfter
    }
    expect(paid).toBe(2021.99)

    // 1 + 2: three posted verifikat on the invoice, three sub-ledger rows.
    const { rows: entries } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.journal_entries
        WHERE company_id = $1 AND source_type = 'invoice_cash_payment' AND source_id = $2 AND status = 'posted'`,
      [seeded.companyId, invoice.id],
    )
    expect(entries[0].n).toBe(3)
    const { rows: payments } = await getPool().query(
      `SELECT count(*)::int AS n, sum(amount)::float8 AS total FROM public.invoice_payments WHERE invoice_id = $1`,
      [invoice.id],
    )
    expect(payments[0]).toEqual({ n: 3, total: 2021.99 })

    // 3: each month reports its own installment's moms and revenue...
    expect(await vatTotals(seeded.companyId, '2026-03-01', '2026-03-31')).toEqual(booked[0])
    expect(await vatTotals(seeded.companyId, '2026-04-01', '2026-04-30')).toEqual(booked[1])
    expect(await vatTotals(seeded.companyId, '2026-06-01', '2026-06-30')).toEqual(booked[2])
    // ...and the year exactly the invoice, per rate.
    expect(await vatTotals(seeded.companyId, '2026-01-01', '2026-12-31')).toEqual({
      '3001': 1000,
      '2611': 250,
      '3002': 500,
      '2621': 60,
      '3003': 199.99,
      '2631': 12,
    })
  })
})
