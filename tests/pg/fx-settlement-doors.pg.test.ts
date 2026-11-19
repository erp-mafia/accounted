import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { fxDeviationTooLarge } from '@/lib/bookkeeping/fx-settlement'
import { buildBatchAllocationPreview } from '@/lib/invoices/batch-allocation-preview'
import { sekBookedSettlement } from '@/lib/invoices/voucher-matching-shared'
import { insertCashAccount, insertPostedJournalEntry, seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * One foreign settlement through the SQL door, on real Postgres: the row's
 * currency, the SEK the ledger carries and the rounding of a foreign amount.
 *
 * match_batch_allocate read no amount_sek: a EUR bank row booked its face
 * figure as kronor on both legs, so 1000 EUR left 10 300 kr on 1510 of a paid
 * invoice and the entry balanced. Its siblings bulk_book_transactions and
 * create_expense_payout_batch refuse a foreign row, and now it does too.
 *
 * A full settlement clears what the registration left on 1510 or 2440, which
 * is the sum of its per-line SEK and not the remainder times the rate: 176.70
 * EUR at 11.123 is 1965.43, and a registration of 141.36 + 35.34 credits
 * 1965.44. The öre that was stranded on the ledger lands on 3960/7960 instead.
 */

const pool = () => getPool()

type Company = Awaited<ReturnType<typeof seedCompany>>

async function insertCustomer(company: Company): Promise<string> {
  const id = randomUUID()
  await pool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type, country)
     VALUES ($1, $2, $3, 'Kund AB', 'swedish_business', 'SE')`,
    [id, company.userId, company.companyId],
  )
  return id
}

async function insertSupplier(company: Company): Promise<string> {
  const id = randomUUID()
  await pool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
     VALUES ($1, $2, $3, 'Leverantör AB', 'swedish_business', 'SE', 30, 'SEK')`,
    [id, company.userId, company.companyId],
  )
  return id
}

async function registrationOn(company: Company, account: '1510' | '2440', sek: number): Promise<string> {
  return insertPostedJournalEntry({
    userId: company.userId,
    companyId: company.companyId,
    fiscalPeriodId: company.fiscalPeriodId,
    entryDate: '2026-06-01',
    sourceType: account === '1510' ? 'invoice_created' : 'supplier_invoice_registered',
    lines:
      account === '1510'
        ? [
            { accountNumber: '1510', debitAmount: sek, creditAmount: 0 },
            { accountNumber: '3001', debitAmount: 0, creditAmount: sek },
          ]
        : [
            { accountNumber: '6540', debitAmount: sek, creditAmount: 0 },
            { accountNumber: '2440', debitAmount: 0, creditAmount: sek },
          ],
  })
}

async function insertCustomerInvoice(
  company: Company,
  params: { currency: string; rate: number | null; total: number; journalEntryId?: string | null },
): Promise<string> {
  const id = randomUUID()
  const customerId = await insertCustomer(company)
  await pool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status, currency, exchange_rate,
        subtotal, vat_amount, total, paid_amount, remaining_amount, vat_treatment, journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, '2026-06-01', '2026-07-01', 'sent', $6, $7, $8, 0, $8, 0, $8, 'export', $9)`,
    [id, company.userId, company.companyId, customerId, `F-${id.slice(0, 8)}`, params.currency, params.rate, params.total, params.journalEntryId ?? null],
  )
  return id
}

let arrival = 700_000

async function insertSupplierInvoice(
  company: Company,
  params: { currency: string; rate: number | null; total: number; journalEntryId?: string | null },
): Promise<string> {
  const id = randomUUID()
  const supplierId = await insertSupplier(company)
  arrival += 1
  await pool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency, exchange_rate,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note, registration_journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-06-01', '2026-07-01', '2026-06-01', 'approved', $7, $8,
             $9, 0, $9, 0, $9, 'standard_25', false, false, $10)`,
    [id, company.userId, company.companyId, supplierId, arrival, `LF-${arrival}`, params.currency, params.rate, params.total, params.journalEntryId ?? null],
  )
  return id
}

async function insertRow(
  company: Company,
  params: { amount: number; currency?: string; amountSek?: number | null; rate?: number | null; cashAccountId?: string | null },
): Promise<string> {
  const id = randomUUID()
  await pool().query(
    `INSERT INTO public.transactions
       (id, user_id, company_id, date, description, amount, currency, amount_sek, exchange_rate, cash_account_id, category)
     VALUES ($1, $2, $3, '2026-06-05', 'Bank', $4, $5, $6, $7, $8, 'uncategorized')`,
    [id, company.userId, company.companyId, params.amount, params.currency ?? 'SEK', params.amountSek ?? null, params.rate ?? null, params.cashAccountId ?? null],
  )
  return id
}

type RpcResult = { ok: boolean; code?: string; details?: Record<string, unknown>; journal_entry_id?: string }

async function allocate(company: Company, txId: string, allocation: Record<string, unknown>): Promise<RpcResult> {
  return withUserContext(company.userId, async (client) => {
    const { rows } = await client.query<{ result: RpcResult }>(
      'SELECT public.match_batch_allocate($1, $2::jsonb, $3) AS result',
      [txId, JSON.stringify([allocation]), company.companyId],
    )
    const result = rows[0].result
    if (result.ok) await client.query('COMMIT')
    return result
  })
}

async function linesOf(entryId: string): Promise<string[]> {
  const { rows } = await pool().query<{ account_number: string; debit: number; credit: number }>(
    `SELECT account_number, debit_amount::float8 AS debit, credit_amount::float8 AS credit
       FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY sort_order`,
    [entryId],
  )
  return rows.map((l) => `${l.account_number} D${l.debit} K${l.credit}`)
}

async function accountBalance(entryIds: string[], account: string): Promise<number> {
  const { rows } = await pool().query<{ balance: string }>(
    `SELECT COALESCE(SUM(debit_amount - credit_amount), 0) AS balance
       FROM public.journal_entry_lines WHERE journal_entry_id = ANY($1::uuid[]) AND account_number = $2`,
    [entryIds, account],
  )
  return Number(rows[0].balance)
}

describe('a foreign bank row', () => {
  it('is refused: its figure never lands in the kronor columns', async () => {
    const company = await seedCompany()
    const cashAccountId = await insertCashAccount({ companyId: company.companyId, ledgerAccount: '1932', currency: 'EUR' })
    const invoiceId = await insertCustomerInvoice(company, { currency: 'EUR', rate: 11.3, total: 1000 })
    const txId = await insertRow(company, { amount: 1000, currency: 'EUR', amountSek: 11500, rate: 11.5, cashAccountId })

    const result = await allocate(company, txId, { kind: 'customer_invoice', invoice_id: invoiceId, amount: 1000 })

    expect(result).toMatchObject({ ok: false, code: 'BATCH_FOREIGN_CURRENCY', details: { currency: 'EUR' } })
    const { rows } = await pool().query('SELECT status, paid_amount FROM public.invoices WHERE id = $1', [invoiceId])
    expect(rows[0]).toMatchObject({ status: 'sent' })
  })

  it('is refused on a supplier invoice too, in a third currency as well', async () => {
    const company = await seedCompany()
    const cashAccountId = await insertCashAccount({ companyId: company.companyId, ledgerAccount: '1932', currency: 'EUR' })
    const invoiceId = await insertSupplierInvoice(company, { currency: 'USD', rate: 9.5, total: 100 })
    const txId = await insertRow(company, { amount: -90, currency: 'EUR', amountSek: -1035, rate: 11.5, cashAccountId })

    const result = await allocate(company, txId, { kind: 'supplier_invoice', supplier_invoice_id: invoiceId, amount: 90 })

    expect(result).toMatchObject({ ok: false, code: 'BATCH_FOREIGN_CURRENCY', details: { currency: 'EUR' } })
  })

  it('takes no öresavrundning: 99.50 EUR on a 100 EUR invoice books no 3740', async () => {
    const company = await seedCompany()
    const cashAccountId = await insertCashAccount({ companyId: company.companyId, ledgerAccount: '1932', currency: 'EUR' })
    const invoiceId = await insertCustomerInvoice(company, { currency: 'EUR', rate: 11.3, total: 100 })
    const txId = await insertRow(company, { amount: 99.5, currency: 'EUR', amountSek: 1144.25, rate: 11.5, cashAccountId })

    const result = await allocate(company, txId, { kind: 'customer_invoice', invoice_id: invoiceId, amount: 99.5 })

    expect(result).toMatchObject({ ok: false, code: 'BATCH_FOREIGN_CURRENCY' })
  })
})

describe('a full settlement clears what the registration left', () => {
  // 141.36 + 35.34 EUR at 11.123: the registration credits 1572.35 + 393.09 =
  // 1965.44, the invoice total at the rate is 1965.43.
  const total = 176.7
  const rate = 11.123
  const registered = 1965.44

  it('on 1510: nothing stays on the ledger of a paid invoice', async () => {
    const company = await seedCompany()
    const registration = await registrationOn(company, '1510', registered)
    const invoiceId = await insertCustomerInvoice(company, { currency: 'EUR', rate, total, journalEntryId: registration })
    const txId = await insertRow(company, { amount: 1970 })

    const result = await allocate(company, txId, { kind: 'customer_invoice', invoice_id: invoiceId, amount: 1970 })

    expect(result).toMatchObject({ ok: true })
    expect(await accountBalance([registration, result.journal_entry_id!], '1510')).toBe(0)
    expect(await linesOf(result.journal_entry_id!)).toEqual(['1510 D0 K1965.44', '3960 D0 K4.56', '1930 D1970 K0'])
  })

  it('on 2440: nothing stays on the ledger of a paid invoice', async () => {
    const company = await seedCompany()
    const registration = await registrationOn(company, '2440', registered)
    const invoiceId = await insertSupplierInvoice(company, { currency: 'EUR', rate, total, journalEntryId: registration })
    const txId = await insertRow(company, { amount: -1970 })

    const result = await allocate(company, txId, { kind: 'supplier_invoice', supplier_invoice_id: invoiceId, amount: 1970 })

    expect(result).toMatchObject({ ok: true })
    expect(await accountBalance([registration, result.journal_entry_id!], '2440')).toBe(0)
    expect(await linesOf(result.journal_entry_id!)).toEqual(['2440 D1965.44 K0', '7960 D4.56 K0', '1930 D0 K1970'])
  })
})

describe('the preview shows the booking', () => {
  // Exact half öre: 30 x 10.9455 = 328.365, a prod pair. The float product
  // is 328.36499..., and numeric rounds the written decimals to 328.37.
  it.each([
    [30, 10.9455, 328.37],
    [1630, 11.1465, 18168.8],
    [33.33, 11.5, 383.3],
  ])('%d EUR at %d: the RPC posts the 1510 the preview shows', async (total, rate, sek) => {
    const company = await seedCompany()
    const invoiceId = await insertCustomerInvoice(company, { currency: 'EUR', rate, total })
    const bank = Math.round(sek)
    const txId = await insertRow(company, { amount: bank })

    const allocation = { kind: 'customer_invoice' as const, invoice_id: invoiceId, amount: bank }
    const preview = buildBatchAllocationPreview({
      transaction: { amount: bank, date: '2026-06-05' },
      bankAccount: '1930',
      allocations: [allocation],
      invoices: { [invoiceId]: { currency: 'EUR', exchange_rate: rate, remaining_amount: total, total } },
    })
    const result = await allocate(company, txId, allocation)

    expect(result).toMatchObject({ ok: true })
    const posted = await linesOf(result.journal_entry_id!)
    expect(posted[0]).toBe(`1510 D0 K${sek}`)
    expect(preview.lines.map((l) => `${l.account_number} D${l.debit} K${l.credit}`).sort()).toEqual([...posted].sort())
  })
})

describe('the preview of a foreign invoice that has a ledger', () => {
  it('shows what the RPC posts, read from the same definition', async () => {
    const company = await seedCompany()
    const registration = await registrationOn(company, '2440', 1965.44)
    const invoiceId = await insertSupplierInvoice(company, { currency: 'EUR', rate: 11.123, total: 176.7, journalEntryId: registration })
    const txId = await insertRow(company, { amount: -1970 })
    const allocation = { kind: 'supplier_invoice' as const, supplier_invoice_id: invoiceId, amount: 1970 }

    const { rows } = await pool().query<{ carried: { ok: boolean; sek: number } }>(
      `SELECT public.document_carried_sek($1, 'supplier', $2) AS carried`,
      [company.companyId, invoiceId],
    )
    const preview = buildBatchAllocationPreview({
      transaction: { amount: -1970, date: '2026-06-05' },
      bankAccount: '1930',
      allocations: [allocation],
      invoices: {
        [invoiceId]: { currency: 'EUR', exchange_rate: 11.123, remaining_amount: 176.7, total: 176.7, carried_sek: rows[0].carried.sek },
      },
    })
    const result = await allocate(company, txId, allocation)

    expect(preview.lines.map((l) => `${l.account_number} D${l.debit} K${l.credit}`).sort()).toEqual(
      [...(await linesOf(result.journal_entry_id!))].sort(),
    )
  })
})

describe('the limit on a kronor figure against the booked SEK, at the edge, on every SQL door', () => {
  // 1000 EUR booked at 11: 11 000 kr. fxDeviationTooLarge says 10 %, 1 100 kr.
  const EDGES: ReadonlyArray<[sek: number, inside: boolean]> = [
    [12100, true],
    [12100.01, false],
    [9900, true],
    [9899.99, false],
  ]

  it.each(EDGES)('the TypeScript gate of the link doors at %d', (sek, inside) => {
    const gate = sekBookedSettlement([{ currency: 'SEK', amount_in_currency: null, sideSek: sek }], 'EUR', 11, 1000)
    expect(gate.eligible).toBe(inside)
    expect(fxDeviationTooLarge(sek, 11000)).toBe(!inside)
  })

  it.each(EDGES)('match_batch_allocate at %d', async (sek, inside) => {
    const company = await seedCompany()
    const invoiceId = await insertCustomerInvoice(company, { currency: 'EUR', rate: 11, total: 1000 })
    const txId = await insertRow(company, { amount: sek })
    const result = await allocate(company, txId, { kind: 'customer_invoice', invoice_id: invoiceId, amount: sek })
    expect(result).toMatchObject(inside ? { ok: true } : { ok: false, code: 'BATCH_FX_DEVIATION_TOO_LARGE' })
  })

  it.each(EDGES)('link_invoice_to_voucher at %d', async (sek, inside) => {
    const company = await seedCompany()
    const registration = await registrationOn(company, '1510', 11000)
    const invoiceId = await insertCustomerInvoice(company, { currency: 'EUR', rate: 11, total: 1000, journalEntryId: registration })
    const voucher = await insertPostedJournalEntry({
      userId: company.userId,
      companyId: company.companyId,
      fiscalPeriodId: company.fiscalPeriodId,
      entryDate: '2026-06-05',
      lines: [
        { accountNumber: '1930', debitAmount: sek, creditAmount: 0 },
        { accountNumber: '1510', debitAmount: 0, creditAmount: sek },
      ],
    })
    const { rows } = await pool().query<{ result: RpcResult }>(
      'SELECT public.link_invoice_to_voucher($1, $2, $3, $4) AS result',
      [invoiceId, voucher, company.userId, company.companyId],
    )
    expect(rows[0].result).toMatchObject(
      inside ? { ok: true } : { ok: false, code: 'LINK_VOUCHER_CURRENCY_MISMATCH', details: { reason: 'fx_deviation_too_large' } },
    )
  })

  it.each(EDGES)('link_supplier_invoice_to_voucher at %d', async (sek, inside) => {
    const company = await seedCompany()
    const registration = await registrationOn(company, '2440', 11000)
    const invoiceId = await insertSupplierInvoice(company, { currency: 'EUR', rate: 11, total: 1000, journalEntryId: registration })
    const voucher = await insertPostedJournalEntry({
      userId: company.userId,
      companyId: company.companyId,
      fiscalPeriodId: company.fiscalPeriodId,
      entryDate: '2026-06-05',
      lines: [
        { accountNumber: '2440', debitAmount: sek, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: sek },
      ],
    })
    const { rows } = await pool().query<{ result: RpcResult }>(
      'SELECT public.link_supplier_invoice_to_voucher($1, $2, $3, $4) AS result',
      [invoiceId, voucher, company.userId, company.companyId],
    )
    expect(rows[0].result).toMatchObject(
      inside ? { ok: true } : { ok: false, code: 'LINK_SI_VOUCHER_CURRENCY_MISMATCH', details: { reason: 'fx_deviation_too_large' } },
    )
  })
})

describe('sekOfForeign and round(amount * rate, 2) on numeric', () => {
  it.each([
    [1630, 11.1465],
    [56650, 11.1465],
    [-56650, 11.1465],
    [30, 10.9455],
    [-30, 10.9455],
    [33.33, 11.5],
    [150, 11.7285],
    [1, 1.005],
    [176.7, 11.123],
    [0.01, 10.5],
    [-0.01, 0.1],
  ])('%d x %d', async (amount, rate) => {
    const { rows } = await pool().query<{ sek: string }>('SELECT round($1::numeric * $2::numeric, 2) AS sek', [String(amount), String(rate)])
    expect(sekOfForeign(amount, rate)).toBe(Number(rows[0].sek))
  })
})
