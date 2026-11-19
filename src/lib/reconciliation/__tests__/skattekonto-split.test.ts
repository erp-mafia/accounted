import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

// The company's skattekonto account (lib/skatteverket/skattekonto-account.ts):
// 1630 here, what every company resolved to before the setting existed.
vi.mock('@/lib/skatteverket/skattekonto-account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/skatteverket/skattekonto-account')>()),
  resolveSkattekontoAccount: vi.fn(async () => '1630'),
}))

const statusMock = vi.fn()
const openLedgerMock = vi.fn()
const linkMock = vi.fn()
const unlinkMock = vi.fn()

vi.mock('../skattekonto-reconciliation', () => ({
  getSkattekontoReconciliationStatus: (...args: unknown[]) => statusMock(...args),
  skattekontoOpenLedger: (...args: unknown[]) => openLedgerMock(...args),
}))
vi.mock('@/lib/skatteverket/skattekonto-link', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/skatteverket/skattekonto-link')>()
  return {
    ...actual,
    linkSkattekontoRow: (...args: unknown[]) => linkMock(...args),
    unlinkSkattekontoRow: (...args: unknown[]) => unlinkMock(...args),
  }
})

import {
  releaseSkattekontoSettlementOf,
  splitSkattekontoRow,
  undoSkattekontoSettlement,
} from '../skattekonto-split'

const COMPANY = 'company-1'
const USER = 'user-1'
const ROW = '00000000-0000-4000-8000-000000000029'
const A77 = '00000000-0000-4000-8000-000000000077'
const A76 = '00000000-0000-4000-8000-000000000076'
const SETTLEMENT = '00000000-0000-4000-8000-0000000000ee'

const openRow = { id: ROW, belopp_skatteverket: '29.00', journal_entry_id: null, is_ignored: false, status: 'booked' }
const entryRows = [
  { id: A77, status: 'posted', entry_date: '2025-04-23', voucher_series: 'A', voucher_number: 77 },
  { id: A76, status: 'posted', entry_date: '2025-04-23', voucher_series: 'A', voucher_number: 76 },
]

function openLedger(amounts: Record<string, number>) {
  statusMock.mockResolvedValue({ ledger_read_failed: false })
  openLedgerMock.mockReturnValue(
    new Map(
      Object.entries(amounts).map(([id, amount]) => [
        id,
        { journal_entry_id: id, amount, status: 'posted', entry_date: '2025-04-23' },
      ]),
    ),
  )
}

/** Row read, verifikat read, live settlements read. */
function enqueueFacts(
  enqueue: (r: { data?: unknown; error?: unknown }) => void,
  overrides: { row?: Record<string, unknown> | null; entries?: unknown[]; live?: unknown[] } = {},
) {
  enqueue({ data: overrides.row === null ? null : { ...openRow, ...overrides.row } })
  enqueue({ data: overrides.entries ?? entryRows })
  enqueue({ data: overrides.live ?? [] })
}

beforeEach(() => {
  vi.clearAllMocks()
  linkMock.mockResolvedValue({ skattekonto_transaction_id: ROW, journal_entry_id: A77, via: 'partial', remainder: 8 })
  unlinkMock.mockResolvedValue({ skattekonto_transaction_id: ROW, previous_journal_entry_id: A77 })
})

describe('splitSkattekontoRow', () => {
  it('dry run: the slices are the open amounts, the primary carries the event sign, nothing is written', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueFacts(enqueue)
    openLedger({ [A77]: 37, [A76]: -8 })

    const r = await splitSkattekontoRow(supabase as never, COMPANY, USER, ROW, [A76, A77], { dryRun: true })

    expect(r).toEqual({
      ok: true,
      slices: [
        { journal_entry_id: A76, amount: -8 },
        { journal_entry_id: A77, amount: 37 },
      ],
      primary_journal_entry_id: A77,
      settlement_id: null,
    })
    expect(linkMock).not.toHaveBeenCalled()
    expect(findCalls('account_reconciliation_settlements', 'insert')).toEqual([])
  })

  it('live: links the row to the primary with its remainder, then settles the remainder against the rest on 1630', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueFacts(enqueue)
    enqueue({ data: null }) // settlement insert
    openLedger({ [A77]: 37, [A76]: -8 })

    const r = await splitSkattekontoRow(supabase as never, COMPANY, USER, ROW, [A77, A76])

    expect(r).toMatchObject({ ok: true, primary_journal_entry_id: A77 })
    expect(r.ok && r.settlement_id).toEqual(expect.any(String))
    expect(linkMock).toHaveBeenCalledWith(supabase, COMPANY, ROW, A77, { allowRemainder: true, account: '1630' })
    const [inserted] = findCalls('account_reconciliation_settlements', 'insert')[0] as [Array<Record<string, unknown>>]
    expect(inserted.map((m) => [m.journal_entry_id, m.amount])).toEqual([
      [A77, 8],
      [A76, -8],
    ])
    expect(inserted.every((m) => m.account_number === '1630' && m.settled_by === USER)).toBe(true)
  })

  it('records the settlement on 2012 for an enskild firma that runs the skattekonto there (PH 175)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueFacts(enqueue)
    enqueue({ data: null }) // settlement insert
    openLedger({ [A77]: 37, [A76]: -8 })

    const r = await splitSkattekontoRow(supabase as never, COMPANY, USER, ROW, [A77, A76], { account: '2012' })

    expect(r).toMatchObject({ ok: true, primary_journal_entry_id: A77 })
    expect(statusMock).toHaveBeenCalledWith(supabase, COMPANY, { account: '2012' })
    expect(linkMock).toHaveBeenCalledWith(supabase, COMPANY, ROW, A77, { allowRemainder: true, account: '2012' })
    const [inserted] = findCalls('account_reconciliation_settlements', 'insert')[0] as [Array<Record<string, unknown>>]
    expect(inserted.every((m) => m.account_number === '2012')).toBe(true)
    expect(findCalls('account_reconciliation_settlements', 'eq')).toContainEqual(['account_number', '2012'])
  })

  it('refuses when the open amounts do not sum exactly to the event, and writes nothing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueFacts(enqueue)
    openLedger({ [A77]: 37, [A76]: -7.99 })

    const r = await splitSkattekontoRow(supabase as never, COMPANY, USER, ROW, [A77, A76])

    expect(r).toMatchObject({ ok: false, code: 'PAIR_NOT_CLOSED' })
    expect(linkMock).not.toHaveBeenCalled()
    expect(findCalls('account_reconciliation_settlements', 'insert')).toEqual([])
  })

  it('refuses a verifikat that is not in the open ledger list (ENTRY_NOT_OPEN)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueFacts(enqueue)
    openLedger({ [A77]: 37 })

    const r = await splitSkattekontoRow(supabase as never, COMPANY, USER, ROW, [A77, A76])
    expect(r).toMatchObject({ ok: false, code: 'ENTRY_NOT_OPEN' })
  })

  it('refuses a verifikat already in a live 1630 settlement and names it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueFacts(enqueue, {
      live: [{ settlement_id: SETTLEMENT, journal_entry_id: A76, amount: -8, settled_by: USER, settled_at: 'x' }],
    })
    openLedger({ [A77]: 37, [A76]: -8 })

    const r = await splitSkattekontoRow(supabase as never, COMPANY, USER, ROW, [A77, A76])
    expect(r).toMatchObject({ ok: false, code: 'ALREADY_SETTLED', message: expect.stringContaining(SETTLEMENT) })
    expect(statusMock).not.toHaveBeenCalled()
  })

  it('refuses a linked, an ignored and an unknown row', async () => {
    for (const [override, code] of [
      [{ journal_entry_id: A77 }, 'ALREADY_LINKED'],
      [{ is_ignored: true }, 'ROW_IGNORED'],
      [null, 'NOT_FOUND'],
    ] as const) {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: override === null ? null : { ...openRow, ...override } })
      const r = await splitSkattekontoRow(supabase as never, COMPANY, USER, ROW, [A77, A76])
      expect(r).toMatchObject({ ok: false, code })
    }
  })

  it('refuses a makulerat verifikat and one the company does not have', async () => {
    const reversed = createQueuedMockSupabase()
    enqueueFacts(reversed.enqueue, { entries: [entryRows[0], { ...entryRows[1], status: 'reversed' }] })
    expect(await splitSkattekontoRow(reversed.supabase as never, COMPANY, USER, ROW, [A77, A76])).toMatchObject({
      ok: false,
      code: 'ENTRY_REVERSED',
    })
    const missing = createQueuedMockSupabase()
    enqueueFacts(missing.enqueue, { entries: [entryRows[0]] })
    expect(await splitSkattekontoRow(missing.supabase as never, COMPANY, USER, ROW, [A77, A76])).toMatchObject({
      ok: false,
      code: 'ENTRY_NOT_FOUND',
    })
  })

  it('refuses one verifikat, a repeated one and a malformed id before any read', async () => {
    const { supabase, findCalls } = createQueuedMockSupabase()
    for (const ids of [[A77], [A77, A77], [A77, 'not-a-uuid']]) {
      const r = await splitSkattekontoRow(supabase as never, COMPANY, USER, ROW, ids)
      expect(r.ok).toBe(false)
    }
    expect(findCalls('skattekonto_transactions', 'select')).toEqual([])
  })

  it('takes staged slices only while they still equal the open amounts', async () => {
    const same = createQueuedMockSupabase()
    enqueueFacts(same.enqueue)
    openLedger({ [A77]: 37, [A76]: -8 })
    const ok = await splitSkattekontoRow(same.supabase as never, COMPANY, USER, ROW, [A77, A76], {
      dryRun: true,
      allocations: [
        { journal_entry_id: A77, amount: 37 },
        { journal_entry_id: A76, amount: -8 },
      ],
    })
    expect(ok.ok).toBe(true)

    const moved = createQueuedMockSupabase()
    enqueueFacts(moved.enqueue)
    openLedger({ [A77]: 37, [A76]: -8 })
    const changed = await splitSkattekontoRow(moved.supabase as never, COMPANY, USER, ROW, [A77, A76], {
      allocations: [
        { journal_entry_id: A77, amount: 30 },
        { journal_entry_id: A76, amount: -1 },
      ],
    })
    expect(changed).toMatchObject({ ok: false, code: 'PAIR_NOT_CLOSED' })
    expect(linkMock).not.toHaveBeenCalled()
  })

  it('a lost settlement race rolls the row link back and answers LINK_RACE', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueFacts(enqueue)
    enqueue({ error: { code: '23505', message: 'duplicate key ux_account_reconciliation_settlements_active' } })
    openLedger({ [A77]: 37, [A76]: -8 })

    const r = await splitSkattekontoRow(supabase as never, COMPANY, USER, ROW, [A77, A76])

    expect(r).toMatchObject({ ok: false, code: 'LINK_RACE' })
    expect(unlinkMock).toHaveBeenCalledWith(supabase, COMPANY, ROW)
  })
})

describe('releaseSkattekontoSettlementOf / undoSkattekontoSettlement', () => {
  it('stamps the live 1630 settlement the verifikat is in', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ settlement_id: SETTLEMENT, journal_entry_id: A77, amount: 8, settled_by: USER, settled_at: 'x' }] })
    enqueue({ data: [{ journal_entry_id: A77 }, { journal_entry_id: A76 }] }) // stamp
    expect(await releaseSkattekontoSettlementOf(supabase as never, COMPANY, USER, A77)).toBe(SETTLEMENT)
    expect(findCalls('account_reconciliation_settlements', 'update')).toHaveLength(1)
  })

  it('does nothing for a verifikat in no settlement', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })
    expect(await releaseSkattekontoSettlementOf(supabase as never, COMPANY, USER, A77)).toBeNull()
    expect(findCalls('account_reconciliation_settlements', 'update')).toEqual([])
  })

  it('undo by settlement id returns its verifikat, null for an unknown or malformed id', async () => {
    const hit = createQueuedMockSupabase()
    hit.enqueue({ data: [{ journal_entry_id: A77 }, { journal_entry_id: A76 }] })
    expect(await undoSkattekontoSettlement(hit.supabase as never, COMPANY, USER, SETTLEMENT)).toEqual({
      settlement_id: SETTLEMENT,
      journal_entry_ids: [A77, A76],
    })
    const miss = createQueuedMockSupabase()
    miss.enqueue({ data: [] })
    expect(await undoSkattekontoSettlement(miss.supabase as never, COMPANY, USER, SETTLEMENT)).toBeNull()
    expect(await undoSkattekontoSettlement(miss.supabase as never, COMPANY, USER, 'nope')).toBeNull()
  })
})
