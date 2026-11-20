/**
 * pg-real tests for the dimension tagging of the SQL settlement writers:
 *   20260928201000_coerce_dimensions_bag
 *   20260928201100_match_batch_allocate_document_dimensions
 *   20260928201200_link_voucher_rpcs_document_dimensions
 *
 * The TypeScript payment path stamps the settled invoice's default_dimensions
 * on every leg of the payment verifikat, FX and öre lines included. These
 * RPCs book the same kind of verifikat inside the database and must follow
 * the same rule:
 *   - a line that belongs to one document carries that document's bag;
 *   - a line aggregating several documents (the batch's bank leg) carries a
 *     bag only when every document shares the identical bag;
 *   - an untagged document books exactly the lines it booked before, with {}.
 *
 * Every test runs in one transaction that rolls back: fixtures are seeded as
 * the superuser, match_batch_allocate is called as the member (it resolves
 * its actor from auth.uid()), the link RPCs as a trusted server caller.
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { coerceDimensionsBag } from '@/lib/bookkeeping/dimension-resolver'
import { getClient } from '@/tests/pg/setup'

type Bag = Record<string, string>

let seq = 0
function nextSeq(): number {
  return (Date.now() % 1_000_000) * 1000 + seq++
}

async function inRolledBackTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

async function seedTenant(client: PoolClient): Promise<{
  userId: string
  companyId: string
  fiscalPeriodId: string
}> {
  const userId = randomUUID()
  await client.query(
    `INSERT INTO auth.users (id, email, instance_id)
     VALUES ($1, $2, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [userId, `pg-real-${userId}@test.invalid`],
  )
  const companyId = randomUUID()
  await client.query(
    `INSERT INTO public.companies (id, name, entity_type, created_by)
     VALUES ($1, 'Dimension AB', 'aktiebolag', $2)`,
    [companyId, userId],
  )
  await client.query(
    `INSERT INTO public.company_members (company_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [companyId, userId],
  )
  const fiscalPeriodId = randomUUID()
  await client.query(
    `INSERT INTO public.fiscal_periods
       (id, user_id, company_id, name, period_start, period_end, is_closed)
     VALUES ($1, $2, $3, '2026', '2026-01-01', '2026-12-31', false)`,
    [fiscalPeriodId, userId, companyId],
  )
  return { userId, companyId, fiscalPeriodId }
}

async function seedCustomerInvoice(
  client: PoolClient,
  params: {
    userId: string
    companyId: string
    total: number
    dims?: Bag
    currency?: string
    exchangeRate?: number | null
    totalSek?: number | null
  },
): Promise<string> {
  const customerId = randomUUID()
  await client.query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type, country)
     VALUES ($1, $2, $3, 'Kund AB', 'swedish_business', 'SE')`,
    [customerId, params.userId, params.companyId],
  )
  const id = randomUUID()
  await client.query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        status, currency, exchange_rate, subtotal, vat_amount, total, total_sek,
        paid_amount, remaining_amount, vat_treatment, vat_rate, default_dimensions)
     VALUES ($1, $2, $3, $4, $5, '2026-04-01', '2026-05-01', 'sent', $6, $7,
             $8, 0, $8, $9, 0, $8, 'standard_25', 25, $10::jsonb)`,
    [
      id,
      params.userId,
      params.companyId,
      customerId,
      `F-${nextSeq()}`,
      params.currency ?? 'SEK',
      params.exchangeRate ?? null,
      params.total,
      params.totalSek ?? null,
      JSON.stringify(params.dims ?? {}),
    ],
  )
  return id
}

async function seedSupplierInvoice(
  client: PoolClient,
  params: {
    userId: string
    companyId: string
    total: number
    dims?: Bag
    currency?: string
    exchangeRate?: number | null
  },
): Promise<string> {
  const supplierId = randomUUID()
  await client.query(
    `INSERT INTO public.suppliers
       (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
     VALUES ($1, $2, $3, 'Leverantör AB', 'swedish_business', 'SE', 30, $4)`,
    [supplierId, params.userId, params.companyId, params.currency ?? 'SEK'],
  )
  const id = randomUUID()
  const arrival = nextSeq()
  await client.query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency, exchange_rate,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note, default_dimensions)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-04-01', '2026-05-01', '2026-04-01', 'approved',
             $7, $8, $9, 0, $9, 0, $9, 'standard_25', false, false, $10::jsonb)`,
    [
      id,
      params.userId,
      params.companyId,
      supplierId,
      arrival,
      `LF-${arrival}`,
      params.currency ?? 'SEK',
      params.exchangeRate ?? null,
      params.total,
      JSON.stringify(params.dims ?? {}),
    ],
  )
  return id
}

async function seedTransaction(
  client: PoolClient,
  params: { userId: string; companyId: string; amount: number },
): Promise<string> {
  const id = randomUUID()
  await client.query(
    `INSERT INTO public.transactions
       (id, user_id, company_id, date, description, amount, currency, category)
     VALUES ($1, $2, $3, '2026-05-05', 'Bank', $4, 'SEK', 'uncategorized')`,
    [id, params.userId, params.companyId, params.amount],
  )
  return id
}

/** A posted two-line payment voucher in plain SEK, as a bank import books it. */
async function seedSekVoucher(
  client: PoolClient,
  params: {
    userId: string
    companyId: string
    fiscalPeriodId: string
    debitAccount: string
    creditAccount: string
    amount: number
  },
): Promise<string> {
  const id = randomUUID()
  await client.query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, 0, 'A', '2026-05-05', 'Betalning', 'manual', 'draft')`,
    [id, params.userId, params.companyId, params.fiscalPeriodId],
  )
  await client.query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
     VALUES ($1, $2, $4, 0, 'SEK', 0), ($1, $3, 0, $4, 'SEK', 1)`,
    [id, params.debitAccount, params.creditAccount, params.amount],
  )
  await client.query('SELECT * FROM public.commit_journal_entry($1, $2)', [params.companyId, id])
  return id
}

interface BatchResult {
  ok: boolean
  code?: string
  journal_entry_id?: string
}

/** match_batch_allocate resolves its actor from auth.uid(): call it as the member. */
async function allocateAsMember(
  client: PoolClient,
  params: { userId: string; companyId: string; txId: string; allocations: unknown[] },
): Promise<BatchResult> {
  await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: params.userId, role: 'authenticated' }),
  ])
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [params.userId])
  await client.query('SET LOCAL ROLE authenticated')
  try {
    const { rows } = await client.query<{ result: BatchResult }>(
      `SELECT public.match_batch_allocate($1, $2::jsonb, $3) AS result`,
      [params.txId, JSON.stringify(params.allocations), params.companyId],
    )
    return rows[0].result
  } finally {
    await client.query('RESET ROLE')
  }
}

interface LineRow {
  account_number: string
  debit: number
  credit: number
  dimensions: Bag
  project: string | null
  cost_center: string | null
}

async function linesOf(client: PoolClient, journalEntryId: string): Promise<LineRow[]> {
  const { rows } = await client.query<{
    account_number: string
    debit_amount: string
    credit_amount: string
    dimensions: Bag
    project: string | null
    cost_center: string | null
  }>(
    `SELECT account_number, debit_amount, credit_amount, dimensions, project, cost_center
     FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY sort_order`,
    [journalEntryId],
  )
  return rows.map((r) => ({
    account_number: r.account_number,
    debit: Number(r.debit_amount),
    credit: Number(r.credit_amount),
    dimensions: r.dimensions,
    project: r.project,
    cost_center: r.cost_center,
  }))
}

function expectBalanced(lines: LineRow[]): void {
  const debit = Math.round(lines.reduce((s, l) => s + l.debit, 0) * 100) / 100
  const credit = Math.round(lines.reduce((s, l) => s + l.credit, 0) * 100) / 100
  expect(debit).toBe(credit)
  expect(debit).toBeGreaterThan(0)
}

const P1: Bag = { '6': 'P1', '1': 'KS1' }
const P2: Bag = { '6': 'P2' }

describe('coerce_dimensions_bag: the SQL twin of coerceDimensionsBag', () => {
  it.each([
    [{ '6': 'P1', '1': 'KS01' }],
    [{}],
    [{ '6': ' P1 ', '1': '   ' }],
    [{ '06': 'P1' }],
    [{ abc: 'P1', '6': 'P2' }],
    [{ '6': '' }],
    [{ '6': 7 }],
    [{ '6': 'has"quote' }],
    [{ '6': 'a'.repeat(40) }],
    [{ '6': 'a'.repeat(41) }],
    [{ '20': 'X' }],
    [['6', 'P1']],
    [null],
  ])('agrees with the TypeScript function on %j', async (bag) => {
    const client = await getClient()
    try {
      const { rows } = await client.query<{ bag: Bag }>(
        'SELECT public.coerce_dimensions_bag($1::jsonb) AS bag',
        [bag === null ? null : JSON.stringify(bag)],
      )
      expect(rows[0].bag).toEqual(coerceDimensionsBag(bag) ?? {})
    } finally {
      client.release()
    }
  })
})

describe('match_batch_allocate: settlement lines carry the settled document dimensions', () => {
  it('tags the 1510, 3740 and bank legs of a tagged customer invoice paid a whole krona short', async () => {
    await inRolledBackTransaction(async (client) => {
      const { userId, companyId } = await seedTenant(client)
      const invoiceId = await seedCustomerInvoice(client, { userId, companyId, total: 1000.4, dims: P1 })
      const txId = await seedTransaction(client, { userId, companyId, amount: 1000 })

      const result = await allocateAsMember(client, {
        userId, companyId, txId,
        allocations: [{ kind: 'customer_invoice', invoice_id: invoiceId, amount: 1000 }],
      })
      expect(result).toMatchObject({ ok: true })

      const lines = await linesOf(client, result.journal_entry_id!)
      expectBalanced(lines)
      expect(lines.map((l) => [l.account_number, l.debit, l.credit])).toEqual([
        ['1510', 0, 1000.4],
        ['3740', 0.4, 0],
        ['1930', 1000, 0],
      ])
      for (const line of lines) {
        expect(line.dimensions).toEqual(P1)
        expect(line.project).toBe('P1')
        expect(line.cost_center).toBe('KS1')
      }
    })
  })

  it('tags the kursvinst of a tagged foreign supplier invoice, so it stays in the project result', async () => {
    await inRolledBackTransaction(async (client) => {
      const { userId, companyId } = await seedTenant(client)
      // 100 EUR booked at 11.00 = 1 100 kr on 2440; the bank paid 1 080 kr.
      const siId = await seedSupplierInvoice(client, {
        userId, companyId, total: 100, currency: 'EUR', exchangeRate: 11, dims: P2,
      })
      const txId = await seedTransaction(client, { userId, companyId, amount: -1080 })

      const result = await allocateAsMember(client, {
        userId, companyId, txId,
        allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: siId, amount: 1080 }],
      })
      expect(result).toMatchObject({ ok: true })

      const lines = await linesOf(client, result.journal_entry_id!)
      expectBalanced(lines)
      expect(lines.map((l) => [l.account_number, l.debit, l.credit, l.dimensions])).toEqual([
        ['2440', 1100, 0, P2],
        ['3960', 0, 20, P2],
        ['1930', 0, 1080, P2],
      ])
      expect(lines.find((l) => l.account_number === '3960')!.project).toBe('P2')
    })
  })

  it('tags each document line with its own bag and leaves the shared bank leg untagged when the bags differ', async () => {
    await inRolledBackTransaction(async (client) => {
      const { userId, companyId } = await seedTenant(client)
      const si1 = await seedSupplierInvoice(client, { userId, companyId, total: 2000, dims: P1 })
      const si2 = await seedSupplierInvoice(client, { userId, companyId, total: 3000.3, dims: P2 })
      const txId = await seedTransaction(client, { userId, companyId, amount: -5000 })

      const result = await allocateAsMember(client, {
        userId, companyId, txId,
        allocations: [
          { kind: 'supplier_invoice', supplier_invoice_id: si1, amount: 2000 },
          { kind: 'supplier_invoice', supplier_invoice_id: si2, amount: 3000 },
        ],
      })
      expect(result).toMatchObject({ ok: true })

      const lines = await linesOf(client, result.journal_entry_id!)
      expectBalanced(lines)
      const bank = lines.filter((l) => l.account_number === '1930')
      expect(bank).toHaveLength(1)
      expect(bank[0].credit).toBe(5000)
      expect(bank[0].dimensions).toEqual({})
      expect(bank[0].project).toBeNull()

      // si2's öre residual (3740) is a P&L line of that one document: it
      // carries P2, never P1 and never the bank leg's empty bag.
      const byBag = (bag: Bag) =>
        lines
          .filter((l) => JSON.stringify(l.dimensions) === JSON.stringify(bag))
          .map((l) => [l.account_number, l.debit, l.credit])
      const perDocument = lines.filter((l) => l.account_number !== '1930')
      expect(perDocument).toHaveLength(3)
      expect(byBag(P1)).toEqual([['2440', 2000, 0]])
      expect(
        perDocument
          .filter((l) => l.project === 'P2')
          .map((l) => [l.account_number, l.debit, l.credit]),
      ).toEqual([
        ['2440', 3000.3, 0],
        ['3740', 0, 0.3],
      ])
    })
  })

  it('tags the bank leg when every settled document shares the identical bag', async () => {
    await inRolledBackTransaction(async (client) => {
      const { userId, companyId } = await seedTenant(client)
      const i1 = await seedCustomerInvoice(client, { userId, companyId, total: 400, dims: P1 })
      // Same bag, stored with its keys the other way round and a padded value:
      // equality is on the normalized bag, not the stored text.
      const i2 = await seedCustomerInvoice(client, {
        userId, companyId, total: 600, dims: { '1': 'KS1', '6': ' P1 ' },
      })
      const txId = await seedTransaction(client, { userId, companyId, amount: 1000 })

      const result = await allocateAsMember(client, {
        userId, companyId, txId,
        allocations: [
          { kind: 'customer_invoice', invoice_id: i1, amount: 400 },
          { kind: 'customer_invoice', invoice_id: i2, amount: 600 },
        ],
      })
      expect(result).toMatchObject({ ok: true })

      const lines = await linesOf(client, result.journal_entry_id!)
      expectBalanced(lines)
      expect(lines).toHaveLength(3)
      for (const line of lines) expect(line.dimensions).toEqual(P1)
    })
  })

  it('leaves the bank leg untagged when a tagged and an untagged document share it', async () => {
    await inRolledBackTransaction(async (client) => {
      const { userId, companyId } = await seedTenant(client)
      const tagged = await seedSupplierInvoice(client, { userId, companyId, total: 100, dims: P1 })
      const untagged = await seedSupplierInvoice(client, { userId, companyId, total: 200 })
      const txId = await seedTransaction(client, { userId, companyId, amount: -300 })

      const result = await allocateAsMember(client, {
        userId, companyId, txId,
        allocations: [
          { kind: 'supplier_invoice', supplier_invoice_id: tagged, amount: 100 },
          { kind: 'supplier_invoice', supplier_invoice_id: untagged, amount: 200 },
        ],
      })
      expect(result).toMatchObject({ ok: true })

      const lines = await linesOf(client, result.journal_entry_id!)
      expectBalanced(lines)
      expect(lines.map((l) => [l.account_number, l.debit, l.credit, l.dimensions])).toEqual(
        expect.arrayContaining([
          ['2440', 100, 0, P1],
          ['2440', 200, 0, {}],
          ['1930', 0, 300, {}],
        ]),
      )
      expect(lines).toHaveLength(3)
    })
  })

  it('books an untagged document exactly as before: same lines, empty bags', async () => {
    await inRolledBackTransaction(async (client) => {
      const { userId, companyId } = await seedTenant(client)
      const siId = await seedSupplierInvoice(client, {
        userId, companyId, total: 100, currency: 'EUR', exchangeRate: 11,
      })
      const txId = await seedTransaction(client, { userId, companyId, amount: -1120 })

      const result = await allocateAsMember(client, {
        userId, companyId, txId,
        allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: siId, amount: 1120 }],
      })
      expect(result).toMatchObject({ ok: true })

      const lines = await linesOf(client, result.journal_entry_id!)
      expect(lines).toEqual([
        { account_number: '2440', debit: 1100, credit: 0, dimensions: {}, project: null, cost_center: null },
        { account_number: '7960', debit: 20, credit: 0, dimensions: {}, project: null, cost_center: null },
        { account_number: '1930', debit: 0, credit: 1120, dimensions: {}, project: null, cost_center: null },
      ])
    })
  })

  it('books a document whose stored bag is invalid untagged, as the TypeScript path does', async () => {
    await inRolledBackTransaction(async (client) => {
      const { userId, companyId } = await seedTenant(client)
      const invoiceId = await seedCustomerInvoice(client, {
        userId, companyId, total: 500, dims: { '6': 'P1', projekt: 'X' },
      })
      const txId = await seedTransaction(client, { userId, companyId, amount: 500 })

      const result = await allocateAsMember(client, {
        userId, companyId, txId,
        allocations: [{ kind: 'customer_invoice', invoice_id: invoiceId, amount: 500 }],
      })
      expect(result).toMatchObject({ ok: true })
      const lines = await linesOf(client, result.journal_entry_id!)
      expect(lines.map((l) => l.dimensions)).toEqual([{}, {}])
    })
  })
})

type LinkResult = {
  ok: boolean
  code?: string
  fx_journal_entry_id?: string | null
  fx_residual_sek?: number | null
}

async function linkInvoice(
  client: PoolClient,
  args: { invoiceId: string; voucherId: string; userId: string; companyId: string },
): Promise<LinkResult> {
  const { rows } = await client.query<{ result: LinkResult }>(
    'SELECT public.link_invoice_to_voucher($1, $2, $3, $4, NULL) AS result',
    [args.invoiceId, args.voucherId, args.userId, args.companyId],
  )
  return rows[0].result
}

async function linkSupplierInvoice(
  client: PoolClient,
  args: { supplierInvoiceId: string; voucherId: string; userId: string; companyId: string },
): Promise<LinkResult> {
  const { rows } = await client.query<{ result: LinkResult }>(
    'SELECT public.link_supplier_invoice_to_voucher($1, $2, $3, $4, NULL) AS result',
    [args.supplierInvoiceId, args.voucherId, args.userId, args.companyId],
  )
  return rows[0].result
}

describe('link_invoice_to_voucher: the FX residual verifikat carries the invoice dimensions', () => {
  it.each([
    ['a tagged invoice (loss)', P1, 11200, [['7960', 300, 0], ['1510', 0, 300]]],
    ['a tagged invoice (gain)', P2, 11800, [['1510', 300, 0], ['3960', 0, 300]]],
    ['an untagged invoice, exactly as before', {}, 11200, [['7960', 300, 0], ['1510', 0, 300]]],
  ] as const)('%s', async (_label, dims, bankSek, expected) => {
    await inRolledBackTransaction(async (client) => {
      const { userId, companyId, fiscalPeriodId } = await seedTenant(client)
      // 1 000 EUR booked at 11.50 = 11 500 kr on 1510.
      const invoiceId = await seedCustomerInvoice(client, {
        userId, companyId, total: 1000, currency: 'EUR', exchangeRate: 11.5, totalSek: 11500,
        dims: { ...dims },
      })
      const voucherId = await seedSekVoucher(client, {
        userId, companyId, fiscalPeriodId, debitAccount: '1930', creditAccount: '1510', amount: bankSek,
      })

      const result = await linkInvoice(client, { invoiceId, voucherId, userId, companyId })
      expect(result).toMatchObject({ ok: true })
      expect(result.fx_journal_entry_id).toBeTruthy()

      const lines = await linesOf(client, result.fx_journal_entry_id!)
      expectBalanced(lines)
      expect(lines.map((l) => [l.account_number, l.debit, l.credit])).toEqual(expected)
      for (const line of lines) {
        expect(line.dimensions).toEqual(dims)
        expect(line.project).toBe(dims['6' as keyof typeof dims] ?? null)
      }
      // The linked voucher is posted and immutable: its lines stay as booked.
      const voucherLines = await linesOf(client, voucherId)
      for (const line of voucherLines) expect(line.dimensions).toEqual({})
    })
  })
})

describe('link_supplier_invoice_to_voucher: the FX residual verifikat carries the invoice dimensions', () => {
  it.each([
    ['a tagged invoice (gain)', P1, 1080, [['2440', 20, 0], ['3960', 0, 20]]],
    ['a tagged invoice (loss)', P2, 1120, [['7960', 20, 0], ['2440', 0, 20]]],
    ['an untagged invoice, exactly as before', {}, 1080, [['2440', 20, 0], ['3960', 0, 20]]],
  ] as const)('%s', async (_label, dims, bankSek, expected) => {
    await inRolledBackTransaction(async (client) => {
      const { userId, companyId, fiscalPeriodId } = await seedTenant(client)
      // 100 EUR booked at 11.00 = 1 100 kr on 2440.
      const supplierInvoiceId = await seedSupplierInvoice(client, {
        userId, companyId, total: 100, currency: 'EUR', exchangeRate: 11, dims: { ...dims },
      })
      const voucherId = await seedSekVoucher(client, {
        userId, companyId, fiscalPeriodId, debitAccount: '2440', creditAccount: '1930', amount: bankSek,
      })

      const result = await linkSupplierInvoice(client, { supplierInvoiceId, voucherId, userId, companyId })
      expect(result).toMatchObject({ ok: true })
      expect(result.fx_journal_entry_id).toBeTruthy()

      const lines = await linesOf(client, result.fx_journal_entry_id!)
      expectBalanced(lines)
      expect(lines.map((l) => [l.account_number, l.debit, l.credit])).toEqual(expected)
      for (const line of lines) expect(line.dimensions).toEqual(dims)
    })
  })
})
