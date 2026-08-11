import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

// Covers the total_amount(journal_entries) computed column (migration
// 20260811100000): the verifikat list's amount sort orders by it through
// PostgREST, so the function must return the debit-side sum (= credit side on
// every balanced entry) and 0 for an entry with no lines yet.
describe('total_amount computed column', () => {
  // Header and balanced lines in ONE transaction: check_balance_on_posted_insert
  // is deferred to commit, so a posted header committed alone is rejected.
  async function insertEntry(p: {
    userId: string
    companyId: string
    fiscalPeriodId: string
    voucherNumber: number
    description: string
    lines: Array<{ account: string; debit: number; credit: number }>
    status?: 'draft' | 'posted'
  }): Promise<string> {
    const id = randomUUID()
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO public.journal_entries
           (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
            entry_date, description, source_type, status)
         VALUES ($1,$2,$3,$4,$5,'A','2026-06-01',$6,'manual',$7)`,
        [
          id,
          p.userId,
          p.companyId,
          p.fiscalPeriodId,
          p.voucherNumber,
          p.description,
          p.status ?? 'posted',
        ],
      )
      for (const line of p.lines) {
        await client.query(
          `INSERT INTO public.journal_entry_lines
             (journal_entry_id, account_number, debit_amount, credit_amount)
           VALUES ($1, $2, $3, $4)`,
          [id, line.account, line.debit, line.credit],
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
    return id
  }

  it('returns the debit-side sum, including öre amounts and multi-line entries', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    const single = await insertEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 1, description: 'Single line pair',
      lines: [
        { account: '1930', debit: 250.5, credit: 0 },
        { account: '3001', debit: 0, credit: 250.5 },
      ],
    })
    // Multi-line: total = sum of the debit side (100 + 200), not the line count.
    const multi = await insertEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 2, description: 'Multi line',
      lines: [
        { account: '1930', debit: 100, credit: 0 },
        { account: '5410', debit: 200, credit: 0 },
        { account: '2440', debit: 0, credit: 300 },
      ],
    })

    const { rows } = await getPool().query<{ id: string; total: string }>(
      `SELECT je.id, public.total_amount(je.*)::text AS total
         FROM public.journal_entries je
        WHERE je.id = ANY($1::uuid[])`,
      [[single, multi]],
    )
    const byId = new Map(rows.map((r) => [r.id, Number(r.total)]))
    expect(byId.get(single)).toBe(250.5)
    expect(byId.get(multi)).toBe(300)
  })

  it('returns 0 for an entry without lines and orders a query correctly', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    const mid = await insertEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 1, description: 'Mid',
      lines: [
        { account: '1930', debit: 200, credit: 0 },
        { account: '3001', debit: 0, credit: 200 },
      ],
    })
    const big = await insertEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 2, description: 'Big',
      lines: [
        { account: '1930', debit: 900, credit: 0 },
        { account: '3001', debit: 0, credit: 900 },
      ],
    })
    // A draft with no lines yet must sort as 0, not error or drop out.
    const empty = await insertEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 0, description: 'Empty draft',
      status: 'draft', lines: [],
    })

    const { rows } = await getPool().query<{ id: string }>(
      `SELECT je.id
         FROM public.journal_entries je
        WHERE je.company_id = $1
        ORDER BY public.total_amount(je.*) DESC, je.voucher_number ASC`,
      [companyId],
    )
    expect(rows.map((r) => r.id)).toEqual([big, mid, empty])
  })
})
