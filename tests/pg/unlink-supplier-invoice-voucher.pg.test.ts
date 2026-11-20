/**
 * pg-real tests for migration
 * 20261112100000_unlink_supplier_invoice_from_voucher.sql.
 *
 * link_supplier_invoice_to_voucher marks a supplier invoice paid by pointing a
 * payment row at a verifikat already in the books. Nothing could take such a
 * link back, so an invoice linked to the wrong verifikat stayed paid.
 *
 * What only real Postgres can prove here:
 *   - link then unlink leaves the invoice exactly as it was and the journal
 *     byte for byte untouched;
 *   - with two links, taking one back leaves the other standing;
 *   - every row that is not a plain link is refused with nothing written;
 *   - what hangs on the row follows: a bank payment order it settled is
 *     unsettled, the invoice tag on the verifikat's bank row is cleared while
 *     the row stays reconciled to the verifikat;
 *   - the tenant guard and the grants.
 *
 * All amounts are synthetic.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import {
  insertCashAccount,
  insertPostedJournalEntry,
  insertTransaction,
  seedCompany,
  type PostedJournalEntryLine,
} from './fixtures'

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
  dueDate?: string
  approved?: boolean
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
        vat_treatment, reverse_charge, is_credit_note, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-04-01', $7, '2026-04-01', $8, $9, $10,
             $11, 0, $11, 0, $11, 'standard_25', false, false, $12)`,
    [
      id, userId, companyId, supplierId, arrivalNumber, `LF-${arrivalNumber}`,
      // Far in the future unless a test wants the invoice past due.
      params.dueDate ?? '2099-01-01',
      params.approved ? 'approved' : 'registered',
      params.currency ?? 'SEK', params.exchangeRate ?? null,
      params.total,
      params.approved ? '2026-04-02T10:00:00Z' : null,
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
  sourceId?: string | null
}): Promise<string> {
  return insertPostedJournalEntry({
    userId: params.company.userId,
    companyId: params.company.companyId,
    fiscalPeriodId: params.company.fiscalPeriodId,
    voucherNumber: Math.floor(Math.random() * 1_000_000),
    entryDate: params.entryDate ?? '2026-04-28',
    description: 'Leverantörsbetalning',
    sourceType: params.sourceType ?? 'manual',
    sourceId: params.sourceId ?? null,
    lines: params.lines,
  })
}

interface LinkResult {
  ok: boolean
  code?: string
  payment_id?: string
  invoice_status?: string
  fx_journal_entry_id?: string | null
}

async function link(params: {
  company: Seeded
  invoiceId: string
  voucherId: string
  amount?: number
}): Promise<LinkResult> {
  const { rows } = await getPool().query<{ result: LinkResult }>(
    `SELECT public.link_supplier_invoice_to_voucher($1, $2, $3, $4, NULL, $5::numeric) AS result`,
    [params.invoiceId, params.voucherId, params.company.userId, params.company.companyId, params.amount ?? null],
  )
  return rows[0].result
}

interface UnlinkResult {
  ok: boolean
  code?: string
  details?: Record<string, unknown>
  payment_id?: string
  journal_entry_id?: string
  unlinked_amount?: number
  invoice_status?: string
  paid_amount?: number
  remaining_amount?: number
  cleared_transaction_tags?: number
  document_on_voucher?: boolean
}

const UNLINK_SQL = `SELECT public.unlink_supplier_invoice_from_voucher($1, $2, $3, $4) AS result`

async function unlink(company: Seeded, invoiceId: string, paymentId: string): Promise<UnlinkResult> {
  const { rows } = await getPool().query<{ result: UnlinkResult }>(UNLINK_SQL, [
    company.companyId, company.userId, invoiceId, paymentId,
  ])
  return rows[0].result
}

async function invoiceState(invoiceId: string) {
  const { rows } = await getPool().query<{
    status: string
    paid_amount: number
    remaining_amount: number
    paid_at: string | null
  }>(
    `SELECT status, paid_amount::float8 AS paid_amount, remaining_amount::float8 AS remaining_amount,
            paid_at::text AS paid_at
     FROM public.supplier_invoices WHERE id = $1`,
    [invoiceId],
  )
  return rows[0]
}

async function paymentRowIds(invoiceId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM public.supplier_invoice_payments WHERE supplier_invoice_id = $1 ORDER BY created_at, id`,
    [invoiceId],
  )
  return rows.map((r) => r.id)
}

/** A payment row written past the link, the way another door would write it. */
async function insertPaymentRow(params: {
  company: Seeded
  invoiceId: string
  amount: number
  journalEntryId: string | null
  transactionId?: string | null
  notes?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoice_payments
       (id, user_id, company_id, supplier_invoice_id, payment_date, amount, currency,
        journal_entry_id, transaction_id, notes)
     VALUES ($1, $2, $3, $4, '2026-04-28', $5, 'SEK', $6, $7, $8)`,
    [
      id, params.company.userId, params.company.companyId, params.invoiceId, params.amount,
      params.journalEntryId, params.transactionId ?? null, params.notes ?? null,
    ],
  )
  await getPool().query(
    `UPDATE public.supplier_invoices
        SET status = 'paid', paid_amount = total, remaining_amount = 0, paid_at = now()
      WHERE id = $1`,
    [params.invoiceId],
  )
  return id
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

/** Asserts a refusal wrote nothing: the row stands and the invoice is as it was. */
async function expectNothingWritten(invoiceId: string, paymentId: string, before: Awaited<ReturnType<typeof invoiceState>>) {
  expect(await paymentRowIds(invoiceId)).toContain(paymentId)
  expect(await invoiceState(invoiceId)).toEqual(before)
}

describe('unlink_supplier_invoice_from_voucher: taking a link back', () => {
  it('restores a registered invoice exactly and leaves the journal untouched', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(1250) })
    const before = await invoiceState(invoiceId)
    const journalBefore = await journalFingerprint(company.companyId)

    const linked = await link({ company, invoiceId, voucherId })
    expect(linked).toMatchObject({ ok: true, invoice_status: 'paid' })
    expect(await invoiceState(invoiceId)).toMatchObject({ status: 'paid', paid_amount: 1250, remaining_amount: 0 })

    const result = await unlink(company, invoiceId, linked.payment_id!)
    expect(result).toEqual({
      ok: true,
      payment_id: linked.payment_id,
      journal_entry_id: voucherId,
      unlinked_amount: 1250,
      invoice_status: 'registered',
      paid_amount: 0,
      remaining_amount: 1250,
      cleared_transaction_tags: 0,
      document_on_voucher: false,
    })

    expect(await invoiceState(invoiceId)).toEqual(before)
    expect(await paymentRowIds(invoiceId)).toEqual([])
    expect(await journalFingerprint(company.companyId)).toBe(journalBefore)

    // The removed row is kept whole in the audit log.
    const audit = await getPool().query<{ action: string; amount: string; journal_entry_id: string }>(
      `SELECT action, old_state ->> 'amount' AS amount, old_state ->> 'journal_entry_id' AS journal_entry_id
         FROM public.audit_log
        WHERE company_id = $1 AND table_name = 'supplier_invoice_payments' AND record_id = $2`,
      [company.companyId, linked.payment_id],
    )
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]).toMatchObject({ action: 'DELETE', journal_entry_id: voucherId })
    expect(Number(audit.rows[0].amount)).toBe(1250)
  })

  it('the verifikat is free again: the right invoice can be linked to it afterwards', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const wrong = await seedSupplierInvoice({ company, total: 1250 })
    const right = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(1250) })

    const linked = await link({ company, invoiceId: wrong, voucherId })
    expect(await link({ company, invoiceId: right, voucherId })).toMatchObject({
      ok: false, code: 'LINK_SI_VOUCHER_FULLY_ALLOCATED',
    })
    expect(await unlink(company, wrong, linked.payment_id!)).toMatchObject({ ok: true })
    expect(await link({ company, invoiceId: right, voucherId })).toMatchObject({ ok: true, invoice_status: 'paid' })
  })

  it('an attested invoice goes back to approved, one past due to overdue', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const attested = await seedSupplierInvoice({ company, total: 500, approved: true })
    const pastDue = await seedSupplierInvoice({ company, total: 700, approved: true, dueDate: '2026-05-01' })
    const a = await link({ company, invoiceId: attested, voucherId: await seedVoucher({ company, lines: accrualPaymentLines(500) }) })
    const b = await link({ company, invoiceId: pastDue, voucherId: await seedVoucher({ company, lines: accrualPaymentLines(700) }) })

    expect(await unlink(company, attested, a.payment_id!)).toMatchObject({ ok: true, invoice_status: 'approved' })
    expect(await unlink(company, pastDue, b.payment_id!)).toMatchObject({ ok: true, invoice_status: 'overdue' })
    expect(await invoiceState(pastDue)).toMatchObject({ status: 'overdue', paid_amount: 0, remaining_amount: 700, paid_at: null })
  })

  it('with two links, taking one back leaves the other standing', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1000 })
    const first = await seedVoucher({ company, lines: accrualPaymentLines(400), entryDate: '2026-04-20' })
    const second = await seedVoucher({ company, lines: accrualPaymentLines(600), entryDate: '2026-04-28' })

    const a = await link({ company, invoiceId, voucherId: first })
    expect(a).toMatchObject({ ok: true, invoice_status: 'partially_paid' })
    const b = await link({ company, invoiceId, voucherId: second })
    expect(b).toMatchObject({ ok: true, invoice_status: 'paid' })

    expect(await unlink(company, invoiceId, a.payment_id!)).toMatchObject({
      ok: true,
      unlinked_amount: 400,
      invoice_status: 'partially_paid',
      paid_amount: 600,
      remaining_amount: 400,
    })
    expect(await invoiceState(invoiceId)).toEqual({
      status: 'partially_paid', paid_amount: 600, remaining_amount: 400, paid_at: null,
    })
    expect(await paymentRowIds(invoiceId)).toEqual([b.payment_id])
  })

  it('works on the 19xx side of a kontantmetod company', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1250) })
    const journalBefore = await journalFingerprint(company.companyId)

    const linked = await link({ company, invoiceId, voucherId })
    expect(linked).toMatchObject({ ok: true, invoice_status: 'paid' })
    expect(await unlink(company, invoiceId, linked.payment_id!)).toMatchObject({
      ok: true, invoice_status: 'registered', paid_amount: 0, remaining_amount: 1250,
    })
    expect(await journalFingerprint(company.companyId)).toBe(journalBefore)
  })
})

describe('unlink_supplier_invoice_from_voucher: what is not a plain link is refused', () => {
  it('an unknown payment row, or one of another invoice', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const other = await seedSupplierInvoice({ company, total: 1250 })
    const linked = await link({ company, invoiceId, voucherId: await seedVoucher({ company, lines: accrualPaymentLines(1250) }) })
    const before = await invoiceState(invoiceId)

    expect(await unlink(company, invoiceId, randomUUID())).toEqual({ ok: false, code: 'UNLINK_SI_VOUCHER_NOT_FOUND' })
    expect(await unlink(company, other, linked.payment_id!)).toEqual({ ok: false, code: 'UNLINK_SI_VOUCHER_NOT_FOUND' })
    await expectNothingWritten(invoiceId, linked.payment_id!, before)
  })

  it('a row booked from a bank row', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const cashAccountId = await insertCashAccount({
      companyId: company.companyId, ledgerAccount: '1930', iban: 'SE3550000000054910000003',
    })
    const transactionId = await insertTransaction({
      companyId: company.companyId, userId: company.userId, amount: -1250, cashAccountId,
    })
    const paymentId = await insertPaymentRow({ company, invoiceId, amount: 1250, journalEntryId: null, transactionId })
    const before = await invoiceState(invoiceId)

    expect(await unlink(company, invoiceId, paymentId)).toEqual({
      ok: false, code: 'UNLINK_SI_VOUCHER_NOT_A_LINK', details: { reason: 'bank_transaction' },
    })
    await expectNothingWritten(invoiceId, paymentId, before)
  })

  it('a row without a verifikat', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const paymentId = await insertPaymentRow({ company, invoiceId, amount: 1250, journalEntryId: null })
    const before = await invoiceState(invoiceId)

    expect(await unlink(company, invoiceId, paymentId)).toEqual({
      ok: false, code: 'UNLINK_SI_VOUCHER_NOT_A_LINK', details: { reason: 'no_voucher' },
    })
    await expectNothingWritten(invoiceId, paymentId, before)
  })

  it('a row on a payment verifikat: that payment is undone by a storno', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({
      company, lines: accrualPaymentLines(1250), sourceType: 'supplier_invoice_paid', sourceId: invoiceId,
    })
    const paymentId = await insertPaymentRow({ company, invoiceId, amount: 1250, journalEntryId: voucherId })
    const before = await invoiceState(invoiceId)

    expect(await unlink(company, invoiceId, paymentId)).toMatchObject({
      ok: false, code: 'UNLINK_SI_VOUCHER_PAYMENT_VOUCHER', details: { source_type: 'supplier_invoice_paid' },
    })
    await expectNothingWritten(invoiceId, paymentId, before)
  })

  it('a row on the verifikat the invoice names as its own payment', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(1250) })
    const paymentId = await insertPaymentRow({ company, invoiceId, amount: 1250, journalEntryId: voucherId })
    await getPool().query(`UPDATE public.supplier_invoices SET payment_journal_entry_id = $1 WHERE id = $2`, [voucherId, invoiceId])
    const before = await invoiceState(invoiceId)

    expect(await unlink(company, invoiceId, paymentId)).toMatchObject({
      ok: false, code: 'UNLINK_SI_VOUCHER_PAYMENT_VOUCHER',
    })
    await expectNothingWritten(invoiceId, paymentId, before)
  })

  it('the row of a kvittning', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({
      company,
      sourceType: 'counterparty_setoff',
      sourceId: randomUUID(),
      lines: [
        { accountNumber: '2440', debitAmount: 1250, creditAmount: 0 },
        { accountNumber: '1510', debitAmount: 0, creditAmount: 1250 },
      ],
    })
    const paymentId = await insertPaymentRow({ company, invoiceId, amount: 1250, journalEntryId: voucherId })
    const before = await invoiceState(invoiceId)

    expect(await unlink(company, invoiceId, paymentId)).toEqual({ ok: false, code: 'UNLINK_SI_VOUCHER_SETOFF' })
    await expectNothingWritten(invoiceId, paymentId, before)
  })

  it('a settlement-evidence row: it never advanced the invoice', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(1250) })
    const paymentId = await insertPaymentRow({
      company, invoiceId, amount: 1250, journalEntryId: voucherId, notes: 'settlement-evidence: import',
    })
    const before = await invoiceState(invoiceId)

    expect(await unlink(company, invoiceId, paymentId)).toEqual({
      ok: false, code: 'UNLINK_SI_VOUCHER_SETTLEMENT_EVIDENCE',
    })
    await expectNothingWritten(invoiceId, paymentId, before)
  })

  it('a foreign-currency invoice: the link booked a kursdifferens verifikat with it', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 100, currency: 'EUR', exchangeRate: 11 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(1130) })
    const linked = await link({ company, invoiceId, voucherId })
    expect(linked).toMatchObject({ ok: true, invoice_status: 'paid' })
    expect(linked.fx_journal_entry_id).toEqual(expect.any(String))
    const before = await invoiceState(invoiceId)
    const journalBefore = await journalFingerprint(company.companyId)

    expect(await unlink(company, invoiceId, linked.payment_id!)).toMatchObject({
      ok: false, code: 'UNLINK_SI_VOUCHER_FOREIGN_CURRENCY', details: { invoice_currency: 'EUR' },
    })
    await expectNothingWritten(invoiceId, linked.payment_id!, before)
    expect(await journalFingerprint(company.companyId)).toBe(journalBefore)
  })

  it('an invoice that has moved on since the link', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const linked = await link({ company, invoiceId, voucherId: await seedVoucher({ company, lines: accrualPaymentLines(1250) }) })
    await getPool().query(`UPDATE public.supplier_invoices SET status = 'credited' WHERE id = $1`, [invoiceId])
    const before = await invoiceState(invoiceId)

    expect(await unlink(company, invoiceId, linked.payment_id!)).toEqual({
      ok: false, code: 'UNLINK_SI_VOUCHER_INVOICE_NOT_SETTLED', details: { status: 'credited' },
    })
    await expectNothingWritten(invoiceId, linked.payment_id!, before)
  })

  it('a posted kontantmetod cut-off that counted the invoice as paid', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1250), entryDate: '2026-04-28' })
    const linked = await link({ company, invoiceId, voucherId })
    expect(linked).toMatchObject({ ok: true })

    // The year is closed afterwards: its cut-off left this invoice out as paid.
    const cutoffEntryId = await insertPostedJournalEntry({
      userId: company.userId,
      companyId: company.companyId,
      fiscalPeriodId: company.fiscalPeriodId,
      voucherNumber: Math.floor(Math.random() * 1_000_000),
      entryDate: '2026-12-31',
      description: 'Leverantörsskulder bokslut (kontantmetoden)',
      sourceType: 'year_end',
      sourceId: company.fiscalPeriodId,
      lines: [
        { accountNumber: '4010', debitAmount: 300, creditAmount: 0 },
        { accountNumber: '2440', debitAmount: 0, creditAmount: 300 },
      ],
    })
    await getPool().query(
      `INSERT INTO public.kontantmetod_cutoff_entries
         (company_id, fiscal_period_id, kind, journal_entry_id)
       VALUES ($1, $2, 'payable', $3)`,
      [company.companyId, company.fiscalPeriodId, cutoffEntryId],
    )
    const before = await invoiceState(invoiceId)

    expect(await unlink(company, invoiceId, linked.payment_id!)).toMatchObject({
      ok: false, code: 'UNLINK_SI_VOUCHER_CUTOFF_ALREADY_POSTED',
    })
    await expectNothingWritten(invoiceId, linked.payment_id!, before)
  })
})

describe('unlink_supplier_invoice_from_voucher: what hangs on the row', () => {
  it('the bank row stays reconciled to the verifikat and loses its invoice tag', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1500 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(1500) })
    const linked = await link({ company, invoiceId, voucherId })
    // What the link's TypeScript wrapper writes when one bank row matches.
    const transactionId = await insertTransaction({
      companyId: company.companyId, userId: company.userId, amount: -1500, journalEntryId: voucherId,
    })
    await getPool().query(
      `UPDATE public.transactions SET supplier_invoice_id = $1, is_business = true WHERE id = $2`,
      [invoiceId, transactionId],
    )

    expect(await unlink(company, invoiceId, linked.payment_id!)).toMatchObject({
      ok: true, cleared_transaction_tags: 1,
    })
    const { rows } = await getPool().query(
      `SELECT journal_entry_id, supplier_invoice_id, is_business FROM public.transactions WHERE id = $1`,
      [transactionId],
    )
    expect(rows[0]).toEqual({ journal_entry_id: voucherId, supplier_invoice_id: null, is_business: true })
  })

  it('a bank payment order the link settled is unsettled again', async () => {
    const company = await seedCompany()
    const supplierId = randomUUID()
    await getPool().query(
      `INSERT INTO public.suppliers (id, user_id, company_id, name, bankgiro) VALUES ($1, $2, $3, 'Derome Bygg AB', '5050-1055')`,
      [supplierId, company.userId, company.companyId],
    )
    const invoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.supplier_invoices
         (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date,
          subtotal, vat_amount, total, remaining_amount, status)
       VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int, $5, '2026-09-20', '2026-10-20', 590, 147.5, 737.5, 737.5, 'approved')`,
      [invoiceId, company.userId, company.companyId, supplierId, `CD-${invoiceId.slice(0, 8)}`],
    )
    const cashAccountId = await insertCashAccount({
      companyId: company.companyId, ledgerAccount: '1930', iban: 'SE3550000000054910000003',
    })
    const created = await getPool().query<{ result: { ok: boolean; orders: Array<{ id: string }> } }>(
      `SELECT public.create_payment_orders($1, $2::jsonb, $3) AS result`,
      [
        company.companyId,
        JSON.stringify([
          {
            supplier_invoice_id: invoiceId,
            amount: 737.5,
            currency: 'SEK',
            requested_execution_date: '2026-10-20',
            cash_account_id: cashAccountId,
            debtor_snapshot: { iban: 'SE3550000000054910000003', bic: 'ESSESESS', currency: 'SEK' },
            payee_type: 'bankgiro',
            payee_bankgiro: '50501055',
            payee_name: 'Derome Bygg AB',
            payee_source: 'supplier',
            reference_type: 'ocr',
            reference: '4400112233',
            idempotency_key: randomUUID(),
          },
        ]),
        company.userId,
      ],
    )
    const orderId = created.rows[0]!.result.orders[0]!.id
    const move = (to: string, extra = '') =>
      getPool().query(`UPDATE public.payment_orders SET status = '${to}' ${extra} WHERE id = $1`, [orderId])
    await move('approved')
    await move('submitted', `, provider = 'open_payments', provider_payment_id = 'pay-${orderId.slice(0, 8)}', submitted_at = now()`)
    await move('accepted')
    await move('executed', ', executed_at = now()')

    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(737.5), entryDate: '2026-10-20' })
    const linked = await link({ company, invoiceId, voucherId })
    expect(linked).toMatchObject({ ok: true, invoice_status: 'paid' })
    const readOrder = async () =>
      (await getPool().query(
        `SELECT status, supplier_invoice_payment_id, matched_at FROM public.payment_orders WHERE id = $1`,
        [orderId],
      )).rows[0]
    expect(await readOrder()).toMatchObject({ status: 'executed', supplier_invoice_payment_id: linked.payment_id })

    expect(await unlink(company, invoiceId, linked.payment_id!)).toMatchObject({ ok: true })
    expect(await readOrder()).toEqual({ status: 'executed', supplier_invoice_payment_id: null, matched_at: null })
    const events = await getPool().query(
      `SELECT 1 FROM public.payment_order_events WHERE payment_order_id = $1 AND event_type = 'unmatched'`,
      [orderId],
    )
    expect(events.rows).toHaveLength(1)
  })
})

describe('unlink_supplier_invoice_from_voucher: who may call it', () => {
  it('answers not found for another company, whoever asks, and writes nothing', async () => {
    const a = await seedCompanyWithMethod('accrual')
    const b = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company: a, total: 1250 })
    const linked = await link({ company: a, invoiceId, voucherId: await seedVoucher({ company: a, lines: accrualPaymentLines(1250) }) })
    const before = await invoiceState(invoiceId)

    // A member of company B naming company A: the guard answers before any read.
    await withUserContext(b.userId, async (client) => {
      const res = await client.query(UNLINK_SQL, [a.companyId, b.userId, invoiceId, linked.payment_id])
      expect(res.rows[0].result).toEqual({ ok: false, code: 'UNLINK_SI_VOUCHER_NOT_FOUND' })
    })
    // The right ids under the wrong company.
    expect((await getPool().query(UNLINK_SQL, [b.companyId, b.userId, invoiceId, linked.payment_id])).rows[0].result)
      .toEqual({ ok: false, code: 'UNLINK_SI_VOUCHER_NOT_FOUND' })
    await expectNothingWritten(invoiceId, linked.payment_id!, before)
  })

  it('a member unlinks through a user session, whatever p_user_id says', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const linked = await link({ company, invoiceId, voucherId: await seedVoucher({ company, lines: accrualPaymentLines(1250) }) })

    // Asserted inside the context: withUserContext rolls its transaction back.
    await withUserContext(company.userId, async (client) => {
      const res = await client.query(UNLINK_SQL, [company.companyId, randomUUID(), invoiceId, linked.payment_id])
      expect(res.rows[0].result).toMatchObject({ ok: true, invoice_status: 'registered' })
    })
  })

  it('is granted to authenticated and service_role, not to anon', async () => {
    const { rows } = await getPool().query(
      `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_can,
              p.prosecdef AS security_definer
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'unlink_supplier_invoice_from_voucher'`,
    )
    expect(rows).toEqual([{ anon_can: false, auth_can: true, service_can: true, security_definer: true }])
  })
})
