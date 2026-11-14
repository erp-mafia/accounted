/**
 * pg-real tests for
 * 20261114070000_kontantmetod_purchase_paid_by_owner_links_supplier_invoice.sql
 * (crm#1817).
 *
 * Under kontantmetoden a supplier invoice with no registration verifikat is
 * settled by the verifikat that booked the purchase at payment. When the owner
 * paid with private money that verifikat is Dr cost, Dr 2641 / Cr 2018
 * (enskild firma) or Cr 2893 (aktiebolag), but the link only read 19xx
 * credits and refused it, so the invoice stayed open and mark-paid, the only
 * way left, booked the cost and the moms a second time.
 *
 * What only real Postgres can prove here:
 *   - the owner-paid verifikat links on 2018 and on 2893, writes a payment
 *     row dated at the verifikat and NOTHING in the journal;
 *   - the owner credit counts only on a verifikat that books a purchase: an
 *     owner's deposit, a skuld the owner cleared, an employee's utlägg (2820)
 *     and a 2890 credit are still not a payment;
 *   - a 19xx credit is read exactly as before, with or without a purchase;
 *   - capacity, the foreign-invoice fallback and faktureringsmetoden are
 *     unchanged;
 *   - supplier_invoice_settlement_line() and
 *     supplier_invoice_voucher_books_purchase() agree with their TypeScript
 *     twins, and anon cannot call them.
 *
 * All amounts are synthetic; only the shape is the report's.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertPostedJournalEntry, seedCompany, type PostedJournalEntryLine } from './fixtures'
import {
  AP_DEBIT_SIDE,
  settlesOnAccount,
  voucherBooksPurchase,
  type PurchaseCheckLine,
  type SupplierSettlementSide,
} from '@/lib/invoices/supplier-settlement-side'

type Seeded = Awaited<ReturnType<typeof seedCompany>>

interface LinkResult {
  ok: boolean
  code?: string
  details?: Record<string, unknown>
  invoice_status?: string
  payment_amount?: number
  remaining_amount?: number
  settlement_side?: string
  fx_journal_entry_id?: string | null
}

const BANK_CREDIT_SIDE: SupplierSettlementSide = { side: 'bank_credit', accountPrefix: '19', entrySide: 'credit' }

let seq = 0
const nextSeq = () => (Date.now() % 1_000_000) * 1000 + seq++

async function seedCompanyWithMethod(method: 'cash' | 'accrual'): Promise<Seeded> {
  const company = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, accounting_method)
     VALUES ($1, $2, $3)`,
    [company.userId, company.companyId, method],
  )
  return company
}

async function seedSupplierInvoice(params: {
  company: Seeded
  total?: number
  currency?: string
  exchangeRate?: number | null
  lineAccount?: string
}): Promise<string> {
  const { userId, companyId } = params.company
  const supplierId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers
       (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
     VALUES ($1, $2, $3, 'Leverantör AB', 'swedish_business', 'SE', 30, $4)`,
    [supplierId, userId, companyId, params.currency ?? 'SEK'],
  )
  const id = randomUUID()
  const total = params.total ?? 1250
  const arrivalNumber = nextSeq()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency, exchange_rate,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note, registration_journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-04-01', '2026-05-01', '2026-04-01', 'registered', $7, $8,
             $9, 0, $9, 0, $9, 'standard_25', false, false, NULL)`,
    [id, userId, companyId, supplierId, arrivalNumber, `LF-${arrivalNumber}`,
      params.currency ?? 'SEK', params.exchangeRate ?? null, total],
  )
  if (params.lineAccount) {
    await getPool().query(
      `INSERT INTO public.supplier_invoice_items
         (supplier_invoice_id, description, quantity, unit_price, line_total, account_number, vat_rate, vat_amount)
       VALUES ($1, 'Rad', 1, $2, $2, $3, 0, 0)`,
      [id, total, params.lineAccount],
    )
  }
  return id
}

async function seedVoucher(company: Seeded, lines: PostedJournalEntryLine[]): Promise<string> {
  return insertPostedJournalEntry({
    userId: company.userId,
    companyId: company.companyId,
    fiscalPeriodId: company.fiscalPeriodId,
    voucherNumber: nextSeq() % 1_000_000_000,
    entryDate: '2026-04-28',
    description: 'Inköp betalt privat av ägaren',
    sourceType: 'manual',
    lines,
  })
}

/** The reported shape: the cost and the ingående moms against the owner's funds. */
function ownerPaidLines(amount: number, ownerAccount: string): PostedJournalEntryLine[] {
  const vat = Math.round(amount * 0.2 * 100) / 100
  return [
    { accountNumber: '6230', debitAmount: Math.round((amount - vat) * 100) / 100, creditAmount: 0 },
    { accountNumber: '2641', debitAmount: vat, creditAmount: 0 },
    { accountNumber: ownerAccount, debitAmount: 0, creditAmount: amount },
  ]
}

async function link(company: Seeded, invoiceId: string, voucherId: string): Promise<LinkResult> {
  const { rows } = await getPool().query<{ result: LinkResult }>(
    `SELECT public.link_supplier_invoice_to_voucher($1, $2, $3, $4, NULL) AS result`,
    [invoiceId, voucherId, company.userId, company.companyId],
  )
  return rows[0].result
}

async function paymentRows(invoiceId: string) {
  const { rows } = await getPool().query<{
    amount: number
    currency: string
    payment_date: string
    journal_entry_id: string
    payment_exchange_rate: number | null
  }>(
    `SELECT amount::float8 AS amount, currency, payment_date::text, journal_entry_id,
            payment_exchange_rate::float8 AS payment_exchange_rate
     FROM public.supplier_invoice_payments WHERE supplier_invoice_id = $1 ORDER BY created_at`,
    [invoiceId],
  )
  return rows
}

async function invoiceState(invoiceId: string) {
  const { rows } = await getPool().query<{ status: string; remaining_amount: string; paid_at: string | null }>(
    `SELECT status, remaining_amount, paid_at::text FROM public.supplier_invoices WHERE id = $1`,
    [invoiceId],
  )
  return rows[0]
}

/** Everything the journal holds for a company, as one comparable string. */
async function journalFingerprint(companyId: string): Promise<string> {
  const { rows } = await getPool().query<{ fp: string }>(
    `SELECT COALESCE(string_agg(
       je.id::text || '|' || je.status || '|' || je.voucher_number || '|' ||
       l.account_number || '|' || l.debit_amount || '|' || l.credit_amount,
       ';' ORDER BY je.id, l.sort_order, l.id), '') AS fp
     FROM public.journal_entries je
     JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
     WHERE je.company_id = $1`,
    [companyId],
  )
  return rows[0].fp
}

describe('link_supplier_invoice_to_voucher: a kontantmetod purchase the owner paid privately', () => {
  it.each(['2018', '2893'])('links Dr cost, Dr 2641 / Cr %s and writes nothing in the journal', async (ownerAccount) => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher(company, ownerPaidLines(1250, ownerAccount))
    const journalBefore = await journalFingerprint(company.companyId)

    const result = await link(company, invoiceId, voucherId)

    expect(result).toMatchObject({
      ok: true,
      invoice_status: 'paid',
      payment_amount: 1250,
      remaining_amount: 0,
      settlement_side: 'bank_credit',
      fx_journal_entry_id: null,
    })
    // The cost and the moms were recognised once, by the verifikat the owner's
    // payment was booked on. The link is reskontra only.
    expect(await journalFingerprint(company.companyId)).toBe(journalBefore)
    expect(await paymentRows(invoiceId)).toEqual([
      {
        amount: 1250,
        currency: 'SEK',
        payment_date: '2026-04-28',
        journal_entry_id: voucherId,
        payment_exchange_rate: null,
      },
    ])
    const state = await invoiceState(invoiceId)
    expect(state.status).toBe('paid')
    expect(state.paid_at).toMatch(/^2026-04-28 12:00:00/)
  })

  it('refuses an owner credit on a verifikat that books no purchase', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250, lineAccount: '6230' })
    // Money the owner put INTO the firm, of the invoice's amount.
    const deposit = await seedVoucher(company, [
      { accountNumber: '1930', debitAmount: 1250, creditAmount: 0 },
      { accountNumber: '2018', debitAmount: 0, creditAmount: 1250 },
    ])
    const loan = await seedVoucher(company, [
      { accountNumber: '1930', debitAmount: 1250, creditAmount: 0 },
      { accountNumber: '2893', debitAmount: 0, creditAmount: 1250 },
    ])
    // The owner paid ANOTHER, booked, invoice's skuld.
    const clearedSkuld = await seedVoucher(company, [
      { accountNumber: '2440', debitAmount: 1250, creditAmount: 0 },
      { accountNumber: '2893', debitAmount: 0, creditAmount: 1250 },
    ])

    for (const voucherId of [deposit, loan, clearedSkuld]) {
      expect(await link(company, invoiceId, voucherId)).toEqual({
        ok: false, code: 'LINK_SI_VOUCHER_NO_BANK_CREDIT',
      })
    }
    expect(await paymentRows(invoiceId)).toHaveLength(0)
    expect((await invoiceState(invoiceId)).status).toBe('registered')
  })

  it('does not read an employee utlägg (2820) or a 2890 credit', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    for (const account of ['2820', '2890']) {
      const voucherId = await seedVoucher(company, ownerPaidLines(1250, account))
      expect(await link(company, invoiceId, voucherId)).toEqual({
        ok: false, code: 'LINK_SI_VOUCHER_NO_BANK_CREDIT',
      })
    }
  })

  it('reads a purchase on the account the invoice line posts to, and only then', async () => {
    const company = await seedCompanyWithMethod('cash')
    const inventarie: PostedJournalEntryLine[] = [
      { accountNumber: '1220', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '2641', debitAmount: 250, creditAmount: 0 },
      { accountNumber: '2893', debitAmount: 0, creditAmount: 1250 },
    ]
    const costInvoice = await seedSupplierInvoice({ company, total: 1250, lineAccount: '6230' })
    const assetInvoice = await seedSupplierInvoice({ company, total: 1250, lineAccount: '1220' })
    const voucherId = await seedVoucher(company, inventarie)

    expect(await link(company, costInvoice, voucherId)).toEqual({
      ok: false, code: 'LINK_SI_VOUCHER_NO_BANK_CREDIT',
    })
    expect(await link(company, assetInvoice, voucherId)).toMatchObject({ ok: true, invoice_status: 'paid' })
  })

  it('a 19xx credit is read as before: only that part of a verifikat that books no purchase', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher(company, [
      { accountNumber: '2440', debitAmount: 1250, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 800 },
      { accountNumber: '2018', debitAmount: 0, creditAmount: 450 },
    ])

    expect(await link(company, invoiceId, voucherId)).toMatchObject({
      ok: true, invoice_status: 'partially_paid', payment_amount: 800, remaining_amount: 450,
    })
  })

  it('sums the bank part and the owner part of one purchase', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher(company, [
      { accountNumber: '6230', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '2641', debitAmount: 250, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 800 },
      { accountNumber: '2018', debitAmount: 0, creditAmount: 450 },
    ])

    expect(await link(company, invoiceId, voucherId)).toMatchObject({
      ok: true, invoice_status: 'paid', payment_amount: 1250,
    })
  })

  it('an owner-paid verifikat one invoice has used in full cannot pay a second one', async () => {
    const company = await seedCompanyWithMethod('cash')
    const first = await seedSupplierInvoice({ company, total: 1250 })
    const second = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher(company, ownerPaidLines(1250, '2018'))

    expect(await link(company, first, voucherId)).toMatchObject({ ok: true, invoice_status: 'paid' })
    expect(await link(company, second, voucherId)).toMatchObject({
      ok: false, code: 'LINK_SI_VOUCHER_FULLY_ALLOCATED',
    })
    expect((await invoiceState(second)).status).toBe('registered')
  })

  it('a foreign invoice the owner paid in kronor settles in full and books no residual', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 100, currency: 'EUR', exchangeRate: 11.5 })
    // Reverse charge on a service bought from another EU country.
    const voucherId = await seedVoucher(company, [
      { accountNumber: '6230', debitAmount: 1160, creditAmount: 0 },
      { accountNumber: '2645', debitAmount: 290, creditAmount: 0 },
      { accountNumber: '2614', debitAmount: 0, creditAmount: 290 },
      { accountNumber: '2018', debitAmount: 0, creditAmount: 1160 },
    ])
    const journalBefore = await journalFingerprint(company.companyId)

    const result = await link(company, invoiceId, voucherId)

    expect(result).toMatchObject({
      ok: true, invoice_status: 'paid', payment_amount: 100, fx_journal_entry_id: null,
    })
    expect(await journalFingerprint(company.companyId)).toBe(journalBefore)
    expect(await paymentRows(invoiceId)).toMatchObject([
      { amount: 100, currency: 'EUR', journal_entry_id: voucherId, payment_exchange_rate: null },
    ])
  })

  it('faktureringsmetoden is unchanged: the same verifikat has no 244x debit', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher(company, ownerPaidLines(1250, '2893'))

    expect(await link(company, invoiceId, voucherId)).toEqual({
      ok: false, code: 'LINK_SI_VOUCHER_NO_AP_DEBIT',
    })
  })
})

describe('supplier_invoice_settlement_line parity with settlesOnAccount', () => {
  const CASES: ReadonlyArray<[side: 'bank_credit' | 'ap_debit', account: string, booksPurchase: boolean, expected: boolean]> = [
    ['bank_credit', '1930', false, true],
    ['bank_credit', '1910', true, true],
    ['bank_credit', '2018', true, true],
    ['bank_credit', '2893', true, true],
    ['bank_credit', '2018', false, false],
    ['bank_credit', '2893', false, false],
    ['bank_credit', '2820', true, false],
    ['bank_credit', '2890', true, false],
    ['bank_credit', '2013', true, false],
    ['bank_credit', '20180', true, false],
    ['bank_credit', '2440', true, false],
    ['ap_debit', '2440', false, true],
    ['ap_debit', '2441', true, true],
    ['ap_debit', '2893', true, false],
    ['ap_debit', '2018', true, false],
    ['ap_debit', '1930', true, false],
  ]

  it.each(CASES)('%s, %s, books purchase %s', async (side, account, booksPurchase, expected) => {
    const { rows } = await getPool().query<{ settles: boolean }>(
      'SELECT public.supplier_invoice_settlement_line($1, $2, $3) AS settles',
      [side, account, booksPurchase],
    )
    const tsSide = side === 'bank_credit' ? BANK_CREDIT_SIDE : AP_DEBIT_SIDE
    expect({ sql: rows[0].settles, ts: settlesOnAccount(tsSide, account, booksPurchase) }).toEqual({
      sql: expected,
      ts: expected,
    })
  })

  it('answers false, never NULL, for a missing account or purchase flag', async () => {
    const { rows } = await getPool().query<{ no_account: boolean; no_flag: boolean }>(
      `SELECT public.supplier_invoice_settlement_line('bank_credit', NULL, true) AS no_account,
              public.supplier_invoice_settlement_line('bank_credit', '2018', NULL) AS no_flag`,
    )
    expect(rows[0]).toEqual({ no_account: false, no_flag: false })
    expect(settlesOnAccount(BANK_CREDIT_SIDE, null, true)).toBe(false)
  })
})

describe('supplier_invoice_voucher_books_purchase parity with voucherBooksPurchase', () => {
  type Row = [account: string | null, debit: number | string, credit: number | string]
  const line = ([account_number, debit_amount, credit_amount]: Row): PurchaseCheckLine => ({
    account_number,
    debit_amount,
    credit_amount,
  })

  const CASES: ReadonlyArray<[label: string, rows: Row[], lineAccounts: string[], expected: boolean]> = [
    ['a cost paid by the owner', [['6230', 1000, 0], ['2641', 250, 0], ['2018', 0, 1250]], [], true],
    ['goods paid by the owner', [['4010', 1250, 0], ['2893', 0, 1250]], [], true],
    ['a class 5 and a class 7 cost', [['5410', 500, 0], ['7610', 500, 0], ['2893', 0, 1000]], [], true],
    ['an owner deposit', [['1930', 1250, 0], ['2018', 0, 1250]], [], false],
    ['an owner deposit even when 1930 is listed', [['1930', 1250, 0], ['2018', 0, 1250]], ['1930'], false],
    ['a loan from the owner', [['1930', 1250, 0], ['2893', 0, 1250]], [], false],
    ['a skuld the owner cleared', [['2440', 1250, 0], ['2893', 0, 1250]], [], false],
    ['an inventarie, no line on 1220', [['1220', 1000, 0], ['2641', 250, 0], ['2893', 0, 1250]], ['6230'], false],
    ['an inventarie on the invoice line\'s 1220', [['1220', 1000, 0], ['2641', 250, 0], ['2893', 0, 1250]], ['1220'], true],
    ['ingående moms alone', [['2641', 250, 0], ['2018', 0, 250]], [], false],
    ['a cost credit only', [['2018', 1250, 0], ['6230', 0, 1250]], [], false],
    ['a zero cost debit', [['6230', 0, 0], ['1930', 100, 0], ['2018', 0, 100]], [], false],
    ['revenue and financial accounts are not costs', [['3001', 100, 0], ['8410', 100, 0], ['2018', 0, 200]], [], false],
    ['interest on the invoice line\'s 8410', [['8410', 100, 0], ['2018', 0, 100]], ['8410'], true],
    ['amounts as strings', [['6230', '1250.00', '0.00'], ['2018', '0.00', '1250.00']], [], true],
    ['a line without an account', [[null, 100, 0], ['2018', 0, 100]], [], false],
    ['a five-digit cost account (prefix, not arithmetic)', [['62301', 100, 0], ['2018', 0, 100]], [], true],
    ['no lines at all', [], [], false],
  ]

  it.each(CASES)('%s', async (_label, rows, lineAccounts, expected) => {
    const lines = rows.map(line)
    const { rows: result } = await getPool().query<{ books: boolean }>(
      'SELECT public.supplier_invoice_voucher_books_purchase($1::jsonb, $2::text[]) AS books',
      [JSON.stringify(lines), lineAccounts],
    )
    expect({ sql: result[0].books, ts: voucherBooksPurchase(lines, lineAccounts) }).toEqual({
      sql: expected,
      ts: expected,
    })
  })

  it('reads a NULL lines or accounts argument as empty', async () => {
    const { rows } = await getPool().query<{ no_lines: boolean; no_accounts: boolean }>(
      `SELECT public.supplier_invoice_voucher_books_purchase(NULL, NULL) AS no_lines,
              public.supplier_invoice_voucher_books_purchase($1::jsonb, NULL) AS no_accounts`,
      [JSON.stringify([line(['6230', 100, 0]), line(['2018', 0, 100])])],
    )
    expect(rows[0]).toEqual({ no_lines: false, no_accounts: true })
  })

  it('neither function is callable by anon', async () => {
    const { rows } = await getPool().query<{ anon_line: boolean; anon_purchase: boolean; auth_line: boolean; auth_purchase: boolean }>(
      `SELECT has_function_privilege('anon', 'public.supplier_invoice_settlement_line(text,text,boolean)', 'EXECUTE') AS anon_line,
              has_function_privilege('anon', 'public.supplier_invoice_voucher_books_purchase(jsonb,text[])', 'EXECUTE') AS anon_purchase,
              has_function_privilege('authenticated', 'public.supplier_invoice_settlement_line(text,text,boolean)', 'EXECUTE') AS auth_line,
              has_function_privilege('authenticated', 'public.supplier_invoice_voucher_books_purchase(jsonb,text[])', 'EXECUTE') AS auth_purchase`,
    )
    expect(rows[0]).toEqual({ anon_line: false, anon_purchase: false, auth_line: true, auth_purchase: true })
  })
})
