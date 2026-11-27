import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertPostedJournalEntry, seedCompany } from './fixtures'

/**
 * link_invoice_to_voucher on a SEK customer invoice whose own verifikat
 * booked the öresavrundning: 1510 at the rounded "Att betala" and the öre on
 * 3740 (an issuance edited by hand, an import). The verifikat linked as its
 * payment is one that clears what 1510 carries: a payment booked by hand, or a
 * kreditfaktura whose own verifikat mirrored the rounding.
 *
 * The link compared the verifikat's 151x credit with the reskontra's
 * remainder. Rounded up (999,75 issued at 1 000) it refused the 1 000 that
 * clears 1510; rounded down (1 000,40 issued at 1 000) it took the 1 000 as a
 * part payment and left 0,40 open in the kundreskontra while 1510 was zero.
 * Now a verifikat whose side has exactly what 1510 carries left settles the
 * invoice in full, the rule of the other settlement doors (bookedOreRounding
 * over carriedSekOf). Invoices whose 1510 carries the remainder link as
 * before.
 */

type Company = Awaited<ReturnType<typeof seedCompany>>
type Line = [account: string, debit: number, credit: number]
interface LinkResult {
  ok: boolean
  code?: string
  invoice_status?: string
  paid_amount?: number
  remaining_amount?: number
  payment_amount?: number
  voucher_remaining?: number
}

const pool = () => getPool()

async function post(company: Company, entryDate: string, lines: Line[], sourceType = 'manual'): Promise<string> {
  return insertPostedJournalEntry({
    userId: company.userId,
    companyId: company.companyId,
    fiscalPeriodId: company.fiscalPeriodId,
    entryDate,
    description: 'Verifikat',
    sourceType,
    lines: lines.map(([accountNumber, debitAmount, creditAmount]) => ({ accountNumber, debitAmount, creditAmount })),
  })
}

async function customer(company: Company): Promise<string> {
  const id = randomUUID()
  await pool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [id, company.userId, company.companyId],
  )
  return id
}

/** A sent SEK invoice of `total` whose issue verifikat posts `lines`. */
async function invoice(company: Company, total: number, lines: Line[]): Promise<{ invoiceId: string; issueId: string }> {
  const issueId = await post(company, '2026-03-01', lines, 'invoice_created')
  const invoiceId = randomUUID()
  await pool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, currency,
        subtotal, vat_amount, total, vat_treatment, vat_rate, status, paid_amount, remaining_amount, journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, '2026-03-01', '2026-03-31', 'SEK',
             $6, 0, $6, 'standard_25', 25, 'sent', 0, $6, $7)`,
    [invoiceId, company.userId, company.companyId, await customer(company), `F-${invoiceId.slice(0, 8)}`, total, issueId],
  )
  return { invoiceId, issueId }
}

/** 999,75 issued with 1510 at 1 000 and the 0,25 credited to 3740. */
const roundedUp = (company: Company) =>
  invoice(company, 999.75, [
    ['1510', 1000, 0],
    ['3001', 0, 799.8],
    ['2611', 0, 199.95],
    ['3740', 0, 0.25],
  ])

/** 1 000,40 issued with 1510 at 1 000 and the 0,40 debited to 3740. */
const roundedDown = (company: Company) =>
  invoice(company, 1000.4, [
    ['1510', 1000, 0],
    ['3740', 0.4, 0],
    ['3001', 0, 800.32],
    ['2611', 0, 200.08],
  ])

/** 999,75 issued with 1510 at the total: the öre are the payment's to book. */
const exact = (company: Company) =>
  invoice(company, 999.75, [
    ['1510', 999.75, 0],
    ['3001', 0, 799.8],
    ['2611', 0, 199.95],
  ])

/** A payment booked by hand that clears `amount` off 1510. */
const payment = (company: Company, amount: number) =>
  post(company, '2026-03-20', [
    ['1930', amount, 0],
    ['1510', 0, amount],
  ])

async function link(company: Company, invoiceId: string, voucherId: string, amount: number | null = null): Promise<LinkResult> {
  const { rows } = await pool().query<{ result: LinkResult }>(
    'SELECT public.link_invoice_to_voucher($1, $2, $3, $4, NULL, $5) AS result',
    [invoiceId, voucherId, company.userId, company.companyId, amount],
  )
  return rows[0]!.result
}

async function invoiceRow(invoiceId: string) {
  const { rows } = await pool().query<{ status: string; paid_amount: string; remaining_amount: string }>(
    'SELECT status, paid_amount::text, remaining_amount::text FROM public.invoices WHERE id = $1',
    [invoiceId],
  )
  const row = rows[0]!
  return { status: row.status, paid: Number(row.paid_amount), remaining: Number(row.remaining_amount) }
}

/** Debit less credit on `account` over the given verifikat. */
async function balance(entryIds: string[], account: string): Promise<number> {
  const { rows } = await pool().query<{ balance: string }>(
    `SELECT COALESCE(SUM(debit_amount - credit_amount), 0)::text AS balance
       FROM public.journal_entry_lines WHERE journal_entry_id = ANY($1::uuid[]) AND account_number = $2`,
    [entryIds, account],
  )
  return Number(rows[0]!.balance)
}

/**
 * The judge: what the kundreskontra says is open on `invoiceIds` (their
 * remaining amounts) against what 1510 holds over every verifikat that
 * touched them. They must agree to the öre.
 */
async function reskontraAnd1510(invoiceIds: string[], entryIds: string[]): Promise<{ reskontra: number; ledger: number }> {
  const { rows } = await pool().query<{ open: string }>(
    'SELECT COALESCE(SUM(remaining_amount), 0)::text AS open FROM public.invoices WHERE id = ANY($1::uuid[])',
    [invoiceIds],
  )
  return { reskontra: Number(rows[0]!.open), ledger: await balance(entryIds, '1510') }
}

async function journalCount(companyId: string): Promise<number> {
  const { rows } = await pool().query<{ n: string }>('SELECT count(*)::text AS n FROM public.journal_entries WHERE company_id = $1', [companyId])
  return Number(rows[0]!.n)
}

describe('link_invoice_to_voucher: an invoice whose issue verifikat booked the öresavrundning', () => {
  it('rounded up: the payment of 1 000 settles 999,75 in full and 1510 ends at zero', async () => {
    const company = await seedCompany()
    const { invoiceId, issueId } = await roundedUp(company)
    const paymentId = await payment(company, 1000)
    const entries = await journalCount(company.companyId)

    const result = await link(company, invoiceId, paymentId)

    expect(result).toMatchObject({ ok: true, invoice_status: 'paid', payment_amount: 999.75, remaining_amount: 0 })
    expect(Number(result.voucher_remaining)).toBe(0)
    expect(await invoiceRow(invoiceId)).toEqual({ status: 'paid', paid: 999.75, remaining: 0 })
    expect(await reskontraAnd1510([invoiceId], [issueId, paymentId])).toEqual({ reskontra: 0, ledger: 0 })
    // The link posts nothing: the voucher is the payment.
    expect(await journalCount(company.companyId)).toBe(entries)
  })

  it('rounded down: the payment of 1 000 settles 1 000,40 in full instead of leaving 0,40 open', async () => {
    const company = await seedCompany()
    const { invoiceId, issueId } = await roundedDown(company)
    const paymentId = await payment(company, 1000)

    const result = await link(company, invoiceId, paymentId)

    expect(result).toMatchObject({ ok: true, invoice_status: 'paid', payment_amount: 1000.4, remaining_amount: 0 })
    expect(Number(result.voucher_remaining)).toBe(0)
    expect(await invoiceRow(invoiceId)).toEqual({ status: 'paid', paid: 1000.4, remaining: 0 })
    // On main the invoice stayed open by 0,40 while 1510 was zero.
    expect(await reskontraAnd1510([invoiceId], [issueId, paymentId])).toEqual({ reskontra: 0, ledger: 0 })

    // The verifikat is used up: it pays no other invoice.
    const other = await exact(company)
    expect(await link(company, other.invoiceId, paymentId)).toMatchObject({ ok: false, code: 'LINK_VOUCHER_FULLY_ALLOCATED' })
  })

  it('a kreditfaktura whose verifikat mirrored the rounding pays a new invoice of the same amount', async () => {
    const company = await seedCompany()
    // The customer's credit: a kreditfaktura of 999,75 booked as Cr 1510 1 000 / Dr 3740 0,25.
    const creditId = await post(company, '2026-03-10', [
      ['1510', 0, 1000],
      ['3001', 799.8, 0],
      ['2611', 199.95, 0],
      ['3740', 0.25, 0],
    ])
    const { invoiceId, issueId } = await roundedUp(company)

    const result = await link(company, invoiceId, creditId)

    expect(result).toMatchObject({ ok: true, invoice_status: 'paid', payment_amount: 999.75 })
    expect(Number(result.voucher_remaining)).toBe(0)
    expect(await reskontraAnd1510([invoiceId], [issueId, creditId])).toEqual({ reskontra: 0, ledger: 0 })
  })

  it('a stated share of the whole remainder, or of the rounded amount, settles in full', async () => {
    const company = await seedCompany()
    const up = await roundedUp(company)
    const upPayment = await payment(company, 1000)
    expect(await link(company, up.invoiceId, upPayment, 1000)).toMatchObject({ ok: true, invoice_status: 'paid', payment_amount: 999.75 })

    const down = await roundedDown(company)
    const downPayment = await payment(company, 1000)
    const result = await link(company, down.invoiceId, downPayment, 1000.4)
    expect(result).toMatchObject({ ok: true, invoice_status: 'paid', payment_amount: 1000.4 })
    expect(Number(result.voucher_remaining)).toBe(0)
  })

  it('one verifikat that pays two invoices: the rounded one settles on what 1510 carries for it', async () => {
    const company = await seedCompany()
    const a = await roundedDown(company)
    const b = await invoice(company, 500, [
      ['1510', 500, 0],
      ['3001', 0, 400],
      ['2611', 0, 100],
    ])
    const bundle = await payment(company, 1500)

    expect(await link(company, b.invoiceId, bundle, 500)).toMatchObject({ ok: true, invoice_status: 'paid', payment_amount: 500 })
    const result = await link(company, a.invoiceId, bundle)
    expect(result).toMatchObject({ ok: true, invoice_status: 'paid', payment_amount: 1000.4 })
    expect(Number(result.voucher_remaining)).toBe(0)
    expect(await reskontraAnd1510([a.invoiceId, b.invoiceId], [a.issueId, b.issueId, bundle])).toEqual({ reskontra: 0, ledger: 0 })
  })

  it('a verifikat with other than what 1510 carries left links as before', async () => {
    const company = await seedCompany()
    // A share of the remainder off a verifikat of 999,80: accepted, as on main.
    const up = await roundedUp(company)
    const short = await payment(company, 999.8)
    const shareResult = await link(company, up.invoiceId, short, 999.75)
    expect(shareResult).toMatchObject({ ok: true, invoice_status: 'paid', payment_amount: 999.75 })
    expect(Number(shareResult.voucher_remaining)).toBe(0.05)

    // A share of the remainder past what the verifikat holds: refused, as on main.
    const down = await roundedDown(company)
    const over = await payment(company, 1000.2)
    expect(await link(company, down.invoiceId, over, 1000.4)).toMatchObject({ ok: false, code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_VOUCHER' })
    expect(await invoiceRow(down.invoiceId)).toEqual({ status: 'sent', paid: 0, remaining: 1000.4 })
  })

  it('a part payment and a payment past what 1510 carries link as before', async () => {
    const company = await seedCompany()
    const { invoiceId, issueId } = await roundedDown(company)
    const over = await payment(company, 1500)
    expect(await link(company, invoiceId, over)).toMatchObject({ ok: false, code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING' })

    const part = await payment(company, 400)
    expect(await link(company, invoiceId, part)).toMatchObject({ ok: true, invoice_status: 'partially_paid', payment_amount: 400 })
    expect(await invoiceRow(invoiceId)).toEqual({ status: 'partially_paid', paid: 400, remaining: 600.4 })

    // The rest: 600 clears what 1510 carries (1 000 less 400) and settles 600,40.
    const rest = await payment(company, 600)
    expect(await link(company, invoiceId, rest)).toMatchObject({ ok: true, invoice_status: 'paid', payment_amount: 600.4 })
    expect(await reskontraAnd1510([invoiceId], [issueId, part, rest])).toEqual({ reskontra: 0, ledger: 0 })
  })

  it('an invoice whose 1510 carries the remainder still refuses the rounded payment', async () => {
    const company = await seedCompany()
    const { invoiceId } = await exact(company)
    const paymentId = await payment(company, 1000)

    // Linked as the payment, 1 000 would leave 0,25 on 1510: the öre are the
    // payment verifikat's to book (Cr 3740), and this one does not.
    expect(await link(company, invoiceId, paymentId)).toMatchObject({ ok: false, code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING' })

    const exactPayment = await payment(company, 999.75)
    expect(await link(company, invoiceId, exactPayment)).toMatchObject({ ok: true, invoice_status: 'paid', payment_amount: 999.75 })
  })
})
