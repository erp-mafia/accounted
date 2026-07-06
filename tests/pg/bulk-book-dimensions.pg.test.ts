import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260702201000_bulk_book_transactions_dimensions (dimensions PR7):
 *
 *   - p_new_entry lines may carry a dimensions bag {sie_dim_no: code}. The
 *     RPC stores it on journal_entry_lines.dimensions; cost_center/project
 *     derive from keys '1'/'6' (GENERATED columns since the PR9 cutover:
 *     the mirror assertions below now exercise the generation expression).
 *   - Bag normalization mirrors DimensionsBagSchema: non-canonical keys
 *     (leading zeros, non-numeric) and blank values are dropped; values are
 *     trimmed.
 *   - Lines without a bag store '{}' with NULL mirrors (column default
 *     semantics preserved).
 *   - A present-but-malformed bag (non-object) is rejected with
 *     BULK_BOOK_INVALID_DIMENSIONS before any insert.
 */

async function insertTransaction(params: {
  userId: string
  companyId: string
  amount: number
  date?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions
       (id, user_id, company_id, date, description, amount, currency, category)
     VALUES ($1, $2, $3, $4, 'Bank tx', $5, 'SEK', 'uncategorized')`,
    [id, params.userId, params.companyId, params.date ?? '2026-06-05', params.amount],
  )
  return id
}

async function seedTenant() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await insertFiscalPeriod({
    userId,
    companyId,
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
  })
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance, is_active)
     SELECT $1, $2, n, name, cls, atype, nbal, true
     FROM (VALUES
       ('1930', 'Bankkonto',            1, 'asset',   'debit'),
       ('2611', 'Utgående moms 25%',    2, 'liability', 'credit'),
       ('3001', 'Försäljning 25% moms', 3, 'revenue', 'credit')
     ) AS t(n, name, cls, atype, nbal)`,
    [userId, companyId],
  )
  return { userId, companyId }
}

interface RpcResult {
  ok: boolean
  code?: string
  journal_entry_id?: string
}

interface LineRow {
  account_number: string
  dimensions: Record<string, string>
  cost_center: string | null
  project: string | null
}

/**
 * Run the RPC and read back the created lines INSIDE the same
 * withUserContext transaction: the harness rolls the context back after
 * the callback, so any assertion data must be captured in here.
 */
async function callBulkBook(
  userId: string,
  companyId: string,
  txIds: string[],
  newEntry: unknown,
): Promise<{ result: RpcResult; lines: LineRow[]; linkCount: number }> {
  return withUserContext(userId, async (client) => {
    const r = await client.query<{ bulk_book_transactions: RpcResult }>(
      `SELECT bulk_book_transactions($1::uuid[], $2, $3::jsonb, $4)`,
      [txIds, null, JSON.stringify(newEntry), companyId],
    )
    const result = r.rows[0]!.bulk_book_transactions
    let lines: LineRow[] = []
    if (result.journal_entry_id) {
      const lr = await client.query<LineRow>(
        `SELECT account_number, dimensions, cost_center, project
           FROM public.journal_entry_lines
          WHERE journal_entry_id = $1 ORDER BY sort_order`,
        [result.journal_entry_id],
      )
      lines = lr.rows
    }
    const links = await client.query(
      `SELECT 1 FROM public.transaction_voucher_links WHERE transaction_id = ANY($1::uuid[])`,
      [txIds],
    )
    return { result, lines, linkCount: links.rowCount ?? 0 }
  })
}

describe('bulk_book_transactions: line dimensions (PR7)', () => {
  it('stores the bag and derives cost_center/project mirrors from keys 1/6', async () => {
    const { userId, companyId } = await seedTenant()
    const tx = await insertTransaction({ userId, companyId, amount: 500 })

    const { result, lines } = await callBulkBook(userId, companyId, [tx], {
      description: 'Samlingsverifikation med dimensioner',
      lines: [
        { account_number: '1930', debit_amount: 500, credit_amount: 0, currency: 'SEK' },
        {
          account_number: '3001', debit_amount: 0, credit_amount: 400, currency: 'SEK',
          dimensions: { '1': 'KS01', '6': 'P001' },
        },
        {
          account_number: '2611', debit_amount: 0, credit_amount: 100, currency: 'SEK',
          dimensions: { '6': 'P001' },
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(lines).toHaveLength(3)

    const bank = lines.find((l) => l.account_number === '1930')!
    const revenue = lines.find((l) => l.account_number === '3001')!
    const vat = lines.find((l) => l.account_number === '2611')!

    expect(bank.dimensions).toEqual({})
    expect(bank.cost_center).toBeNull()
    expect(bank.project).toBeNull()

    expect(revenue.dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
    expect(revenue.cost_center).toBe('KS01')
    expect(revenue.project).toBe('P001')

    expect(vat.dimensions).toEqual({ '6': 'P001' })
    expect(vat.cost_center).toBeNull()
    expect(vat.project).toBe('P001')
  })

  it('normalizes the bag: drops non-canonical keys and blank values, trims values', async () => {
    const { userId, companyId } = await seedTenant()
    const tx = await insertTransaction({ userId, companyId, amount: 250 })

    const { result, lines } = await callBulkBook(userId, companyId, [tx], {
      description: 'Normaliseringstest',
      lines: [
        { account_number: '1930', debit_amount: 250, credit_amount: 0, currency: 'SEK' },
        {
          account_number: '3001', debit_amount: 0, credit_amount: 250, currency: 'SEK',
          // '01' (leading zero), 'abc' (non-numeric) and blank values must be
          // dropped; ' KS02 ' must be stored trimmed.
          dimensions: { '01': 'GHOST', abc: 'X', '7': '   ', '1': ' KS02 ' },
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(lines).toHaveLength(2)

    const revenue = lines.find((l) => l.account_number === '3001')!
    expect(revenue.dimensions).toEqual({ '1': 'KS02' })
    expect(revenue.cost_center).toBe('KS02')
    expect(revenue.project).toBeNull()
  })

  it('rejects a present-but-malformed bag with BULK_BOOK_INVALID_DIMENSIONS', async () => {
    const { userId, companyId } = await seedTenant()
    const tx = await insertTransaction({ userId, companyId, amount: 100 })

    const { result, linkCount } = await callBulkBook(userId, companyId, [tx], {
      description: 'Trasig dimensionspayload',
      lines: [
        { account_number: '1930', debit_amount: 100, credit_amount: 0, currency: 'SEK' },
        {
          account_number: '3001', debit_amount: 0, credit_amount: 100, currency: 'SEK',
          dimensions: 'not-an-object',
        },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('BULK_BOOK_INVALID_DIMENSIONS')
    // Nothing booked: the tx must remain unlinked.
    expect(linkCount).toBe(0)
  })

  it('keeps dimension-less bookings byte-identical to before (default bag + NULL mirrors)', async () => {
    const { userId, companyId } = await seedTenant()
    const tx = await insertTransaction({ userId, companyId, amount: 300 })

    const { result, lines } = await callBulkBook(userId, companyId, [tx], {
      description: 'Utan dimensioner',
      lines: [
        { account_number: '1930', debit_amount: 300, credit_amount: 0, currency: 'SEK' },
        { account_number: '3001', debit_amount: 0, credit_amount: 300, currency: 'SEK' },
      ],
    })
    expect(result.ok).toBe(true)
    expect(lines).toHaveLength(2)

    for (const line of lines) {
      expect(line.dimensions).toEqual({})
      expect(line.cost_center).toBeNull()
      expect(line.project).toBeNull()
    }
  })
})
