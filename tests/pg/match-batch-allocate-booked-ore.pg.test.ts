import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { carriedSekOf } from '@/lib/bookkeeping/ledger-carried-sek'
import { buildBatchAllocationPreview } from '@/lib/invoices/batch-allocation-preview'
import { insertPostedJournalEntry, insertTransaction, seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { stagingSIEClient } from './sie-client'

/**
 * #119 (migration 20261119090000): match_batch_allocate on a SEK customer
 * invoice whose issue verifikat already booked the öresavrundning, 1510 at the
 * rounded "Att betala" and the öre on 3740 (an issuance edited by hand).
 *
 * The batch door credited 1510 with the whole remainder and booked the öre on
 * 3740 again: total 12 500.25 issued Dr 1510 12 500 / Dr 3740 0.25, settled by
 * 12 500 as Cr 1510 12 500.25 / Dr 3740 0.25, so 1510 ended at -0.25 and 3740
 * carried the rounding twice. Now it clears what 1510 carries, the rule of the
 * other doors (bookedOreRounding over carriedSekOf), and the staged preview
 * shows the lines the RPC posts.
 */

type Company = Awaited<ReturnType<typeof seedCompany>>
type Line = { accountNumber: string; debitAmount: number; creditAmount: number }
type RpcResult = { ok: boolean; code?: string; journal_entry_id?: string; allocations?: Array<{ status: string; paid_amount: number; remaining_amount: number }> }
type Allocation = { kind: 'customer_invoice'; invoice_id: string; amount: number }

const pool = () => getPool()

/** A sent SEK invoice of `total` whose issue verifikat posts `lines`. */
async function issuedInvoice(company: Company, total: number, lines: Line[]): Promise<{ invoiceId: string; issueId: string }> {
  const issueId = await insertPostedJournalEntry({
    userId: company.userId,
    companyId: company.companyId,
    fiscalPeriodId: company.fiscalPeriodId,
    entryDate: '2026-06-01',
    sourceType: 'invoice_created',
    lines,
  })
  const customerId = randomUUID()
  await pool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type, country)
     VALUES ($1, $2, $3, 'Kund AB', 'swedish_business', 'SE')`,
    [customerId, company.userId, company.companyId],
  )
  const invoiceId = randomUUID()
  await pool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status, currency,
        subtotal, vat_amount, total, paid_amount, remaining_amount, vat_treatment, journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, '2026-06-01', '2026-07-01', 'sent', 'SEK', $6, 0, $6, 0, $6, 'standard_25', $7)`,
    [invoiceId, company.userId, company.companyId, customerId, `F-${invoiceId.slice(0, 8)}`, total, issueId],
  )
  return { invoiceId, issueId }
}

/** 12 500.25 issued with 1510 at 12 500 and the 0.25 debited to 3740. */
function roundedDown(company: Company) {
  return issuedInvoice(company, 12500.25, [
    { accountNumber: '1510', debitAmount: 12500, creditAmount: 0 },
    { accountNumber: '3740', debitAmount: 0.25, creditAmount: 0 },
    { accountNumber: '3001', debitAmount: 0, creditAmount: 12500.25 },
  ])
}

/** 4 999.75 issued with 1510 at 5 000 and the 0.25 credited to 3740. */
function roundedUp(company: Company) {
  return issuedInvoice(company, 4999.75, [
    { accountNumber: '1510', debitAmount: 5000, creditAmount: 0 },
    { accountNumber: '3740', debitAmount: 0, creditAmount: 0.25 },
    { accountNumber: '3001', debitAmount: 0, creditAmount: 4999.75 },
  ])
}

/** 1 000.40 issued with 1510 at the total: the öre are the settlement's. */
function plain(company: Company) {
  return issuedInvoice(company, 1000.4, [
    { accountNumber: '1510', debitAmount: 1000.4, creditAmount: 0 },
    { accountNumber: '3001', debitAmount: 0, creditAmount: 1000.4 },
  ])
}

async function allocate(company: Company, txId: string, allocations: Allocation[]): Promise<RpcResult> {
  return withUserContext(company.userId, async (client) => {
    const { rows } = await client.query<{ result: RpcResult }>(
      'SELECT public.match_batch_allocate($1, $2::jsonb, $3) AS result',
      [txId, JSON.stringify(allocations), company.companyId],
    )
    const result = rows[0]!.result
    if (result.ok) await client.query('COMMIT')
    return result
  })
}

/** The staged preview, built as the dry run builds it: carriedSekOf on the real rows. */
async function preview(company: Company, txAmount: number, allocations: Allocation[]): Promise<string[]> {
  const client = await pool().connect()
  try {
    await client.query('BEGIN')
    const db = stagingSIEClient(client, '')
    const invoices: Record<string, Record<string, unknown>> = {}
    for (const allocation of allocations) {
      const { rows } = await client.query(
        `SELECT id, currency, exchange_rate::float8 AS exchange_rate, remaining_amount::float8 AS remaining_amount,
                total::float8 AS total, paid_amount::float8 AS paid_amount, journal_entry_id
           FROM public.invoices WHERE id = $1`,
        [allocation.invoice_id],
      )
      const invoice = rows[0]
      invoices[allocation.invoice_id] = { ...invoice, carried_sek: await carriedSekOf(db, company.companyId, 'customer', invoice) }
    }
    const built = buildBatchAllocationPreview({
      transaction: { amount: txAmount, date: '2026-06-05' },
      bankAccount: '1930',
      allocations,
      invoices,
    })
    expect(built.balanced).toBe(true)
    return built.lines.map((l) => `${l.account_number} D${l.debit} K${l.credit}`)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

async function linesOf(entryId: string): Promise<string[]> {
  const { rows } = await pool().query<{ account_number: string; debit: number; credit: number }>(
    `SELECT account_number, debit_amount::float8 AS debit, credit_amount::float8 AS credit
       FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY sort_order`,
    [entryId],
  )
  return rows.map((l) => `${l.account_number} D${l.debit} K${l.credit}`)
}

/** Debit less credit on `account` over the given verifikat. */
async function balance(entryIds: string[], account: string): Promise<number> {
  const { rows } = await pool().query<{ balance: string }>(
    `SELECT COALESCE(SUM(debit_amount - credit_amount), 0) AS balance
       FROM public.journal_entry_lines WHERE journal_entry_id = ANY($1::uuid[]) AND account_number = $2`,
    [entryIds, account],
  )
  return Number(rows[0]!.balance)
}

async function invoiceState(invoiceId: string) {
  const { rows } = await pool().query(
    `SELECT i.status, i.paid_amount::float8 AS paid, i.remaining_amount::float8 AS remaining,
            (SELECT array_agg(p.amount::float8 ORDER BY p.created_at) FROM public.invoice_payments p WHERE p.invoice_id = i.id) AS payments
       FROM public.invoices i WHERE i.id = $1`,
    [invoiceId],
  )
  return rows[0]
}

async function settle(company: Company, txAmount: number, allocations: Allocation[]) {
  const txId = await insertTransaction({ companyId: company.companyId, userId: company.userId, amount: txAmount, date: '2026-06-05' })
  const shown = await preview(company, txAmount, allocations)
  const result = await allocate(company, txId, allocations)
  expect(result).toMatchObject({ ok: true })
  const posted = await linesOf(result.journal_entry_id!)
  expect([...shown].sort()).toEqual([...posted].sort())
  return { entryId: result.journal_entry_id!, posted }
}

describe('match_batch_allocate on an invoice whose issue verifikat booked the öresavrundning (#119)', () => {
  it('rounded down, settled at the rounded amount: 1510 ends at 0 and 3740 keeps one rounding', async () => {
    const company = await seedCompany()
    const { invoiceId, issueId } = await roundedDown(company)

    const { entryId, posted } = await settle(company, 12500, [{ kind: 'customer_invoice', invoice_id: invoiceId, amount: 12500 }])

    expect(posted).toEqual(['1510 D0 K12500', '1930 D12500 K0'])
    expect(await balance([issueId, entryId], '1510')).toBe(0)
    expect(await balance([issueId, entryId], '3740')).toBe(0.25)
    expect(await invoiceState(invoiceId)).toEqual({ status: 'paid', paid: 12500.25, remaining: 0, payments: [12500.25] })
  })

  it('rounded up, settled at the rounded amount: 1510 ends at 0 and 3740 keeps one rounding', async () => {
    const company = await seedCompany()
    const { invoiceId, issueId } = await roundedUp(company)

    const { entryId, posted } = await settle(company, 5000, [{ kind: 'customer_invoice', invoice_id: invoiceId, amount: 5000 }])

    expect(posted).toEqual(['1510 D0 K5000', '1930 D5000 K0'])
    expect(await balance([issueId, entryId], '1510')).toBe(0)
    expect(await balance([issueId, entryId], '3740')).toBe(-0.25)
    expect(await invoiceState(invoiceId)).toMatchObject({ status: 'paid', paid: 4999.75, remaining: 0 })
  })

  it('settled at the exact total: 1510 gives up what it carries and 3740 takes the öre back', async () => {
    const company = await seedCompany()
    const { invoiceId, issueId } = await roundedDown(company)

    const { entryId, posted } = await settle(company, 12500.25, [{ kind: 'customer_invoice', invoice_id: invoiceId, amount: 12500.25 }])

    expect(posted).toEqual(['1510 D0 K12500', '3740 D0 K0.25', '1930 D12500.25 K0'])
    expect(await balance([issueId, entryId], '1510')).toBe(0)
    expect(await balance([issueId, entryId], '3740')).toBe(0)
    expect(await invoiceState(invoiceId)).toMatchObject({ status: 'paid', paid: 12500.25, remaining: 0 })
  })

  it('a part allocation clears its own kronor, and the settlement of the rest clears what 1510 still carries', async () => {
    const company = await seedCompany()
    const { invoiceId, issueId } = await roundedDown(company)

    const part = await settle(company, 5000, [{ kind: 'customer_invoice', invoice_id: invoiceId, amount: 5000 }])
    expect(part.posted).toEqual(['1510 D0 K5000', '1930 D5000 K0'])
    expect(await invoiceState(invoiceId)).toMatchObject({ status: 'partially_paid', paid: 5000, remaining: 7500.25 })

    const rest = await settle(company, 7500, [{ kind: 'customer_invoice', invoice_id: invoiceId, amount: 7500 }])
    expect(rest.posted).toEqual(['1510 D0 K7500', '1930 D7500 K0'])
    expect(await balance([issueId, part.entryId, rest.entryId], '1510')).toBe(0)
    expect(await balance([issueId, part.entryId, rest.entryId], '3740')).toBe(0.25)
    expect(await invoiceState(invoiceId)).toMatchObject({ status: 'paid', paid: 12500.25, remaining: 0 })
  })
})

describe('match_batch_allocate on an invoice whose 1510 carries the whole total: unchanged', () => {
  it('settled a few öre short: Cr 1510 the remainder, Dr 3740 the öre, 1510 ends at 0', async () => {
    const company = await seedCompany()
    const { invoiceId, issueId } = await plain(company)

    const { entryId, posted } = await settle(company, 1000, [{ kind: 'customer_invoice', invoice_id: invoiceId, amount: 1000 }])

    expect(posted).toEqual(['1510 D0 K1000.4', '3740 D0.4 K0', '1930 D1000 K0'])
    expect(await balance([issueId, entryId], '1510')).toBe(0)
    expect(await invoiceState(invoiceId)).toMatchObject({ status: 'paid', paid: 1000.4, remaining: 0 })
  })

  it('in one samlingsverifikat with an invoice that booked its öre: each clears what its 1510 carries', async () => {
    const company = await seedCompany()
    const booked = await roundedDown(company)
    const normal = await plain(company)
    const allocations: Allocation[] = [
      { kind: 'customer_invoice', invoice_id: booked.invoiceId, amount: 12500 },
      { kind: 'customer_invoice', invoice_id: normal.invoiceId, amount: 1000 },
    ]

    const { entryId, posted } = await settle(company, 13500, allocations)

    expect([...posted].sort()).toEqual(['1510 D0 K1000.4', '1510 D0 K12500', '1930 D13500 K0', '3740 D0.4 K0'])
    expect(await balance([booked.issueId, normal.issueId, entryId], '1510')).toBe(0)
    expect(await balance([booked.issueId, normal.issueId, entryId], '3740')).toBe(0.65)
    expect(await invoiceState(booked.invoiceId)).toMatchObject({ status: 'paid', remaining: 0 })
    expect(await invoiceState(normal.invoiceId)).toMatchObject({ status: 'paid', remaining: 0 })
  })
})
