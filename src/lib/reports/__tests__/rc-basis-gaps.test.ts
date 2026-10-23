/**
 * Tests for findRcBasisGaps: per-voucher FK004 detection.
 *
 * Mocks the entry-lines fetch layer and resolvePeriodDates. The period must
 * resolve through resolvePeriodDates (not the calendar arithmetic) so yearly
 * (helårsmoms) worklists cover extended/broken räkenskapsår: a calendar span
 * hid gap vouchers that the declaration totals still included.
 *
 * The per-verifikat rule (readVerifikatRcBasis) is also what the Korrigera
 * route reads a verifikat with at correction time (crm#1096), so it is pinned
 * here against the declaration's own account resolution.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const resolvePeriodDatesMock = vi.fn()
vi.mock('../vat-declaration', () => ({
  resolvePeriodDates: (...args: unknown[]) => resolvePeriodDatesMock(...args),
}))

const fetchEntryLinesMock = vi.fn()
const fetchLinesByEntryIdsMock = vi.fn()
const fetchEntriesWithAccountLinesMock = vi.fn()
vi.mock('@/lib/bookkeeping/entry-lines', async (orig) => ({
  ...(await orig<typeof import('@/lib/bookkeeping/entry-lines')>()),
  fetchEntryLines: (...args: unknown[]) => fetchEntryLinesMock(...args),
  fetchLinesByEntryIds: (...args: unknown[]) => fetchLinesByEntryIdsMock(...args),
  fetchEntriesWithAccountLines: (...args: unknown[]) => fetchEntriesWithAccountLinesMock(...args),
}))

const fetchDynamicVatAccountsMock = vi.fn()
vi.mock('../vat-revenue-accounts', () => ({
  fetchDynamicVatAccounts: (...args: unknown[]) => fetchDynamicVatAccountsMock(...args),
}))

import { findRcBasisGaps, rcBasisReading, readVerifikatRcBasis } from '../rc-basis-gaps'

const supabase = {} as SupabaseClient

function rcLine(entryId: string, voucherNumber: number, credit: number, account = '2614') {
  return {
    journal_entry_id: entryId,
    account_number: account,
    debit_amount: 0,
    credit_amount: credit,
    journal_entries: {
      id: entryId,
      voucher_number: voucherNumber,
      voucher_series: 'A',
      entry_date: '2026-05-20',
      description: `Voucher ${voucherNumber}`,
    },
  }
}

function line(entryId: string, account: string, debit: number, credit = 0) {
  return { journal_entry_id: entryId, account_number: account, debit_amount: debit, credit_amount: credit }
}

/**
 * The fiktiv moms lines the scan selects verifikat by, and every line of
 * those verifikat (the fiktiv moms lines included, as the line fetch returns
 * them) beside `otherLines`.
 */
function mockVerifikat(rcLines: ReturnType<typeof rcLine>[], otherLines: ReturnType<typeof line>[] = []) {
  fetchEntryLinesMock.mockResolvedValue(rcLines)
  fetchLinesByEntryIdsMock.mockResolvedValue(verifikatLines(rcLines, otherLines))
}

function verifikatLines(rcLines: ReturnType<typeof rcLine>[], otherLines: ReturnType<typeof line>[]) {
  return [...rcLines.map(({ journal_entries: _entry, ...rest }) => rest), ...otherLines]
    .map((l, i) => ({ id: `l-${i}`, ...l }))
}

/**
 * The same verifikat as get_entries_with_account_lines returns them: each
 * with every line, the verifikat ordered by id.
 */
function mockVerifikatRpc(rcLines: ReturnType<typeof rcLine>[], otherLines: ReturnType<typeof line>[] = []) {
  const lines = verifikatLines(rcLines, otherLines)
  const entries = new Map(rcLines.map((l) => [l.journal_entry_id, l.journal_entries]))
  fetchEntriesWithAccountLinesMock.mockResolvedValue(
    [...entries.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((entry) => ({
        ...entry,
        status: 'posted',
        source_type: 'manual',
        source_id: null,
        reverses_id: null,
        correction_of_id: null,
        lines: lines
          .filter((l) => l.journal_entry_id === entry.id)
          .map(({ id, account_number, debit_amount, credit_amount }) => ({ id, account_number, debit_amount, credit_amount })),
      })),
  )
}

/** The company's kontoplan, resolved by the declaration's own loader. */
async function chart(rows: Array<{ account: string; treatment: string; rate?: number | null }>) {
  const { fetchDynamicVatAccounts } = await vi.importActual<typeof import('../vat-revenue-accounts')>(
    '../vat-revenue-accounts',
  )
  const { supabase: db, enqueue } = createQueuedMockSupabase()
  enqueue({
    data: rows.map(({ account, treatment, rate }) => ({
      account_number: account,
      account_name: account,
      account_class: Number(account.charAt(0)),
      default_vat_treatment: treatment,
      default_vat_rate: rate ?? null,
      vat_box: null,
    })),
  })
  return fetchDynamicVatAccounts(db as never, 'company-1')
}

describe('findRcBasisGaps', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolvePeriodDatesMock.mockResolvedValue({ start: '2025-07-17', end: '2026-12-31' })
    fetchEntryLinesMock.mockResolvedValue([])
    fetchLinesByEntryIdsMock.mockResolvedValue([])
    // No get_entries_with_account_lines yet: the paged read answers.
    fetchEntriesWithAccountLinesMock.mockResolvedValue(null)
    fetchDynamicVatAccountsMock.mockResolvedValue({
      explicitAccounts: new Set(),
      mappingByAccount: new Map(),
      rcBasisRateByAccount: new Map(),
    })
  })

  it('resolves the period via resolvePeriodDates with the fiscal period id', async () => {
    await findRcBasisGaps(supabase, 'company-1', 'yearly', 2026, 1, { fiscalPeriodId: 'fp-1' })

    expect(resolvePeriodDatesMock).toHaveBeenCalledWith(
      supabase, 'company-1', 'yearly', 2026, 1, 'fp-1',
    )
  })

  it('filters entries on the resolved bounds, not the calendar year', async () => {
    await findRcBasisGaps(supabase, 'company-1', 'yearly', 2026, 1, { fiscalPeriodId: 'fp-1' })

    const { filterEntries } = fetchEntryLinesMock.mock.calls[0][0]
    const calls: Array<[string, ...unknown[]]> = []
    const q = new Proxy(
      {},
      {
        get:
          (_t, method: string) =>
          (...args: unknown[]) => {
            calls.push([method, ...args])
            return q
          },
      },
    )
    filterEntries(q)

    expect(calls).toContainEqual(['gte', 'entry_date', '2025-07-17'])
    expect(calls).toContainEqual(['lte', 'entry_date', '2026-12-31'])
  })

  it('flags vouchers whose RC output VAT lacks a matching basis pair', async () => {
    mockVerifikat(
      [
        rcLine('entry-1', 8, 527.29), // no basis lines at all
        rcLine('entry-2', 9, 250), // fully booked basis
      ],
      [line('entry-2', '4535', 1000)],
    )

    const gaps = await findRcBasisGaps(supabase, 'company-1', 'monthly', 2026, 5)

    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({
      entryId: 'entry-1',
      voucherNumber: 8,
      rcOutputAccount: '2614',
      rcOutputAmount: 527.29,
      expectedBasisAmount: 2109.16,
      missingBasisAmount: 2109.16,
      suggestedBasisAccount: '4535',
      rate: 0.25,
    })
  })

  it('flags a voucher whose basis is materially short of the expected amount, with what it lacks', async () => {
    mockVerifikat([rcLine('entry-1', 8, 2500)], [line('entry-1', '4535', 4000)]) // expected 10000

    const gaps = await findRcBasisGaps(supabase, 'company-1', 'monthly', 2026, 5)
    expect(gaps).toHaveLength(1)
    expect(gaps[0].expectedBasisAmount).toBe(10000)
    expect(gaps[0].missingBasisAmount).toBe(6000)
  })

  it('accepts a custom EU purchase basis account at the matching rate', async () => {
    fetchDynamicVatAccountsMock.mockResolvedValue({
      explicitAccounts: new Set(['4056']),
      mappingByAccount: new Map([['4056', { box: 'ruta20', side: 'debit' }]]),
      rcBasisRateByAccount: new Map([['4056', 0.25]]),
    })
    mockVerifikat([rcLine('entry-1', 8, 250)], [line('entry-1', '4056', 1000)])
    await expect(findRcBasisGaps(supabase, 'company-1', 'monthly', 2026, 5))
      .resolves.toEqual([])
  })

  it('does not let a 25 percent basis cover 12 percent output VAT', async () => {
    mockVerifikat([rcLine('entry-1', 8, 120, '2624')], [line('entry-1', '4535', 1000)])
    const gaps = await findRcBasisGaps(supabase, 'company-1', 'monthly', 2026, 5)
    expect(gaps).toHaveLength(1)
    expect(gaps[0].rate).toBe(0.12)
  })

  // crm#1096: the row says what Korrigera adds, which is the shortfall.
  it('reports only what a cost line whose momskod reports ruta 20-24 leaves', async () => {
    fetchDynamicVatAccountsMock.mockResolvedValue(await chart([{ account: '4056', treatment: 'reverse_charge_eu_goods' }]))
    mockVerifikat(
      [rcLine('entry-1', 8, 250)],
      [line('entry-1', '4056', 600), line('entry-1', '6540', 400), line('entry-1', '2645', 250), line('entry-1', '1930', 0, 1000)],
    )

    const gaps = await findRcBasisGaps(supabase, 'company-1', 'monthly', 2026, 5)
    expect(gaps).toEqual([
      expect.objectContaining({ entryId: 'entry-1', expectedBasisAmount: 1000, missingBasisAmount: 400 }),
    ])
  })

  it('reads each momssats of a verifikat on its own: one row per sats that falls short', async () => {
    mockVerifikat(
      [rcLine('entry-1', 8, 250), rcLine('entry-1', 8, 60, '2624')],
      [line('entry-1', '4515', 1000)],
    )

    const gaps = await findRcBasisGaps(supabase, 'company-1', 'monthly', 2026, 5)
    expect(gaps.map((g) => [g.entryId, g.rcOutputAccount, g.missingBasisAmount])).toEqual([
      ['entry-1', '2624', 500],
    ])
  })
})

describe('findRcBasisGaps through get_entries_with_account_lines', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolvePeriodDatesMock.mockResolvedValue({ start: '2026-05-01', end: '2026-05-31' })
    fetchDynamicVatAccountsMock.mockResolvedValue({
      explicitAccounts: new Set(),
      mappingByAccount: new Map(),
      rcBasisRateByAccount: new Map(),
    })
  })

  it('reads the posted verifikat on the output accounts, every line of them, in one call', async () => {
    mockVerifikatRpc([rcLine('entry-1', 8, 527.29)])

    const gaps = await findRcBasisGaps(supabase, 'company-1', 'monthly', 2026, 5)

    expect(fetchEntriesWithAccountLinesMock).toHaveBeenCalledWith(supabase, 'company-1', {
      start: '2026-05-01',
      end: '2026-05-31',
      accounts: ['2614', '2624', '2634'],
      statuses: ['posted'],
      allLines: true,
    })
    expect(fetchEntryLinesMock).not.toHaveBeenCalled()
    expect(fetchLinesByEntryIdsMock).not.toHaveBeenCalled()
    expect(gaps).toEqual([expect.objectContaining({ entryId: 'entry-1', voucherNumber: 8, missingBasisAmount: 2109.16 })])
  })

  it('finds the same gaps, in the same order, as the paged read', async () => {
    const scenarios: Array<[ReturnType<typeof rcLine>[], ReturnType<typeof line>[]]> = [
      [[rcLine('entry-2', 9, 250), rcLine('entry-1', 8, 527.29)], [line('entry-2', '4535', 1000)]],
      [[rcLine('entry-1', 8, 2500)], [line('entry-1', '4535', 4000)]],
      [[rcLine('entry-1', 8, 250), rcLine('entry-1', 8, 60, '2624')], [line('entry-1', '4515', 1000)]],
      // Two verifikat with one voucher number (two räkenskapsår in a helår): the paged order breaks the tie.
      [[rcLine('entry-b', 3, 100), rcLine('entry-a', 3, 200, '2634')], [line('entry-a', '1930', 0, 200)]],
    ]
    for (const [rcLines, otherLines] of scenarios) {
      fetchEntriesWithAccountLinesMock.mockResolvedValue(null)
      mockVerifikat(rcLines, otherLines)
      const paged = await findRcBasisGaps(supabase, 'company-1', 'monthly', 2026, 5)
      mockVerifikatRpc(rcLines, otherLines)
      const rpc = await findRcBasisGaps(supabase, 'company-1', 'monthly', 2026, 5)
      expect(rpc).toEqual(paged)
      expect(paged.length).toBeGreaterThan(0)
    }
  })
})

describe('readVerifikatRcBasis', () => {
  it('reads the basis per momssats as the filing gate buckets it', async () => {
    const accounts = await chart([
      { account: '6540', treatment: 'reverse_charge_eu_services', rate: 0.12 },
      { account: '4056', treatment: 'reverse_charge_eu_goods' },
    ])
    const { rates, unratedAccounts } = readVerifikatRcBasis(
      [
        line('e', '2614', 0, 250),
        line('e', '2624', 0, 60),
        line('e', '4056', 600), // 25 %, its momskod's default sats
        line('e', '4536', 100), // static BAS basis account, 12 %
        line('e', '6540', 400), // configured at 12 %
        line('e', '5410', 75), // ordinary cost account
        line('e', '2645', 310),
        line('e', '2440', 0, 1175),
      ],
      accounts,
    )
    expect(rates).toEqual([
      { rcOutputAccount: '2614', rate: 0.25, rcOutputAmount: 250, expectedBasisAmount: 1000, reportedBasisAmount: 600 },
      { rcOutputAccount: '2624', rate: 0.12, rcOutputAmount: 60, expectedBasisAmount: 500, reportedBasisAmount: 500 },
      { rcOutputAccount: '2634', rate: 0.06, rcOutputAmount: 0, expectedBasisAmount: 0, reportedBasisAmount: 0 },
    ])
    expect(unratedAccounts).toEqual([])
  })

  it('names an account whose momskod reports ruta 20-24 at a momssats the gate buckets no basis at', async () => {
    const accounts = await chart([{ account: '4056', treatment: 'reverse_charge_eu_goods', rate: 0 }])
    expect(rcBasisReading('4056', accounts)).toBe('unrated')
    const { rates, unratedAccounts } = readVerifikatRcBasis(
      [line('e', '4056', 1000), line('e', '2645', 250), line('e', '2614', 0, 250), line('e', '1930', 0, 1000)],
      accounts,
    )
    expect(unratedAccounts).toEqual(['4056'])
    expect(rates[0].reportedBasisAmount).toBe(0)
  })

  it('reads a momskod that reports no ruta 20-24 as no basis, also on a BAS basis account number', async () => {
    const accounts = await chart([
      { account: '4535', treatment: 'standard_25' },
      { account: '4512', treatment: 'triangulation_eu_goods' },
    ])
    expect(rcBasisReading('4535', accounts)).toBeNull()
    expect(rcBasisReading('4512', accounts)).toBeNull()
    expect(rcBasisReading('4536', accounts)).toBe(0.12)
    expect(rcBasisReading('6540', accounts)).toBeNull()
  })
})
