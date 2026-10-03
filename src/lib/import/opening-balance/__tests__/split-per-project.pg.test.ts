import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getPool, withUserContext } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  insertPostedJournalEntry,
} from '@/tests/pg/fixtures'
import {
  previewOpeningBalanceSplit,
  splitOpeningBalancesPerProject,
  type OpeningBalanceSplitPreview,
} from '../split-per-project'
import type { Logger } from '@/lib/logger'

/**
 * Issue #3313, "Dela upp IB per projekt", against real Postgres with every
 * migration: the service reads the previous year's object balances through
 * compute_object_closing_balances and splits the IB verifikat through
 * correct_entry_lines_inline (migration 20260831150000), as the company's
 * member (RLS on, like the dashboard).
 *
 * The books: 2025 opened with an untagged IB (1470 1000). During 2025 P1
 * booked 300 on 1470 (also tagged with a kostnadsställe, which resets
 * annually and must not carry), P2 500, and 100 landed untagged. 2026's IB
 * was booked as one line per account (1470 1900). P2 was archived after the
 * year: a finished project still holding a balance.
 *
 *   1. open year: the split lands in the same verifikat (1470: P1 300, P2
 *      500, untagged 1100), totals unchanged, the period link unchanged, a
 *      rättelse log row; a second run is a no-op;
 *   2. locked year: the service refuses before writing, and the RPC itself
 *      refuses the same split lines.
 */

const log: Logger = { info: () => {}, warn: () => {}, error: () => {}, child: () => log }

/** The Supabase surface the service uses, over one pg connection (real SQL, real RPCs). */
function pgSupabase(client: PoolClient): SupabaseClient {
  const ident = (value: string) => {
    if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw new Error(`unsafe identifier ${value}`)
    return `"${value}"`
  }
  function from(table: string) {
    let columns = '*'
    let countOnly = false
    let single = false
    let offset = 0
    let limit: number | null = null
    const values: unknown[] = []
    const where: string[] = []
    const order: string[] = []
    const filter = (column: string, op: string, value: unknown) => {
      values.push(value)
      where.push(`${ident(column)} ${op} $${values.length}`)
      return builder
    }
    const builder = {
      select(value: string, options?: { count?: 'exact'; head?: boolean }) {
        countOnly = options?.count === 'exact' && options.head === true
        columns = value.split(',').map((c) => ident(c.trim())).join(', ')
        return builder
      },
      eq: (column: string, value: unknown) => filter(column, '=', value),
      lt: (column: string, value: unknown) => filter(column, '<', value),
      in(column: string, list: unknown[]) {
        values.push(list)
        where.push(`${ident(column)} = ANY($${values.length})`)
        return builder
      },
      order(column: string, options?: { ascending?: boolean }) {
        order.push(`${ident(column)} ${options?.ascending === false ? 'DESC' : 'ASC'}`)
        return builder
      },
      range(start: number, end: number) {
        offset = start
        limit = end - start + 1
        return builder
      },
      limit(value: number) {
        limit = value
        return builder
      },
      maybeSingle() {
        single = true
        return builder
      },
      async then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        try {
          const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
          if (countOnly) {
            const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.${ident(table)} ${clause}`, values)
            return resolve({ data: null, count: rows[0].n, error: null })
          }
          const { rows } = await client.query(
            `SELECT ${columns} FROM public.${ident(table)} ${clause} ${order.length ? `ORDER BY ${order.join(', ')}` : ''} OFFSET ${offset} ${limit === null ? '' : `LIMIT ${limit}`}`,
            values,
          )
          return resolve({ data: single ? (rows[0] ?? null) : rows, error: null })
        } catch (error) {
          return reject ? reject(error) : resolve({ data: null, error })
        }
      },
    }
    return builder
  }
  async function rpc(name: string, args: Record<string, unknown>) {
    const pairs = Object.entries(args)
    const params = pairs.map(([, value]) =>
      Array.isArray(value) && value.some((v) => v !== null && typeof v === 'object')
        ? JSON.stringify(value)
        : value !== null && typeof value === 'object' && !Array.isArray(value)
          ? JSON.stringify(value)
          : value,
    )
    await client.query('SAVEPOINT simulated_rpc')
    try {
      const { rows } = await client.query(
        `SELECT public.${ident(name)}(${pairs.map(([key], i) => `${ident(key)} => $${i + 1}`).join(', ')}) AS data`,
        params,
      )
      await client.query('RELEASE SAVEPOINT simulated_rpc')
      return { data: rows[0]?.data ?? null, error: null }
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT simulated_rpc')
      const err = error as { code?: string; message?: string }
      return { data: null, error: { code: err.code, message: err.message } }
    }
  }
  return { from, rpc } as unknown as SupabaseClient
}

async function insertAccount(companyId: string, userId: string, accountNumber: string, name: string) {
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
     VALUES ($1, $2, $3, $4, left($3, 1)::int, 'asset', 'debit')
     ON CONFLICT DO NOTHING`,
    [userId, companyId, accountNumber, name],
  )
}

async function insertValue(companyId: string, sieDimNo: number, code: string) {
  await getPool().query(
    `INSERT INTO public.dimension_values (company_id, dimension_id, code, name)
     SELECT $1, d.id, $3, 'Projekt ' || $3 FROM public.dimensions d WHERE d.company_id = $1 AND d.sie_dim_no = $2`,
    [companyId, sieDimNo, code],
  )
}

async function seedBooks() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await getPool().query('SELECT public.ensure_company_dimensions($1)', [companyId])
  await insertValue(companyId, 6, 'P1')
  await insertValue(companyId, 6, 'P2')
  await insertValue(companyId, 1, 'K1')
  for (const [number, name] of [['1470', 'Pågående arbeten'], ['1930', 'Företagskonto'], ['2081', 'Aktiekapital'], ['4010', 'Inköp']]) {
    await insertAccount(companyId, userId, number, name)
  }

  const fy2025 = await insertFiscalPeriod({ userId, companyId, periodStart: '2025-01-01', periodEnd: '2025-12-31', name: '2025' })
  const fy2026 = await insertFiscalPeriod({ userId, companyId, periodStart: '2026-01-01', periodEnd: '2026-12-31', name: '2026' })
  await getPool().query('UPDATE public.fiscal_periods SET previous_period_id = $1 WHERE id = $2', [fy2025, fy2026])

  const ib2025 = await insertPostedJournalEntry({
    userId, companyId, fiscalPeriodId: fy2025, entryDate: '2025-01-01', sourceType: 'opening_balance', voucherNumber: 1,
    lines: [
      { accountNumber: '1470', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '2081', debitAmount: 0, creditAmount: 1000 },
    ],
  })
  await getPool().query(
    'UPDATE public.fiscal_periods SET opening_balance_entry_id = $1, opening_balances_set = true WHERE id = $2',
    [ib2025, fy2025],
  )
  await insertPostedJournalEntry({
    userId, companyId, fiscalPeriodId: fy2025, entryDate: '2025-04-01', voucherNumber: 2,
    lines: [
      { accountNumber: '1470', debitAmount: 300, creditAmount: 0, dimensions: { '1': 'K1', '6': 'P1' } },
      { accountNumber: '4010', debitAmount: 0, creditAmount: 300, dimensions: { '1': 'K1', '6': 'P1' } },
    ],
  })
  await insertPostedJournalEntry({
    userId, companyId, fiscalPeriodId: fy2025, entryDate: '2025-05-01', voucherNumber: 3,
    lines: [
      { accountNumber: '1470', debitAmount: 500, creditAmount: 0, dimensions: { '6': 'P2' } },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 500 },
    ],
  })
  await insertPostedJournalEntry({
    userId, companyId, fiscalPeriodId: fy2025, entryDate: '2025-06-01', voucherNumber: 4,
    lines: [
      { accountNumber: '1470', debitAmount: 100, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 100 },
    ],
  })
  await getPool().query('UPDATE public.fiscal_periods SET is_closed = true, closed_at = now() WHERE id = $1', [fy2025])

  const ib2026 = await insertPostedJournalEntry({
    userId, companyId, fiscalPeriodId: fy2026, entryDate: '2026-01-01', sourceType: 'opening_balance', voucherNumber: 1,
    lines: [
      { accountNumber: '1470', debitAmount: 1900, creditAmount: 0, lineDescription: 'IB 1470' },
      { accountNumber: '2081', debitAmount: 0, creditAmount: 1900, lineDescription: 'IB 2081' },
    ],
  })
  await getPool().query(
    'UPDATE public.fiscal_periods SET opening_balance_entry_id = $1, opening_balances_set = true WHERE id = $2',
    [ib2026, fy2026],
  )
  // P2 finished after the year; it still holds its 1470 balance.
  await getPool().query(`UPDATE public.dimension_values SET is_active = false WHERE company_id = $1 AND code = 'P2'`, [companyId])

  return { userId, companyId, fy2025, fy2026, ib2026 }
}

type LineRow = { account_number: string; debit_amount: string; credit_amount: string; dimensions: Record<string, string> }

const netsOf = (rows: LineRow[], account: string) => {
  const out: Record<string, number> = {}
  for (const row of rows.filter((r) => r.account_number === account)) {
    const key = row.dimensions['6'] ?? (Object.keys(row.dimensions).length ? JSON.stringify(row.dimensions) : '')
    out[key] = Math.round(((out[key] ?? 0) + Number(row.debit_amount) - Number(row.credit_amount)) * 100) / 100
  }
  return out
}

describe('split IB per project (issue #3313)', () => {
  it('splits the IB verifikat in place in an open year, keeps totals, logs the rättelse, and is idempotent', async () => {
    const { userId, companyId, fy2025, fy2026, ib2026 } = await seedBooks()

    await withUserContext(userId, async (client) => {
      const ctx = { supabase: pgSupabase(client), companyId, userId, log }

      const preview = await previewOpeningBalanceSplit(ctx, { fiscal_period_id: fy2026 })
      expect(preview.ok).toBe(true)
      const data = (preview as { data: OpeningBalanceSplitPreview }).data
      expect(data).toMatchObject({
        journal_entry_id: ib2026,
        source_fiscal_period_id: fy2025,
        source_period_closed: true,
        accumulating_dimensions: ['6'],
        accounts_to_change: 1,
        can_apply: true,
        blocked: null,
        unresolved_dimensions: [],
      })
      expect(data.dimension_values.find((v) => v.code === 'P2')).toMatchObject({ is_active: false })

      const applied = await splitOpeningBalancesPerProject(ctx, {
        fiscal_period_id: fy2026,
        expected_fingerprint: data.fingerprint,
      })
      expect(applied).toMatchObject({ ok: true, data: { applied: true, accounts_changed: ['1470'], journal_entry_id: ib2026 } })

      const { rows } = await client.query<LineRow>(
        'SELECT account_number, debit_amount, credit_amount, dimensions FROM public.journal_entry_lines WHERE journal_entry_id = $1',
        [ib2026],
      )
      // The kostnadsställe tag resets annually: never carried. The archived P2 is.
      expect(netsOf(rows, '1470')).toEqual({ P1: 300, P2: 500, '': 1100 })
      expect(netsOf(rows, '2081')).toEqual({ '': -1900 })
      expect(rows.some((row) => '1' in row.dimensions)).toBe(false)

      // Same verifikat, still posted, still the year's IB.
      const { rows: period } = await client.query('SELECT opening_balance_entry_id FROM public.fiscal_periods WHERE id = $1', [fy2026])
      expect(period[0].opening_balance_entry_id).toBe(ib2026)
      const { rows: entry } = await client.query('SELECT status FROM public.journal_entries WHERE id = $1', [ib2026])
      expect(entry[0].status).toBe('posted')

      // The struck line survives in the immutable who/when log.
      const { rows: logRows } = await client.query(
        'SELECT actor, struck_lines, added_lines FROM public.journal_entry_rattelse_log WHERE journal_entry_id = $1',
        [ib2026],
      )
      expect(logRows).toHaveLength(1)
      expect(logRows[0].actor).toBe(userId)
      expect(logRows[0].struck_lines).toHaveLength(1)
      expect(logRows[0].added_lines).toHaveLength(3)

      // Running it again changes nothing.
      const again = await splitOpeningBalancesPerProject(ctx, { fiscal_period_id: fy2026 })
      expect(again).toMatchObject({ ok: true, data: { applied: false, accounts_changed: [] } })
      const { rows: logAfter } = await client.query(
        'SELECT count(*)::int AS n FROM public.journal_entry_rattelse_log WHERE journal_entry_id = $1',
        [ib2026],
      )
      expect(logAfter[0].n).toBe(1)
    })
  })

  it('is refused in a locked year: by the service before writing, and by the RPC itself', async () => {
    const { userId, companyId, fy2026, ib2026 } = await seedBooks()
    await getPool().query('UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1', [fy2026])

    await withUserContext(userId, async (client) => {
      const ctx = { supabase: pgSupabase(client), companyId, userId, log }

      const preview = await previewOpeningBalanceSplit(ctx, { fiscal_period_id: fy2026 })
      const data = (preview as { data: OpeningBalanceSplitPreview }).data
      expect(data.accounts_to_change).toBe(1)
      expect(data.can_apply).toBe(false)
      expect(data.blocked?.code).toBe('OB_SPLIT_PERIOD_LOCKED')

      const refused = await splitOpeningBalancesPerProject(ctx, { fiscal_period_id: fy2026 })
      expect(refused).toMatchObject({ ok: false, code: 'OB_SPLIT_PERIOD_LOCKED' })

      // The database is the last line: the same split lines through the RPC.
      const { rows: lines } = await client.query<{ id: string }>(
        `SELECT id FROM public.journal_entry_lines WHERE journal_entry_id = $1 AND account_number = '1470'`,
        [ib2026],
      )
      await expect(
        client.query('SELECT public.correct_entry_lines_inline($1, $2, $3::uuid[], $4::jsonb, $5)', [
          companyId,
          ib2026,
          lines.map((l) => l.id),
          JSON.stringify([
            { account_number: '1470', debit_amount: 300, credit_amount: 0, dimensions: { '6': 'P1' } },
            { account_number: '1470', debit_amount: 1600, credit_amount: 0, dimensions: {} },
          ]),
          userId,
        ]),
      ).rejects.toThrow(/stängd eller låst/)
    })

    const { rows } = await getPool().query<LineRow>(
      'SELECT account_number, debit_amount, credit_amount, dimensions FROM public.journal_entry_lines WHERE journal_entry_id = $1',
      [ib2026],
    )
    expect(netsOf(rows, '1470')).toEqual({ '': 1900 })
  })
})
