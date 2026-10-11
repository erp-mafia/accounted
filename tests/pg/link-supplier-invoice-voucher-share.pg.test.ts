/**
 * pg-real tests for migration
 * 20261011153000_link_supplier_invoice_to_voucher_share.sql (GitHub issue 3490).
 *
 * One bank payment often pays several leverantörsskulder and is booked as one
 * verifikat. The link read the whole 244x debit as the payment of the one
 * invoice it was asked about and refused as soon as the debit was larger than
 * the invoice's remainder. A company that came in by SIE was stuck there: the
 * other debt is not an invoice in Accounted at all, only part of the 2440
 * opening balance, so the invoice could never be settled against the verifikat
 * that paid it.
 *
 * What only real Postgres can prove here:
 *   - the reported scenario end to end: the share settles the invoice, nothing
 *     is written to the journal, and the leverantörsreskontra agrees with 2440;
 *   - the rule the old refusal stood in for: the payment rows pointing at one
 *     verifikat never add up to more than its settlement side, on the 244x
 *     side as on the 19xx side, under concurrency too;
 *   - that a call without a stated share still splits nothing on a guess;
 *   - that a share is refused where the verifikat is not in the invoice's
 *     currency, before any kursdifferens verifikat is booked;
 *   - the signature: one function, five positional arguments still resolve.
 *
 * All amounts are synthetic.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { insertPostedJournalEntry, seedCompany, type PostedJournalEntryLine } from './fixtures'

let arrivalSeq = 0

type Seeded = Awaited<ReturnType<typeof seedCompany>>

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
  total: number
  currency?: string
  exchangeRate?: number | null
  registrationEntryId?: string | null
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
  // Time component for cross-run uniqueness, counter for within-run uniqueness.
  const arrivalNumber = (Date.now() % 1_000_000) * 1000 + arrivalSeq++
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency, exchange_rate,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note, registration_journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-04-01', '2026-05-01', '2026-04-01', 'registered', $7, $8,
             $9, 0, $9, 0, $9, 'standard_25', false, false, $10)`,
    [
      id, userId, companyId, supplierId, arrivalNumber, `LF-${arrivalNumber}`,
      params.currency ?? 'SEK', params.exchangeRate ?? null,
      params.total, params.registrationEntryId ?? null,
    ],
  )
  return id
}

/** Faktureringsmetoden: leverantörsskulder against the bank account. */
function accrualPaymentLines(amount: number): PostedJournalEntryLine[] {
  return [
    { accountNumber: '2440', debitAmount: amount, creditAmount: 0 },
    { accountNumber: '1930', debitAmount: 0, creditAmount: amount },
  ]
}

/** Kontantmetoden: the cost against the bank account, no 244x line at all. */
function cashPaymentLines(amount: number): PostedJournalEntryLine[] {
  return [
    { accountNumber: '4010', debitAmount: amount, creditAmount: 0 },
    { accountNumber: '1930', debitAmount: 0, creditAmount: amount },
  ]
}

async function seedVoucher(params: {
  company: Seeded
  lines: PostedJournalEntryLine[]
  entryDate?: string
  sourceType?: string
}): Promise<string> {
  return insertPostedJournalEntry({
    userId: params.company.userId,
    companyId: params.company.companyId,
    fiscalPeriodId: params.company.fiscalPeriodId,
    voucherNumber: Math.floor(Math.random() * 1_000_000),
    entryDate: params.entryDate ?? '2026-04-28',
    description: 'Leverantörsbetalning',
    sourceType: params.sourceType ?? 'manual',
    lines: params.lines,
  })
}

/**
 * A posted payment whose 244x debit carries document-currency metadata
 * (`currency` + `amount_in_currency`), which the shared fixture cannot
 * express. Built the way the fixture builds its entries (draft, lines, post),
 * so every accounting guard stays on.
 */
async function seedVoucherWithLabelledPayableLine(params: {
  company: Seeded
  sekAmount: number
  currency: string
  amountInCurrency: number
}): Promise<string> {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, $5, 'A', '2026-04-28', 'Leverantörsbetalning', 'manual', 'draft')`,
      [
        id, params.company.userId, params.company.companyId, params.company.fiscalPeriodId,
        Math.floor(Math.random() * 1_000_000),
      ],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, currency, amount_in_currency, sort_order)
       VALUES ($1, '2440', $2, 0, $3, $4, 0),
              ($1, '1930', 0, $2, 'SEK', NULL, 1)`,
      [id, params.sekAmount, params.currency, params.amountInCurrency],
    )
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
    await client.query('COMMIT')
    return id
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

interface LinkResult {
  ok: boolean
  code?: string
  invoice_status?: string
  paid_amount?: number
  remaining_amount?: number
  payment_amount?: number
  settlement_side?: string
  voucher_remaining?: number
  fx_journal_entry_id?: string | null
  details?: Record<string, unknown>
}

/** The link with a stated share (`amount`), or without one when it is omitted. */
async function link(params: {
  company: Seeded
  invoiceId: string
  voucherId: string
  amount?: number | string
}): Promise<LinkResult> {
  const { rows } = await getPool().query<{ result: LinkResult }>(
    `SELECT public.link_supplier_invoice_to_voucher($1, $2, $3, $4, NULL, $5::numeric) AS result`,
    [
      params.invoiceId, params.voucherId, params.company.userId, params.company.companyId,
      params.amount ?? null,
    ],
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
  const { rows } = await getPool().query<{ status: string; paid_amount: number; remaining_amount: number }>(
    `SELECT status, paid_amount::float8 AS paid_amount, remaining_amount::float8 AS remaining_amount
     FROM public.supplier_invoices WHERE id = $1`,
    [invoiceId],
  )
  return rows[0]
}

/** What the payment rows pointing at a verifikat add up to. */
async function linkedOnVoucher(voucherId: string): Promise<number> {
  const { rows } = await getPool().query<{ total: number }>(
    `SELECT COALESCE(SUM(amount), 0)::float8 AS total
     FROM public.supplier_invoice_payments WHERE journal_entry_id = $1`,
    [voucherId],
  )
  return rows[0].total
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

/**
 * The two figures the leverantörsreskontra is reconciled on, read the way
 * lib/reports/supplier-reconciliation.ts reads them: the remainder of every
 * open supplier invoice, and the balance of 2440 (credits less debits) over
 * posted and reversed entries.
 */
async function reskontraAgainst2440(companyId: string): Promise<{ reskontra: number; account2440: number }> {
  const { rows } = await getPool().query<{ reskontra: number; account2440: number }>(
    `SELECT
       (SELECT COALESCE(SUM(remaining_amount), 0)::float8
          FROM public.supplier_invoices
         WHERE company_id = $1
           AND status IN ('registered', 'approved', 'partially_paid', 'overdue')) AS reskontra,
       (SELECT COALESCE(SUM(l.credit_amount - l.debit_amount), 0)::float8
          FROM public.journal_entry_lines l
          JOIN public.journal_entries je ON je.id = l.journal_entry_id
         WHERE je.company_id = $1
           AND je.status IN ('posted', 'reversed')
           AND l.account_number = '2440') AS account2440`,
    [companyId],
  )
  return rows[0]
}

// ============================================================
// The report
// ============================================================

describe('link_supplier_invoice_to_voucher: one bank payment, an old skuld and a new invoice', () => {
  /**
   * A company that came in by SIE: 4 000 kr of the 2440 opening balance is a
   * supplier debt from the old system with no invoice here. A new invoice of
   * 1 250 kr is registered in Accounted. One bank debit of 5 250 kr pays both
   * and is booked as one verifikat.
   */
  async function seedCutover() {
    const company = await seedCompanyWithMethod('accrual')
    await seedVoucher({
      company,
      sourceType: 'opening_balance',
      entryDate: '2026-01-01',
      lines: [
        { accountNumber: '1930', debitAmount: 10000, creditAmount: 0 },
        { accountNumber: '2440', debitAmount: 0, creditAmount: 4000 },
        { accountNumber: '2099', debitAmount: 0, creditAmount: 6000 },
      ],
    })
    const registration = await seedVoucher({
      company,
      sourceType: 'supplier_invoice_registered',
      entryDate: '2026-04-01',
      lines: [
        { accountNumber: '4010', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '2641', debitAmount: 250, creditAmount: 0 },
        { accountNumber: '2440', debitAmount: 0, creditAmount: 1250 },
      ],
    })
    const invoiceId = await seedSupplierInvoice({ company, total: 1250, registrationEntryId: registration })
    const payment = await seedVoucher({ company, lines: accrualPaymentLines(5250), entryDate: '2026-04-28' })
    return { company, invoiceId, payment }
  }

  it('without a stated share the verifikat is still refused: nothing is split on a guess', async () => {
    const { company, invoiceId, payment } = await seedCutover()

    expect(await link({ company, invoiceId, voucherId: payment })).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      details: { ap_debit: 5250, remaining: 1250 },
    })
    expect(await paymentRows(invoiceId)).toHaveLength(0)
    // The state the report describes: the invoice stays open although the
    // bank payment is booked, so the reskontra can never agree with 2440.
    expect(await reskontraAgainst2440(company.companyId)).toEqual({ reskontra: 1250, account2440: 0 })
  })

  it('the stated share settles the invoice, writes nothing in the journal, and the reskontra agrees with 2440', async () => {
    const { company, invoiceId, payment } = await seedCutover()
    const journalBefore = await journalFingerprint(company.companyId)

    const result = await link({ company, invoiceId, voucherId: payment, amount: 1250 })

    expect(result).toMatchObject({
      ok: true,
      invoice_status: 'paid',
      paid_amount: 1250,
      remaining_amount: 0,
      payment_amount: 1250,
      journal_entry_id: payment,
      settlement_side: 'ap_debit',
      // The old skuld's 4 000 kr stay on the verifikat. They have no invoice
      // here, so nothing ever links them.
      voucher_remaining: 4000,
      fx_journal_entry_id: null,
    })
    expect(await invoiceState(invoiceId)).toEqual({ status: 'paid', paid_amount: 1250, remaining_amount: 0 })
    expect(await paymentRows(invoiceId)).toEqual([
      {
        amount: 1250,
        currency: 'SEK',
        payment_date: '2026-04-28',
        journal_entry_id: payment,
        payment_exchange_rate: null,
      },
    ])
    expect(await journalFingerprint(company.companyId)).toBe(journalBefore)
    expect(await reskontraAgainst2440(company.companyId)).toEqual({ reskontra: 0, account2440: 0 })
  })

  it('once the old invoice is registered too, the rest of the verifikat settles it', async () => {
    const { company, invoiceId, payment } = await seedCutover()
    // The other way to the same end: the old invoice is brought into the
    // reskontra (register_booked_supplier_invoice does this from its own
    // verifikat) and takes what the new invoice left of the payment.
    const old = await seedSupplierInvoice({ company, total: 4000 })

    expect((await link({ company, invoiceId, voucherId: payment, amount: 1250 })).ok).toBe(true)
    expect(await link({ company, invoiceId: old, voucherId: payment })).toMatchObject({
      ok: true, invoice_status: 'paid', payment_amount: 4000, voucher_remaining: 0,
    })
    expect(await linkedOnVoucher(payment)).toBe(5250)
  })
})

// ============================================================
// The rule: rows on one verifikat never exceed its settlement side
// ============================================================

describe('link_supplier_invoice_to_voucher: several invoices on one 244x verifikat', () => {
  it('two invoices each take their share, and a third finds nothing left', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const a = await seedSupplierInvoice({ company, total: 1250 })
    const b = await seedSupplierInvoice({ company, total: 2000 })
    const c = await seedSupplierInvoice({ company, total: 500 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(3250) })

    expect(await link({ company, invoiceId: a, voucherId, amount: 1250 })).toMatchObject({
      ok: true, invoice_status: 'paid', payment_amount: 1250, voucher_remaining: 2000,
    })
    expect(await link({ company, invoiceId: b, voucherId, amount: 2000 })).toMatchObject({
      ok: true, invoice_status: 'paid', payment_amount: 2000, voucher_remaining: 0,
    })
    expect(await link({ company, invoiceId: c, voucherId, amount: 500 })).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_FULLY_ALLOCATED',
      details: { ap_debit: 3250, already_linked: 3250 },
    })
    expect(await linkedOnVoucher(voucherId)).toBe(3250)
    expect((await invoiceState(c)).status).toBe('registered')
  })

  it('what is left links without a stated share when it fits inside the invoice', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const a = await seedSupplierInvoice({ company, total: 1250 })
    const b = await seedSupplierInvoice({ company, total: 2000 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(3250) })

    expect((await link({ company, invoiceId: a, voucherId, amount: 1250 })).ok).toBe(true)
    expect(await link({ company, invoiceId: b, voucherId })).toMatchObject({
      ok: true, invoice_status: 'paid', payment_amount: 2000, voucher_remaining: 0,
    })
  })

  it('what is left is still refused without a stated share when it is more than the invoice needs', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const a = await seedSupplierInvoice({ company, total: 1250 })
    const small = await seedSupplierInvoice({ company, total: 500 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(3250) })

    expect((await link({ company, invoiceId: a, voucherId, amount: 1250 })).ok).toBe(true)
    expect(await link({ company, invoiceId: small, voucherId })).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      // What the verifikat has LEFT, not its whole debit.
      details: { ap_debit: 2000, remaining: 500 },
    })
  })

  it('a share smaller than the invoice is a part payment, and leaves the rest of the verifikat', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(3250) })

    expect(await link({ company, invoiceId, voucherId, amount: 400 })).toMatchObject({
      ok: true,
      invoice_status: 'partially_paid',
      paid_amount: 400,
      remaining_amount: 850,
      payment_amount: 400,
      voucher_remaining: 2850,
    })
  })

  it('counts rows other writers left on the verifikat, whichever path wrote them', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const other = await seedSupplierInvoice({ company, total: 2000 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(3250) })
    // A row written outside the link (mark-paid and the batch allocation
    // write theirs the same way): 2 000 kr of the verifikat are another invoice's.
    await getPool().query(
      `INSERT INTO public.supplier_invoice_payments
         (user_id, company_id, supplier_invoice_id, payment_date, amount, currency, journal_entry_id)
       VALUES ($1, $2, $3, '2026-04-28', 2000, 'SEK', $4)`,
      [company.userId, company.companyId, other, voucherId],
    )
    const invoiceId = await seedSupplierInvoice({ company, total: 1500 })

    expect(await link({ company, invoiceId, voucherId, amount: 1500 })).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
      details: { amount: 1500, available: 1250, ap_debit: 3250, already_linked: 2000 },
    })
    expect(await link({ company, invoiceId, voucherId, amount: 1250 })).toMatchObject({
      ok: true, invoice_status: 'partially_paid', payment_amount: 1250, voucher_remaining: 0,
    })
  })

  it('two invoices reaching for the last of one verifikat at the same moment: the rows never exceed it', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const a = await seedSupplierInvoice({ company, total: 1500 })
    const b = await seedSupplierInvoice({ company, total: 1500 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(2000) })

    const results = await Promise.all([
      link({ company, invoiceId: a, voucherId, amount: 1500 }),
      link({ company, invoiceId: b, voucherId, amount: 1500 }),
    ])

    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
      details: { amount: 1500, available: 500, ap_debit: 2000, already_linked: 1500 },
    })
    expect(await linkedOnVoucher(voucherId)).toBe(1500)
  })
})

// ============================================================
// Over-allocation is still refused
// ============================================================

describe('link_supplier_invoice_to_voucher: what a stated share may not be', () => {
  it('more than the invoice has left', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(5250) })

    expect(await link({ company, invoiceId, voucherId, amount: 1250.01 })).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      details: { amount: 1250.01, remaining: 1250 },
    })
    expect(await paymentRows(invoiceId)).toHaveLength(0)
    expect((await invoiceState(invoiceId)).status).toBe('registered')
  })

  it('more than the verifikat holds', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(800) })

    expect(await link({ company, invoiceId, voucherId, amount: 1250 })).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
      details: { amount: 1250, available: 800, ap_debit: 800, already_linked: 0 },
    })
    expect(await paymentRows(invoiceId)).toHaveLength(0)
  })

  it('zero, negative, below one öre or not a number', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(5250) })

    for (const amount of [0, -1250, 0.004, 'NaN'] as const) {
      const result = await link({ company, invoiceId, voucherId, amount })
      expect(result.ok, String(amount)).toBe(false)
      expect(result.code, String(amount)).toBe('LINK_SI_VOUCHER_AMOUNT_INVALID')
    }
    expect(await paymentRows(invoiceId)).toHaveLength(0)
  })

  it('is read to the öre', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(5250) })

    expect(await link({ company, invoiceId, voucherId, amount: 1250.004 })).toMatchObject({
      ok: true, invoice_status: 'paid', payment_amount: 1250, voucher_remaining: 4000,
    })
  })
})

// ============================================================
// Kontantmetoden: the 19xx credit takes a share the same way
// ============================================================

describe('link_supplier_invoice_to_voucher: a share of a 19xx credit (kontantmetoden)', () => {
  it('one payout that paid two purchases settles each invoice with its share', async () => {
    const company = await seedCompanyWithMethod('cash')
    const a = await seedSupplierInvoice({ company, total: 1250 })
    const b = await seedSupplierInvoice({ company, total: 4000 })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(5250) })
    const journalBefore = await journalFingerprint(company.companyId)

    expect(await link({ company, invoiceId: a, voucherId })).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      details: { bank_credit: 5250, remaining: 1250 },
    })
    expect(await link({ company, invoiceId: a, voucherId, amount: 1250 })).toMatchObject({
      ok: true,
      invoice_status: 'paid',
      payment_amount: 1250,
      settlement_side: 'bank_credit',
      voucher_remaining: 4000,
      fx_journal_entry_id: null,
    })
    expect(await link({ company, invoiceId: b, voucherId })).toMatchObject({
      ok: true, invoice_status: 'paid', payment_amount: 4000, voucher_remaining: 0,
    })
    expect(await journalFingerprint(company.companyId)).toBe(journalBefore)
  })

  it('names the 19xx side when the share is more than the payout has left', async () => {
    const company = await seedCompanyWithMethod('cash')
    const a = await seedSupplierInvoice({ company, total: 1250 })
    const b = await seedSupplierInvoice({ company, total: 4500 })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(5250) })

    expect((await link({ company, invoiceId: a, voucherId, amount: 1250 })).ok).toBe(true)
    expect(await link({ company, invoiceId: b, voucherId, amount: 4500 })).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
      details: { amount: 4500, available: 4000, bank_credit: 5250, already_linked: 1250 },
    })
  })
})

// ============================================================
// Foreign currency
// ============================================================

describe('link_supplier_invoice_to_voucher: a share and a foreign invoice', () => {
  it('a verifikat whose 244x debit is in the invoice currency takes a share, with no kursdifferens verifikat', async () => {
    const company = await seedCompanyWithMethod('accrual')
    // 300 EUR left the books on one verifikat; this invoice is 100 EUR of it.
    const invoiceId = await seedSupplierInvoice({ company, total: 100, currency: 'EUR', exchangeRate: 11 })
    const voucherId = await seedVoucherWithLabelledPayableLine({
      company, sekAmount: 3300, currency: 'EUR', amountInCurrency: 300,
    })
    const journalBefore = await journalFingerprint(company.companyId)

    expect(await link({ company, invoiceId, voucherId })).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      details: { ap_debit: 300, remaining: 100 },
    })
    expect(await link({ company, invoiceId, voucherId, amount: 100 })).toMatchObject({
      ok: true,
      invoice_status: 'paid',
      payment_amount: 100,
      currency: 'EUR',
      voucher_remaining: 200,
      fx_journal_entry_id: null,
    })
    expect(await paymentRows(invoiceId)).toMatchObject([
      { amount: 100, currency: 'EUR', payment_exchange_rate: null },
    ])
    expect(await journalFingerprint(company.companyId)).toBe(journalBefore)
  })

  it('a kronor verifikat takes no share of a foreign invoice: the kursdifferens would be a guess', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 100, currency: 'EUR', exchangeRate: 11 })
    // 1 100 kr of this payout are the invoice at its own rate; nothing in the
    // books says how many kronor were actually paid for it.
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(5250) })
    const journalBefore = await journalFingerprint(company.companyId)

    expect(await link({ company, invoiceId, voucherId, amount: 100 })).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
      details: { invoice_currency: 'EUR', line_currency: 'SEK', reason: 'amount_needs_invoice_currency' },
    })
    expect(await paymentRows(invoiceId)).toHaveLength(0)
    expect(await journalFingerprint(company.companyId)).toBe(journalBefore)
  })

  it('a kronor verifikat that settles the whole foreign invoice still does, without a share', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 100, currency: 'EUR', exchangeRate: 11 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(1130) })

    const result = await link({ company, invoiceId, voucherId })
    expect(result).toMatchObject({
      ok: true, invoice_status: 'paid', payment_amount: 100, voucher_remaining: 0,
    })
    // Paid 1 130 kr for a skuld carried at 1 100 kr: the 30 kr kursförlust is
    // its own verifikat, exactly as before.
    expect(result.fx_journal_entry_id).toEqual(expect.any(String))
  })

  it('a 244x verifikat whose rows are in another currency has no readable capacity', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(5250) })
    const eur = await seedSupplierInvoice({ company, total: 100, currency: 'EUR', exchangeRate: 11 })
    // A row in EUR on a kronor verifikat (a batch allocation writes one per
    // invoice in the invoice's currency): its kronor cannot be read off it.
    await getPool().query(
      `INSERT INTO public.supplier_invoice_payments
         (user_id, company_id, supplier_invoice_id, payment_date, amount, currency, journal_entry_id)
       VALUES ($1, $2, $3, '2026-04-28', 100, 'EUR', $4)`,
      [company.userId, company.companyId, eur, voucherId],
    )
    const sek = await seedSupplierInvoice({ company, total: 1250 })

    expect(await link({ company, invoiceId: sek, voucherId, amount: 1250 })).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
      details: { invoice_currency: 'SEK', reason: 'voucher_settles_other_currency' },
    })
  })
})

// ============================================================
// The signature
// ============================================================

describe('link_supplier_invoice_to_voucher: one function, old callers intact', () => {
  it('exists once, with the share as a sixth defaulted argument and the grants restated', async () => {
    const { rows } = await getPool().query<{ signature: string; security_definer: boolean }>(
      `SELECT oid::regprocedure::text AS signature, prosecdef AS security_definer
       FROM pg_proc
       WHERE proname = 'link_supplier_invoice_to_voucher' AND pronamespace = 'public'::regnamespace`,
    )
    expect(rows).toEqual([
      { signature: 'link_supplier_invoice_to_voucher(uuid,uuid,uuid,uuid,text,numeric)', security_definer: true },
    ])

    const grants = await getPool().query<{ anon: boolean; authenticated: boolean; service: boolean }>(
      `SELECT has_function_privilege('anon', 'public.link_supplier_invoice_to_voucher(uuid,uuid,uuid,uuid,text,numeric)', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.link_supplier_invoice_to_voucher(uuid,uuid,uuid,uuid,text,numeric)', 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', 'public.link_supplier_invoice_to_voucher(uuid,uuid,uuid,uuid,text,numeric)', 'EXECUTE') AS service`,
    )
    expect(grants.rows[0]).toEqual({ anon: false, authenticated: true, service: true })
  })

  it('five positional arguments still resolve, as the SQL callers pass them', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(1250) })

    const { rows } = await getPool().query<{ result: LinkResult }>(
      `SELECT public.link_supplier_invoice_to_voucher($1, $2, $3, $4, 'Provider migration') AS result`,
      [invoiceId, voucherId, company.userId, company.companyId],
    )
    expect(rows[0].result).toMatchObject({ ok: true, invoice_status: 'paid', payment_amount: 1250 })
  })
})
