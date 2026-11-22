import { describe, it, expect, vi, beforeEach } from 'vitest'

// The line reads are stubbed: these tests cover what the search asks for and
// the check over what comes back (the two-step read itself is covered in
// lib/bookkeeping/__tests__).
vi.mock('@/lib/bookkeeping/entry-lines', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/entry-lines')>()),
  fetchEntryLines: vi.fn(),
  fetchLinesByEntryIds: vi.fn(),
}))

import { fetchEntryLines, fetchLinesByEntryIds } from '@/lib/bookkeeping/entry-lines'
import {
  findDirectLedgerHolders,
  findDirectLedgerHoldersForIds,
  sameCounterLine,
  selectDirectHolders,
  type DirectCandidateEntry,
  type DirectHolderProbe,
} from '../lib/skattekonto-direct'

type Line = { account_number: string; debit_amount: number; credit_amount: number }
const D = (account: string, amount: number): Line => ({ account_number: account, debit_amount: amount, credit_amount: 0 })
const K = (account: string, amount: number): Line => ({ account_number: account, debit_amount: 0, credit_amount: amount })

function entry(id: string, date: string, lines: Line[], extra: Partial<DirectCandidateEntry> = {}): DirectCandidateEntry {
  return {
    id,
    entry_date: date,
    status: 'posted',
    voucher_series: 'A',
    voucher_number: Number(id.replace(/\D/g, '')) || 1,
    description: `Verifikat ${id}`,
    reverses_id: null,
    reversed_by_id: null,
    source_type: 'import',
    lines,
    ...extra,
  }
}

function probe(id: string, date: string, account: string, net: number): DirectHolderProbe {
  return { id, transaktionsdatum: date, counter: { account, net } }
}

// A previous system's month verifikat: the bank pays the month's tax
// straight to the tax accounts, no 1630 line (PH 171, February 2026).
const FEBRUARY = entry('a14', '2026-02-28', [
  K('1930', 60400),
  D('2510', 1779),
  D('2650', 17637),
  D('2710', 20430),
  D('2731', 20563),
  K('8314', 9),
])

// Each Skatteverket row of February as its booking's counter line (ledger
// sign): charges debit the tax account, the payment credits the bank, the
// interest income credits 8314.
const FEBRUARY_ROWS = [
  probe('moms', '2026-02-12', '2650', 17637),
  probe('personalskatt', '2026-02-12', '2710', 20430),
  probe('avgifter', '2026-02-12', '2731', 20563),
  probe('fskatt', '2026-02-12', '2510', 1779),
  probe('inbetalning', '2026-02-13', '1930', -60400),
  probe('ranta', '2026-02-01', '8314', -9),
]

function select(probes: DirectHolderProbe[], entries: DirectCandidateEntry[], opts: { linked?: string[]; account?: '1630' | '2012' } = {}) {
  return selectDirectHolders({
    probes,
    entries,
    linkedEntryIds: new Set(opts.linked ?? []),
    account: opts.account ?? '1630',
  })
}

function heldBy(result: Map<string, Array<{ journal_entry_id: string }>>, id: string): string[] {
  return (result.get(id) ?? []).map((h) => h.journal_entry_id)
}

describe('selectDirectHolders', () => {
  it('finds every row of a month the previous system paid straight from the bank, without 1630', () => {
    const result = select(FEBRUARY_ROWS, [FEBRUARY])
    for (const p of FEBRUARY_ROWS) expect(heldBy(result, p.id)).toEqual(['a14'])
    expect(result.get('moms')?.[0]).toMatchObject({
      voucher_series: 'A',
      voucher_number: 14,
      entry_date: '2026-02-28',
      status: 'posted',
    })
  })

  it('finds a bank line booked straight to 2510: both the payment row and the charge row', () => {
    const bank = entry('b172', '2026-09-02', [K('1930', 618), D('2510', 618)], { source_type: 'bank_transaction' })
    const result = select(
      [probe('in', '2026-09-03', '1930', -618), probe('charge', '2026-09-14', '2510', 618)],
      [bank],
    )
    expect(heldBy(result, 'in')).toEqual(['b172'])
    expect(heldBy(result, 'charge')).toEqual(['b172'])
  })

  // The seed rule moved debiterad preliminärskatt from 2510 to 2518 Betald
  // F-skatt (migration 20261120150000); a bank line booked to 2510 before
  // the move still holds the row the rule now books to 2518.
  it('finds a bank line booked to 2510 for a row the rule now books to 2518', () => {
    const bank = entry('b180', '2026-11-03', [K('1930', 1779), D('2510', 1779)], { source_type: 'bank_transaction' })
    const result = select([probe('charge', '2026-11-12', '2518', 1779)], [bank])
    expect(heldBy(result, 'charge')).toEqual(['b180'])
    expect(heldBy(select([probe('moms', '2026-11-12', '2650', 1779)], [bank]), 'moms')).toEqual([])
  })

  it('never reaches the neighbouring month: a fixed monthly amount recurs', () => {
    // March's arbetsgivaravgifter equal February's to the krona; only the
    // March verifikat may hold the March row.
    const result = select([probe('mars', '2026-03-12', '2731', 20563)], [FEBRUARY])
    expect(heldBy(result, 'mars')).toEqual([])
  })

  it('leaves a verifikat with a line on the skattekonto account to the twin, cover and plan guards', () => {
    const withSkattekonto = entry('a33', '2026-05-31', [D('1630', 100), K('1930', 69354), D('2650', 26482), D('2510', 1779), D('2710', 20430), D('2731', 20563)])
    expect(heldBy(select([probe('moms', '2026-05-12', '2650', 26482)], [withSkattekonto]), 'moms')).toEqual([])
  })

  it('reads the company account: a 2012 verifikat holds the payment of a company on 1630, not of one on 2012', () => {
    const onEquity = entry('v132', '2025-07-25', [K('1930', 5000), D('2012', 5000)])
    const p = probe('in', '2025-07-26', '1930', -5000)
    expect(heldBy(select([p], [onEquity], { account: '1630' }), 'in')).toEqual(['v132'])
    expect(heldBy(select([p], [onEquity], { account: '2012' }), 'in')).toEqual([])
  })

  it('needs a payment: an accrual without a bank line, or a transfer between bank accounts, never holds a row', () => {
    const accrual = entry('l1', '2026-02-28', [D('7510', 20563), K('2731', 20563)])
    const reversedAccrual = entry('l2', '2026-02-28', [K('7510', 20563), D('2731', 20563)])
    const transfer = entry('t1', '2026-02-12', [K('1930', 60400), D('1940', 60400)])
    const result = select(
      [probe('avgifter', '2026-02-12', '2731', 20563), probe('in', '2026-02-13', '1930', -60400)],
      [accrual, reversedAccrual, transfer],
    )
    expect(heldBy(result, 'avgifter')).toEqual([])
    expect(heldBy(result, 'in')).toEqual([])
  })

  it('needs the same side: the salary credits 2710, the charge debits it', () => {
    const salary = entry('s1', '2026-02-25', [D('7010', 60000), K('2710', 20430), K('1930', 39570)])
    expect(heldBy(select([probe('personalskatt', '2026-02-12', '2710', 20430)], [salary]), 'personalskatt')).toEqual([])
  })

  it('compares the net on the account: lines that cancel out hold nothing', () => {
    const selfCancelling = entry('a1', '2025-10-25', [D('1930', 15569), K('1930', 15569)])
    expect(heldBy(select([probe('in', '2025-10-25', '1930', -15569)], [selfCancelling]), 'in')).toEqual([])
  })

  it('skips cancelled, reversed, storno, opening-balance and linked verifikat', () => {
    const lines = [K('1930', 4288), D('2650', 4288)]
    const annulled = entry('v10', '2025-10-30', lines)
    const annulment = entry('v11', '2025-10-30', [D('1930', 4288), K('2650', 4288)], { description: 'Annullering av A10' })
    const reversed = entry('v12', '2025-10-29', lines, { status: 'reversed', reversed_by_id: 'v13' })
    const storno = entry('v13', '2025-10-29', [D('1930', 4288), K('2650', 4288)], { reverses_id: 'v12' })
    const opening = entry('v14', '2025-10-01', lines, { source_type: 'opening_balance' })
    const linked = entry('v15', '2025-10-30', lines)
    const result = select([probe('moms', '2025-10-30', '2650', 4288)], [annulled, annulment, reversed, storno, opening, linked], {
      linked: ['v15'],
    })
    expect(heldBy(result, 'moms')).toEqual([])
  })

  it('counts a draft bank verifikat: committing it later would double the event too', () => {
    const draft = entry('d1', '2026-02-10', [K('1930', 17637), D('2650', 17637)], { status: 'draft', voucher_number: 0 })
    expect(heldBy(select([probe('moms', '2026-02-12', '2650', 17637)], [draft]), 'moms')).toEqual(['d1'])
  })

  it('lists the nearest verifikat first', () => {
    const early = entry('e1', '2026-02-02', [K('1930', 1779), D('2510', 1779)])
    const near = entry('e2', '2026-02-11', [K('1930', 1779), D('2510', 1779)])
    expect(heldBy(select([probe('fskatt', '2026-02-12', '2510', 1779)], [early, near]), 'fskatt')).toEqual(['e2', 'e1'])
  })

  it('answers every probe, empty for a zero line or a line on the skattekonto account', () => {
    const result = select([probe('zero', '2026-02-12', '2650', 0), probe('self', '2026-02-12', '1630', 100)], [FEBRUARY])
    expect(result.get('zero')).toEqual([])
    expect(result.get('self')).toEqual([])
  })
})

describe('sameCounterLine', () => {
  it('compares account and amount to the öre', () => {
    expect(sameCounterLine({ account: '1650', net: -100.1 }, { account: '1650', net: -100.1 })).toBe(true)
    expect(sameCounterLine({ account: '1650', net: -100 }, { account: '2650', net: -100 })).toBe(false)
    expect(sameCounterLine({ account: '2650', net: -100 }, { account: '2650', net: 100 })).toBe(false)
  })
})

/** A supabase stub for the link read (skattekonto_transactions) only. */
function linkSupabase(linked: Array<{ journal_entry_id: string }>, error: { message: string } | null = null) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'is']) {
    chain[m] = (...args: unknown[]) => {
      calls.push({ method: m, args })
      return chain
    }
  }
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: error ? null : linked, error })
  const from = vi.fn(() => chain)
  return { supabase: { from } as never, from, calls }
}

/** What fetchEntryLines returns: the matching lines with their entry attached. */
function asHeadLines(entries: DirectCandidateEntry[], accounts: string[]) {
  return entries.flatMap((e) =>
    e.lines
      .filter((l) => accounts.includes(l.account_number))
      .map((l) => {
        const { lines: _lines, ...head } = e
        void _lines
        return { ...l, journal_entries: head }
      }),
  )
}

function allLines(entries: DirectCandidateEntry[]) {
  return entries.flatMap((e) => e.lines.map((l, i) => ({ ...l, id: `${e.id}-${i}`, journal_entry_id: e.id })))
}

describe('findDirectLedgerHolders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads the months of the probes with the annulment lookaround, only on the counter accounts, and answers each probe', async () => {
    const other = entry('x1', '2026-02-20', [K('1930', 999), D('6110', 999)])
    vi.mocked(fetchEntryLines).mockImplementation(async (opts) => {
      const recorded: Array<[string, unknown[]]> = []
      const q: Record<string, (...a: unknown[]) => unknown> = {}
      for (const m of ['eq', 'gte', 'lte', 'in']) q[m] = (...a: unknown[]) => (recorded.push([m, a]), q)
      opts.filterEntries(q)
      opts.filterLines?.(q)
      expect(recorded).toEqual(
        expect.arrayContaining([
          ['eq', ['company_id', 'company-1']],
          ['gte', ['entry_date', '2026-01-01']],
          ['lte', ['entry_date', '2026-03-31']],
          ['in', ['status', ['draft', 'posted']]],
        ]),
      )
      const accounts = recorded.find(([m, a]) => m === 'in' && a[0] === 'account_number')?.[1][1] as string[]
      expect(accounts.sort()).toEqual(['1930', '2510', '2518', '2650', '2710', '2731', '8314'])
      return asHeadLines([FEBRUARY, other], accounts) as never
    })
    vi.mocked(fetchLinesByEntryIds).mockImplementation(async (_s, ids) => {
      // Only the verifikat with a probe amount are read in full.
      expect(ids).toEqual(['a14'])
      return allLines([FEBRUARY]) as never
    })
    const { supabase, from } = linkSupabase([])
    const result = await findDirectLedgerHolders(supabase, 'company-1', FEBRUARY_ROWS, '1630')
    for (const p of FEBRUARY_ROWS) expect(heldBy(result, p.id)).toEqual(['a14'])
    expect(from).toHaveBeenCalledWith('skattekonto_transactions')
    expect(fetchEntryLines).toHaveBeenCalledTimes(1)
  })

  it('a verifikat a Skatteverket row is linked to holds nothing', async () => {
    vi.mocked(fetchEntryLines).mockResolvedValue(asHeadLines([FEBRUARY], ['2650']) as never)
    vi.mocked(fetchLinesByEntryIds).mockResolvedValue(allLines([FEBRUARY]) as never)
    const { supabase } = linkSupabase([{ journal_entry_id: 'a14' }])
    const result = await findDirectLedgerHolders(supabase, 'company-1', [FEBRUARY_ROWS[0]], '1630')
    expect(result.get('moms')).toEqual([])
  })

  it('reads months far apart separately, never the span between them', async () => {
    vi.mocked(fetchEntryLines).mockResolvedValue([])
    const { supabase } = linkSupabase([])
    const result = await findDirectLedgerHolders(
      supabase,
      'company-1',
      [probe('jan', '2025-01-12', '2650', 100), probe('dec', '2025-12-12', '2650', 100)],
      '1630',
    )
    expect(fetchEntryLines).toHaveBeenCalledTimes(2)
    expect(result.get('jan')).toEqual([])
    expect(result.get('dec')).toEqual([])
  })

  it('reads nothing without a usable probe', async () => {
    const { supabase, from } = linkSupabase([])
    const result = await findDirectLedgerHolders(supabase, 'company-1', [probe('zero', '2026-02-12', '2650', 0)], '1630')
    expect(result.get('zero')).toEqual([])
    expect(fetchEntryLines).not.toHaveBeenCalled()
    expect(from).not.toHaveBeenCalled()
  })

  it('fails closed with a Swedish message when a read fails', async () => {
    vi.mocked(fetchEntryLines).mockRejectedValue(new Error('timeout'))
    const { supabase } = linkSupabase([])
    await expect(findDirectLedgerHolders(supabase, 'company-1', [FEBRUARY_ROWS[0]], '1630')).rejects.toThrow(
      /Kunde inte kontrollera om händelsen redan finns i bokföringen/,
    )
    vi.mocked(fetchEntryLines).mockResolvedValue(asHeadLines([FEBRUARY], ['2650']) as never)
    vi.mocked(fetchLinesByEntryIds).mockResolvedValue(allLines([FEBRUARY]) as never)
    const failing = linkSupabase([], { message: 'link read failed' })
    await expect(findDirectLedgerHolders(failing.supabase, 'company-1', [FEBRUARY_ROWS[0]], '1630')).rejects.toThrow(
      /link read failed/,
    )
  })
})

describe('findDirectLedgerHoldersForIds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads the open rows, asks for each counter line, and keeps it beside the holders', async () => {
    const rows = [
      { id: 'moms', transaktionsdatum: '2026-02-12', transaktionstext: 'Moms dec 2025', belopp_skatteverket: -17637, status: 'booked' },
      { id: 'norule', transaktionsdatum: '2026-02-12', transaktionstext: 'Okänd händelse', belopp_skatteverket: -5, status: 'booked' },
    ]
    const { supabase, calls } = linkSupabase(rows as never)
    vi.mocked(fetchEntryLines).mockResolvedValue(asHeadLines([FEBRUARY], ['2650']) as never)
    vi.mocked(fetchLinesByEntryIds).mockResolvedValue(allLines([FEBRUARY]) as never)
    const counterOf = vi.fn(async (row: { id: string }) => (row.id === 'moms' ? { account: '2650', net: 17637 } : null))
    // The same stub answers the row read and the link read: the link read
    // finds no row linked to a14 because the stub's rows carry no
    // journal_entry_id.
    const result = await findDirectLedgerHoldersForIds(supabase, 'company-1', ['moms', 'norule'], '1630', counterOf)
    expect(counterOf).toHaveBeenCalledTimes(2)
    expect(result.get('moms')).toMatchObject({ counter: { account: '2650', net: 17637 }, holders: [{ journal_entry_id: 'a14' }] })
    expect(result.has('norule')).toBe(false)
    // Open rows only: not ignored, not linked.
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['is_ignored', false] },
        { method: 'is', args: ['journal_entry_id', null] },
      ]),
    )
  })

  it('reads nothing for no ids', async () => {
    const { supabase, from } = linkSupabase([])
    expect((await findDirectLedgerHoldersForIds(supabase, 'company-1', [], '1630', vi.fn())).size).toBe(0)
    expect(from).not.toHaveBeenCalled()
  })
})
