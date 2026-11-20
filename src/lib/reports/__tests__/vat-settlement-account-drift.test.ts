import { describe, expect, it, vi } from 'vitest'
import {
  computeSettlementAccountDrift,
  settlementAccountDrift,
  type SettlementAccountAging,
  type SettlementEntryRow,
} from '../vat-settlement-account-drift'
import { settlementAccountDriftBlocker } from '../vat-close-check'

let seq = 0
const row = (account: string, date: string, debit: number, credit: number, extra: Partial<SettlementEntryRow> = {}): SettlementEntryRow => {
  seq += 1
  return {
    account_number: account,
    entry_date: date,
    debit,
    credit,
    journal_entry_id: `je-${seq}`,
    voucher_label: `A-${seq}`,
    opening_balance: false,
    cancelled: false,
    ...extra,
  }
}
const credit = (account: string, date: string, amount: number, extra: Partial<SettlementEntryRow> = {}) => row(account, date, 0, amount, extra)
const debit = (account: string, date: string, amount: number, extra: Partial<SettlementEntryRow> = {}) => row(account, date, amount, 0, extra)

/** An ingående balans verifikat and the floor it gives its account. */
const openingBalance = (account: string, date: string, amount: number) => {
  const ib = account === '2650'
    ? credit(account, date, amount, { opening_balance: true })
    : debit(account, date, amount, { opening_balance: true })
  return { ib, floor: { date, entryIds: [ib.journal_entry_id] } }
}

const aging = (overrides: Partial<SettlementAccountAging>): SettlementAccountAging => ({
  account_number: '2650',
  balance: 0,
  counted_from: null,
  window_start: '2026-05-30',
  recent: 0,
  older: 0,
  inherited: 0,
  drift: 0,
  entries: [],
  unattributed: 0,
  ...overrides,
})

describe('settlementAccountDrift', () => {
  it('reads a quarterly filer that books every charge as clean, and a period not yet charged as recent', () => {
    const rows = [
      credit('2650', '2026-03-31', 10000), // Q1 momsredovisning
      debit('2650', '2026-05-12', 10000), // Skatteverket's charge, booked
      credit('2650', '2026-06-30', 12000), // Q2, due 12 August
    ]
    // 26 October: Q2 lies 118 days back, inside the window even if not yet booked as charged.
    const october = settlementAccountDrift(rows, '2026-10-26', null)
    expect(october.payable.drift).toBe(0)
    expect(october.receivable.drift).toBe(0)
    // 1 December: Q2's charge was due long ago and is still not booked.
    expect(settlementAccountDrift(rows, '2026-12-01', null).payable.drift).toBe(12000)
  })

  it('adds up every period whose charge was never booked', () => {
    const rows = [credit('2650', '2025-03-31', 8000), credit('2650', '2025-06-30', 9000), credit('2650', '2025-09-30', 7000)]
    expect(settlementAccountDrift(rows, '2026-10-26', null).payable.drift).toBe(24000)
  })

  it('takes the balance oldest first: one payment for two periods clears both', () => {
    const rows = [credit('2650', '2025-12-31', 10000), credit('2650', '2026-03-31', 12000), debit('2650', '2026-05-12', 22000)]
    expect(settlementAccountDrift(rows, '2026-10-26', null).payable.drift).toBe(0)
  })

  it('never flags a company that dates the momsredovisning on the charge day or clears it at once', () => {
    const rows = [credit('2650', '2025-08-12', 15000), debit('2650', '2025-08-12', 15000)]
    expect(settlementAccountDrift(rows, '2026-10-26', null).payable.drift).toBe(0)
  })

  it('nets a verifikat that moves the period onto the account and pays it in the same entry', () => {
    // Momsredovisning and payment in one verifikat, inside the window: nothing
    // came onto the account, so it hides none of the older moms.
    const rows = [credit('2650', '2026-01-31', 5000), row('2650', '2026-09-30', 9000, 9000)]
    expect(settlementAccountDrift(rows, '2026-10-26', null).payable).toMatchObject({ balance: 5000, recent: 0, drift: 5000 })
  })

  it('flags a refund that was never booked as paid out', () => {
    const rows = [debit('1650', '2025-12-31', 4300)]
    const drift = settlementAccountDrift(rows, '2026-10-26', null)
    expect(drift.payable.drift).toBe(0)
    expect(drift.receivable.drift).toBe(4300)
  })

  it('reports what was already stale at the last imported verifikat apart, and only what built up since as drift', () => {
    const rows = [
      credit('2650', '2018-09-01', 50000), // opening balance in the old system, never cleared
      credit('2650', '2026-03-31', 10000), // after the move: Q1, never charged
    ]
    expect(settlementAccountDrift(rows, '2026-10-26', '2025-12-31').payable).toMatchObject({ drift: 10000, inherited: 50000 })
    expect(settlementAccountDrift([rows[0]], '2026-10-26', '2025-12-31').payable).toMatchObject({ drift: 0, inherited: 50000 })
  })
})

describe('settlementAccountDrift: the balance is the huvudbok balance, counted from the ingående balans', () => {
  it('counts a year the ingående balans restates once, so the finding never exceeds what the account holds (crm#1924)', () => {
    // Last year left 1 000 kr to get back on 1650; the year-end rolled it into
    // this year's IB. This year: 400 more in April, 950 paid out in May, and a
    // refund in September that is still inside the window.
    const { ib, floor } = openingBalance('1650', '2026-01-01', 1000)
    const rows = [
      debit('1650', '2025-11-30', 1000),
      ib,
      debit('1650', '2026-04-30', 400),
      credit('1650', '2026-05-20', 950),
      debit('1650', '2026-09-30', 200),
    ]
    const floors = { asOf: { '1650': floor }, cutover: {} }

    const receivable = settlementAccountDrift(rows, '2026-11-16', null, floors).receivable
    // Huvudboken: IB 1 000 + 400 - 950 + 200 = 650, of which 200 is recent.
    expect(receivable).toMatchObject({ balance: 650, counted_from: '2026-01-01', recent: 200, older: 450, drift: 450 })
    expect(receivable.drift).toBeLessThanOrEqual(receivable.balance)
    // April's 400, then 50 of what the ingående balans carried in.
    expect(receivable.entries.map((e) => [e.entry_date, e.counted, e.opening_balance])).toEqual([
      ['2026-04-30', 400, false],
      ['2026-01-01', 50, true],
    ])

    // Without the floor every posting is summed and last year counts twice:
    // the figure the close check used to give, more than the account holds.
    expect(settlementAccountDrift(rows, '2026-11-16', null).receivable.drift).toBe(1450)
  })

  it('is the same on every date an ingående balans lies behind: a paid year never comes back as drift', () => {
    // Q4 moved onto 2650 on 31 December, carried by the IB, charged and booked in February.
    const { ib, floor } = openingBalance('2650', '2026-01-01', 10000)
    const rows = [credit('2650', '2025-12-31', 10000), ib, debit('2650', '2026-02-12', 10000)]
    const floors = { asOf: { '2650': floor }, cutover: {} }
    for (const day of ['2026-02-01', '2026-03-01', '2026-06-15', '2026-11-16']) {
      expect(settlementAccountDrift(rows, day, null, floors).payable.drift).toBe(0)
    }
    // Summed over all history the IB's 10 000 stood there again from its 150th day.
    expect(settlementAccountDrift(rows, '2026-11-16', null).payable.drift).toBe(10000)
  })

  it('lets the verifikat before an ingående balans say how old it is while the year is young', () => {
    // 6 000 from March was never charged; Q4 (9 000) is not due yet. The IB
    // carries both. In February only Q4 is recent: the March moms is drift.
    const { ib, floor } = openingBalance('2650', '2026-01-01', 15000)
    const rows = [credit('2650', '2025-03-31', 6000), credit('2650', '2025-12-31', 9000), ib]
    const payable = settlementAccountDrift(rows, '2026-02-01', null, { asOf: { '2650': floor }, cutover: {} }).payable
    expect(payable).toMatchObject({ balance: 15000, recent: 9000, drift: 6000, unattributed: 0 })
    expect(payable.entries).toEqual([
      expect.objectContaining({ voucher_label: rows[0].voucher_label, entry_date: '2025-03-31', amount: 6000, counted: 6000 }),
    ])
  })

  it('counts an ingående balans with nothing before it as moved on at its date: a migrated balance is not drift', () => {
    const { ib, floor } = openingBalance('2650', '2026-01-01', 8000)
    const floors = { asOf: { '2650': floor }, cutover: {} }
    expect(settlementAccountDrift([ib], '2026-03-01', null, floors).payable).toMatchObject({ balance: 8000, recent: 8000, drift: 0 })
    // Still there 150 days on: now it is older moms, named as the ingående balans.
    const later = settlementAccountDrift([ib], '2026-11-16', null, floors).payable
    expect(later.drift).toBe(8000)
    expect(later.entries).toEqual([expect.objectContaining({ opening_balance: true, entry_date: '2026-01-01', counted: 8000 })])
  })

  it('takes what was stale at the last import from the ingående balans that stood then', () => {
    // Imported year 2025: its IB carries 50 000 the old system never cleared.
    // The year-end then rolled it into 2026, where Q1 was never charged.
    const imported = openingBalance('2650', '2025-01-01', 50000)
    const rolled = openingBalance('2650', '2026-01-01', 50000)
    const rows = [imported.ib, rolled.ib, credit('2650', '2026-03-31', 10000)]
    const payable = settlementAccountDrift(rows, '2026-10-26', '2025-12-31', {
      asOf: { '2650': rolled.floor },
      cutover: { '2650': imported.floor },
    }).payable
    expect(payable).toMatchObject({ balance: 60000, older: 60000, inherited: 50000, drift: 10000 })
  })
})

describe('settlementAccountDrift: the verifikat the drift comes from', () => {
  it('names the latest verifikat before the window, as far back as the amount reaches', () => {
    const rows = [
      credit('2650', '2026-01-31', 3000),
      credit('2650', '2026-02-28', 4000),
      debit('2650', '2026-03-12', 3000), // January's charge, booked
      credit('2650', '2026-03-31', 5000),
      credit('2650', '2026-09-30', 2000), // inside the window
    ]
    const payable = settlementAccountDrift(rows, '2026-10-26', null).payable
    expect(payable).toMatchObject({ balance: 11000, recent: 2000, drift: 9000, unattributed: 0 })
    expect(payable.entries.map((e) => [e.entry_date, e.amount, e.counted])).toEqual([
      ['2026-03-31', 5000, 5000],
      ['2026-02-28', 4000, 4000],
    ])
    expect(payable.entries.reduce((sum, e) => sum + e.counted, 0)).toBe(payable.drift)
  })

  it('takes only part of the oldest verifikat it reaches', () => {
    const rows = [credit('2650', '2026-01-31', 3000), credit('2650', '2026-02-28', 4000), debit('2650', '2026-03-12', 2000)]
    const payable = settlementAccountDrift(rows, '2026-10-26', null).payable
    expect(payable.entries.map((e) => [e.entry_date, e.amount, e.counted])).toEqual([
      ['2026-02-28', 4000, 4000],
      ['2026-01-31', 3000, 1000],
    ])
  })

  it('never names a stornerad verifikat or a storno: the pair cancels', () => {
    const rows = [
      credit('2650', '2026-01-31', 3000),
      credit('2650', '2026-02-28', 4000, { cancelled: true }), // stornerad
      debit('2650', '2026-03-02', 4000, { cancelled: true }), // its storno
    ]
    const payable = settlementAccountDrift(rows, '2026-10-26', null).payable
    expect(payable.drift).toBe(3000)
    expect(payable.entries.map((e) => e.entry_date)).toEqual(['2026-01-31'])
  })

  it('stops at an ingående balans: the year before is not walked through it', () => {
    const { ib, floor } = openingBalance('2650', '2026-01-01', 5000)
    const rows = [credit('2650', '2025-06-30', 5000), ib, credit('2650', '2026-02-28', 1000)]
    const payable = settlementAccountDrift(rows, '2026-10-26', null, { asOf: { '2650': floor }, cutover: {} }).payable
    expect(payable).toMatchObject({ balance: 6000, drift: 6000, unattributed: 0 })
    expect(payable.entries.map((e) => [e.entry_date, e.counted, e.opening_balance])).toEqual([
      ['2026-02-28', 1000, false],
      ['2026-01-01', 5000, true],
    ])
  })

  it('never looks for sources before the ingående balans the balance is counted from', () => {
    // The account stood the other way at the year start, and the one verifikat
    // since then is stornerad with a storno dated after as_of: nothing of this
    // year can be named, and last year's verifikat are not this balance.
    const ib = debit('2650', '2026-01-01', 500, { opening_balance: true })
    const rows = [credit('2650', '2025-06-30', 4000), ib, credit('2650', '2026-02-28', 3000, { cancelled: true })]
    const floors = { asOf: { '2650': { date: '2026-01-01', entryIds: [ib.journal_entry_id] } }, cutover: {} }
    const payable = settlementAccountDrift(rows, '2026-10-26', null, floors).payable
    expect(payable).toMatchObject({ balance: 2500, drift: 2500, entries: [], unattributed: 2500 })
  })

  it('says what no verifikat accounts for when an ingående balans holds more than the verifikat before it moved on', () => {
    const { ib, floor } = openingBalance('2650', '2026-01-01', 7000)
    const rows = [credit('2650', '2025-03-31', 5000), ib]
    const drift = settlementAccountDrift(rows, '2026-02-01', null, { asOf: { '2650': floor }, cutover: {} })
    expect(drift.payable).toMatchObject({ balance: 7000, drift: 7000, unattributed: 2000 })
    expect(drift.payable.entries.map((e) => [e.entry_date, e.counted])).toEqual([['2025-03-31', 5000]])
    expect(settlementAccountDriftBlocker(drift)?.message).toMatch(/2\s000\skr som inget verifikat på kontot förklarar/)
  })
})

describe('settlementAccountDriftBlocker', () => {
  it('stays quiet below 100 kr: öre rounding on 2650 is not a finding', () => {
    expect(settlementAccountDriftBlocker({
      as_of: '2026-10-26',
      payable: aging({ balance: 99, older: 99, drift: 99 }),
      receivable: aging({ account_number: '1650' }),
    })).toBeNull()
  })

  it('names the amount, the account and the fix as a medium finding that does not stop the close', () => {
    const blocker = settlementAccountDriftBlocker({
      as_of: '2026-10-26',
      payable: aging({ balance: 53775, older: 53775, drift: 53775 }),
      receivable: aging({ account_number: '1650' }),
    })
    expect(blocker).toMatchObject({ kind: 'earlier_vat_on_settlement_account', severity: 'medium', count: 1 })
    expect(blocker?.message).toMatch(/53\s775/)
    expect(blocker?.message).toContain('2650')
    expect(blocker?.hint).toContain('Skattekonto')
  })

  it('says which day it describes, the balance it is part of and the verifikat it comes from', () => {
    const rows = [
      debit('1650', '2026-03-31', 300),
      debit('1650', '2026-04-30', 520),
      credit('1650', '2026-05-20', 300),
      debit('1650', '2026-09-30', 190),
      credit('1650', '2026-10-20', 190),
    ]
    const drift = settlementAccountDrift(rows, '2026-11-16', null)
    const blocker = settlementAccountDriftBlocker(drift)

    // Balance 520 with 190 moved on inside the window: 330 is older, and it
    // is part of the 520 the huvudbok shows, never more.
    expect(blocker?.as_of).toBe('2026-11-16')
    expect(blocker?.message).toContain('per 2026-11-16, oavsett vilken period kontrollen gäller')
    expect(blocker?.message).toMatch(/330\skr av saldot 520\skr på 1650/)
    expect(blocker?.message).toMatch(new RegExp(`${rows[1].voucher_label} 2026-04-30: 330\\skr av 520\\skr`))
    expect(blocker?.hint).toContain('aldrig ett eget belopp att boka bort')
    expect(blocker?.settlement_accounts).toEqual([
      expect.objectContaining({
        account_number: '1650',
        balance: 520,
        recent: 190,
        older: 330,
        drift: 330,
        window_start: '2026-06-20',
        entry_count: 1,
        entries: [expect.objectContaining({ journal_entry_id: rows[1].journal_entry_id, entry_date: '2026-04-30', amount: 520, counted: 330 })],
      }),
    ])
  })

  it('names five verifikat in the sentence and the rest by count, with every one in settlement_accounts', () => {
    const rows = Array.from({ length: 8 }, (_, i) => credit('2650', `2025-0${i + 1}-28`, 1000))
    const blocker = settlementAccountDriftBlocker(settlementAccountDrift(rows, '2026-10-26', null))
    expect(blocker?.message).toContain('3 verifikat till')
    expect(blocker?.settlement_accounts?.[0]).toMatchObject({ entry_count: 8 })
    expect(blocker?.settlement_accounts?.[0].entries).toHaveLength(8)
  })
})

describe('computeSettlementAccountDrift', () => {
  const entry = (id: string, date: string, lines: Array<[string, number, number]>, extra: Record<string, unknown> = {}) => ({
    id,
    voucher_series: 'A',
    voucher_number: Number(id.replace(/\D/g, '')),
    entry_date: date,
    description: '',
    status: 'posted',
    source_type: 'manual',
    source_id: null,
    reverses_id: null,
    correction_of_id: null,
    lines: lines.map(([account_number, debit_amount, credit_amount], i) => ({ id: `${id}-l${i}`, account_number, debit_amount, credit_amount })),
    ...extra,
  })

  function mockSupabase(options: {
    entries: unknown[] | null
    lastImport?: string | null
    floors?: Record<string, Array<{ floor_date: string; amount: number; entry_ids: string[] }>>
    entriesError?: { code: string; message: string }
  }) {
    const rpc = vi.fn((fn: string, params: Record<string, unknown>) => {
      if (fn === 'get_entries_with_account_lines') {
        return Promise.resolve(options.entriesError ? { data: null, error: options.entriesError } : { data: options.entries, error: null })
      }
      if (fn === 'account_ib_floor') {
        const through = params.p_through as string
        const floor = (options.floors?.[params.p_account_number as string] ?? [])
          .filter((f) => f.floor_date <= through)
          .sort((a, b) => (a.floor_date < b.floor_date ? 1 : -1))[0]
        return { maybeSingle: async () => ({ data: floor ?? null, error: null }) }
      }
      throw new Error(`unexpected rpc ${fn}`)
    })
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'order', 'limit']) chain[m] = () => chain
    chain.maybeSingle = async () => ({ data: options.lastImport ? { entry_date: options.lastImport } : null, error: null })
    return { supabase: { from: () => chain, rpc } as never, rpc }
  }

  it('reads every verifikat on 2650 and 1650 through as_of in one call and floors each account at its ingående balans', async () => {
    const { supabase, rpc } = mockSupabase({
      entries: [
        entry('e1', '2025-11-30', [['1650', 1000, 0]]),
        entry('e2', '2026-01-01', [['1650', 1000, 0]], { source_type: 'opening_balance' }),
        entry('e3', '2026-04-30', [['1650', 400, 0], ['1650', 60, 0]]),
        entry('e4', '2026-05-20', [['1650', 0, 1000]]),
      ],
      floors: { '1650': [{ floor_date: '2026-01-01', amount: 1000, entry_ids: ['e2'] }] },
    })

    const drift = await computeSettlementAccountDrift(supabase, 'company-1', '2026-11-16')

    expect(rpc).toHaveBeenCalledWith('get_entries_with_account_lines', expect.objectContaining({
      p_company_id: 'company-1',
      p_end: '2026-11-16',
      p_accounts: ['2650', '1650'],
      p_statuses: ['posted', 'reversed'],
      p_all_lines: false,
    }))
    // IB 1 000 + 460 - 1 000: the huvudbok balance, not the 1 460 all history sums to.
    expect(drift.receivable).toMatchObject({ balance: 460, counted_from: '2026-01-01', drift: 460 })
    expect(drift.receivable.entries).toEqual([
      { journal_entry_id: 'e3', voucher_label: 'A-3', entry_date: '2026-04-30', amount: 460, counted: 460, opening_balance: false },
    ])
    expect(drift.payable).toMatchObject({ balance: 0, counted_from: null, drift: 0 })
  })

  it('asks for the floor at the last import only when an ingående balans lies after it', async () => {
    const { supabase, rpc } = mockSupabase({
      entries: [
        entry('e1', '2025-01-01', [['2650', 0, 50000]], { source_type: 'opening_balance' }),
        entry('e2', '2026-01-01', [['2650', 0, 50000]], { source_type: 'opening_balance' }),
        entry('e3', '2026-03-31', [['2650', 0, 10000]]),
      ],
      lastImport: '2025-12-31',
      floors: {
        '2650': [
          { floor_date: '2025-01-01', amount: -50000, entry_ids: ['e1'] },
          { floor_date: '2026-01-01', amount: -50000, entry_ids: ['e2'] },
        ],
      },
    })

    const drift = await computeSettlementAccountDrift(supabase, 'company-1', '2026-10-26')

    expect(drift.payable).toMatchObject({ balance: 60000, inherited: 50000, drift: 10000 })
    const floorReads = rpc.mock.calls.filter(([fn]) => fn === 'account_ib_floor').map(([, params]) => [params.p_account_number, params.p_through])
    // Both accounts on as_of; on the cutover only 2650, whose IB is newer than the import.
    expect(floorReads).toEqual([['2650', '2026-10-26'], ['1650', '2026-10-26'], ['2650', '2025-12-31']])
  })

  it('marks a stornerad verifikat and its storno so neither is named', async () => {
    const { supabase } = mockSupabase({
      entries: [
        entry('e1', '2026-01-31', [['2650', 0, 3000]]),
        entry('e2', '2026-02-28', [['2650', 0, 4000]], { status: 'reversed' }),
        entry('e3', '2026-03-02', [['2650', 4000, 0]], { reverses_id: 'e2' }),
      ],
    })
    const drift = await computeSettlementAccountDrift(supabase, 'company-1', '2026-10-26')
    expect(drift.payable.drift).toBe(3000)
    expect(drift.payable.entries.map((e) => e.journal_entry_id)).toEqual(['e1'])
  })

  it('throws when the verifikat cannot be read, so the close check leaves the finding out instead of guessing', async () => {
    const missing = mockSupabase({ entries: null, entriesError: { code: 'PGRST202', message: 'no such function' } })
    await expect(computeSettlementAccountDrift(missing.supabase, 'company-1', '2026-10-26')).rejects.toThrow('get_entries_with_account_lines is not available')
    const failed = mockSupabase({ entries: null, entriesError: { code: '57014', message: 'statement timeout' } })
    await expect(computeSettlementAccountDrift(failed.supabase, 'company-1', '2026-10-26')).rejects.toThrow('statement timeout')
  })
})
