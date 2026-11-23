/**
 * The huvudbok export read a page at a time is the report one read gives,
 * byte for byte, through a REAL PostgREST over the real ledger functions.
 *
 * generateGeneralLedger read the whole period in one get_general_ledger_lines
 * call. For the largest ledgers that statement outlasts the 8 s statement
 * timeout every PostgREST call runs under whenever their lines are not
 * cached, so the full-year huvudbok (the xlsx file, the v1 report, the MCP
 * tool, the complete archive) failed. A ledger over
 * LEDGER_READ_LIMITS.singleRead lines is now read account by account, a page
 * at a time, through get_general_ledger_account_page, and checked to be one
 * state of the ledger. The writes during the read are tested at the end.
 *
 * Every company whose export works today must get the same report. The judge
 * here: the one-call read (the code path a ledger under the limit still takes,
 * unchanged) against the paged read, serialised, on a ledger built to make
 * paging hard (two series sharing a number on one day, a busy account spanning
 * many pages, a storno, tags on one and two dimensions, a padded code, a
 * missing series, an IB verifikat left out of the lines, an account with an
 * opening balance and no lines, one booked outside the chart), over account
 * ranges, date windows and dimension filters, on the summaries and on the
 * line-level path of a company not yet built.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it } from 'vitest'
import { generateGeneralLedger, LEDGER_READ_LIMITS, type LedgerReadLimits } from '@/lib/reports/general-ledger'
import { insertDraftJournalEntry, insertFiscalPeriod, seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'
import { createToolPgClient } from './client'

interface Line {
  account: string
  debit?: number
  credit?: number
  dims?: Record<string, string>
}

interface World {
  userId: string
  companyId: string
  periodId: string
  priorPeriodId: string
}

const ONE_READ: LedgerReadLimits = { singleRead: Number.MAX_SAFE_INTEGER, page: 5000 }
const paged = (page: number): LedgerReadLimits => ({ singleRead: 0, page })

let world: World
let lineCount2026 = 0

/** Whole öre to kronor: an integer over 100 is the two-decimal amount exactly. */
const kr = (ore: number) => ore / 100

async function ensureAccounts(w: World, accounts: string[]): Promise<void> {
  for (const account of accounts) {
    await getPool().query(
      `INSERT INTO public.chart_of_accounts
         (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
       VALUES ($1, $2, $3, 'Konto ' || $3, left($3, 1)::int,
               CASE WHEN $3 < '2000' THEN 'asset' WHEN $3 < '3000' THEN 'liability'
                    WHEN $3 < '4000' THEN 'revenue' ELSE 'expense' END,
               CASE WHEN $3 < '2000' OR $3 >= '4000' THEN 'debit' ELSE 'credit' END)
       ON CONFLICT DO NOTHING`,
      [w.userId, w.companyId, account],
    )
  }
}

/** A draft with its lines, then posted (draft -> posted), as the fixtures post. */
async function post(
  w: World,
  params: { date: string; voucher: number; lines: Line[]; series?: string | null; sourceType?: string; periodId?: string; reversesId?: string },
): Promise<string> {
  const id = await insertDraftJournalEntry({
    userId: w.userId,
    companyId: w.companyId,
    fiscalPeriodId: params.periodId ?? w.periodId,
    entryDate: params.date,
    description: `Verifikat ${params.series ?? '-'}${params.voucher}`,
    sourceType: params.sourceType ?? 'manual',
    voucherNumber: params.voucher,
    voucherSeries: params.series ?? undefined,
  })
  if (params.series === null) {
    await getPool().query(`UPDATE public.journal_entries SET voucher_series = NULL WHERE id = $1`, [id])
  }
  if (params.reversesId) {
    await getPool().query(`UPDATE public.journal_entries SET reverses_id = $2 WHERE id = $1`, [id, params.reversesId])
  }
  for (const [i, line] of params.lines.entries()) {
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, sort_order, dimensions)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [id, line.account, line.debit ?? 0, line.credit ?? 0, i, JSON.stringify(line.dims ?? {})],
    )
  }
  await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
  if ((params.periodId ?? w.periodId) === w.periodId && params.sourceType !== 'opening_balance') {
    lineCount2026 += params.lines.length
  }
  return id
}

async function buildWorld(): Promise<World> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const priorPeriodId = await insertFiscalPeriod({
    userId, companyId, name: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31',
  })
  const w: World = { userId, companyId, periodId: fiscalPeriodId, priorPeriodId }
  // 2440 is booked but not in the chart: the report names it "Konto 2440".
  await ensureAccounts(w, ['1229', '1510', '1930', '2081', '2099', '2611', '3001', '5010', '7832'])

  // Last year: a few verifikat, so 2025 has a ledger of its own.
  for (let i = 0; i < 4; i++) {
    await post(w, {
      date: `2025-0${3 + i}-1${i}`, voucher: 1 + i, periodId: priorPeriodId,
      lines: [{ account: '1930', debit: kr(50_000 + i * 1_001) }, { account: '3001', credit: kr(50_000 + i * 1_001) }],
    })
  }

  // The IB verifikat, linked: the opening balances, never a line. 2081
  // carries a balance and no line all year.
  const ib = await post(w, {
    date: '2026-01-01', voucher: 1, sourceType: 'opening_balance',
    lines: [
      { account: '1930', debit: 5000 }, { account: '1510', debit: 1200.5 },
      { account: '2081', credit: 5000 }, { account: '2440', credit: 1200.5 },
    ],
  })
  await getPool().query(`UPDATE public.fiscal_periods SET opening_balance_entry_id = $2 WHERE id = $1`, [fiscalPeriodId, ib])

  // Sales through the year, tagged on projekt P1/P2, some on a kostnadsställe.
  let voucher = 2
  for (let i = 0; i < 30; i++) {
    const total = 10_000 + i * 1_337
    const net = Math.round(total * 0.8)
    const month = String(1 + (i % 11)).padStart(2, '0')
    const day = String(1 + ((i * 7) % 27)).padStart(2, '0')
    await post(w, {
      date: `2026-${month}-${day}`, voucher: voucher++,
      lines: [
        { account: '1930', debit: kr(total), dims: i % 5 === 0 ? { '1': 'KS01' } : undefined },
        { account: '3001', credit: kr(net), dims: i % 3 === 0 ? { '6': 'P1' } : { '6': 'P2', ...(i % 4 === 0 ? { '1': 'KS02' } : {}) } },
        { account: '2611', credit: kr(total - net) },
      ],
    })
  }
  // Costs on both dimensions, paid from 2440.
  for (let i = 0; i < 10; i++) {
    await post(w, {
      date: `2026-${String(2 + i).padStart(2, '0')}-15`, voucher: voucher++,
      lines: [
        { account: '5010', debit: kr(3_333 + i), dims: i % 2 === 0 ? { '1': 'KS02', '6': 'P1' } : { '1': i % 3 === 0 ? ' KS01 ' : 'KS01' } },
        { account: '2440', credit: kr(3_333 + i) },
      ],
    })
  }
  // Same day, same number, two series: their 1930 lines interleave by line id.
  for (const series of ['A', 'B']) {
    await post(w, {
      date: '2026-08-10', voucher: 100, series,
      lines: [
        { account: '1930', debit: 10 }, { account: '1930', debit: 20.05, dims: { '1': 'KS01' } },
        { account: '1930', credit: 5 }, { account: '3001', credit: 25.05 },
      ],
    })
  }
  // A verifikat and its storno: both stay in the ledger.
  const wrong = await post(w, {
    date: '2026-06-15', voucher: voucher++,
    lines: [{ account: '5010', debit: 300, dims: { '6': 'P1' } }, { account: '1930', credit: 300 }],
  })
  const storno = await post(w, {
    date: '2026-06-20', voucher: voucher++, sourceType: 'storno', reversesId: wrong,
    lines: [{ account: '1930', debit: 300 }, { account: '5010', credit: 300, dims: { '6': 'P1' } }],
  })
  await getPool().query(
    `UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $2 WHERE id = $1`,
    [wrong, storno],
  )
  // No series at all (legacy rows): the report reads it as A.
  await post(w, {
    date: '2026-09-01', voucher: 200, series: null,
    lines: [{ account: '1930', debit: 7 }, { account: '3001', credit: 7 }],
  })
  // Bokslut on the last day: depreciation tagged, and a resultatavslut.
  await post(w, {
    date: '2026-12-31', voucher: voucher++, sourceType: 'year_end',
    lines: [{ account: '7832', debit: 500, dims: { '1': 'KS01' } }, { account: '1229', credit: 500 }],
  })
  await post(w, {
    date: '2026-12-31', voucher: voucher++,
    lines: [{ account: '3001', debit: 1000 }, { account: '2099', credit: 1000 }],
  })
  return w
}

/**
 * The client with every RPC it makes counted by name. `before` runs ahead of
 * each call, so a test can write to the ledger between two pages.
 */
function countingClient(
  before?: (fn: string, args: Record<string, unknown>) => Promise<void>,
): { client: SupabaseClient; rpcCalls: string[] } {
  const base = createToolPgClient()
  const rpcCalls: string[] = []
  const client = new Proxy(base, {
    get(target, prop) {
      if (prop === 'rpc') {
        return async (fn: string, args: Record<string, unknown> = {}) => {
          rpcCalls.push(fn)
          await before?.(fn, args)
          return target.rpc(fn, args)
        }
      }
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { client, rpcCalls }
}

type Args = Parameters<typeof generateGeneralLedger>
type Scenario = { label: string; period: 'current' | 'prior'; accountFrom?: string; accountTo?: string; options?: NonNullable<Args[5]> }

const SCENARIOS: Scenario[] = [
  { label: 'the year', period: 'current' },
  { label: 'last year, no IB verifikat', period: 'prior' },
  { label: '1900-1999', period: 'current', accountFrom: '1900', accountTo: '1999' },
  { label: '1500-3001', period: 'current', accountFrom: '1500', accountTo: '3001' },
  { label: 'from 3000', period: 'current', accountFrom: '3000' },
  { label: 'to 1930', period: 'current', accountTo: '1930' },
  { label: 'March to 12 August', period: 'current', options: { fromDate: '2026-03-01', toDate: '2026-08-12' } },
  { label: 'the day two series share', period: 'current', options: { fromDate: '2026-08-10', toDate: '2026-08-10' } },
  { label: 'to midsummer', period: 'current', options: { toDate: '2026-06-30' } },
  { label: 'KS01', period: 'current', options: { dimensions: { '1': 'KS01' } } },
  { label: 'padded KS01', period: 'current', options: { dimensions: { '1': ' KS01 ' } } },
  { label: 'P1 in a window', period: 'current', options: { dimensions: { '6': 'P1' }, fromDate: '2026-04-01', toDate: '2026-10-31' } },
  { label: 'KS02 and P1', period: 'current', options: { dimensions: { '1': 'KS02', '6': 'P1' } } },
]

async function ledger(client: SupabaseClient, scenario: Scenario, readLimits: LedgerReadLimits): Promise<string> {
  const periodId = scenario.period === 'current' ? world.periodId : world.priorPeriodId
  const report = await generateGeneralLedger(client, world.companyId, periodId, scenario.accountFrom, scenario.accountTo, {
    ...scenario.options,
    readLimits,
  })
  return JSON.stringify(report)
}

async function isBuilt(): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT EXISTS (SELECT 1 FROM public.ledger_account_days_companies WHERE company_id = $1) AS built`,
    [world.companyId],
  )
  return rows[0].built
}

/** Every scenario read once and paged, compared as the serialised report the export writes. */
async function compareReads(): Promise<void> {
  for (const scenario of SCENARIOS) {
    const once = countingClient()
    const expected = await ledger(once.client, scenario, ONE_READ)
    expect(once.rpcCalls, scenario.label).not.toContain('get_general_ledger_account_page')
    for (const page of [1, 4]) {
      const pages = countingClient()
      const actual = await ledger(pages.client, scenario, paged(page))
      expect(actual, `${scenario.label}, pages of ${page}`).toBe(expected)
      expect(pages.rpcCalls, scenario.label).not.toContain('get_general_ledger_lines')
    }
  }
}

beforeAll(async () => {
  world = await buildWorld()
}, 120_000)

describe('generateGeneralLedger: the paged read gives the report one read gives', () => {
  it('on the summaries, for every range, window and filter', async () => {
    expect(await isBuilt()).toBe(true)
    await compareReads()

    // Not vacuous: the year has every posted line but the IB verifikat's, the
    // busy account spans many pages, and the two series interleave on 1930.
    const year = JSON.parse(await ledger(createToolPgClient(), SCENARIOS[0], paged(1)))
    expect(year.accounts.reduce((sum: number, a: { lines: unknown[] }) => sum + a.lines.length, 0)).toBe(lineCount2026)
    const bank = year.accounts.find((a: { account_number: string }) => a.account_number === '1930')
    expect(bank.lines.length).toBeGreaterThan(30)
    expect(bank.opening_balance).toBe(5000)
    const sameDay = bank.lines.filter((l: { date: string }) => l.date === '2026-08-10').map((l: { voucher_series: string }) => l.voucher_series)
    expect(sameDay).toHaveLength(6)
    expect(new Set(sameDay)).toEqual(new Set(['A', 'B']))
    expect(year.accounts.find((a: { account_number: string }) => a.account_number === '2081')).toMatchObject({ opening_balance: -5000, lines: [] })
    expect(year.accounts.find((a: { account_number: string }) => a.account_number === '2440').account_name).toBe('Konto 2440')
    const pages = countingClient()
    await ledger(pages.client, SCENARIOS[0], paged(1))
    expect(pages.rpcCalls.filter((fn) => fn === 'get_general_ledger_account_page').length).toBeGreaterThan(bank.lines.length)
  }, 180_000)

  it('on the line-level path of a company the summaries are not built for', async () => {
    await getPool().query(`DELETE FROM public.ledger_account_days_companies WHERE company_id = $1`, [world.companyId])
    expect(await isBuilt()).toBe(false)
    await compareReads()
  }, 180_000)
})

describe('generateGeneralLedger: which read', () => {
  it('reads a ledger within the default limit in one call, as before', async () => {
    const { client, rpcCalls } = countingClient()
    await generateGeneralLedger(client, world.companyId, world.periodId)
    expect(lineCount2026).toBeLessThan(LEDGER_READ_LIMITS.singleRead)
    expect(rpcCalls.filter((fn) => fn === 'get_general_ledger_lines')).toHaveLength(1)
    expect(rpcCalls).not.toContain('get_general_ledger_account_page')
  })
})

describe('generateGeneralLedger: a verifikat booked while the pages are read', () => {
  it('is seen by the check against the summaries, and the ledger is read again whole', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const w: World = { userId, companyId, periodId: fiscalPeriodId, priorPeriodId: '' }
    await ensureAccounts(w, ['1930', '3001'])
    for (let i = 0; i < 5; i++) {
      await post(w, {
        date: `2026-0${3 + i}-10`, voucher: 1 + i,
        lines: [{ account: '1930', debit: 100 + i }, { account: '3001', credit: 100 + i }],
      })
    }

    // Booked once 1930's first page is back, dated before every line: 1930's
    // pages are past it, so the first read cannot be whole.
    let booked = false
    const { client, rpcCalls } = countingClient(async (fn, args) => {
      if (booked || fn !== 'get_general_ledger_account_page' || args.p_account_number !== '1930' || !args.p_after_date) return
      booked = true
      await post(w, {
        date: '2026-01-02', voucher: 50,
        lines: [{ account: '1930', debit: 777 }, { account: '3001', credit: 777 }],
      })
    })
    const report = await generateGeneralLedger(client, companyId, fiscalPeriodId, undefined, undefined, { readLimits: paged(1) })

    expect(booked).toBe(true)
    expect(rpcCalls.filter((fn) => fn === 'get_trial_balance_aggregates')).toHaveLength(2)
    for (const account of report.accounts) {
      expect(account.lines.map((l) => l.voucher_number), account.account_number).toEqual([50, 1, 2, 3, 4, 5])
    }
    const once = await generateGeneralLedger(createToolPgClient(), companyId, fiscalPeriodId, undefined, undefined, { readLimits: ONE_READ })
    expect(JSON.stringify(report)).toBe(JSON.stringify(once))
  })

  it('is not disturbed by a draft saved while the pages are read', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const w: World = { userId, companyId, periodId: fiscalPeriodId, priorPeriodId: '' }
    await ensureAccounts(w, ['1930', '3001'])
    for (let i = 0; i < 5; i++) {
      await post(w, {
        date: `2026-0${3 + i}-10`, voucher: 1 + i,
        lines: [{ account: '1930', debit: 100 + i }, { account: '3001', credit: 100 + i }],
      })
    }
    let drafted = false
    const { client, rpcCalls } = countingClient(async (fn, args) => {
      if (drafted || fn !== 'get_general_ledger_account_page' || args.p_account_number !== '1930' || !args.p_after_date) return
      drafted = true
      await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId, entryDate: '2026-01-02', description: 'Utkast' })
    })
    const report = await generateGeneralLedger(client, companyId, fiscalPeriodId, undefined, undefined, { readLimits: paged(1) })

    expect(drafted).toBe(true)
    // Read once: two accounts of five lines, a page a line and an empty page to end each.
    expect(rpcCalls.filter((fn) => fn === 'get_general_ledger_account_page')).toHaveLength(2 * 6)
    const once = await generateGeneralLedger(createToolPgClient(), companyId, fiscalPeriodId, undefined, undefined, { readLimits: ONE_READ })
    expect(JSON.stringify(report)).toBe(JSON.stringify(once))
  })

  it('is seen by the marks under two dimension values, where the summaries cannot check the pages', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const w: World = { userId, companyId, periodId: fiscalPeriodId, priorPeriodId: '' }
    await ensureAccounts(w, ['1930', '3001'])
    const tags = { '1': 'KS01', '6': 'P1' }
    for (let i = 0; i < 5; i++) {
      await post(w, {
        date: `2026-0${3 + i}-10`, voucher: 1 + i,
        lines: [{ account: '1930', debit: 100 + i, dims: tags }, { account: '3001', credit: 100 + i, dims: tags }],
      })
    }
    let booked = false
    const { client, rpcCalls } = countingClient(async (fn, args) => {
      if (booked || fn !== 'get_general_ledger_account_page' || args.p_account_number !== '1930' || !args.p_after_date) return
      booked = true
      await post(w, {
        date: '2026-01-02', voucher: 50,
        lines: [{ account: '1930', debit: 777, dims: tags }, { account: '3001', credit: 777, dims: tags }],
      })
    })
    const report = await generateGeneralLedger(client, companyId, fiscalPeriodId, undefined, undefined, {
      dimensions: tags, readLimits: paged(1),
    })

    expect(booked).toBe(true)
    expect(rpcCalls).not.toContain('get_trial_balance_aggregates')
    for (const account of report.accounts) {
      expect(account.lines.map((l) => l.voucher_number), account.account_number).toEqual([50, 1, 2, 3, 4, 5])
    }
    const once = await generateGeneralLedger(createToolPgClient(), companyId, fiscalPeriodId, undefined, undefined, {
      dimensions: tags, readLimits: ONE_READ,
    })
    expect(JSON.stringify(report)).toBe(JSON.stringify(once))
  })

  it('is seen by the retag log when a verifikat is retagged, and the ledger is read again whole', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const w: World = { userId, companyId, periodId: fiscalPeriodId, priorPeriodId: '' }
    await ensureAccounts(w, ['1930', '3001'])
    const first = await post(w, {
      date: '2026-02-10', voucher: 1,
      lines: [{ account: '1930', debit: 500 }, { account: '3001', credit: 500 }],
    })
    for (let i = 0; i < 4; i++) {
      await post(w, {
        date: `2026-0${3 + i}-10`, voucher: 2 + i,
        lines: [{ account: '1930', debit: 100 + i }, { account: '3001', credit: 100 + i }],
      })
    }
    // The retag the way the app does it: registry value, then the RPC with its log.
    const { rows: dim } = await getPool().query<{ id: string }>(
      `INSERT INTO public.dimensions (company_id, sie_dim_no, name, resets_annually, is_system, is_active)
       VALUES ($1, 1, 'Kostnadsställe', true, false, true)
       ON CONFLICT (company_id, sie_dim_no) DO UPDATE SET is_active = true RETURNING id`,
      [companyId],
    )
    await getPool().query(
      `INSERT INTO public.dimension_values (company_id, dimension_id, code, name, is_active)
       VALUES ($1, $2, 'KS01', 'KS01', true) ON CONFLICT (company_id, dimension_id, code) DO UPDATE SET is_active = true`,
      [companyId, dim[0].id],
    )
    const { rows: lines } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY account_number`,
      [first],
    )

    // Both lines of the first verifikat retagged once 1930's first page is
    // back: 1930's pages are past its line, 3001's are not.
    let retagged = false
    const { client, rpcCalls } = countingClient(async (fn, args) => {
      if (retagged || fn !== 'get_general_ledger_account_page' || args.p_account_number !== '1930' || !args.p_after_date) return
      retagged = true
      for (const line of lines) {
        await getPool().query(
          `SELECT public.retag_line_dimensions($1::uuid, $2::uuid, $3::jsonb, 'Fel kostnadsställe', $4::uuid)`,
          [companyId, line.id, JSON.stringify({ '1': 'KS01' }), userId],
        )
      }
    })
    const report = await generateGeneralLedger(client, companyId, fiscalPeriodId, undefined, undefined, { readLimits: paged(1) })

    expect(retagged).toBe(true)
    // Read twice: two accounts of five lines, a page a line and an empty page to end each.
    expect(rpcCalls.filter((fn) => fn === 'get_general_ledger_account_page')).toHaveLength(2 * 2 * 6)
    for (const account of report.accounts) {
      expect(account.lines[0].dimensions, account.account_number).toEqual({ '1': 'KS01' })
    }
    const once = await generateGeneralLedger(createToolPgClient(), companyId, fiscalPeriodId, undefined, undefined, { readLimits: ONE_READ })
    expect(JSON.stringify(report)).toBe(JSON.stringify(once))
  })
})
