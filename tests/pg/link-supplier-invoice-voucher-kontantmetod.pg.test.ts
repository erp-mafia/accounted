/**
 * pg-real tests for migration
 * 20260921190300_link_supplier_invoice_to_voucher_kontantmetod.sql (issue #2854).
 *
 * "Markera som betald, Befintlig verifikation" could never work for a supplier
 * invoice in a kontantmetod company: the RPC read the 244x debit only, and the
 * verifikat that pays an invoice under kontantmetoden is Dr cost, Dr 2641 /
 * Cr 19xx. The way out was mark-paid, which books the cost and the moms again.
 *
 * What only real Postgres can prove here:
 *   - supplier_invoice_settlement_side, the ONE definition of the side, under
 *     RLS and with its real grants;
 *   - that the link on the 19xx side writes a payment row and the invoice's
 *     paid state and NOTHING in the journal, locked year included;
 *   - the capacity rule against rows other writers left on the voucher, under
 *     concurrency (the advisory lock) and together with
 *     attach_supplier_invoice_settlement_voucher;
 *   - that the 244x side still answers as before. The byte-for-byte pin of that
 *     side is the existing suites running against this body:
 *     tests/pg/link-voucher-fx-residual.pg.test.ts (current applied schema),
 *     tests/pg/link-voucher-rpcs-tenant-guard.pg.test.ts and
 *     lib/invoices/__tests__/link-voucher-currency.pg.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import {
  insertAuthUser,
  insertPostedJournalEntry,
  seedCompany,
  type PostedJournalEntryLine,
} from './fixtures'
import { roundOre } from '@/lib/money'

let arrivalSeq = 0

type Seeded = Awaited<ReturnType<typeof seedCompany>>

async function seedCompanyWithMethod(method: 'cash' | 'accrual' | null): Promise<Seeded> {
  const company = await seedCompany()
  // seedCompany() inserts companies/members/period but not company_settings.
  if (method) {
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, accounting_method)
       VALUES ($1, $2, $3)`,
      [company.userId, company.companyId, method],
    )
  }
  return company
}

async function seedSupplierInvoice(params: {
  company: Seeded
  total?: number
  currency?: string
  exchangeRate?: number | null
  registrationEntryId?: string | null
  invoiceDate?: string
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
  // Time component for cross-run uniqueness, counter for within-run uniqueness.
  const arrivalNumber = (Date.now() % 1_000_000) * 1000 + arrivalSeq++
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency, exchange_rate,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note, registration_journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-05-01', $7, 'registered', $8, $9,
             $10, 0, $10, 0, $10, 'standard_25', false, false, $11)`,
    [
      id, userId, companyId, supplierId, arrivalNumber, `LF-${arrivalNumber}`,
      params.invoiceDate ?? '2026-04-01', params.currency ?? 'SEK', params.exchangeRate ?? null,
      total, params.registrationEntryId ?? null,
    ],
  )
  return id
}

/** Kontantmetoden: the cost and the ingående moms against the bank account. */
function cashPaymentLines(amount: number): PostedJournalEntryLine[] {
  const vat = roundOre(amount * 0.2)
  return [
    { accountNumber: '4010', debitAmount: roundOre(amount - vat), creditAmount: 0 },
    { accountNumber: '2641', debitAmount: vat, creditAmount: 0 },
    { accountNumber: '1930', debitAmount: 0, creditAmount: amount },
  ]
}

/** Faktureringsmetoden: leverantörsskulder against the bank account. */
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
    entryDate: params.entryDate ?? '2026-04-28',
    description: 'Betalning leverantör',
    // These are existing vouchers, without a source bank transaction fixture.
    sourceType: params.sourceType ?? 'manual',
    lines: params.lines,
  })
}

/**
 * A posted kontantmetod payment whose bank line carries document-currency
 * metadata (`currency` + `amount_in_currency`), which the shared fixture cannot
 * express. Built the way the fixture builds its entries: draft, lines, post, so
 * every accounting guard stays on.
 */
async function seedVoucherWithLabelledBankLine(params: {
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
       VALUES ($1, $2, $3, $4, $5, 'A', '2026-04-28', 'Betalning leverantör', 'manual', 'draft')`,
      [
        id, params.company.userId, params.company.companyId, params.company.fiscalPeriodId,
        Math.floor(Math.random() * 1_000_000),
      ],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, currency, amount_in_currency, sort_order)
       VALUES ($1, '4010', $2, 0, 'SEK', NULL, 0),
              ($1, '1930', 0, $2, $3, $4, 1)`,
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
  fx_journal_entry_id?: string | null
  fx_residual_sek?: number | null
  details?: Record<string, unknown>
}

const LINK = `SELECT public.link_supplier_invoice_to_voucher($1, $2, $3, $4, NULL) AS result`

async function link(params: { company: Seeded; invoiceId: string; voucherId: string }): Promise<LinkResult> {
  const { rows } = await getPool().query<{ result: LinkResult }>(LINK, [
    params.invoiceId, params.voucherId, params.company.userId, params.company.companyId,
  ])
  return rows[0].result
}

async function side(companyId: string, invoiceId: string) {
  const { rows } = await getPool().query<{
    settlement_side: string
    account_prefix: string
    entry_side: string
  }>(`SELECT * FROM public.supplier_invoice_settlement_side($1, $2)`, [invoiceId, companyId])
  return rows
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
  const { rows } = await getPool().query<{
    status: string
    paid_amount: string
    remaining_amount: string
    paid_at: string | null
  }>(
    `SELECT status, paid_amount, remaining_amount, paid_at::text
     FROM public.supplier_invoices WHERE id = $1`,
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

// ============================================================
// The one definition of the side
// ============================================================

describe('supplier_invoice_settlement_side', () => {
  it('kontantmetoden with no registration verifikat: the 19xx credit', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company })
    expect(await side(company.companyId, invoiceId)).toEqual([
      { settlement_side: 'bank_credit', account_prefix: '19', entry_side: 'credit' },
    ])
  })

  it('kontantmetoden WITH a registration verifikat: the 244x debit, as before', async () => {
    const company = await seedCompanyWithMethod('cash')
    const registration = await seedVoucher({
      company,
      sourceType: 'supplier_invoice_registered',
      lines: [
        { accountNumber: '4010', debitAmount: 1250, creditAmount: 0 },
        { accountNumber: '2440', debitAmount: 0, creditAmount: 1250 },
      ],
    })
    const invoiceId = await seedSupplierInvoice({ company, registrationEntryId: registration })
    expect(await side(company.companyId, invoiceId)).toEqual([
      { settlement_side: 'ap_debit', account_prefix: '244', entry_side: 'debit' },
    ])
  })

  it('faktureringsmetoden, and a company with no settings row: the 244x debit', async () => {
    for (const method of ['accrual', null] as const) {
      const company = await seedCompanyWithMethod(method)
      const invoiceId = await seedSupplierInvoice({ company })
      expect(await side(company.companyId, invoiceId)).toEqual([
        { settlement_side: 'ap_debit', account_prefix: '244', entry_side: 'debit' },
      ])
    }
  })

  it('answers nothing for an invoice of another company', async () => {
    const company = await seedCompanyWithMethod('cash')
    const other = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company })
    expect(await side(other.companyId, invoiceId)).toEqual([])
  })

  it('is SECURITY INVOKER: a member reads the side, an outsider gets no row, anon cannot call it', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company })
    const outsider = await insertAuthUser()
    const sql = `SELECT settlement_side FROM public.supplier_invoice_settlement_side($1, $2)`

    const asMember = await withUserContext(company.userId, (c) =>
      c.query<{ settlement_side: string }>(sql, [invoiceId, company.companyId]),
    )
    expect(asMember.rows).toEqual([{ settlement_side: 'bank_credit' }])

    const asOutsider = await withUserContext(outsider, (c) =>
      c.query(sql, [invoiceId, company.companyId]),
    )
    expect(asOutsider.rows).toEqual([])

    const { rows } = await getPool().query<{ anon: boolean; authenticated: boolean; service: boolean }>(
      `SELECT has_function_privilege('anon', 'public.supplier_invoice_settlement_side(uuid, uuid)', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.supplier_invoice_settlement_side(uuid, uuid)', 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', 'public.supplier_invoice_settlement_side(uuid, uuid)', 'EXECUTE') AS service`,
    )
    expect(rows[0]).toEqual({ anon: false, authenticated: true, service: true })
  })
})

// ============================================================
// The defect, and what the link writes
// ============================================================

describe('link_supplier_invoice_to_voucher: kontantmetoden, the 19xx credit', () => {
  it('links the bank-first verifikat (Dr cost, Dr 2641 / Cr 1930) and writes nothing in the journal', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1250), entryDate: '2026-04-28' })
    const journalBefore = await journalFingerprint(company.companyId)

    const result = await link({ company, invoiceId, voucherId })

    expect(result).toMatchObject({
      ok: true,
      invoice_status: 'paid',
      payment_amount: 1250,
      remaining_amount: 0,
      settlement_side: 'bank_credit',
      fx_journal_entry_id: null,
    })
    // The cost and the moms were recognised once, by the verifikat that moved
    // the money. The link is reskontra only.
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

  it('refuses a verifikat that does not credit 19xx, naming the bank side', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const noBank = await seedVoucher({
      company,
      lines: [
        { accountNumber: '4010', debitAmount: 1250, creditAmount: 0 },
        { accountNumber: '2893', debitAmount: 0, creditAmount: 1250 },
      ],
    })
    // Money coming INTO the bank is not a payment of a supplier invoice.
    const refund = await seedVoucher({
      company,
      lines: [
        { accountNumber: '1930', debitAmount: 1250, creditAmount: 0 },
        { accountNumber: '4010', debitAmount: 0, creditAmount: 1250 },
      ],
    })
    const storno = await seedVoucher({ company, lines: cashPaymentLines(1250), sourceType: 'storno' })

    expect(await link({ company, invoiceId, voucherId: noBank })).toEqual({
      ok: false, code: 'LINK_SI_VOUCHER_NO_BANK_CREDIT',
    })
    expect(await link({ company, invoiceId, voucherId: refund })).toEqual({
      ok: false, code: 'LINK_SI_VOUCHER_NO_BANK_CREDIT',
    })
    expect(await link({ company, invoiceId, voucherId: storno })).toEqual({
      ok: false, code: 'LINK_SI_VOUCHER_NO_BANK_CREDIT', details: { source_type: 'storno' },
    })
    expect(await paymentRows(invoiceId)).toHaveLength(0)
  })

  it('records instalments as partial payments, one verifikat each', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const first = await seedVoucher({ company, lines: cashPaymentLines(500), entryDate: '2026-04-20' })
    const second = await seedVoucher({ company, lines: cashPaymentLines(750), entryDate: '2026-05-02' })

    expect(await link({ company, invoiceId, voucherId: first })).toMatchObject({
      ok: true, invoice_status: 'partially_paid', payment_amount: 500, remaining_amount: 750,
    })
    // A repeated link of the same pair is refused and writes nothing.
    expect(await link({ company, invoiceId, voucherId: first })).toEqual({
      ok: false, code: 'LINK_SI_VOUCHER_ALREADY_LINKED',
    })
    expect(await link({ company, invoiceId, voucherId: second })).toMatchObject({
      ok: true, invoice_status: 'paid', payment_amount: 750, remaining_amount: 0,
    })
    expect(await link({ company, invoiceId, voucherId: second })).toMatchObject({
      ok: false, code: 'LINK_SI_VOUCHER_INVOICE_FULLY_PAID',
    })
    expect((await paymentRows(invoiceId)).map((r) => r.amount)).toEqual([500, 750])
  })

  it('refuses a payout larger than the remainder: one verifikat paying several invoices is never split on a guess', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 4000 })
    const batch = await seedVoucher({ company, lines: cashPaymentLines(10000) })

    expect(await link({ company, invoiceId, voucherId: batch })).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      details: { bank_credit: 10000, remaining: 4000 },
    })
    expect(await paymentRows(invoiceId)).toHaveLength(0)
  })

  it('links in a closed and locked year: nothing is written to it', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1250) })
    await getPool().query(
      `UPDATE public.fiscal_periods SET is_closed = true, closed_at = now(), locked_at = now() WHERE id = $1`,
      [company.fiscalPeriodId],
    )
    const journalBefore = await journalFingerprint(company.companyId)

    expect((await link({ company, invoiceId, voucherId })).ok).toBe(true)
    expect(await journalFingerprint(company.companyId)).toBe(journalBefore)
  })

  it('tenant guard: an outsider session is answered as if the invoice did not exist', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1250) })
    const outsider = await insertAuthUser()
    const args = [invoiceId, voucherId, outsider, company.companyId]

    const asOutsider = await withUserContext(outsider, (c) => c.query<{ result: LinkResult }>(LINK, args))
    expect(asOutsider.rows[0].result).toEqual({ ok: false, code: 'LINK_SI_VOUCHER_INVOICE_NOT_FOUND' })

    // The member's own session links, attributed to the JWT sub whatever
    // p_user_id says (withUserContext rolls the write back).
    const asMember = await withUserContext(company.userId, async (c) => {
      const res = await c.query<{ result: LinkResult }>(LINK, args)
      const row = await c.query<{ user_id: string }>(
        `SELECT user_id FROM public.supplier_invoice_payments WHERE supplier_invoice_id = $1`,
        [invoiceId],
      )
      return { result: res.rows[0].result, userId: row.rows[0]?.user_id }
    })
    expect(asMember.result.ok).toBe(true)
    expect(asMember.userId).toBe(company.userId)
    expect(await paymentRows(invoiceId)).toHaveLength(0)
  })
})

// ============================================================
// A 19xx credit is a weak discriminator: capacity
// ============================================================

describe('link_supplier_invoice_to_voucher: what a 19xx credit has left', () => {
  it("refuses last month's payment for this month's invoice of the same amount", async () => {
    const company = await seedCompanyWithMethod('cash')
    const lastMonth = await seedSupplierInvoice({ company, total: 1250 })
    const thisMonth = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1250) })

    expect((await link({ company, invoiceId: lastMonth, voucherId })).ok).toBe(true)
    expect(await link({ company, invoiceId: thisMonth, voucherId })).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_FULLY_ALLOCATED',
      details: { bank_credit: 1250, already_linked: 1250 },
    })
    expect(await paymentRows(thisMonth)).toHaveLength(0)
    expect((await invoiceState(thisMonth)).status).toBe('registered')
  })

  it('two invoices reaching for one verifikat at the same moment: exactly one gets it', async () => {
    const company = await seedCompanyWithMethod('cash')
    const a = await seedSupplierInvoice({ company, total: 1250 })
    const b = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1250) })

    const results = await Promise.all([
      link({ company, invoiceId: a, voucherId }),
      link({ company, invoiceId: b, voucherId }),
    ])

    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)?.code).toBe('LINK_SI_VOUCHER_FULLY_ALLOCATED')
    const { rows } = await getPool().query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM public.supplier_invoice_payments WHERE journal_entry_id = $1`,
      [voucherId],
    )
    expect(Number(rows[0].total)).toBe(1250)
  })

  it('settles with what is left after settlement evidence attached to the same batch verifikat', async () => {
    const company = await seedCompanyWithMethod('cash')
    const batch = await seedVoucher({ company, lines: cashPaymentLines(10000) })
    // A migrated, already settled invoice explains 6 000 of the payout
    // (attach_supplier_invoice_settlement_voucher, 20260921084700).
    const settled = await seedSupplierInvoice({ company, total: 6000 })
    await getPool().query(
      `UPDATE public.supplier_invoices SET status = 'paid', paid_amount = 6000, remaining_amount = 0 WHERE id = $1`,
      [settled],
    )
    const attached = await getPool().query<{ result: { ok: boolean } }>(
      `SELECT public.attach_supplier_invoice_settlement_voucher($1, $2, $3, $4, NULL, false) AS result`,
      [settled, batch, company.userId, company.companyId],
    )
    expect(attached.rows[0].result.ok).toBe(true)

    const open = await seedSupplierInvoice({ company, total: 4000 })
    expect(await link({ company, invoiceId: open, voucherId: batch })).toMatchObject({
      ok: true, invoice_status: 'paid', payment_amount: 4000,
    })
    // And now the payout is spent.
    const third = await seedSupplierInvoice({ company, total: 4000 })
    expect((await link({ company, invoiceId: third, voucherId: batch })).code).toBe(
      'LINK_SI_VOUCHER_FULLY_ALLOCATED',
    )
  })

  it('refuses a verifikat whose rows are in another currency: the used part cannot be read', async () => {
    const company = await seedCompanyWithMethod('cash')
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1250) })
    const eur = await seedSupplierInvoice({ company, total: 100, currency: 'EUR', exchangeRate: 12.5 })
    expect((await link({ company, invoiceId: eur, voucherId })).ok).toBe(true)

    const sek = await seedSupplierInvoice({ company, total: 1250 })
    expect(await link({ company, invoiceId: sek, voucherId })).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
      details: { invoice_currency: 'SEK', reason: 'voucher_settles_other_currency' },
    })
  })
})

// ============================================================
// Foreign invoices: no kursdifferens on kontantmetoden
// ============================================================

describe('link_supplier_invoice_to_voucher: kontantmetoden and a foreign invoice', () => {
  it('a plain kronor payout settles the full remaining and books NO residual verifikat', async () => {
    const company = await seedCompanyWithMethod('cash')
    // 100 EUR at 11.50 = 1 150 kr at the invoice rate; 1 180 kr left the bank.
    const invoiceId = await seedSupplierInvoice({ company, total: 100, currency: 'EUR', exchangeRate: 11.5 })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1180) })
    const journalBefore = await journalFingerprint(company.companyId)

    const result = await link({ company, invoiceId, voucherId })

    expect(result).toMatchObject({
      ok: true,
      invoice_status: 'paid',
      payment_amount: 100,
      settlement_side: 'bank_credit',
      fx_journal_entry_id: null,
      fx_residual_sek: null,
    })
    // No skuld was ever carried at 11.50, so there is nothing for a
    // kursdifferens to arise against: the cost is in the books at 11.80.
    expect(await journalFingerprint(company.companyId)).toBe(journalBefore)
    const [row] = await paymentRows(invoiceId)
    expect(row.currency).toBe('EUR')
    expect(row.amount).toBe(100)
    // The rate column marks a link whose FX fallback trued up a residual
    // against 244x. No residual can exist here, so it stays NULL.
    expect(row.payment_exchange_rate).toBeNull()
  })

  it('still refuses a kronor payout far off the invoice value: the wrong verifikat, not FX', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 100, currency: 'EUR', exchangeRate: 11.5 })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(100) })

    expect(await link({ company, invoiceId, voucherId })).toMatchObject({
      ok: false,
      code: 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
      details: { reason: 'fx_deviation_too_large', expected_sek: 1150, voucher_sek: 100 },
    })
  })

  it('a kronor payout that already carries a row cannot also settle a foreign invoice in full', async () => {
    const company = await seedCompanyWithMethod('cash')
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1180) })
    const sek = await seedSupplierInvoice({ company, total: 1180 })
    expect((await link({ company, invoiceId: sek, voucherId })).ok).toBe(true)

    const eur = await seedSupplierInvoice({ company, total: 100, currency: 'EUR', exchangeRate: 11.5 })
    expect(await link({ company, invoiceId: eur, voucherId })).toEqual({
      ok: false, code: 'LINK_SI_VOUCHER_FULLY_ALLOCATED', details: { linked_rows: 1 },
    })
  })

  it('reads a 19xx credit labelled in the invoice currency from amount_in_currency', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 100, currency: 'EUR', exchangeRate: 11.5 })
    const voucherId = await seedVoucherWithLabelledBankLine({
      company, sekAmount: 1180, currency: 'EUR', amountInCurrency: 100,
    })

    expect(await link({ company, invoiceId, voucherId })).toMatchObject({
      ok: true, invoice_status: 'paid', payment_amount: 100, fx_journal_entry_id: null,
    })
  })

  it('label guard: a payout stamped with another document currency belongs to another invoice', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucherWithLabelledBankLine({
      company, sekAmount: 1250, currency: 'EUR', amountInCurrency: 110,
    })

    expect(await link({ company, invoiceId, voucherId })).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
      details: { invoice_currency: 'SEK', line_currency: 'EUR' },
    })
  })
})

// ============================================================
// A posted kontantmetod cut-off
// ============================================================

describe('link_supplier_invoice_to_voucher: a posted kontantmetod cut-off', () => {
  async function seedPostedPayableCutoff(company: Seeded): Promise<void> {
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
        { accountNumber: '4010', debitAmount: 1250, creditAmount: 0 },
        { accountNumber: '2440', debitAmount: 0, creditAmount: 1250 },
      ],
    })
    await getPool().query(
      `INSERT INTO public.kontantmetod_cutoff_entries
         (company_id, fiscal_period_id, kind, journal_entry_id)
       VALUES ($1, $2, 'payable', $3)`,
      [company.companyId, company.fiscalPeriodId, entryId],
    )
  }

  it('refuses a link the posted cut-off would contradict, on the 19xx side', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1250), entryDate: '2026-04-28' })
    await seedPostedPayableCutoff(company)

    expect(await link({ company, invoiceId, voucherId })).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_CUTOFF_ALREADY_POSTED',
      details: { voucher_date: '2026-04-28', invoice_date: '2026-04-01' },
    })
    expect(await paymentRows(invoiceId)).toHaveLength(0)
  })

  it('does not reach the 244x side, which is exactly as it was', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(1250) })
    await seedPostedPayableCutoff(company)

    expect((await link({ company, invoiceId, voucherId })).ok).toBe(true)
  })
})

// ============================================================
// The 244x side did not move
// ============================================================

describe('link_supplier_invoice_to_voucher: the 244x debit side is unchanged', () => {
  it('faktureringsmetoden: Dr cost / Cr 1930 is still a non-invoiced purchase, refused', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: cashPaymentLines(1250) })

    expect(await link({ company, invoiceId, voucherId })).toEqual({
      ok: false, code: 'LINK_SI_VOUCHER_NO_AP_DEBIT',
    })
  })

  it('faktureringsmetoden: Dr 2440 / Cr 1930 links, with the same payload plus settlement_side', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(1250), entryDate: '2026-04-28' })

    const result = await link({ company, invoiceId, voucherId })
    expect(result).toEqual({
      ok: true,
      payment_id: expect.any(String),
      invoice_status: 'paid',
      paid_amount: 1250,
      remaining_amount: 0,
      payment_amount: 1250,
      journal_entry_id: voucherId,
      currency: 'SEK',
      settlement_side: 'ap_debit',
      fx_settled_sek: null,
      fx_residual_sek: null,
      fx_journal_entry_id: null,
      fx_voucher_number: null,
    })
  })

  it('faktureringsmetoden: an overshooting 244x debit keeps its code and its details keys', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(5000) })

    expect(await link({ company, invoiceId, voucherId })).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      details: { ap_debit: 5000, remaining: 1250 },
    })
  })

  it('kontantmetoden with a registration verifikat: the skuld is on 244x, so only a 244x debit clears it', async () => {
    const company = await seedCompanyWithMethod('cash')
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
    // Booking the cost again against the bank is not the payment of a booked
    // invoice: linking it would leave 1 250 kr standing on 2440.
    const costAgain = await seedVoucher({ company, lines: cashPaymentLines(1250) })
    const payment = await seedVoucher({ company, lines: accrualPaymentLines(1250) })

    expect(await link({ company, invoiceId, voucherId: costAgain })).toEqual({
      ok: false, code: 'LINK_SI_VOUCHER_NO_AP_DEBIT',
    })
    expect(await link({ company, invoiceId, voucherId: payment })).toMatchObject({
      ok: true, invoice_status: 'paid', settlement_side: 'ap_debit',
    })
  })

  // Deliberately pinned, not endorsed: the capacity rule is 19xx-only in this
  // migration so that no existing 244x answer moves. Extending it to the 244x
  // side is a follow-up (bulk reconcile already enforces it for unattended links).
  it('faktureringsmetoden: a second invoice can still link the same 244x verifikat', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const a = await seedSupplierInvoice({ company, total: 1250 })
    const b = await seedSupplierInvoice({ company, total: 1250 })
    const voucherId = await seedVoucher({ company, lines: accrualPaymentLines(1250) })

    expect((await link({ company, invoiceId: a, voucherId })).ok).toBe(true)
    expect((await link({ company, invoiceId: b, voucherId })).ok).toBe(true)
  })
})
