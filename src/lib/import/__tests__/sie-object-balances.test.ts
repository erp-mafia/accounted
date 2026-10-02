/**
 * Issue #3313: SIE #OIB/#OUB split the IB per project.
 *
 * Before, the parser counted object balance rows and dropped them ("balanser
 * per objekt stöds inte ännu"), and the IB verifikat got one untagged line
 * per account. Now each account's IB is split into one line per object of an
 * accumulating dimension plus an untagged remainder; the account total is
 * the #IB amount exactly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateJournalEntryLineInput } from '@/types'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
  replaceOpeningBalanceEntry: vi.fn(async () => ({
    newEntryId: 'ob-new',
    stornoEntryId: 'ob-storno',
    newVoucherNumber: 2,
    stornoVoucherNumber: 1,
  })),
}))

import { replaceOpeningBalanceEntry } from '@/lib/bookkeeping/engine'
import { DimensionValidationError } from '@/lib/bookkeeping/dimension-errors'
import { parseSIEFile, getEffectiveObjectOpeningBalances } from '../sie-parser'
import { buildSIEOpeningBalanceEntry, resyncNextPeriodOpeningBalance, validateIBBalance } from '../sie-import'
import { openingBalanceSplitRefusedNotice, planObjectBalances, splitBalanceLines } from '../sie-object-balances'
import { collectSIEDimensionUsage } from '../sie-dimensions'
import { prepareSIEOpeningBalance, toPrepared } from '../sie-job-preparation'
import { SIE_LIMITS } from '../sie-job-contract'
import type { CreateJournalEntryInput } from '@/types'
import type { ParsedSIEFile, SIEObjectBalance } from '../types'

const ACC6 = new Set(['6'])

function sie(...body: string[]): string {
  return ['#FLAGGA 0', '#SIETYP 4', '#RAR 0 20260101 20261231', '#RAR -1 20250101 20251231', ...body].join('\n')
}

function identity(parsed: ParsedSIEFile): Map<string, string> {
  return new Map(parsed.accounts.map((a) => [a.number, a.number]))
}

/** Net per (account, bag) of a line set: debit positive. */
function netByBag(lines: CreateJournalEntryLineInput[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of lines) {
    const key = `${line.account_number}${line.dimensions ? ' ' + JSON.stringify(line.dimensions) : ''}`
    out[key] = Math.round(((out[key] ?? 0) + line.debit_amount - line.credit_amount) * 100) / 100
  }
  return out
}

function obRow(account: string, dimNo: string, code: string, amount: number): SIEObjectBalance {
  return { yearIndex: 0, account, dimNo, code, amount }
}

describe('parseSIEFile: #OIB / #OUB', () => {
  it('parses one object per row and warns on a row with none or several', () => {
    const parsed = parseSIEFile(
      sie(
        '#IB 0 1470 3000.00',
        '#OIB 0 1470 {6 "P1"} 1000.00 2',
        '#OIB 0 1470 {} 50.00',
        '#OIB 0 1470 {1 "K1" 6 "P2"} 50.00',
        '#OUB 0 1470 {"06" "P1"} 1200.00'
      )
    )
    expect(parsed.objectOpeningBalances).toEqual([
      { yearIndex: 0, account: '1470', dimNo: '6', code: 'P1', amount: 1000, quantity: 2 },
    ])
    expect(parsed.objectClosingBalances).toEqual([
      { yearIndex: 0, account: '1470', dimNo: '6', code: 'P1', amount: 1200 },
    ])
    const warnings = parsed.issues.filter((i) => i.severity === 'warning' && i.tag === 'OIB')
    expect(warnings).toHaveLength(2)
    expect(warnings[0].message).toContain('exakt ett objekt')
  })

  it('reports skipped rows by reason, with counts, never silently', () => {
    const parsed = parseSIEFile(
      sie(
        '#IB 0 1470 3000.00',
        '#IB 0 1510 500.00',
        '#OIB 0 1470 {6 "P1"} 1000.00',
        '#OIB 0 1510 {1 "K1"} 200.00',
        '#OIB 0 1510 {1 "K2"} 100.00',
        '#OIB 0 3010 {6 "P1"} -400.00'
      )
    )
    const messages = parsed.issues.filter((i) => i.tag === 'OIB').map((i) => i.message)
    expect(messages).toEqual([
      expect.stringMatching(/^1 objektbalanser \(#OIB\) fördelar den ingående balansen per projekt på 1 konton/),
      expect.stringMatching(/^1 objektbalanser \(#OIB\) på resultatkonton hoppas över/),
      expect.stringMatching(/^2 objektbalanser \(#OIB\) på dimensioner som nollställs vid årsskiftet/),
    ])
  })

  it('warns when #OUB 0 disagrees with #OIB 0 plus the tagged movements in the file', () => {
    const parsed = parseSIEFile(
      sie(
        '#IB 0 1470 1000.00',
        '#OIB 0 1470 {6 "P1"} 1000.00',
        '#OUB 0 1470 {6 "P1"} 1250.00',
        '#VER A 1 20260115 "Arbete"',
        '{',
        '#TRANS 1470 {6 "P1"} 200.00',
        '#TRANS 4010 {6 "P1"} -200.00',
        '}'
      )
    )
    const oub = parsed.issues.filter((i) => i.tag === 'OUB')
    expect(oub).toHaveLength(1)
    expect(oub[0].severity).toBe('warning')
    expect(oub[0].message).toContain('konto 1470 objekt 6 "P1"')

    const consistent = parseSIEFile(
      sie(
        '#IB 0 1470 1000.00',
        '#OIB 0 1470 {6 "P1"} 1000.00',
        '#OUB 0 1470 {6 "P1"} 1200.00',
        '#VER A 1 20260115 "Arbete"',
        '{',
        '#TRANS 1470 {6 "P1"} 200.00',
        '#TRANS 4010 {6 "P1"} -200.00',
        '}'
      )
    )
    expect(consistent.issues.some((i) => i.tag === 'OUB')).toBe(false)
  })

  it('says the rows go unused when the file has no IB to split', () => {
    const parsed = parseSIEFile(sie('#OIB 0 1470 {6 "P1"} 1000.00'))
    expect(parsed.issues.some((i) => i.tag === 'OIB' && i.message.includes('används inte'))).toBe(true)
  })

  it('reports #OIB rows on the VAT accounts (26xx) as skipped: their IB is not split per project', () => {
    const parsed = parseSIEFile(
      sie('#IB 0 1510 1250.00', '#IB 0 2611 -250.00', '#OIB 0 1510 {6 "P1"} 1250.00', '#OIB 0 2611 {6 "P1"} -250.00')
    )
    const messages = parsed.issues.filter((i) => i.tag === 'OIB').map((i) => i.message)
    expect(messages).toEqual([
      expect.stringMatching(/^1 objektbalanser \(#OIB\) fördelar den ingående balansen per projekt på 1 konton/),
      expect.stringMatching(/^1 objektbalanser \(#OIB\) på momskonton \(26xx\) hoppas över/),
    ])
  })

  it('checks #OUB 0 against the derived opening rows (#OUB -1) when the IB is derived from #UB -1', () => {
    const file = (oub0: string) =>
      parseSIEFile(
        sie(
          '#UB -1 1470 800.00',
          '#UB -1 2081 -800.00',
          '#OUB -1 1470 {6 "P1"} 300.00',
          `#OUB 0 1470 {6 "P1"} ${oub0}`,
          '#VER A 1 20260115 "Arbete"',
          '{',
          '#TRANS 1470 {6 "P1"} 200.00',
          '#TRANS 4010 {6 "P1"} -200.00',
          '}'
        )
      )
    // 300 (#OUB -1) + 200 tagged = 500: consistent, no false warning.
    expect(file('500.00').issues.some((i) => i.tag === 'OUB')).toBe(false)
    expect(file('650.00').issues.filter((i) => i.tag === 'OUB')).toHaveLength(1)
  })

  it('skips the #OUB check when the file has no per-account IB (an IB #VER stands in for it)', () => {
    const parsed = parseSIEFile(
      sie(
        '#OUB 0 1470 {6 "P1"} 1000.00',
        '#VER A 1 20260101 "Ingående balans"',
        '{',
        '#TRANS 1470 {} 800.00',
        '#TRANS 2081 {} -800.00',
        '}',
        '#VER A 2 20260115 "Arbete"',
        '{',
        '#TRANS 1470 {6 "P1"} 200.00',
        '#TRANS 4010 {6 "P1"} -200.00',
        '}'
      )
    )
    expect(getEffectiveObjectOpeningBalances(parsed).source).toBe('none')
    expect(parsed.issues.some((i) => i.tag === 'OUB')).toBe(false)
  })
})

describe('planObjectBalances', () => {
  it('keeps accumulating dimensions on balance-sheet accounts and sums duplicates', () => {
    const plan = planObjectBalances(
      [obRow('1470', '6', 'P1', 600), obRow('1470', '6', 'P1', 400), obRow('1470', '6', 'P2', -50), obRow('1470', '6', 'P3', 0)],
      ACC6
    )
    expect(plan.byAccount.get('1470')).toEqual([
      { dimensions: { '6': 'P1' }, amount: 1000 },
      { dimensions: { '6': 'P2' }, amount: -50 },
    ])
    expect(plan.applied).toBe(4)
  })

  it('uses the registry, not the SIE number: a resetting dimension 6 carries nothing', () => {
    const plan = planObjectBalances([obRow('1470', '6', 'P1', 100), obRow('1470', '7', 'X', 100)], new Set(['7']))
    expect(plan.byAccount.get('1470')).toEqual([{ dimensions: { '7': 'X' }, amount: 100 }])
    expect(plan.skipped.resetting_dimension).toBe(1)
  })

  it('splits on projekt when an account has objects on two accumulating dimensions, and says so', () => {
    const plan = planObjectBalances([obRow('1470', '7', 'X', 100), obRow('1470', '6', 'P1', 300)], new Set(['6', '7']))
    expect(plan.byAccount.get('1470')).toEqual([{ dimensions: { '6': 'P1' }, amount: 300 }])
    expect(plan.skipped.second_dimension).toBe(1)
    expect(plan.multiDimensionAccounts).toEqual([{ account: '1470', usedDimNo: '6', ignoredDimNos: ['7'] }])
  })

  it('never splits the VAT accounts (26xx): their rows are skipped and counted', () => {
    const plan = planObjectBalances(
      [obRow('1510', '6', 'P1', 1250), obRow('2611', '6', 'P1', -250), obRow('2641', '6', 'P2', 80)],
      ACC6
    )
    expect([...plan.byAccount.keys()]).toEqual(['1510'])
    expect(plan.skipped.vat_account).toBe(2)
    expect(plan.applied).toBe(1)
  })

  it('skips codes the registry cannot hold', () => {
    const plan = planObjectBalances([obRow('1470', '6', 'a"b', 100), obRow('1470', '6', 'x'.repeat(41), 1)], ACC6)
    expect(plan.byAccount.size).toBe(0)
    expect(plan.skipped.invalid_code).toBe(2)
  })
})

describe('splitBalanceLines', () => {
  it('books each object and the remainder, netting to the total in either sign', () => {
    const lines = splitBalanceLines('1470', 3000, [{ dimensions: { '6': 'P1' }, amount: 1000 }], 'IB 1470')
    expect(lines).toEqual([
      { account_number: '1470', debit_amount: 1000, credit_amount: 0, line_description: 'IB 1470', dimensions: { '6': 'P1' } },
      { account_number: '1470', debit_amount: 2000, credit_amount: 0, line_description: 'IB 1470' },
    ])
    // An object larger than the account: the remainder is negative.
    expect(netByBag(splitBalanceLines('1470', 100, [{ dimensions: { '6': 'P1' }, amount: 250 }], 'x'))).toEqual({
      '1470 {"6":"P1"}': 250,
      '1470': -150,
    })
  })

  it('omits a zero remainder and keeps offsetting objects on a zero total', () => {
    expect(splitBalanceLines('1470', 1000, [{ dimensions: { '6': 'P1' }, amount: 1000 }], 'x')).toHaveLength(1)
    expect(
      netByBag(
        splitBalanceLines('1470', 0, [
          { dimensions: { '6': 'P1' }, amount: 100 },
          { dimensions: { '6': 'P2' }, amount: -100 },
        ], 'x')
      )
    ).toEqual({ '1470 {"6":"P1"}': 100, '1470 {"6":"P2"}': -100 })
  })
})

describe('buildSIEOpeningBalanceEntry: the IB split per project', () => {
  it('books X tagged {"6":"P1"} and Y - X untagged on 1470 (the acceptance case)', () => {
    const parsed = parseSIEFile(
      sie('#IB 0 1470 5000.00', '#IB 0 2081 -5000.00', '#OIB 0 1470 {6 "P1"} 1200.00')
    )
    const entry = buildSIEOpeningBalanceEntry('fp-1', parsed, identity(parsed), 0, 'M', '2099', { accumulating: ACC6 })!
    expect(netByBag(entry.lines)).toEqual({
      '1470 {"6":"P1"}': 1200,
      '1470': 3800,
      '2081': -5000,
    })
    // Account totals, and so the balance check, are the #IB amounts.
    expect(validateIBBalance(parsed, identity(parsed)).roundingAdjustment).toBe(0)
  })

  it('defaults to the SIE convention (projekt) when no registry set is passed', () => {
    const parsed = parseSIEFile(sie('#IB 0 1470 5000.00', '#IB 0 2081 -5000.00', '#OIB 0 1470 {6 "P1"} 1200.00'))
    const entry = buildSIEOpeningBalanceEntry('fp-1', parsed, identity(parsed), 0, 'M', '2099')!
    expect(netByBag(entry.lines)['1470 {"6":"P1"}']).toBe(1200)
  })

  it('leaves a kostnadsställe (#OIB on dimension 1) and a result account untagged', () => {
    const parsed = parseSIEFile(
      sie('#IB 0 1470 5000.00', '#IB 0 2081 -5000.00', '#OIB 0 1470 {1 "K1"} 1200.00', '#OIB 0 3010 {6 "P1"} -99.00')
    )
    const entry = buildSIEOpeningBalanceEntry('fp-1', parsed, identity(parsed), 0, 'M', '2099', { accumulating: ACC6 })!
    expect(netByBag(entry.lines)).toEqual({ '1470': 5000, '2081': -5000 })
  })

  it('splits a derived IB (#UB -1, no #IB 0) on #OUB -1', () => {
    const parsed = parseSIEFile(
      sie('#UB -1 1470 800.00', '#UB -1 2081 -800.00', '#OUB -1 1470 {6 "P1"} 300.00', '#OUB 0 1470 {6 "P1"} 999.00')
    )
    expect(getEffectiveObjectOpeningBalances(parsed).source).toBe('prior_year_oub')
    const entry = buildSIEOpeningBalanceEntry('fp-1', parsed, identity(parsed), 0, 'M', '2099', { accumulating: ACC6 })!
    expect(entry.description).toContain('härledda')
    expect(netByBag(entry.lines)).toEqual({ '1470 {"6":"P1"}': 300, '1470': 500, '2081': -800 })
  })

  it('books the objects of an account without an #IB row (a zero IB) with an offsetting remainder', () => {
    const parsed = parseSIEFile(
      sie(
        '#KONTO 1470 "Pågående arbeten"',
        '#IB 0 1930 100.00',
        '#IB 0 2081 -100.00',
        '#OIB 0 1470 {6 "P1"} 40.00',
        '#OIB 0 1470 {6 "P2"} -40.00'
      )
    )
    const entry = buildSIEOpeningBalanceEntry('fp-1', parsed, identity(parsed), 0, 'M', '2099', { accumulating: ACC6 })!
    expect(netByBag(entry.lines)).toEqual({ '1930': 100, '2081': -100, '1470 {"6":"P1"}': 40, '1470 {"6":"P2"}': -40 })
  })

  it('books a 26xx account with #OIB rows as one untagged IB line and keeps 1510 split per project', () => {
    const parsed = parseSIEFile(
      sie(
        '#IB 0 1510 2500.00',
        '#IB 0 2611 -500.00',
        '#IB 0 2081 -2000.00',
        '#OIB 0 1510 {6 "P1"} 1250.00',
        '#OIB 0 1510 {6 "P2"} 1250.00',
        '#OIB 0 2611 {6 "P1"} -250.00',
        '#OIB 0 2611 {6 "P2"} -250.00'
      )
    )
    const entry = buildSIEOpeningBalanceEntry('fp-1', parsed, identity(parsed), 0, 'M', '2099', { accumulating: ACC6 })!
    expect(entry.lines.filter((l) => l.account_number === '2611')).toEqual([
      { account_number: '2611', debit_amount: 0, credit_amount: 500, line_description: 'IB 2611' },
    ])
    expect(netByBag(entry.lines)).toEqual({
      '1510 {"6":"P1"}': 1250,
      '1510 {"6":"P2"}': 1250,
      '2611': -500,
      '2081': -2000,
    })
    const debit = Math.round(entry.lines.reduce((sum, l) => sum + l.debit_amount, 0) * 100) / 100
    const credit = Math.round(entry.lines.reduce((sum, l) => sum + l.credit_amount, 0) * 100) / 100
    expect(debit).toBe(credit)
    expect(debit).toBe(2500)
  })

  it('does not split a source account the company maps onto a 26xx account', () => {
    const parsed = parseSIEFile(
      sie('#IB 0 2890 -300.00', '#IB 0 1930 300.00', '#OIB 0 2890 {6 "P1"} -300.00', '#OIB 0 2891 {6 "P2"} -40.00')
    )
    const accountMap = new Map([['2890', '2650'], ['2891', '2650'], ['1930', '1930']])
    const entry = buildSIEOpeningBalanceEntry('fp-1', parsed, accountMap, 0, 'M', '2099', { accumulating: ACC6 })!
    expect(netByBag(entry.lines)).toEqual({ '2650': -300, '1930': 300 })
    expect(entry.lines.every((l) => l.dimensions === undefined)).toBe(true)
  })

  it('is byte-identical to the per-account IB for a file without object balances', () => {
    const parsed = parseSIEFile(sie('#IB 0 1470 5000.00', '#IB 0 2081 -5000.00'))
    const entry = buildSIEOpeningBalanceEntry('fp-1', parsed, identity(parsed), 0, 'M', '2099', { accumulating: ACC6 })!
    expect(entry.lines).toEqual([
      { account_number: '1470', debit_amount: 5000, credit_amount: 0, line_description: 'IB 1470' },
      { account_number: '2081', debit_amount: 0, credit_amount: 5000, line_description: 'IB 2081' },
    ])
  })
})

describe('collectSIEDimensionUsage: object balance codes', () => {
  it('registers the objects #OIB/#OUB reference, leaving out codes the registry cannot hold', () => {
    const parsed = parseSIEFile(
      sie('#IB 0 1470 100.00', '#OIB 0 1470 {6 "P1"} 100.00', '#OUB 0 1470 {6 "P2"} 100.00', '#OIB 0 1470 {6 "a{b"} 1.00')
    )
    const usage = collectSIEDimensionUsage(parsed)
    expect([...usage.values.keys()].sort()).toEqual(['6 P1', '6 P2'])
    expect(usage.invalidCodes.size).toBe(0)
    expect(usage.dims.get(6)?.name).toBe('Projekt')
  })
})

describe('toPrepared (resumable job path): nets per account and project bag', () => {
  it('keeps the split lines apart and nets untagged lines per account as before', () => {
    const prepared = toPrepared(
      {
        fiscal_period_id: 'fp-1',
        entry_date: '2026-01-01',
        description: 'Ingående balanser från SIE-import',
        source_type: 'opening_balance',
        voucher_series: 'M',
        lines: [
          { account_number: '1470', debit_amount: 1200, credit_amount: 0, dimensions: { '6': 'P1' } },
          { account_number: '1470', debit_amount: 3000, credit_amount: 0 },
          { account_number: '1470', debit_amount: 800, credit_amount: 0 },
          { account_number: '2081', debit_amount: 0, credit_amount: 5000 },
        ],
      },
      { id: 'job-1' },
      50_000,
      new Map([['1470', 'acc-1470']])
    )
    expect(prepared.sourceId).toBe('IB')
    expect(prepared.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount, l.dimensions, l.sort_order])).toEqual([
      ['1470', 1200, 0, { '6': 'P1' }, 0],
      ['1470', 3800, 0, {}, 1],
      ['2081', 0, 5000, {}, 2],
    ])
  })
})

describe('resyncNextPeriodOpeningBalance: splits on #OUB 0', () => {
  const { supabase, enqueue, reset } = createQueuedMockSupabase()
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('books the next IB per project from the year\'s closing object balances', async () => {
    enqueue({
      data: {
        id: 'fp-2026', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31',
        is_closed: false, locked_at: null, opening_balance_entry_id: 'ob-old', opening_balances_set: true,
      },
    }) // fiscal_periods
    enqueue({ data: { voucher_series: 'A' } }) // journal_entries: the old IB
    enqueue({ data: [{ sie_dim_no: 6 }] }) // dimensions: accumulating

    const parsed = {
      closingBalances: [
        { yearIndex: 0, account: '1470', amount: 1000 },
        { yearIndex: 0, account: '2081', amount: -1000 },
      ],
      objectClosingBalances: [{ yearIndex: 0, account: '1470', dimNo: '6', code: 'P1', amount: 700 }],
    } as unknown as ParsedSIEFile

    const result = await resyncNextPeriodOpeningBalance(
      supabase as unknown as SupabaseClient, 'co-1', 'user-1', '2025-12-31', parsed, new Map(), '2099',
    )
    expect(result).toMatchObject({ resynced: true })
    const input = vi.mocked(replaceOpeningBalanceEntry).mock.calls[0][4] as { lines: CreateJournalEntryLineInput[] }
    expect(netByBag(input.lines)).toEqual({ '1470 {"6":"P1"}': 700, '1470': 300, '2081': -1000 })
  })

  it('does not read the registry when the file has no closing object balances', async () => {
    enqueue({
      data: {
        id: 'fp-2026', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31',
        is_closed: false, locked_at: null, opening_balance_entry_id: 'ob-old', opening_balances_set: true,
      },
    })
    enqueue({ data: { voucher_series: 'A' } })

    const parsed = {
      closingBalances: [
        { yearIndex: 0, account: '1930', amount: 1000 },
        { yearIndex: 0, account: '2081', amount: -1000 },
      ],
    } as unknown as ParsedSIEFile
    await resyncNextPeriodOpeningBalance(
      supabase as unknown as SupabaseClient, 'co-1', 'user-1', '2025-12-31', parsed, new Map(), '2099',
    )
    expect(supabase.from).toHaveBeenCalledTimes(2)
    const input = vi.mocked(replaceOpeningBalanceEntry).mock.calls[0][4] as { lines: CreateJournalEntryLineInput[] }
    expect(input.lines.every((l) => l.dimensions === undefined)).toBe(true)
  })

  it('resyncs per account, flagged, when the registry refuses a #OUB object (nothing posted by the refused try)', async () => {
    enqueue({
      data: {
        id: 'fp-2026', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31',
        is_closed: false, locked_at: null, opening_balance_entry_id: 'ob-old', opening_balances_set: true,
      },
    })
    enqueue({ data: { voucher_series: 'A' } })
    enqueue({ data: [{ sie_dim_no: 6 }] })
    vi.mocked(replaceOpeningBalanceEntry).mockRejectedValueOnce(
      new DimensionValidationError([{ sie_dim_no: '6', code: 'P1', reason: 'archived_value', dimension_name: 'Projekt' }])
    )

    const parsed = {
      closingBalances: [
        { yearIndex: 0, account: '1470', amount: 1000 },
        { yearIndex: 0, account: '2081', amount: -1000 },
      ],
      objectClosingBalances: [{ yearIndex: 0, account: '1470', dimNo: '6', code: 'P1', amount: 700 }],
    } as unknown as ParsedSIEFile

    const result = await resyncNextPeriodOpeningBalance(
      supabase as unknown as SupabaseClient, 'co-1', 'user-1', '2025-12-31', parsed, new Map(), '2099',
    )
    expect(result).toMatchObject({ resynced: true, splitRefused: { reason: 'registry' } })
    expect(replaceOpeningBalanceEntry).toHaveBeenCalledTimes(2)
    const retry = vi.mocked(replaceOpeningBalanceEntry).mock.calls[1][4] as { lines: CreateJournalEntryLineInput[] }
    expect(netByBag(retry.lines)).toEqual({ '1470': 1000, '2081': -1000 })
    // Both tries replace the same old IB.
    expect(vi.mocked(replaceOpeningBalanceEntry).mock.calls[1][3]).toBe('ob-old')
  })

  it('does not swallow other failures', async () => {
    enqueue({
      data: {
        id: 'fp-2026', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31',
        is_closed: false, locked_at: null, opening_balance_entry_id: 'ob-old', opening_balances_set: true,
      },
    })
    enqueue({ data: { voucher_series: 'A' } })
    enqueue({ data: [{ sie_dim_no: 6 }] })
    vi.mocked(replaceOpeningBalanceEntry).mockRejectedValueOnce(new Error('period locked'))
    const parsed = {
      closingBalances: [
        { yearIndex: 0, account: '1470', amount: 1000 },
        { yearIndex: 0, account: '2081', amount: -1000 },
      ],
      objectClosingBalances: [{ yearIndex: 0, account: '1470', dimNo: '6', code: 'P1', amount: 700 }],
    } as unknown as ParsedSIEFile
    await expect(
      resyncNextPeriodOpeningBalance(supabase as unknown as SupabaseClient, 'co-1', 'user-1', '2025-12-31', parsed, new Map(), '2099'),
    ).rejects.toThrow('period locked')
    expect(replaceOpeningBalanceEntry).toHaveBeenCalledTimes(1)
  })
})

describe('prepareSIEOpeningBalance (resumable job path): the split never fails an import', () => {
  const { supabase, enqueue, reset } = createQueuedMockSupabase()
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  /** An IB with one project line per object on 1470, plus the equity side. */
  function ibInput(split: boolean, objects: number): CreateJournalEntryInput {
    const tagged: CreateJournalEntryLineInput[] = split
      ? Array.from({ length: objects }, (_, i) => ({
          account_number: '1470', debit_amount: 1, credit_amount: 0, dimensions: { '6': `P${i + 1}` },
        }))
      : [{ account_number: '1470', debit_amount: objects, credit_amount: 0 }]
    return {
      fiscal_period_id: 'fp-1', entry_date: '2026-01-01', description: 'Ingående balanser från SIE-import',
      source_type: 'opening_balance', voucher_series: 'M',
      lines: [...tagged, { account_number: '2081', debit_amount: 0, credit_amount: objects }],
    }
  }
  const prepare = (input: CreateJournalEntryInput) => toPrepared(input, { id: 'job-1' }, 50_000, new Map())

  it('keeps the split when the registry accepts every object', async () => {
    enqueue({ data: { dimensions_enabled: true } }) // company_settings
    enqueue({ data: [{ id: 'd6', sie_dim_no: 6, name: 'Projekt', is_active: true }] }) // dimensions
    enqueue({ data: [{ dimension_id: 'd6', code: 'P1', is_active: true }, { dimension_id: 'd6', code: 'P2', is_active: true }] })
    const result = await prepareSIEOpeningBalance(
      supabase as unknown as SupabaseClient, 'co-1', (split) => ibInput(split, 2), true, prepare,
    )
    expect(result?.splitRefused).toBeUndefined()
    expect(result?.prepared.lines.filter((l) => Object.keys(l.dimensions).length > 0)).toHaveLength(2)
  })

  it('books the IB per account, flagged, when the split is over the 2 000-line entry limit', async () => {
    const objects = SIE_LIMITS.chunkLines + 1
    const result = await prepareSIEOpeningBalance(
      supabase as unknown as SupabaseClient, 'co-1', (split) => ibInput(split, objects), true, prepare,
    )
    expect(result?.splitRefused).toEqual({ reason: 'line_limit', lines: objects + 1 })
    expect(result?.prepared.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount, l.dimensions])).toEqual([
      ['1470', objects, 0, {}],
      ['2081', 0, objects, {}],
    ])
    // Over the limit is decided before any registry read.
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('books the IB per account, flagged, when the registry refuses an object (as the direct path does)', async () => {
    enqueue({ data: { dimensions_enabled: true } })
    enqueue({ data: [{ id: 'd6', sie_dim_no: 6, name: 'Projekt', is_active: true }] })
    enqueue({ data: [{ dimension_id: 'd6', code: 'P1', is_active: false }] }) // P1 archived
    const result = await prepareSIEOpeningBalance(
      supabase as unknown as SupabaseClient, 'co-1', (split) => ibInput(split, 1), true, prepare,
    )
    expect(result?.splitRefused).toMatchObject({ reason: 'registry' })
    expect(result?.prepared.lines.every((l) => Object.keys(l.dimensions).length === 0)).toBe(true)
  })

  it('reads nothing and flags nothing for a file without object balances', async () => {
    const build = vi.fn((split: boolean) => ibInput(split, 3))
    const result = await prepareSIEOpeningBalance(supabase as unknown as SupabaseClient, 'co-1', build, false, prepare)
    expect(result?.splitRefused).toBeUndefined()
    expect(build).toHaveBeenCalledTimes(1)
    expect(build).toHaveBeenCalledWith(false)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns null when there is no IB to book', async () => {
    expect(await prepareSIEOpeningBalance(supabase as unknown as SupabaseClient, 'co-1', () => null, true, prepare)).toBeNull()
  })
})

describe('openingBalanceSplitRefusedNotice', () => {
  it('gives each refusal a structured sv/en notice next to the Swedish warning text', () => {
    const registry = openingBalanceSplitRefusedNotice({ reason: 'registry', detail: 'Projekt P1 är arkiverat' })
    expect(registry.notice).toEqual({ code: 'sie_ib_project_split_refused', severity: 'notice', params: { detail: 'Projekt P1 är arkiverat' } })
    expect(registry.text).toMatch(/utan fördelning per projekt.*Projekt P1 är arkiverat/)
    const large = openingBalanceSplitRefusedNotice({ reason: 'line_limit', lines: 2400 })
    expect(large.notice).toEqual({ code: 'sie_ib_project_split_too_large', severity: 'notice', params: { lines: 2400 } })
    expect(large.text).toMatch(/2400 rader/)
  })
})
