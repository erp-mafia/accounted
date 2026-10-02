/**
 * Issue #3313: the year-end close splits next year's IB per project.
 *
 * The per-account totals must equal the one-line-per-account IB exactly (the
 * continuity check and every tag-blind reader depend on it); the per-project
 * lines carry each project's closing balance; a project archived during the
 * year must not block the close; and a failure of the split itself (it runs
 * after the period was closed) falls back to the per-account IB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CreateJournalEntryLineInput } from '@/types'

vi.mock('@/lib/reports/trial-balance', () => ({ generateTrialBalance: vi.fn() }))
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'ib-2027' })),
  reverseEntry: vi.fn(),
}))

import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import { buildOpeningBalanceLines, fetchObjectClosingBalances } from '../opening-balance-split'
import { generateOpeningBalances } from '../year-end-service'

type Result = { data?: unknown; error?: unknown }

/** Table-routed FIFO client; rpc results keyed `rpc:<name>`. Records calls. */
function makeClient(queues: Record<string, Result[]>) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const chain = (table: string, result: Result): unknown =>
    new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: null, error: null, ...result })
          return (...args: unknown[]) => {
            calls.push({ table, method: String(prop), args })
            if (prop === 'single' || prop === 'maybeSingle') return Promise.resolve({ data: null, error: null, ...result })
            return chain(table, result)
          }
        },
      }
    )
  const take = (key: string): Result => queues[key]?.shift() ?? {}
  const client = {
    from: vi.fn((table: string) => chain(table, take(table))),
    rpc: vi.fn(async (name: string, args: unknown) => {
      calls.push({ table: `rpc:${name}`, method: 'rpc', args: [args] })
      return { data: null, error: null, ...take(`rpc:${name}`) }
    }),
  }
  return { client, calls }
}

function netByBag(lines: CreateJournalEntryLineInput[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of lines) {
    const key = `${line.account_number}${line.dimensions ? ' ' + JSON.stringify(line.dimensions) : ''}`
    out[key] = Math.round(((out[key] ?? 0) + line.debit_amount - line.credit_amount) * 100) / 100
  }
  return out
}

function netByAccount(lines: CreateJournalEntryLineInput[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of lines) {
    out[line.account_number] = Math.round(((out[line.account_number] ?? 0) + line.debit_amount - line.credit_amount) * 100) / 100
  }
  return out
}

const TB_ROWS = [
  { account_number: '1470', account_name: 'Pågående arbeten', account_class: 1, closing_debit: 2100, closing_credit: 0 },
  { account_number: '1510', account_name: 'Kundfordringar', account_class: 1, closing_debit: 500.004, closing_credit: 0 },
  { account_number: '1930', account_name: 'Företagskonto', account_class: 1, closing_debit: 0.004, closing_credit: 0 },
  { account_number: '2099', account_name: 'Årets resultat', account_class: 2, closing_debit: 0, closing_credit: 2600 },
  { account_number: '3010', account_name: 'Försäljning', account_class: 3, closing_debit: 0, closing_credit: 0 },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildOpeningBalanceLines', () => {
  const accounts = TB_ROWS.filter((r) => r.account_class <= 2).map((r) => ({
    account_number: r.account_number,
    account_name: r.account_name,
    net: r.closing_debit - r.closing_credit,
  }))

  it('keeps every account total exactly as the one-line-per-account IB booked it', () => {
    const lines = buildOpeningBalanceLines(accounts, new Map([
      ['1470', [{ dimensions: { '6': 'P1' }, amount: 1300 }, { dimensions: { '6': 'P2' }, amount: 500 }]],
      ['1510', [{ dimensions: { '6': 'P1' }, amount: 700 }]],
    ]))
    // The unsplit IB: 1470 2100, 1510 500 (öre-rounded), 1930 below tolerance, 2099 -2600.
    expect(netByAccount(lines)).toEqual({ '1470': 2100, '1510': 500, '2099': -2600 })
    expect(netByBag(lines)).toEqual({
      '1470 {"6":"P1"}': 1300,
      '1470 {"6":"P2"}': 500,
      '1470': 300,
      '1510 {"6":"P1"}': 700,
      '1510': -200,
      '2099': -2600,
    })
    expect(lines.every((l) => l.line_description?.startsWith('Ingående balans: '))).toBe(true)
  })

  it('is the per-account IB line for line when nothing is tagged', () => {
    expect(buildOpeningBalanceLines(accounts, new Map())).toEqual([
      { account_number: '1470', debit_amount: 2100, credit_amount: 0, line_description: 'Ingående balans: Pågående arbeten' },
      { account_number: '1510', debit_amount: 500, credit_amount: 0, line_description: 'Ingående balans: Kundfordringar' },
      { account_number: '2099', debit_amount: 0, credit_amount: 2600, line_description: 'Ingående balans: Årets resultat' },
    ])
  })

  it('carries offsetting projects on an account whose total is zero', () => {
    const lines = buildOpeningBalanceLines(
      [{ account_number: '1930', account_name: 'Företagskonto', net: 0.004 }],
      new Map([['1930', [{ dimensions: { '6': 'P1' }, amount: 40 }, { dimensions: { '6': 'P2' }, amount: -40 }]]])
    )
    expect(netByBag(lines)).toEqual({ '1930 {"6":"P1"}': 40, '1930 {"6":"P2"}': -40 })
    expect(netByAccount(lines)).toEqual({ '1930': 0 })
  })

  describe('VAT accounts (26xx) are never split per project (founder decision 2026-10-01)', () => {
    // A project invoice: 1510 debit 1250 and 2611 credit 250 tagged P1/P2,
    // the VAT settled untagged (2611 debit, 2650 credit), so the per-project
    // 2611 parts net against an untagged settlement on the same account.
    const vatAccounts = [
      { account_number: '1510', account_name: 'Kundfordringar', net: 2500 },
      { account_number: '2611', account_name: 'Utgående moms 25 %', net: -300 },
      { account_number: '2650', account_name: 'Redovisningskonto för moms', net: -200 },
      { account_number: '2099', account_name: 'Årets resultat', net: -2000 },
    ]
    const vatObjects = new Map([
      ['1510', [{ dimensions: { '6': 'P1' }, amount: 1250 }, { dimensions: { '6': 'P2' }, amount: 1250 }]],
      ['2611', [{ dimensions: { '6': 'P1' }, amount: -250 }, { dimensions: { '6': 'P2' }, amount: -250 }]],
    ])

    it('books a 26xx account with project balances as one untagged IB line', () => {
      const lines = buildOpeningBalanceLines(vatAccounts, vatObjects)
      expect(lines.filter((l) => l.account_number === '2611')).toEqual([
        { account_number: '2611', debit_amount: 0, credit_amount: 300, line_description: 'Ingående balans: Utgående moms 25 %' },
      ])
      expect(lines.filter((l) => l.account_number.startsWith('26')).every((l) => l.dimensions === undefined)).toBe(true)
    })

    it('keeps the per-project lines on 1510', () => {
      const lines = buildOpeningBalanceLines(vatAccounts, vatObjects)
      expect(netByBag(lines.filter((l) => l.account_number === '1510'))).toEqual({
        '1510 {"6":"P1"}': 1250,
        '1510 {"6":"P2"}': 1250,
      })
    })

    it('keeps every account total and the entry balanced', () => {
      const lines = buildOpeningBalanceLines(vatAccounts, vatObjects)
      expect(netByAccount(lines)).toEqual({ '1510': 2500, '2611': -300, '2650': -200, '2099': -2000 })
      const debit = Math.round(lines.reduce((sum, l) => sum + l.debit_amount, 0) * 100) / 100
      const credit = Math.round(lines.reduce((sum, l) => sum + l.credit_amount, 0) * 100) / 100
      expect(debit).toBe(credit)
      expect(debit).toBeGreaterThan(0)
    })

    it('books nothing for 26xx project balances on an account the rows lack (zero total)', () => {
      const lines = buildOpeningBalanceLines(
        [{ account_number: '1930', account_name: 'Företagskonto', net: 100 }, { account_number: '2081', account_name: 'Aktiekapital', net: -100 }],
        new Map([['2641', [{ dimensions: { '6': 'P1' }, amount: 80 }, { dimensions: { '6': 'P2' }, amount: -80 }]]])
      )
      expect(lines.some((l) => l.account_number === '2641')).toBe(false)
      expect(netByAccount(lines)).toEqual({ '1930': 100, '2081': -100 })
    })
  })
})

describe('fetchObjectClosingBalances', () => {
  it('asks for the registry\'s accumulating dimensions and groups the rows per account', async () => {
    const { client, calls } = makeClient({
      dimensions: [{ data: [{ sie_dim_no: 6 }] }],
      'rpc:compute_object_closing_balances': [{
        data: [
          { account_number: '1470', dimensions: { '6': 'P1' }, net: '1300.00' },
          { account_number: '1470', dimensions: { '6': 'P2' }, net: 500 },
          { account_number: '1510', dimensions: { '6': 'P1' }, net: 0 },
        ],
      }],
    })
    const result = await fetchObjectClosingBalances(client as never, 'co-1', 'fp-2026')
    expect(calls).toContainEqual({ table: 'dimensions', method: 'eq', args: ['resets_annually', false] })
    expect(client.rpc).toHaveBeenCalledWith('compute_object_closing_balances', {
      p_company_id: 'co-1',
      p_fiscal_period_id: 'fp-2026',
      p_dim_nos: ['6'],
    })
    expect([...result]).toEqual([
      ['1470', [{ dimensions: { '6': 'P1' }, amount: 1300 }, { dimensions: { '6': 'P2' }, amount: 500 }]],
    ])
  })

  it('leaves malformed legacy bags out of the split (their amount stays in the remainder)', async () => {
    const { client } = makeClient({
      dimensions: [{ data: [{ sie_dim_no: 6 }] }],
      'rpc:compute_object_closing_balances': [{
        data: [
          { account_number: '1470', dimensions: { '6': 42 }, net: 100 },
          { account_number: '1470', dimensions: { '6': 'x'.repeat(41) }, net: 100 },
          { account_number: '1470', dimensions: { '6': 'P"1' }, net: 100 },
          { account_number: '1470', dimensions: { '06': 'P1' }, net: 100 },
          { account_number: '1470', dimensions: ['P1'], net: 100 },
          { account_number: '1470', dimensions: { '6': 'P2' }, net: 200 },
        ],
      }],
    })
    const result = await fetchObjectClosingBalances(client as never, 'co-1', 'fp')
    expect([...result]).toEqual([['1470', [{ dimensions: { '6': 'P2' }, amount: 200 }]]])
  })

  it('does not call the RPC when no dimension accumulates', async () => {
    const { client } = makeClient({ dimensions: [{ data: [] }] })
    expect((await fetchObjectClosingBalances(client as never, 'co-1', 'fp')).size).toBe(0)
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('throws on a registry or RPC error (the caller decides the fallback)', async () => {
    const registryDown = makeClient({ dimensions: [{ error: { message: 'down' } }] })
    await expect(fetchObjectClosingBalances(registryDown.client as never, 'co-1', 'fp')).rejects.toThrow(/registry/)
    const rpcDown = makeClient({
      dimensions: [{ data: [{ sie_dim_no: 6 }] }],
      'rpc:compute_object_closing_balances': [{ error: { message: 'timeout' } }],
    })
    await expect(fetchObjectClosingBalances(rpcDown.client as never, 'co-1', 'fp')).rejects.toThrow(/timeout/)
  })
})

describe('generateOpeningBalances: next year\'s IB split per project', () => {
  const NEXT = { id: 'fp-2027', name: '2027', period_start: '2027-01-01', period_end: '2027-12-31' }

  it('books the split IB with the replayed bags, so an archived project cannot block the close', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({ rows: TB_ROWS, totalDebit: 0, totalCredit: 0, isBalanced: true } as never)
    const { client } = makeClient({
      fiscal_periods: [{ data: NEXT }, { error: null }],
      dimensions: [{ data: [{ sie_dim_no: 6 }] }],
      'rpc:compute_object_closing_balances': [{
        data: [{ account_number: '1470', dimensions: { '6': 'P-ARKIV' }, net: 1300 }],
      }],
    })

    const entry = await generateOpeningBalances(client as never, 'co-1', 'user-1', 'fp-2026', 'fp-2027')

    expect(entry).toEqual({ id: 'ib-2027' })
    const call = vi.mocked(createJournalEntry).mock.calls[0]
    const input = call[3]
    expect(input).toMatchObject({ fiscal_period_id: 'fp-2027', entry_date: '2027-01-01', source_type: 'opening_balance' })
    expect(netByBag(input.lines)).toEqual({
      '1470 {"6":"P-ARKIV"}': 1300,
      '1470': 800,
      '1510': 500,
      '2099': -2600,
    })
    expect(call[6]).toEqual({ replayDimensions: true })
  })

  it('falls back to one line per account when the split cannot be computed (never an IB-less closed year)', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({ rows: TB_ROWS, totalDebit: 0, totalCredit: 0, isBalanced: true } as never)
    const { client } = makeClient({
      fiscal_periods: [{ data: NEXT }, { error: null }],
      dimensions: [{ data: [{ sie_dim_no: 6 }] }],
      'rpc:compute_object_closing_balances': [{ error: { message: 'statement timeout' } }],
    })

    await generateOpeningBalances(client as never, 'co-1', 'user-1', 'fp-2026', 'fp-2027')

    const input = vi.mocked(createJournalEntry).mock.calls[0][3]
    expect(input.lines.every((l) => l.dimensions === undefined)).toBe(true)
    expect(netByBag(input.lines)).toEqual({ '1470': 2100, '1510': 500, '2099': -2600 })
  })

  it('books the IB per account when the database refuses the split post (nothing was posted by that try)', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({ rows: TB_ROWS, totalDebit: 0, totalCredit: 0, isBalanced: true } as never)
    vi.mocked(createJournalEntry)
      .mockRejectedValueOnce(new BookkeepingDatabaseError('create_entry_lines', 'violates check constraint "jel_dimensions_well_formed"', '23514'))
      .mockResolvedValueOnce({ id: 'ib-2027-flat' } as never)
    const { client } = makeClient({
      fiscal_periods: [{ data: NEXT }, { error: null }],
      dimensions: [{ data: [{ sie_dim_no: 6 }] }],
      'rpc:compute_object_closing_balances': [{ data: [{ account_number: '1470', dimensions: { '6': 'P1' }, net: 1300 }] }],
    })

    const entry = await generateOpeningBalances(client as never, 'co-1', 'user-1', 'fp-2026', 'fp-2027')

    expect(entry).toEqual({ id: 'ib-2027-flat' })
    expect(createJournalEntry).toHaveBeenCalledTimes(2)
    const retry = vi.mocked(createJournalEntry).mock.calls[1]
    expect(netByBag(retry[3].lines)).toEqual({ '1470': 2100, '1510': 500, '2099': -2600 })
    expect(retry[6]).toBeUndefined()
  })

  it('does not retry a failure that may have posted, or an IB without a split', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({ rows: TB_ROWS, totalDebit: 0, totalCredit: 0, isBalanced: true } as never)
    // A failure after the commit (e.g. while emitting events) could mean the
    // IB is posted: retrying would book a second IB.
    vi.mocked(createJournalEntry).mockRejectedValueOnce(new Error('handler failed after commit'))
    const split = makeClient({
      fiscal_periods: [{ data: NEXT }, { error: null }],
      dimensions: [{ data: [{ sie_dim_no: 6 }] }],
      'rpc:compute_object_closing_balances': [{ data: [{ account_number: '1470', dimensions: { '6': 'P1' }, net: 1300 }] }],
    })
    await expect(generateOpeningBalances(split.client as never, 'co-1', 'user-1', 'fp-2026', 'fp-2027')).rejects.toThrow(/after commit/)
    expect(createJournalEntry).toHaveBeenCalledTimes(1)

    vi.mocked(createJournalEntry).mockClear()
    vi.mocked(createJournalEntry).mockRejectedValueOnce(new BookkeepingDatabaseError('commit_entry', 'period locked'))
    const flat = makeClient({
      fiscal_periods: [{ data: NEXT }, { error: null }],
      dimensions: [{ data: [] }],
    })
    await expect(generateOpeningBalances(flat.client as never, 'co-1', 'user-1', 'fp-2026', 'fp-2027')).rejects.toThrow(/period locked/)
    expect(createJournalEntry).toHaveBeenCalledTimes(1)
  })

  describe('the per-account retry never doubles the IB', () => {
    const splitClient = (journalEntries: Result[] = []) =>
      makeClient({
        fiscal_periods: [{ data: NEXT }, { error: null }],
        dimensions: [{ data: [{ sie_dim_no: 6 }] }],
        'rpc:compute_object_closing_balances': [{ data: [{ account_number: '1470', dimensions: { '6': 'P1' }, net: 1300 }] }],
        journal_entries: journalEntries,
      })

    beforeEach(() => {
      vi.mocked(generateTrialBalance).mockResolvedValue({ rows: TB_ROWS, totalDebit: 0, totalCredit: 0, isBalanced: true } as never)
    })

    it('does not retry a commit error without a Postgres code: the commit may have succeeded and its response been lost', async () => {
      vi.mocked(createJournalEntry).mockRejectedValueOnce(new BookkeepingDatabaseError('commit_entry', 'TypeError: fetch failed', ''))
      const { client } = splitClient()
      await expect(generateOpeningBalances(client as never, 'co-1', 'user-1', 'fp-2026', 'fp-2027')).rejects.toThrow(/fetch failed/)
      expect(createJournalEntry).toHaveBeenCalledTimes(1)
    })

    it('retries a commit the database rejected once a read confirms no IB is posted', async () => {
      vi.mocked(createJournalEntry)
        .mockRejectedValueOnce(new BookkeepingDatabaseError('commit_entry', 'trigger refused the line', 'P0001'))
        .mockResolvedValueOnce({ id: 'ib-2027-flat' } as never)
      const { client, calls } = splitClient([{ data: [] }])

      const entry = await generateOpeningBalances(client as never, 'co-1', 'user-1', 'fp-2026', 'fp-2027')

      expect(entry).toEqual({ id: 'ib-2027-flat' })
      expect(createJournalEntry).toHaveBeenCalledTimes(2)
      expect(calls).toContainEqual({ table: 'journal_entries', method: 'eq', args: ['fiscal_period_id', 'fp-2027'] })
      expect(calls).toContainEqual({ table: 'journal_entries', method: 'eq', args: ['source_type', 'opening_balance'] })
      expect(calls).toContainEqual({ table: 'journal_entries', method: 'eq', args: ['status', 'posted'] })
    })

    it('does not retry when the next period already holds a posted IB', async () => {
      vi.mocked(createJournalEntry).mockRejectedValueOnce(new BookkeepingDatabaseError('commit_entry', 'trigger refused the line', 'P0001'))
      const { client } = splitClient([{ data: [{ id: 'ib-posted' }] }])
      await expect(generateOpeningBalances(client as never, 'co-1', 'user-1', 'fp-2026', 'fp-2027')).rejects.toThrow(/trigger refused/)
      expect(createJournalEntry).toHaveBeenCalledTimes(1)
    })

    it('does not retry when the posted-IB read fails', async () => {
      vi.mocked(createJournalEntry).mockRejectedValueOnce(
        new BookkeepingDatabaseError('create_entry_lines', 'violates check constraint "jel_dimensions_well_formed"', '23514')
      )
      const { client } = splitClient([{ error: { message: 'connection reset' } }])
      await expect(generateOpeningBalances(client as never, 'co-1', 'user-1', 'fp-2026', 'fp-2027')).rejects.toThrow(/jel_dimensions_well_formed/)
      expect(createJournalEntry).toHaveBeenCalledTimes(1)
    })

    it('treats an IB whose only project balances are on 26xx as unsplit (no tagged line, no retry)', async () => {
      vi.mocked(createJournalEntry).mockRejectedValueOnce(new BookkeepingDatabaseError('commit_entry', 'period locked', 'P0001'))
      const { client } = makeClient({
        fiscal_periods: [{ data: NEXT }, { error: null }],
        dimensions: [{ data: [{ sie_dim_no: 6 }] }],
        'rpc:compute_object_closing_balances': [{ data: [{ account_number: '2611', dimensions: { '6': 'P1' }, net: -250 }] }],
      })
      await expect(generateOpeningBalances(client as never, 'co-1', 'user-1', 'fp-2026', 'fp-2027')).rejects.toThrow(/period locked/)
      expect(createJournalEntry).toHaveBeenCalledTimes(1)
      const input = vi.mocked(createJournalEntry).mock.calls[0][3]
      expect(input.lines.every((l) => l.dimensions === undefined)).toBe(true)
    })
  })
})
