import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getClient, getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'
import type { CreateJournalEntryInput } from '@/types'
import type { ParsedSIEFile } from '../types'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
  replaceOpeningBalanceEntry: vi.fn(),
}))

import { replaceOpeningBalanceEntry } from '@/lib/bookkeeping/engine'
import {
  companyHasPriorActivity,
  resyncNextPeriodOpeningBalance,
} from '../sie-import'

type EntryLine = {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description?: string | null
}

async function insertPostedEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  entryDate: string
  sourceType: 'opening_balance' | 'import' | 'storno'
  description: string
  lines: EntryLine[]
  reversesId?: string | null
}): Promise<string> {
  const id = randomUUID()
  const voucher = await getPool().query<{ next_number: number }>(
    `SELECT COALESCE(MAX(voucher_number), 0) + 1 AS next_number
       FROM public.journal_entries
      WHERE company_id = $1
        AND fiscal_period_id = $2
        AND voucher_series = 'A'`,
    [params.companyId, params.fiscalPeriodId],
  )

  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number,
        voucher_series, entry_date, description, source_type, status, reverses_id)
     VALUES ($1, $2, $3, $4, $5, 'A', $6, $7, $8, 'posted', $9)`,
    [
      id,
      params.userId,
      params.companyId,
      params.fiscalPeriodId,
      voucher.rows[0]!.next_number,
      params.entryDate,
      params.description,
      params.sourceType,
      params.reversesId ?? null,
    ],
  )

  await getPool().query(
    `INSERT INTO public.voucher_sequences
       (company_id, user_id, fiscal_period_id, voucher_series, last_number)
     VALUES ($1, $2, $3, 'A', $4)
     ON CONFLICT (company_id, fiscal_period_id, voucher_series)
     DO UPDATE SET last_number = GREATEST(
       public.voucher_sequences.last_number,
       EXCLUDED.last_number
     )`,
    [
      params.companyId,
      params.userId,
      params.fiscalPeriodId,
      voucher.rows[0]!.next_number,
    ],
  )

  for (const line of params.lines) {
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, line_description)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        id,
        line.account_number,
        line.debit_amount,
        line.credit_amount,
        line.line_description ?? null,
      ],
    )
  }

  return id
}

async function runAsAuthenticated<T>(
  userId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query('SET LOCAL ROLE authenticated')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function makePgSupabase(_userId: string): SupabaseClient {
  const from = (table: string) => {
    if (table === 'journal_entries') {
      const filters: {
        companyId?: string
        status?: string
        excludedSourceTypes: string[]
        throughDate?: string
      } = { excludedSourceTypes: [] }

      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          if (column === 'company_id') filters.companyId = String(value)
          if (column === 'status') filters.status = String(value)
          return chain
        },
        neq: (column: string, value: unknown) => {
          if (column === 'source_type') filters.excludedSourceTypes.push(String(value))
          return chain
        },
        lte: (column: string, value: unknown) => {
          if (column === 'entry_date') filters.throughDate = String(value)
          return chain
        },
        then: (
          resolve: (value: { data: null; error: null; count: number }) => void,
          reject: (reason: unknown) => void,
        ) => {
          getPool()
            .query<{ count: string }>(
              `SELECT count(*)::text AS count
                 FROM public.journal_entries
                WHERE company_id = $1
                  AND status = $2
                  AND source_type <> ALL($3::text[])
                  AND entry_date <= $4::date`,
              [
                filters.companyId,
                filters.status,
                filters.excludedSourceTypes,
                filters.throughDate,
              ],
            )
            .then((result) => resolve({
              data: null,
              error: null,
              count: Number(result.rows[0]!.count),
            }))
            .catch(reject)
        },
      }
      return chain
    }

    if (table === 'fiscal_periods') {
      const filters: { companyId?: string; afterDate?: string } = {}
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          if (column === 'company_id') filters.companyId = String(value)
          return chain
        },
        gt: (column: string, value: unknown) => {
          if (column === 'period_start') filters.afterDate = String(value)
          return chain
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => {
          const result = await getPool().query(
            `SELECT id, name, period_start, period_end, is_closed, locked_at,
                    opening_balance_entry_id, opening_balances_set
               FROM public.fiscal_periods
              WHERE company_id = $1
                AND period_start > $2::date
              ORDER BY period_start ASC
              LIMIT 1`,
            [filters.companyId, filters.afterDate],
          )
          return { data: result.rows[0] ?? null, error: null }
        },
      }
      return chain
    }

    throw new Error(`Unexpected table in pg adapter: ${table}`)
  }

  return { from } as unknown as SupabaseClient
}

function closingBalances(): ParsedSIEFile {
  return {
    closingBalances: [
      { yearIndex: 0, account: '1930', amount: 150 },
      { yearIndex: 0, account: '2010', amount: -150 },
    ],
  } as ParsedSIEFile
}

async function insertPriorPeriod(companyId: string): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO public.fiscal_periods
       (company_id, name, period_start, period_end, is_closed, opening_balances_set)
     VALUES ($1, 'Räkenskapsår 2025', '2025-01-01', '2025-12-31', false, false)
     RETURNING id`,
    [companyId],
  )
  return result.rows[0]!.id
}

const oldIBLines: EntryLine[] = [
  { account_number: '1930', debit_amount: 100, credit_amount: 0 },
  { account_number: '2010', debit_amount: 0, credit_amount: 100 },
]

describe('out-of-order SIE opening balances', () => {
  beforeEach(() => {
    vi.mocked(replaceOpeningBalanceEntry).mockReset()
  })

  it('keeps the 2025 IB and replaces the imported-first 2026 IB without duplication', async () => {
    const { userId, companyId, fiscalPeriodId: period2026Id } = await seedCompany()
    const old2026IBId = await insertPostedEntry({
      userId,
      companyId,
      fiscalPeriodId: period2026Id,
      entryDate: '2026-01-01',
      sourceType: 'opening_balance',
      description: 'Old 2026 IB',
      lines: oldIBLines,
    })
    await insertPostedEntry({
      userId,
      companyId,
      fiscalPeriodId: period2026Id,
      entryDate: '2026-06-01',
      sourceType: 'import',
      description: 'Imported 2026 activity',
      lines: [
        { account_number: '1930', debit_amount: 25, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 25 },
      ],
    })
    await getPool().query(
      `UPDATE public.fiscal_periods
          SET opening_balance_entry_id = $1, opening_balances_set = true
        WHERE id = $2`,
      [old2026IBId, period2026Id],
    )

    const supabase = makePgSupabase(userId)
    expect(await companyHasPriorActivity(supabase, companyId, '2025-12-31')).toBe(false)
    // Inclusive end-date filtering preserves the same-period continuation guard.
    expect(await companyHasPriorActivity(supabase, companyId, '2026-12-31')).toBe(true)

    const period2025Id = await insertPriorPeriod(companyId)
    await getPool().query(
      `UPDATE public.fiscal_periods SET previous_period_id = $1 WHERE id = $2`,
      [period2025Id, period2026Id],
    )
    const ib2025Id = await insertPostedEntry({
      userId,
      companyId,
      fiscalPeriodId: period2025Id,
      entryDate: '2025-01-01',
      sourceType: 'opening_balance',
      description: 'Imported 2025 IB',
      lines: oldIBLines,
    })
    await getPool().query(
      `UPDATE public.fiscal_periods
          SET opening_balance_entry_id = $1, opening_balances_set = true
        WHERE id = $2`,
      [ib2025Id, period2025Id],
    )

    vi.mocked(replaceOpeningBalanceEntry).mockImplementation(async (
      _client: SupabaseClient,
      targetCompanyId: string,
      targetUserId: string,
      expectedOldEntryId: string,
      input: CreateJournalEntryInput,
    ) => {
      const accounts = await getPool().query<{ id: string; account_number: string }>(
        `SELECT id, account_number
           FROM public.chart_of_accounts
          WHERE company_id = $1
            AND account_number = ANY($2::text[])`,
        [targetCompanyId, input.lines.map((line) => line.account_number)],
      )
      const accountIds = new Map(accounts.rows.map((account) => [account.account_number, account.id]))
      const lines = input.lines.map((line, sortOrder) => ({
        account_number: line.account_number,
        account_id: accountIds.get(line.account_number),
        debit_amount: line.debit_amount,
        credit_amount: line.credit_amount,
        currency: line.currency ?? 'SEK',
        amount_in_currency: line.amount_in_currency ?? null,
        exchange_rate: line.exchange_rate ?? null,
        line_description: line.line_description ?? null,
        tax_code: line.tax_code ?? null,
        dimensions: line.dimensions ?? {},
        sort_order: sortOrder,
      }))

      const outcome = await runAsAuthenticated(targetUserId, async (client) => {
        const result = await client.query<{
          new_entry_id: string
          storno_entry_id: string
          new_voucher_number: number
          storno_voucher_number: number
        }>(
          `SELECT * FROM public.commit_opening_balance_replacement(
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date,
             $6::text, $7::text, $8::jsonb, NULL, NULL
           )`,
          [
            targetCompanyId,
            input.fiscal_period_id,
            expectedOldEntryId,
            targetUserId,
            input.entry_date,
            input.description,
            input.voucher_series ?? 'A',
            JSON.stringify(lines),
          ],
        )
        return result.rows[0]!
      })

      return {
        newEntryId: outcome.new_entry_id,
        stornoEntryId: outcome.storno_entry_id,
        newVoucherNumber: outcome.new_voucher_number,
        stornoVoucherNumber: outcome.storno_voucher_number,
      }
    })

    const resync = await resyncNextPeriodOpeningBalance(
      supabase,
      companyId,
      userId,
      '2025-12-31',
      closingBalances(),
      new Map([['1930', '1930'], ['2010', '2010']]),
    )

    expect(resync.resynced).toBe(true)
    if (!resync.resynced) throw new Error(`Unexpected resync failure: ${resync.reason}`)

    const periods = await getPool().query<{
      id: string
      previous_period_id: string | null
      opening_balance_entry_id: string | null
    }>(
      `SELECT id, previous_period_id, opening_balance_entry_id
         FROM public.fiscal_periods
        WHERE id = ANY($1::uuid[])
        ORDER BY period_start`,
      [[period2025Id, period2026Id]],
    )
    expect(periods.rows[0]).toMatchObject({
      id: period2025Id,
      opening_balance_entry_id: ib2025Id,
    })
    expect(periods.rows[1]).toMatchObject({
      id: period2026Id,
      previous_period_id: period2025Id,
      opening_balance_entry_id: resync.newOpeningBalanceEntryId,
    })

    const replaced = await getPool().query<{
      id: string
      status: string
      source_type: string
      reverses_id: string | null
    }>(
      `SELECT id, status, source_type, reverses_id
         FROM public.journal_entries
        WHERE id = ANY($1::uuid[])`,
      [[old2026IBId, resync.stornoEntryId, resync.newOpeningBalanceEntryId]],
    )
    expect(replaced.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: old2026IBId, status: 'reversed', source_type: 'opening_balance' }),
      expect.objectContaining({
        id: resync.stornoEntryId,
        status: 'posted',
        source_type: 'storno',
        reverses_id: old2026IBId,
      }),
      expect.objectContaining({
        id: resync.newOpeningBalanceEntryId,
        status: 'posted',
        source_type: 'opening_balance',
      }),
    ]))

    const net = await getPool().query<{ account_number: string; amount: number }>(
      `SELECT l.account_number,
              SUM(l.debit_amount - l.credit_amount)::float8 AS amount
         FROM public.journal_entry_lines l
         JOIN public.journal_entries e ON e.id = l.journal_entry_id
        WHERE e.id = ANY($1::uuid[])
          AND e.status IN ('posted', 'reversed')
        GROUP BY l.account_number
        ORDER BY l.account_number`,
      [[old2026IBId, resync.stornoEntryId, resync.newOpeningBalanceEntryId]],
    )
    expect(net.rows).toEqual([
      { account_number: '1930', amount: 150 },
      { account_number: '2010', amount: -150 },
    ])
  })

  it('leaves a locked successor unchanged', async () => {
    const { userId, companyId, fiscalPeriodId: period2026Id } = await seedCompany()
    const old2026IBId = await insertPostedEntry({
      userId,
      companyId,
      fiscalPeriodId: period2026Id,
      entryDate: '2026-01-01',
      sourceType: 'opening_balance',
      description: 'Locked 2026 IB',
      lines: oldIBLines,
    })
    await getPool().query(
      `UPDATE public.fiscal_periods
          SET opening_balance_entry_id = $1,
              opening_balances_set = true,
              locked_at = now()
        WHERE id = $2`,
      [old2026IBId, period2026Id],
    )
    const before = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.journal_entries WHERE company_id = $1`,
      [companyId],
    )

    const result = await resyncNextPeriodOpeningBalance(
      makePgSupabase(userId),
      companyId,
      userId,
      '2025-12-31',
      closingBalances(),
      new Map([['1930', '1930'], ['2010', '2010']]),
    )

    expect(result).toEqual({
      resynced: false,
      reason: 'next_period_locked',
      nextPeriodName: '2026',
    })
    expect(replaceOpeningBalanceEntry).not.toHaveBeenCalled()

    const after = await getPool().query<{
      opening_balance_entry_id: string | null
      count: string
    }>(
      `SELECT fp.opening_balance_entry_id,
              (SELECT count(*)::text FROM public.journal_entries WHERE company_id = $1) AS count
         FROM public.fiscal_periods fp
        WHERE fp.id = $2`,
      [companyId, period2026Id],
    )
    expect(after.rows[0]).toEqual({
      opening_balance_entry_id: old2026IBId,
      count: before.rows[0]!.count,
    })
  })
})
