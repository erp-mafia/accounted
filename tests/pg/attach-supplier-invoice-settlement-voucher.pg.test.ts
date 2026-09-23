/**
 * pg-real test for attach_supplier_invoice_settlement_voucher
 * (20260921084700_attach_supplier_invoice_settlement_voucher.sql).
 *
 * A migrated supplier invoice arrives settled (status 'paid', paid_amount =
 * total) but with no supplier_invoice_payments row, because the provider names
 * neither a payment date nor a payment voucher. The kontantmetoden year-end
 * cut-off reads the rows and nothing else, so such an invoice counts as a
 * leverantörsskuld at year end. The function attaches the verifikat that paid
 * it as the missing row, and must do exactly that and nothing more: the
 * invoice row and the journal stay untouched.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { getPool, withUserContext } from './setup'
import {
  insertAuthUser,
  insertCompanyMember,
  insertDraftJournalEntry,
  insertFiscalPeriod,
  insertPostedJournalEntry,
  seedCompany,
  type PostedJournalEntryLine,
} from './fixtures'

let arrivalSeq = 0

type Seeded = Awaited<ReturnType<typeof seedCompany>>

async function seedCompanyWithMethod(method: 'cash' | 'accrual'): Promise<Seeded> {
  const company = await seedCompany()
  // seedCompany() inserts companies/members/period but not company_settings.
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, accounting_method)
     VALUES ($1, $2, $3)`,
    [company.userId, company.companyId, method],
  )
  return company
}

async function setActiveCompany(userId: string, companyId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.user_preferences (user_id, active_company_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id`,
    [userId, companyId],
  )
}

async function seedSupplierInvoice(params: {
  company: Seeded
  total?: number
  status?: string
  paidAmount?: number
  currency?: string
  isCreditNote?: boolean
}): Promise<string> {
  const { userId, companyId } = params.company
  const supplierId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers
       (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
     VALUES ($1, $2, $3, 'Leverantör AB', 'swedish_business', 'SE', 30, 'SEK')`,
    [supplierId, userId, companyId],
  )
  const id = randomUUID()
  const total = params.total ?? 1000
  const status = params.status ?? 'paid'
  const paid = params.paidAmount ?? (status === 'paid' ? total : 0)
  // Time component for cross-run uniqueness, counter for within-run uniqueness.
  const arrivalNumber = (Date.now() % 1_000_000) * 1000 + arrivalSeq++
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-04-01', '2026-05-01', '2026-04-01', $7, $8,
             $9, 0, $9, $10, $11, 'standard_25', false, $12)`,
    [
      id, userId, companyId, supplierId, arrivalNumber, `LF-${arrivalNumber}`,
      status, params.currency ?? 'SEK', total, paid, Math.round((total - paid) * 100) / 100,
      params.isCreditNote ?? false,
    ],
  )
  return id
}

/** Kontantmetoden shape: the cost and the input moms against the bank account. */
function cashPaymentLines(amount: number): PostedJournalEntryLine[] {
  const vat = Math.round(amount * 0.2 * 100) / 100
  return [
    { accountNumber: '5410', debitAmount: Math.round((amount - vat) * 100) / 100, creditAmount: 0 },
    { accountNumber: '2640', debitAmount: vat, creditAmount: 0 },
    { accountNumber: '1930', debitAmount: 0, creditAmount: amount },
  ]
}

/** Faktureringsmetoden shape: leverantörsskulder against the bank account. */
function accrualPaymentLines(amount: number): PostedJournalEntryLine[] {
  return [
    { accountNumber: '2440', debitAmount: amount, creditAmount: 0 },
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
    entryDate: params.entryDate ?? '2026-05-05',
    description: 'Betalning leverantör',
    sourceType: params.sourceType ?? 'import',
    lines: params.lines,
  })
}

const ATTACH =
  `SELECT public.attach_supplier_invoice_settlement_voucher($1, $2, $3, $4, $5, $6) AS result`

interface AttachResult {
  ok: boolean
  code?: string
  dry_run?: boolean
  payment_id?: string | null
  payment_date?: string
  amount?: number
  settled?: number
  explained_before?: number
  voucher_settlement_side?: number
  voucher_capacity_after?: number
  details?: Record<string, unknown>
}

async function attach(
  params: {
    company: Seeded
    invoiceId: string
    voucherId: string
    notes?: string | null
    dryRun?: boolean
    companyId?: string
  },
  client?: PoolClient,
): Promise<AttachResult> {
  const runner = client ?? getPool()
  const { rows } = await runner.query<{ result: AttachResult }>(ATTACH, [
    params.invoiceId,
    params.voucherId,
    params.company.userId,
    params.companyId ?? params.company.companyId,
    params.notes ?? null,
    params.dryRun ?? false,
  ])
  return rows[0].result
}

async function paymentRows(invoiceId: string, client?: PoolClient) {
  const runner = client ?? getPool()
  const { rows } = await runner.query<{
    amount: string
    payment_date: string
    currency: string
    journal_entry_id: string | null
    transaction_id: string | null
    notes: string | null
    user_id: string | null
  }>(
    `SELECT amount, payment_date::text AS payment_date, currency, journal_entry_id,
            transaction_id, notes, user_id
     FROM public.supplier_invoice_payments
     WHERE supplier_invoice_id = $1
     ORDER BY created_at, id`,
    [invoiceId],
  )
  return rows
}

async function invoiceSnapshot(invoiceId: string) {
  const { rows } = await getPool().query(
    `SELECT status, paid_amount::text, remaining_amount::text, paid_at::text, updated_at::text,
            registration_journal_entry_id, payment_journal_entry_id
     FROM public.supplier_invoices WHERE id = $1`,
    [invoiceId],
  )
  return rows[0]
}

describe('attach_supplier_invoice_settlement_voucher', () => {
  it('kontantmetoden: writes one row dated at the verifikat and leaves the invoice untouched', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1250), entryDate: '2026-05-07' })
    const before = await invoiceSnapshot(invoiceId)

    const result = await attach({ company, invoiceId, voucherId, notes: 'Bokio V342' })

    expect(result).toMatchObject({
      ok: true,
      dry_run: false,
      amount: 1250,
      settled: 1250,
      explained_before: 0,
      voucher_settlement_side: 1250,
      voucher_capacity_after: 0,
      payment_date: '2026-05-07',
    })
    expect(result.payment_id).toBeTruthy()

    const rows = await paymentRows(invoiceId)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].amount)).toBe(1250)
    expect(rows[0]).toMatchObject({
      payment_date: '2026-05-07',
      currency: 'SEK',
      journal_entry_id: voucherId,
      transaction_id: null,
      notes: 'settlement-evidence: Bokio V342',
      user_id: company.userId,
    })

    // The whole point: status, amounts, paid_at and even updated_at stand as
    // they were. Only the payment row is new.
    expect(await invoiceSnapshot(invoiceId)).toEqual(before)
  })

  it('writes the bare marker when no note is given', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1000) })

    expect((await attach({ company, invoiceId, voucherId })).ok).toBe(true)
    expect((await paymentRows(invoiceId))[0].notes).toBe('settlement-evidence')
  })

  it('dry run passes every check and writes nothing', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1000) })

    const result = await attach({ company, invoiceId, voucherId, dryRun: true })

    expect(result).toMatchObject({ ok: true, dry_run: true, payment_id: null, amount: 1000 })
    expect(await paymentRows(invoiceId)).toHaveLength(0)

    // And the same pair then attaches for real: the dry run reserved nothing.
    expect((await attach({ company, invoiceId, voucherId })).ok).toBe(true)
    expect(await paymentRows(invoiceId)).toHaveLength(1)
  })

  it('an explicit NULL p_dry_run fails safe: nothing is written and the result says dry run', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1000) })

    // Left raw, `IF NOT NULL` would skip the INSERT and still answer ok with
    // dry_run null, which a caller reads as a write that never happened.
    const { rows } = await getPool().query<{ result: AttachResult }>(ATTACH, [
      invoiceId, voucherId, company.userId, company.companyId, null, null,
    ])

    expect(rows[0].result).toMatchObject({ ok: true, dry_run: true, payment_id: null, amount: 1000 })
    expect(await paymentRows(invoiceId)).toHaveLength(0)
  })

  it('faktureringsmetoden: reads the 244x debit', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(1000) })

    expect(await attach({ company, invoiceId, voucherId })).toMatchObject({
      ok: true,
      amount: 1000,
      voucher_settlement_side: 1000,
    })
  })

  it('defaults to faktureringsmetoden when the company has no settings row', async () => {
    const company = await seedCompany()
    const invoiceId = await seedSupplierInvoice({ company })
    const cashShaped = await seedVoucher({ company, lines: cashPaymentLines(1000) })

    expect(await attach({ company, invoiceId, voucherId: cashShaped })).toMatchObject({
      ok: false,
      code: 'ATTACH_SI_SETTLEMENT_NO_SETTLEMENT_SIDE',
      details: { accounting_method: 'accrual', expected: '244x debit' },
    })
  })

  it('refuses a verifikat without the settlement side for the method', async () => {
    const cash = await seedCompanyWithMethod('cash')
    const cashInvoice = await seedSupplierInvoice({ company: cash })
    // Paid privately by the owner: no liquid-funds account is credited.
    const privatelyPaid = await seedVoucher({
      company: cash,
      lines: [
        { accountNumber: '5410', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '2893', debitAmount: 0, creditAmount: 1000 },
      ],
    })
    expect(await attach({ company: cash, invoiceId: cashInvoice, voucherId: privatelyPaid })).toMatchObject({
      ok: false,
      code: 'ATTACH_SI_SETTLEMENT_NO_SETTLEMENT_SIDE',
      details: { accounting_method: 'cash', expected: '19xx credit' },
    })
    // A deposit debits 19xx; only the credit side is an outgoing payment.
    const deposit = await seedVoucher({
      company: cash,
      lines: [
        { accountNumber: '1930', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '3001', debitAmount: 0, creditAmount: 1000 },
      ],
    })
    expect((await attach({ company: cash, invoiceId: cashInvoice, voucherId: deposit })).code)
      .toBe('ATTACH_SI_SETTLEMENT_NO_SETTLEMENT_SIDE')
    expect(await paymentRows(cashInvoice)).toHaveLength(0)
  })

  it('lets one batch-payment verifikat settle several invoices, never past its settlement side', async () => {
    const company = await seedCompanyWithMethod('cash')
    const first = await seedSupplierInvoice({ company, total: 1000 })
    const second = await seedSupplierInvoice({ company, total: 2000 })
    const third = await seedSupplierInvoice({ company, total: 500 })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(3000) })

    expect(await attach({ company, invoiceId: first, voucherId })).toMatchObject({
      ok: true, amount: 1000, voucher_capacity_after: 2000,
    })
    expect(await attach({ company, invoiceId: second, voucherId })).toMatchObject({
      ok: true, amount: 2000, voucher_capacity_after: 0,
    })
    expect(await attach({ company, invoiceId: third, voucherId })).toMatchObject({
      ok: false,
      code: 'ATTACH_SI_SETTLEMENT_EXCEEDS_VOUCHER',
      details: { unexplained: 500, voucher_settlement_side: 3000, already_attached: 3000, capacity: 0 },
    })
    expect(await paymentRows(third)).toHaveLength(0)
  })

  it('refuses a verifikat that cannot cover the whole unexplained amount', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 1000 })
    const tooSmall = await seedVoucher({ company, lines: cashPaymentLines(400) })

    expect(await attach({ company, invoiceId, voucherId: tooSmall })).toMatchObject({
      ok: false,
      code: 'ATTACH_SI_SETTLEMENT_EXCEEDS_VOUCHER',
      details: { unexplained: 1000, capacity: 400 },
    })
    expect(await paymentRows(invoiceId)).toHaveLength(0)
  })

  it('is idempotent per pair and stops once the settlement is explained', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1000) })
    const other = await seedVoucher({ company, lines: cashPaymentLines(1000) })

    expect((await attach({ company, invoiceId, voucherId })).ok).toBe(true)
    expect((await attach({ company, invoiceId, voucherId })).code).toBe('ATTACH_SI_SETTLEMENT_ALREADY_LINKED')
    expect(await attach({ company, invoiceId, voucherId: other })).toMatchObject({
      ok: false,
      code: 'ATTACH_SI_SETTLEMENT_NOTHING_TO_EXPLAIN',
      details: { settled: 1000, explained: 1000 },
    })
    expect(await paymentRows(invoiceId)).toHaveLength(1)
  })

  it('explains only what paid_amount says on a partially paid invoice', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 1000, status: 'partially_paid', paidAmount: 400 })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(400) })

    expect(await attach({ company, invoiceId, voucherId })).toMatchObject({ ok: true, amount: 400, settled: 400 })
    expect(Number((await paymentRows(invoiceId))[0].amount)).toBe(400)
  })

  it('counts rows written by other paths against the invoice and the verifikat', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 1000 })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1000) })
    const earlier = await seedVoucher({ company, lines: cashPaymentLines(300), entryDate: '2026-04-20' })
    // A payment another flow recorded earlier explains 300 of the 1000.
    await getPool().query(
      `INSERT INTO public.supplier_invoice_payments
         (user_id, company_id, supplier_invoice_id, payment_date, amount, currency, journal_entry_id)
       VALUES ($1, $2, $3, '2026-04-20', 300, 'SEK', $4)`,
      [company.userId, company.companyId, invoiceId, earlier],
    )

    expect(await attach({ company, invoiceId, voucherId })).toMatchObject({
      ok: true, amount: 700, explained_before: 300, voucher_capacity_after: 300,
    })
  })

  it('refuses an open invoice, a credit note and a foreign-currency invoice', async () => {
    const company = await seedCompanyWithMethod('cash')
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1000) })

    const open = await seedSupplierInvoice({ company, status: 'approved' })
    expect(await attach({ company, invoiceId: open, voucherId })).toMatchObject({
      ok: false, code: 'ATTACH_SI_SETTLEMENT_NOT_SETTLED', details: { status: 'approved' },
    })

    // 'credited' is the only settled-looking state the schema lets a new
    // credit note hold (supplier_invoices_credit_note_not_payable).
    const creditNote = await seedSupplierInvoice({ company, isCreditNote: true, status: 'credited' })
    expect((await attach({ company, invoiceId: creditNote, voucherId })).code)
      .toBe('ATTACH_SI_SETTLEMENT_CREDIT_NOTE_UNSUPPORTED')

    const euro = await seedSupplierInvoice({ company, currency: 'EUR' })
    expect(await attach({ company, invoiceId: euro, voucherId })).toMatchObject({
      ok: false, code: 'ATTACH_SI_SETTLEMENT_CURRENCY_UNSUPPORTED', details: { invoice_currency: 'EUR' },
    })

    for (const id of [open, creditNote, euro]) expect(await paymentRows(id)).toHaveLength(0)
  })

  it('refuses a verifikat that is not posted, or is an opening balance or a storno', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company })

    const draft = await insertDraftJournalEntry({
      userId: company.userId,
      companyId: company.companyId,
      fiscalPeriodId: company.fiscalPeriodId,
    })
    expect(await attach({ company, invoiceId, voucherId: draft })).toMatchObject({
      ok: false, code: 'ATTACH_SI_SETTLEMENT_NOT_POSTED', details: { status: 'draft' },
    })

    for (const sourceType of ['opening_balance', 'storno']) {
      const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1000), sourceType })
      expect(await attach({ company, invoiceId, voucherId })).toMatchObject({
        ok: false,
        code: 'ATTACH_SI_SETTLEMENT_VOUCHER_NOT_ELIGIBLE',
        details: { reason: 'source_type', source_type: sourceType },
      })
    }
    expect(await paymentRows(invoiceId)).toHaveLength(0)
  })

  it('refuses when a foreign-currency row already sits on the verifikat', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 1000 })
    const euroInvoice = await seedSupplierInvoice({ company, total: 100, currency: 'EUR' })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(5000) })
    await getPool().query(
      `INSERT INTO public.supplier_invoice_payments
         (user_id, company_id, supplier_invoice_id, payment_date, amount, currency, journal_entry_id)
       VALUES ($1, $2, $3, '2026-05-05', 100, 'EUR', $4)`,
      [company.userId, company.companyId, euroInvoice, voucherId],
    )

    expect((await attach({ company, invoiceId, voucherId })).code)
      .toBe('ATTACH_SI_SETTLEMENT_VOUCHER_CURRENCY_UNSUPPORTED')
  })

  it('never crosses companies, whichever side is foreign', async () => {
    const a = await seedCompanyWithMethod('cash')
    const b = await seedCompanyWithMethod('cash')
    const invoiceA = await seedSupplierInvoice({ company: a })
    const voucherA = await seedVoucher({ company: a, lines: cashPaymentLines(1000) })
    const invoiceB = await seedSupplierInvoice({ company: b })
    const voucherB = await seedVoucher({ company: b, lines: cashPaymentLines(1000) })

    expect((await attach({ company: a, invoiceId: invoiceA, voucherId: voucherB })).code)
      .toBe('ATTACH_SI_SETTLEMENT_VOUCHER_NOT_FOUND')
    expect((await attach({ company: a, invoiceId: invoiceB, voucherId: voucherA })).code)
      .toBe('ATTACH_SI_SETTLEMENT_INVOICE_NOT_FOUND')
    // Naming the other company outright finds neither of this company's rows.
    expect((await attach({ company: a, invoiceId: invoiceA, voucherId: voucherA, companyId: b.companyId })).code)
      .toBe('ATTACH_SI_SETTLEMENT_INVOICE_NOT_FOUND')
    expect(await paymentRows(invoiceA)).toHaveLength(0)
    expect(await paymentRows(invoiceB)).toHaveLength(0)
  })

  it('refuses a note longer than 2000 characters', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1000) })

    expect(await attach({ company, invoiceId, voucherId, notes: 'x'.repeat(2001) })).toMatchObject({
      ok: false, code: 'ATTACH_SI_SETTLEMENT_NOTES_TOO_LONG', details: { max_length: 2000, length: 2001 },
    })
  })
})

describe('attach_supplier_invoice_settlement_voucher: closed years and a posted cut-off', () => {
  /** The payable half of a posted kontantmetoden cut-off for the seeded 2026 year. */
  async function seedPostedPayableCutoff(company: Seeded, kind = 'payable'): Promise<string> {
    const entryId = await insertPostedJournalEntry({
      userId: company.userId,
      companyId: company.companyId,
      fiscalPeriodId: company.fiscalPeriodId,
      voucherNumber: Math.floor(Math.random() * 1_000_000),
      entryDate: '2026-12-31',
      description: 'Leverantörsskulder bokslut (kontantmetoden)',
      sourceType: 'year_end',
      sourceId: company.fiscalPeriodId,
      lines: [
        { accountNumber: '5410', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '2440', debitAmount: 0, creditAmount: 1000 },
      ],
    })
    await getPool().query(
      `INSERT INTO public.kontantmetod_cutoff_entries
         (company_id, fiscal_period_id, kind, journal_entry_id)
       VALUES ($1, $2, $3, $4)`,
      [company.companyId, company.fiscalPeriodId, kind, entryId],
    )
    return entryId
  }

  it('a closed year alone does not refuse: nothing in the journal is written', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1000) })
    // Closed after the verifikat was posted, as an imported year is.
    await getPool().query(
      `UPDATE public.fiscal_periods SET is_closed = true, closed_at = now(), locked_at = now() WHERE id = $1`,
      [company.fiscalPeriodId],
    )

    expect((await attach({ company, invoiceId, voucherId })).ok).toBe(true)
    expect(await paymentRows(invoiceId)).toHaveLength(1)
  })

  it('refuses evidence that a posted cut-off for that year would contradict', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1000), entryDate: '2026-05-05' })
    await seedPostedPayableCutoff(company)

    expect(await attach({ company, invoiceId, voucherId })).toMatchObject({
      ok: false,
      code: 'ATTACH_SI_SETTLEMENT_CUTOFF_ALREADY_POSTED',
      details: { voucher_date: '2026-05-05', invoice_date: '2026-04-01' },
    })
    // The dry run says the same, so a preview never promises what apply refuses.
    expect((await attach({ company, invoiceId, voucherId, dryRun: true })).code)
      .toBe('ATTACH_SI_SETTLEMENT_CUTOFF_ALREADY_POSTED')
    expect(await paymentRows(invoiceId)).toHaveLength(0)
  })

  it('passes evidence dated after that year: the invoice WAS a skuld at its end, the cut-off stands', async () => {
    const company = await seedCompanyWithMethod('cash')
    const nextYear = await insertFiscalPeriod({
      userId: company.userId,
      companyId: company.companyId,
      name: '2027',
      periodStart: '2027-01-01',
      periodEnd: '2027-12-31',
    })
    const invoiceId = await seedSupplierInvoice({ company })
    const paidInJanuary = await insertPostedJournalEntry({
      userId: company.userId,
      companyId: company.companyId,
      fiscalPeriodId: nextYear,
      voucherNumber: Math.floor(Math.random() * 1_000_000),
      entryDate: '2027-01-08',
      description: 'Betalning leverantör',
      sourceType: 'import',
      lines: cashPaymentLines(1000),
    })
    await seedPostedPayableCutoff(company)

    expect(await attach({ company, invoiceId, voucherId: paidInJanuary })).toMatchObject({
      ok: true, payment_date: '2027-01-08',
    })
  })

  it('reads a stornoed cut-off as absent, and ignores the receivable half', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1000) })
    // reverseEntry() leaves the cancelled verifikat at 'reversed' with its
    // marker behind; that is how the wrong cut-off is cleared before evidence.
    const cancelled = await seedPostedPayableCutoff(company)
    await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [cancelled])
    await seedPostedPayableCutoff(company, 'receivable')

    expect((await attach({ company, invoiceId, voucherId })).ok).toBe(true)
  })

  it('refuses a verifikat that has been reversed', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1000) })
    await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [voucherId])

    expect(await attach({ company, invoiceId, voucherId })).toMatchObject({
      ok: false, code: 'ATTACH_SI_SETTLEMENT_NOT_POSTED', details: { status: 'reversed' },
    })
    expect(await paymentRows(invoiceId)).toHaveLength(0)
  })
})

describe('attach_supplier_invoice_settlement_voucher: SECURITY INVOKER under RLS', () => {
  it('a writing member of the active company attaches, attributed to the JWT sub', async () => {
    const company = await seedCompanyWithMethod('cash')
    await setActiveCompany(company.userId, company.companyId)
    const invoiceId = await seedSupplierInvoice({ company })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1000) })
    const someoneElse = await insertAuthUser()

    await withUserContext(company.userId, async (client) => {
      const { rows } = await client.query<{ result: AttachResult }>(ATTACH, [
        invoiceId, voucherId, someoneElse, company.companyId, null, false,
      ])
      expect(rows[0].result.ok).toBe(true)
      // p_user_id named someone else; the row still belongs to the caller.
      const written = await paymentRows(invoiceId, client)
      expect(written).toHaveLength(1)
      expect(written[0].user_id).toBe(company.userId)
    })
  })

  it('a member of another company finds nothing and writes nothing', async () => {
    const a = await seedCompanyWithMethod('cash')
    const b = await seedCompanyWithMethod('cash')
    await setActiveCompany(b.userId, b.companyId)
    const invoiceId = await seedSupplierInvoice({ company: a })
    const voucherId = await seedVoucher({ company: a, lines: cashPaymentLines(1000) })

    await withUserContext(b.userId, async (client) => {
      const result = await attach({ company: a, invoiceId, voucherId }, client)
      expect(result).toMatchObject({ ok: false, code: 'ATTACH_SI_SETTLEMENT_INVOICE_NOT_FOUND' })
    })
    expect(await paymentRows(invoiceId)).toHaveLength(0)
  })

  it('a read-only member cannot attach', async () => {
    const company = await seedCompanyWithMethod('cash')
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: company.companyId, userId: viewer, role: 'viewer' })
    await setActiveCompany(viewer, company.companyId)
    const invoiceId = await seedSupplierInvoice({ company })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1000) })

    await withUserContext(viewer, async (client) => {
      const result = await attach({ company, invoiceId, voucherId }, client)
      expect(result.ok).toBe(false)
      expect(await paymentRows(invoiceId, client)).toHaveLength(0)
    })
    expect(await paymentRows(invoiceId)).toHaveLength(0)
  })

  it('anon cannot execute the function at all', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1000) })

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE anon')
      await expect(
        client.query(ATTACH, [invoiceId, voucherId, company.userId, company.companyId, null, false]),
      ).rejects.toThrow(/permission denied/i)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
    expect(await paymentRows(invoiceId)).toHaveLength(0)
  })
})
