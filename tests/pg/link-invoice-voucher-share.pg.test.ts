/**
 * pg-real tests for migration
 * 20261026007000_link_invoice_to_voucher_share.sql (crm#1434).
 *
 * One verifikat often clears several kundfordringar: a bankgiro bundle that
 * pays three invoices, or a konstaterad kundförlust booked as one verifikat
 * for several invoices in the old system (Dr 635x, Dr 26xx / Cr 1510 for the
 * sum). The link read the whole 151x credit as the settlement of the one
 * invoice it was asked about and refused as soon as the credit was larger
 * than the invoice's remainder, so the invoices stayed open in the
 * kundreskontra although 1510 was cleared. The mirror of
 * link-supplier-invoice-voucher-share.pg.test.ts.
 *
 * What only real Postgres can prove here:
 *   - the reported scenario end to end: each invoice takes its share, nothing
 *     is written to the journal, and the kundreskontra agrees with 1510;
 *   - the capacity rule: the payment rows pointing at one verifikat never add
 *     up to more than its settlement side, on the 151x side as on the 19xx
 *     side, whichever path wrote them, and under concurrency too;
 *   - that a call without a stated share still splits nothing on a guess;
 *   - that a share is refused where the verifikat is not in the invoice's
 *     currency, before any kursdifferens verifikat is booked;
 *   - the signature: one function, the old positional and named calls resolve.
 *
 * All amounts are synthetic.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { insertPostedJournalEntry, seedCompany, type PostedJournalEntryLine } from './fixtures'

let invoiceSeq = 0

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

async function seedInvoice(params: {
  company: Seeded
  total: number
  currency?: string
  exchangeRate?: number | null
}): Promise<string> {
  const { userId, companyId } = params.company
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [customerId, userId, companyId],
  )
  const id = randomUUID()
  // Time component for cross-run uniqueness, counter for within-run uniqueness.
  const number = `F-${(Date.now() % 1_000_000) * 1000 + invoiceSeq++}`
  const currency = params.currency ?? 'SEK'
  const rate = params.exchangeRate ?? null
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, exchange_rate, subtotal, vat_amount, total, total_sek,
        vat_treatment, vat_rate, status, paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-02-01', '2026-03-01',
             $6, $7, $8, 0, $8, $9, 'standard_25', 25, 'sent', 0, $8)`,
    [id, userId, companyId, customerId, number, currency, rate, params.total,
      currency === 'SEK' ? params.total : Math.round(params.total * (rate ?? 1) * 100) / 100],
  )
  return id
}

/** A konstaterad kundförlust for several invoices, booked as one verifikat. */
function lossLines(total: number): PostedJournalEntryLine[] {
  const vat = Math.round(total * 0.2 * 100) / 100
  return [
    { accountNumber: '6351', debitAmount: Math.round((total - vat) * 100) / 100, creditAmount: 0 },
    { accountNumber: '2611', debitAmount: vat, creditAmount: 0 },
    { accountNumber: '1510', debitAmount: 0, creditAmount: total },
  ]
}

/** A bankgiro bundle that pays several invoices: one deposit, one 1510 credit. */
function bundleLines(total: number): PostedJournalEntryLine[] {
  return [
    { accountNumber: '1930', debitAmount: total, creditAmount: 0 },
    { accountNumber: '1510', debitAmount: 0, creditAmount: total },
  ]
}

/** Kontantmetoden: one deposit for several never-booked invoices, no 151x line. */
function cashDepositLines(total: number): PostedJournalEntryLine[] {
  const vat = Math.round(total * 0.2 * 100) / 100
  return [
    { accountNumber: '1930', debitAmount: total, creditAmount: 0 },
    { accountNumber: '3001', debitAmount: 0, creditAmount: Math.round((total - vat) * 100) / 100 },
    { accountNumber: '2611', debitAmount: 0, creditAmount: vat },
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
    entryDate: params.entryDate ?? '2026-06-30',
    description: 'Konstaterade kundförluster',
    sourceType: params.sourceType ?? 'manual',
    lines: params.lines,
  })
}

type LinkResult = {
  ok: boolean
  code?: string
  details?: Record<string, unknown>
  invoice_status?: string
  paid_amount?: number
  remaining_amount?: number
  payment_amount?: number
  voucher_remaining?: number
  fx_journal_entry_id?: string | null
  [key: string]: unknown
}

async function link(params: {
  company: Seeded
  invoiceId: string
  voucherId: string
  amount?: number | string
}): Promise<LinkResult> {
  const { rows } = await getPool().query<{ result: LinkResult }>(
    `SELECT public.link_invoice_to_voucher(
       p_invoice_id => $1, p_journal_entry_id => $2, p_user_id => $3, p_company_id => $4,
       p_amount => $5::numeric) AS result`,
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
  }>(
    `SELECT amount::float8 AS amount, currency, payment_date::text, journal_entry_id
     FROM public.invoice_payments WHERE invoice_id = $1 ORDER BY created_at`,
    [invoiceId],
  )
  return rows
}

async function invoiceState(invoiceId: string) {
  const { rows } = await getPool().query<{ status: string; paid_amount: number; remaining_amount: number }>(
    `SELECT status, paid_amount::float8 AS paid_amount, remaining_amount::float8 AS remaining_amount
     FROM public.invoices WHERE id = $1`,
    [invoiceId],
  )
  return rows[0]
}

/** What the payment rows pointing at a verifikat add up to. */
async function linkedOnVoucher(voucherId: string): Promise<number> {
  const { rows } = await getPool().query<{ total: number }>(
    `SELECT COALESCE(SUM(amount), 0)::float8 AS total
     FROM public.invoice_payments WHERE journal_entry_id = $1`,
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
 * The two figures the kundreskontra is reconciled on: the remainder of every
 * open invoice, and the balance of 1510 (debits less credits) over posted
 * entries.
 */
async function reskontraAgainst1510(companyId: string): Promise<{ reskontra: number; account1510: number }> {
  const { rows } = await getPool().query<{ reskontra: number; account1510: number }>(
    `SELECT
       (SELECT COALESCE(SUM(remaining_amount), 0)::float8
          FROM public.invoices
         WHERE company_id = $1
           AND status IN ('sent', 'overdue', 'partially_paid')) AS reskontra,
       (SELECT COALESCE(SUM(l.debit_amount - l.credit_amount), 0)::float8
          FROM public.journal_entry_lines l
          JOIN public.journal_entries je ON je.id = l.journal_entry_id
         WHERE je.company_id = $1
           AND je.status IN ('posted', 'reversed')
           AND l.account_number = '1510') AS account1510`,
    [companyId],
  )
  return rows[0]
}

// ============================================================
// The report
// ============================================================

describe('link_invoice_to_voucher: one kundförlust verifikat for three migrated invoices', () => {
  /**
   * A migrated company: the three sales came in with the SIE opening balance
   * (1510 debit 2 600 kr), the invoices are in the register with no verifikat
   * of their own, and one verifikat in the old system wrote all three off.
   */
  async function seedMigratedLoss() {
    const company = await seedCompanyWithMethod('accrual')
    await seedVoucher({
      company,
      sourceType: 'opening_balance',
      entryDate: '2026-01-01',
      lines: [
        { accountNumber: '1510', debitAmount: 2600, creditAmount: 0 },
        { accountNumber: '2099', debitAmount: 0, creditAmount: 2600 },
      ],
    })
    const a = await seedInvoice({ company, total: 1500 })
    const b = await seedInvoice({ company, total: 700 })
    const c = await seedInvoice({ company, total: 400 })
    const loss = await seedVoucher({ company, lines: lossLines(2600) })
    return { company, a, b, c, loss }
  }

  it('without a stated share the verifikat is still refused, with the details it always had', async () => {
    const { company, a, loss } = await seedMigratedLoss()

    expect(await link({ company, invoiceId: a, voucherId: loss })).toEqual({
      ok: false,
      code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      details: { ar_credit: 2600, remaining: 1500 },
    })
    expect(await paymentRows(a)).toHaveLength(0)
    // The state the report describes: the ledger cleared 1510, the register did not.
    expect(await reskontraAgainst1510(company.companyId)).toEqual({ reskontra: 2600, account1510: 0 })
  })

  it('each invoice takes its share, nothing is written in the journal, and the reskontra agrees with 1510', async () => {
    const { company, a, b, c, loss } = await seedMigratedLoss()
    const journalBefore = await journalFingerprint(company.companyId)

    expect(await link({ company, invoiceId: a, voucherId: loss, amount: 1500 })).toMatchObject({
      ok: true, invoice_status: 'paid', paid_amount: 1500, remaining_amount: 0, payment_amount: 1500,
      voucher_remaining: 1100, fx_journal_entry_id: null,
    })
    expect(await link({ company, invoiceId: b, voucherId: loss, amount: 700 })).toMatchObject({
      ok: true, invoice_status: 'paid', payment_amount: 700, voucher_remaining: 400,
    })
    // The last one fits what is left: no share needed.
    expect(await link({ company, invoiceId: c, voucherId: loss })).toMatchObject({
      ok: true, invoice_status: 'paid', payment_amount: 400, voucher_remaining: 0,
    })

    expect(await paymentRows(a)).toEqual([
      { amount: 1500, currency: 'SEK', payment_date: '2026-06-30', journal_entry_id: loss },
    ])
    expect(await linkedOnVoucher(loss)).toBe(2600)
    expect(await journalFingerprint(company.companyId)).toBe(journalBefore)
    expect(await reskontraAgainst1510(company.companyId)).toEqual({ reskontra: 0, account1510: 0 })
  })
})

// ============================================================
// The rule: rows on one verifikat never exceed its settlement side
// ============================================================

describe('link_invoice_to_voucher: several invoices on one 151x verifikat', () => {
  it('two invoices each take their share, and a third finds nothing left', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const a = await seedInvoice({ company, total: 1250 })
    const b = await seedInvoice({ company, total: 2000 })
    const c = await seedInvoice({ company, total: 500 })
    const voucherId = await seedVoucher({ company, lines: bundleLines(3250) })

    expect(await link({ company, invoiceId: a, voucherId, amount: 1250 })).toMatchObject({
      ok: true, payment_amount: 1250, voucher_remaining: 2000,
    })
    expect(await link({ company, invoiceId: b, voucherId, amount: 2000 })).toMatchObject({
      ok: true, payment_amount: 2000, voucher_remaining: 0,
    })
    expect(await link({ company, invoiceId: c, voucherId, amount: 500 })).toEqual({
      ok: false,
      code: 'LINK_VOUCHER_FULLY_ALLOCATED',
      details: { ar_credit: 3250, already_linked: 3250 },
    })
    expect(await linkedOnVoucher(voucherId)).toBe(3250)
    expect((await invoiceState(c)).status).toBe('sent')
  })

  it('a verifikat used in full by one invoice no longer settles a second one too', async () => {
    // Before this migration both links passed: each fit on its own.
    const company = await seedCompanyWithMethod('accrual')
    const a = await seedInvoice({ company, total: 1000 })
    const b = await seedInvoice({ company, total: 1000 })
    const voucherId = await seedVoucher({ company, lines: bundleLines(1000) })

    expect((await link({ company, invoiceId: a, voucherId })).ok).toBe(true)
    expect(await link({ company, invoiceId: b, voucherId })).toEqual({
      ok: false,
      code: 'LINK_VOUCHER_FULLY_ALLOCATED',
      details: { ar_credit: 1000, already_linked: 1000 },
    })
    expect(await linkedOnVoucher(voucherId)).toBe(1000)
  })

  it('what is left is still refused without a stated share when it is more than the invoice needs', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const a = await seedInvoice({ company, total: 1250 })
    const small = await seedInvoice({ company, total: 500 })
    const voucherId = await seedVoucher({ company, lines: bundleLines(3250) })

    expect((await link({ company, invoiceId: a, voucherId, amount: 1250 })).ok).toBe(true)
    expect(await link({ company, invoiceId: small, voucherId })).toEqual({
      ok: false,
      code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      // What the verifikat has LEFT, not its whole credit.
      details: { ar_credit: 2000, remaining: 500 },
    })
  })

  it('a share smaller than the invoice is a part settlement, and leaves the rest of the verifikat', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: bundleLines(3250) })

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
    const other = await seedInvoice({ company, total: 2000 })
    const voucherId = await seedVoucher({ company, lines: bundleLines(3250) })
    // A row written outside the link (a bank match and the batch allocation
    // write theirs the same way): 2 000 kr of the verifikat are another invoice's.
    await getPool().query(
      `INSERT INTO public.invoice_payments
         (user_id, company_id, invoice_id, payment_date, amount, currency, journal_entry_id)
       VALUES ($1, $2, $3, '2026-06-30', 2000, 'SEK', $4)`,
      [company.userId, company.companyId, other, voucherId],
    )
    const invoiceId = await seedInvoice({ company, total: 1500 })

    expect(await link({ company, invoiceId, voucherId, amount: 1500 })).toEqual({
      ok: false,
      code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
      details: { amount: 1500, available: 1250, ar_credit: 3250, already_linked: 2000 },
    })
    expect(await link({ company, invoiceId, voucherId, amount: 1250 })).toMatchObject({
      ok: true, invoice_status: 'partially_paid', payment_amount: 1250, voucher_remaining: 0,
    })
  })

  it('two invoices reaching for the last of one verifikat at the same moment: the rows never exceed it', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const a = await seedInvoice({ company, total: 1500 })
    const b = await seedInvoice({ company, total: 1500 })
    const voucherId = await seedVoucher({ company, lines: bundleLines(2000) })

    const results = await Promise.all([
      link({ company, invoiceId: a, voucherId, amount: 1500 }),
      link({ company, invoiceId: b, voucherId, amount: 1500 }),
    ])

    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toEqual({
      ok: false,
      code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
      details: { amount: 1500, available: 500, ar_credit: 2000, already_linked: 1500 },
    })
    expect(await linkedOnVoucher(voucherId)).toBe(1500)
  })
})

// ============================================================
// What a stated share may not be
// ============================================================

describe('link_invoice_to_voucher: what a stated share may not be', () => {
  it('more than the invoice has left', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: bundleLines(5250) })

    expect(await link({ company, invoiceId, voucherId, amount: 1250.01 })).toEqual({
      ok: false,
      code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      details: { amount: 1250.01, remaining: 1250 },
    })
    expect(await paymentRows(invoiceId)).toHaveLength(0)
    expect((await invoiceState(invoiceId)).status).toBe('sent')
  })

  it('more than the verifikat holds', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: bundleLines(800) })

    expect(await link({ company, invoiceId, voucherId, amount: 1250 })).toEqual({
      ok: false,
      code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
      details: { amount: 1250, available: 800, ar_credit: 800, already_linked: 0 },
    })
    expect(await paymentRows(invoiceId)).toHaveLength(0)
  })

  it('zero, negative, below one öre or not a number', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: bundleLines(5250) })

    for (const amount of [0, -1250, 0.004, 'NaN'] as const) {
      const result = await link({ company, invoiceId, voucherId, amount })
      expect(result.ok, String(amount)).toBe(false)
      expect(result.code, String(amount)).toBe('LINK_VOUCHER_AMOUNT_INVALID')
    }
    expect(await paymentRows(invoiceId)).toHaveLength(0)
  })

  it('is read to the öre', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: bundleLines(5250) })

    expect(await link({ company, invoiceId, voucherId, amount: 1250.004 })).toMatchObject({
      ok: true, invoice_status: 'paid', payment_amount: 1250, voucher_remaining: 4000,
    })
  })
})

// ============================================================
// Kontantmetoden: the 19xx debit takes a share the same way
// ============================================================

describe('link_invoice_to_voucher: a share of a 19xx debit (kontantmetoden)', () => {
  it('one deposit that paid two never-booked invoices settles each with its share', async () => {
    const company = await seedCompanyWithMethod('cash')
    const a = await seedInvoice({ company, total: 1250 })
    const b = await seedInvoice({ company, total: 4000 })
    const voucherId = await seedVoucher({ company, lines: cashDepositLines(5250) })
    const journalBefore = await journalFingerprint(company.companyId)

    expect(await link({ company, invoiceId: a, voucherId })).toEqual({
      ok: false,
      code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      details: { ar_credit: 5250, remaining: 1250 },
    })
    expect(await link({ company, invoiceId: a, voucherId, amount: 1250 })).toMatchObject({
      ok: true, invoice_status: 'paid', payment_amount: 1250, voucher_remaining: 4000, fx_journal_entry_id: null,
    })
    expect(await link({ company, invoiceId: b, voucherId })).toMatchObject({
      ok: true, invoice_status: 'paid', payment_amount: 4000, voucher_remaining: 0,
    })
    expect(await journalFingerprint(company.companyId)).toBe(journalBefore)
  })

  it('names the 19xx side when the share is more than the deposit has left', async () => {
    const company = await seedCompanyWithMethod('cash')
    const a = await seedInvoice({ company, total: 1250 })
    const b = await seedInvoice({ company, total: 4500 })
    const voucherId = await seedVoucher({ company, lines: cashDepositLines(5250) })

    expect((await link({ company, invoiceId: a, voucherId, amount: 1250 })).ok).toBe(true)
    expect(await link({ company, invoiceId: b, voucherId, amount: 4500 })).toEqual({
      ok: false,
      code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
      details: { amount: 4500, available: 4000, bank_debit: 5250, already_linked: 1250 },
    })
  })
})

// ============================================================
// Foreign currency
// ============================================================

describe('link_invoice_to_voucher: a share and a foreign invoice', () => {
  it('a kronor verifikat takes no share of a foreign invoice: the kursdifferens would be a guess', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedInvoice({ company, total: 100, currency: 'EUR', exchangeRate: 11 })
    const voucherId = await seedVoucher({ company, lines: bundleLines(5250) })
    const journalBefore = await journalFingerprint(company.companyId)

    expect(await link({ company, invoiceId, voucherId, amount: 100 })).toEqual({
      ok: false,
      code: 'LINK_VOUCHER_CURRENCY_MISMATCH',
      details: { invoice_currency: 'EUR', line_currency: 'SEK', reason: 'amount_needs_invoice_currency' },
    })
    expect(await paymentRows(invoiceId)).toHaveLength(0)
    expect(await journalFingerprint(company.companyId)).toBe(journalBefore)
  })

  it('a kronor verifikat that settles the whole foreign invoice still does, without a share', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedInvoice({ company, total: 100, currency: 'EUR', exchangeRate: 11 })
    const voucherId = await seedVoucher({ company, lines: bundleLines(1130) })

    const result = await link({ company, invoiceId, voucherId })
    expect(result).toMatchObject({ ok: true, invoice_status: 'paid', payment_amount: 100, voucher_remaining: 0 })
    // Settled 1 130 kr for a fordran carried at 1 100 kr: the kursdifferens is
    // its own verifikat, exactly as before.
    expect(result.fx_journal_entry_id).toEqual(expect.any(String))
  })

  it('a verifikat whose rows are in another currency has no readable capacity', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const voucherId = await seedVoucher({ company, lines: bundleLines(5250) })
    const eur = await seedInvoice({ company, total: 100, currency: 'EUR', exchangeRate: 11 })
    await getPool().query(
      `INSERT INTO public.invoice_payments
         (user_id, company_id, invoice_id, payment_date, amount, currency, journal_entry_id)
       VALUES ($1, $2, $3, '2026-06-30', 100, 'EUR', $4)`,
      [company.userId, company.companyId, eur, voucherId],
    )
    const sek = await seedInvoice({ company, total: 1250 })

    expect(await link({ company, invoiceId: sek, voucherId, amount: 1250 })).toEqual({
      ok: false,
      code: 'LINK_VOUCHER_CURRENCY_MISMATCH',
      details: { invoice_currency: 'SEK', reason: 'voucher_settles_other_currency' },
    })
  })
})

// ============================================================
// The signature
// ============================================================

describe('link_invoice_to_voucher: one function, old callers intact', () => {
  it('exists once, with the share as a sixth defaulted argument and the grants restated', async () => {
    const sig = 'link_invoice_to_voucher(uuid,uuid,uuid,uuid,text,numeric,text,text,uuid[],text)'
    const { rows } = await getPool().query<{ signature: string; security_definer: boolean; comment: string }>(
      `SELECT oid::regprocedure::text AS signature, prosecdef AS security_definer,
              obj_description(oid, 'pg_proc') AS comment
       FROM pg_proc
       WHERE proname = 'link_invoice_to_voucher' AND pronamespace = 'public'::regnamespace`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ signature: sig, security_definer: true })
    expect(rows[0].comment).toContain('customer invoice as its payment')
    expect(rows[0].comment).toContain('p_amount')

    const grants = await getPool().query<{ anon: boolean; authenticated: boolean; service: boolean }>(
      `SELECT has_function_privilege('anon', 'public.${sig}', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.${sig}', 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', 'public.${sig}', 'EXECUTE') AS service`,
    )
    expect(grants.rows[0]).toEqual({ anon: false, authenticated: true, service: true })
  })

  it('five positional arguments still resolve, as older callers pass them', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: bundleLines(1250) })

    const { rows } = await getPool().query<{ result: LinkResult }>(
      `SELECT public.link_invoice_to_voucher($1, $2, $3, $4, NULL) AS result`,
      [invoiceId, voucherId, company.userId, company.companyId],
    )
    expect(rows[0].result).toMatchObject({ ok: true, invoice_status: 'paid', payment_amount: 1250, voucher_remaining: 0 })
  })
})
