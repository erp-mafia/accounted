import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

const appendProcessingHistory = vi.fn()
vi.mock('@/lib/processing-history/append', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/processing-history/append')>()),
  appendProcessingHistory: (...a: unknown[]) => appendProcessingHistory(...a),
}))

import { applyTwins, planTwins, prepareMoveTwins, type StoredBankRow } from '../channel-twins'

const COMPANY = 'company-1'
const FEED_ACCOUNT = 'cash-feed'
const FILE_ACCOUNT = 'cash-file'

let seq = 0
/** A statement-file row (imported 2026-10-30) or a bank-feed row (arrived 2026-11-04). */
function row(channel: 'file' | 'feed', date: string, amount: number, open: boolean, overrides: Partial<StoredBankRow> = {}): StoredBankRow {
  seq += 1
  return {
    id: `${channel}-${String(seq).padStart(4, '0')}`,
    date,
    amount,
    currency: 'SEK',
    import_source: channel === 'file' ? 'csv_seb' : 'open_payments',
    bank_connection_id: channel === 'feed' ? 'conn-1' : null,
    created_at: channel === 'file' ? '2026-10-30T10:12:16.000000+00:00' : '2026-11-04T07:36:43.000000+00:00',
    cash_account_id: channel === 'file' ? FILE_ACCOUNT : FEED_ACCOUNT,
    is_ignored: false,
    open,
    ...overrides,
  }
}

const ids = (plan: { setAside: Array<{ transaction_id: string }> }) => plan.setAside.map((s) => s.transaction_id).sort()

beforeEach(() => {
  seq = 0
  vi.clearAllMocks()
})

describe('planTwins', () => {
  // crm#1701: statement files booked on a manual 1930 account, the bank's feed
  // on 1935, then moved onto 1930. Every booked file row got an open feed copy.
  it('sets aside the feed copy of a movement the statement file already booked', () => {
    const file = row('file', '2026-03-02', -450, false)
    const feed = row('feed', '2026-03-02', -450, true)
    expect(planTwins([feed], [file])).toEqual({
      setAside: [{ transaction_id: feed.id, twin_transaction_id: file.id }],
      overBookedBuckets: 0,
    })
  })

  it('keeps one of two open copies, the earlier side, whichever side is named first', () => {
    const file = row('file', '2026-07-01', 1200, true)
    const feed = row('feed', '2026-07-01', 1200, true)
    expect(planTwins([feed], [file]).setAside).toEqual([{ transaction_id: feed.id, twin_transaction_id: file.id }])
    expect(planTwins([file], [feed]).setAside).toEqual([{ transaction_id: feed.id, twin_transaction_id: file.id }])
  })

  it('sets aside the open file row when the feed copy is the one booked', () => {
    const file = row('file', '2026-07-01', 1200, true)
    const feed = row('feed', '2026-07-01', 1200, false)
    expect(planTwins([feed], [file]).setAside).toEqual([{ transaction_id: file.id, twin_transaction_id: feed.id }])
  })

  it('keeps one row per movement when a day has several of the same amount, each twin named once', () => {
    const files = [row('file', '2026-05-05', 99, false), row('file', '2026-05-05', 99, true)]
    const feeds = [row('feed', '2026-05-05', 99, true), row('feed', '2026-05-05', 99, true)]
    const plan = planTwins(feeds, files)
    expect(ids(plan)).toEqual(feeds.map((r) => r.id).sort())
    expect(new Set(plan.setAside.map((s) => s.twin_transaction_id)).size).toBe(2)
  })

  // Second review: same-day rows of one amount cannot be told apart, so a
  // side goes whole or not at all. Feed first (10-01), files later (10-20):
  // file X booked, file Y open, both feed rows open.
  it('sets aside the whole all-open side when the other side holds a booking, never a mix', () => {
    const early = { created_at: '2026-10-01T00:00:00+00:00' }
    const late = { created_at: '2026-10-20T00:00:00+00:00' }
    const fileX = row('file', '2026-05-05', 1250, false, late)
    const fileY = row('file', '2026-05-05', 1250, true, late)
    const feedX = row('feed', '2026-05-05', 1250, true, early)
    const feedY = row('feed', '2026-05-05', 1250, true, early)
    const plan = planTwins([feedX, feedY], [fileX, fileY])
    // The later side (files) holds a booking, so the earlier side (feed) goes whole.
    expect(ids(plan)).toEqual([feedX.id, feedY.id].sort())
  })

  it('leaves a day with bookings on both sides for a person', () => {
    const files = [row('file', '2026-05-05', 1250, false), row('file', '2026-05-05', 1250, true)]
    const feeds = [row('feed', '2026-05-05', 1250, false), row('feed', '2026-05-05', 1250, true)]
    expect(planTwins(feeds, files)).toEqual({ setAside: [], overBookedBuckets: 1 })
  })

  it('never sets aside rows when the side kept has lost one of its rows', () => {
    const files = [row('file', '2026-05-05', 99, false), row('file', '2026-05-05', 99, true, { is_ignored: true })]
    const feeds = [row('feed', '2026-05-05', 99, true), row('feed', '2026-05-05', 99, true)]
    // The feed could go whole only if the files still held both movements.
    expect(planTwins(feeds, files).setAside).toEqual([])
  })

  // A second run, or a move back, must find nothing to do.
  it('counts rows already set aside, so a second run sets aside nothing more', () => {
    const f1 = row('file', '2026-05-05', 99, false)
    const f2 = row('file', '2026-05-05', 99, true)
    const p1 = row('feed', '2026-05-05', 99, true)
    const p2 = row('feed', '2026-05-05', 99, true)
    const first = planTwins([p1, p2], [f1, f2])
    expect(first.setAside).toHaveLength(2)
    const aside = new Set(first.setAside.map((s) => s.transaction_id))
    const after = (r: StoredBankRow) => (aside.has(r.id) ? { ...r, is_ignored: true, open: false } : r)
    expect(planTwins([p1, p2].map(after), [f1, f2].map(after)).setAside).toEqual([])
  })

  it('leaves an asymmetric day alone: a movement only one side has is real', () => {
    const files = [row('file', '2026-05-05', 99, false)]
    const feeds = [row('feed', '2026-05-05', 99, true), row('feed', '2026-05-05', 99, true)]
    expect(planTwins(feeds, files).setAside).toEqual([])
  })

  it('pairs only across the two sides, never rows of one side', () => {
    const feeds = [row('feed', '2026-01-02', 10, true), row('feed', '2026-01-02', 10, true)]
    expect(planTwins(feeds, []).setAside).toEqual([])
    expect(planTwins([row('feed', '2026-01-03', 10, true)], [row('file', '2026-01-02', 10, false)]).setAside).toEqual([])
    expect(planTwins([row('feed', '2026-01-02', 11, true)], [row('file', '2026-01-02', 10, false)]).setAside).toEqual([])
  })

  it('never pairs rows of two currencies', () => {
    expect(planTwins([row('feed', '2026-01-02', 10, true, { currency: 'EUR' })], [row('file', '2026-01-02', 10, false)]).setAside).toEqual([])
  })

  it('never treats a hand-entered row as a copy', () => {
    const manual = row('feed', '2026-01-02', 10, true, { import_source: 'manual', bank_connection_id: null })
    expect(planTwins([manual], [row('file', '2026-01-02', 10, false)]).setAside).toEqual([])
  })

  it('reports a day booked more times than it has movements and leaves it for a person', () => {
    expect(planTwins([row('feed', '2026-02-02', 300, false)], [row('file', '2026-02-02', 300, false)])).toEqual({
      setAside: [],
      overBookedBuckets: 1,
    })
  })

  it('compares amounts in öre, so a numeric string matches its number', () => {
    const file = row('file', '2026-04-01', -1301.25, false)
    const feed = row('feed', '2026-04-01', '-1301.25' as unknown as number, true)
    expect(planTwins([feed], [file]).setAside).toEqual([{ transaction_id: feed.id, twin_transaction_id: file.id }])
  })
})

const stored = (r: StoredBankRow) => {
  const { open: _open, ...rest } = r
  return rest
}

describe('prepareMoveTwins', () => {
  it('plans across the moving account and the target accounts, read only', async () => {
    const file = row('file', '2026-03-02', -450, false)
    const feed = row('feed', '2026-03-02', -450, true)
    const mock = createTableMockSupabase({
      transactions: { data: [stored(file), stored(feed)] },
      open_bank_rows: { data: [{ id: feed.id }] },
    })
    const plan = await prepareMoveTwins(mock.supabase as unknown as SupabaseClient, COMPANY, FEED_ACCOUNT, [FILE_ACCOUNT, FEED_ACCOUNT])
    expect(plan.setAside).toEqual([{ transaction_id: feed.id, twin_transaction_id: file.id }])
    expect(mock.findCall('transactions', 'update')).toBeUndefined()
    const accountFilter = mock.calls.find((c) => c.table === 'transactions' && c.method === 'in')
    expect(accountFilter?.args).toEqual(['cash_account_id', [FEED_ACCOUNT, FILE_ACCOUNT]])
  })

  it('plans nothing when two accounts sit on the target: they could be two bank accounts', async () => {
    const mock = createTableMockSupabase({})
    expect(
      await prepareMoveTwins(mock.supabase as unknown as SupabaseClient, COMPANY, FEED_ACCOUNT, [FILE_ACCOUNT, 'cash-file-2']),
    ).toEqual({ setAside: [], overBookedBuckets: 0 })
    expect(mock.calls).toEqual([])
  })

  it('plans nothing without another account to compare with', async () => {
    const mock = createTableMockSupabase({})
    expect(await prepareMoveTwins(mock.supabase as unknown as SupabaseClient, COMPANY, FEED_ACCOUNT, [FEED_ACCOUNT])).toEqual({
      setAside: [],
      overBookedBuckets: 0,
    })
    expect(mock.calls).toEqual([])
  })
})

describe('applyTwins', () => {
  const actor = { type: 'user' as const, id: 'user-1' }
  const options = { actor, correlationId: 'conn-1', reason: 'ledger_move' as const }
  const plan = { setAside: [{ transaction_id: 'feed-1', twin_transaction_id: 'file-1' }], overBookedBuckets: 0 }
  const merged = { data: [{ id: 'feed-1', cash_account_id: FEED_ACCOUNT }, { id: 'file-1', cash_account_id: FEED_ACCOUNT }] }

  it('ignores a copy that sits on one account with its twin, with every ignore guard, and records it', async () => {
    const mock = createTableMockSupabase({
      transactions: [merged, { data: [{ id: 'feed-1' }] }],
      open_bank_rows: { data: [{ id: 'feed-1' }] },
    })
    const done = await applyTwins(mock.supabase as unknown as SupabaseClient, COMPANY, plan, options)
    expect(done).toEqual(plan.setAside)
    expect(mock.findCall('transactions', 'update')).toEqual([{ is_ignored: true }])
    const write = mock.calls.filter((c) => c.table === 'transactions').map((c) => `${c.method}:${JSON.stringify(c.args)}`)
    expect(write).toEqual(expect.arrayContaining(['eq:["is_ignored",false]', 'is:["journal_entry_id",null]', 'eq:["company_id","company-1"]']))
    const openGuards = mock.calls.filter((c) => c.table === 'open_bank_rows').map((c) => `${c.method}:${JSON.stringify(c.args)}`)
    expect(openGuards).toEqual(expect.arrayContaining(['is:["invoice_id",null]', 'is:["supplier_invoice_id",null]', 'is:["journal_entry_id",null]']))
    expect(appendProcessingHistory).toHaveBeenCalledTimes(1)
    expect(appendProcessingHistory.mock.calls[0][0]).toMatchObject({
      companyId: COMPANY,
      eventType: 'BankTransactionTwinsIgnored',
      aggregateType: 'BankTransaction',
      aggregateId: FEED_ACCOUNT,
      correlationId: 'conn-1',
      actor,
      payload: { cash_account_id: FEED_ACCOUNT, reason: 'ledger_move', count: 1, set_aside: plan.setAside },
    })
  })

  it('leaves a pair the save did not put on one account', async () => {
    const mock = createTableMockSupabase({
      transactions: { data: [{ id: 'feed-1', cash_account_id: FEED_ACCOUNT }, { id: 'file-1', cash_account_id: FILE_ACCOUNT }] },
    })
    expect(await applyTwins(mock.supabase as unknown as SupabaseClient, COMPANY, plan, options)).toEqual([])
    expect(mock.findCall('transactions', 'update')).toBeUndefined()
    expect(appendProcessingHistory).not.toHaveBeenCalled()
  })

  it('leaves a row booked or linked since the plan, and records nothing', async () => {
    const mock = createTableMockSupabase({ transactions: merged, open_bank_rows: { data: [] } })
    expect(await applyTwins(mock.supabase as unknown as SupabaseClient, COMPANY, plan, options)).toEqual([])
    expect(appendProcessingHistory).not.toHaveBeenCalled()
  })

  // A failure part way must not leave set-aside rows unrecorded.
  it('records the rows of earlier chunks when a later chunk fails, then rethrows', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ transaction_id: `feed-${i}`, twin_transaction_id: `file-${i}` }))
    const where = many.flatMap((s) => [
      { id: s.transaction_id, cash_account_id: FEED_ACCOUNT },
      { id: s.twin_transaction_id, cash_account_id: FEED_ACCOUNT },
    ])
    const firstChunk = many.slice(0, 100).map((s) => ({ id: s.transaction_id }))
    const mock = createTableMockSupabase({
      transactions: [
        { data: where.slice(0, 100) },
        { data: where.slice(100, 200) },
        { data: where.slice(200) },
        { data: firstChunk },
      ],
      open_bank_rows: [{ data: firstChunk }, { error: { code: '57014', message: 'statement timeout' } }],
    })
    await expect(
      applyTwins(mock.supabase as unknown as SupabaseClient, COMPANY, { setAside: many, overBookedBuckets: 0 }, options),
    ).rejects.toBeTruthy()
    expect(appendProcessingHistory).toHaveBeenCalledTimes(1)
    expect(appendProcessingHistory.mock.calls[0][0].payload.count).toBe(100)
  })

  it('keeps the rows set aside when the record cannot be written', async () => {
    appendProcessingHistory.mockRejectedValueOnce(new Error('fk violation'))
    const mock = createTableMockSupabase({
      transactions: [merged, { data: [{ id: 'feed-1' }] }],
      open_bank_rows: { data: [{ id: 'feed-1' }] },
    })
    expect(await applyTwins(mock.supabase as unknown as SupabaseClient, COMPANY, plan, options)).toHaveLength(1)
  })

  it("writes the record with a script's own client", async () => {
    const history = createTableMockSupabase({ processing_history: { data: null } })
    const mock = createTableMockSupabase({
      transactions: [merged, { data: [{ id: 'feed-1' }] }],
      open_bank_rows: { data: [{ id: 'feed-1' }] },
    })
    await applyTwins(mock.supabase as unknown as SupabaseClient, COMPANY, plan, {
      ...options,
      reason: 'repair',
      historyClient: history.supabase as unknown as SupabaseClient,
    })
    expect(appendProcessingHistory).not.toHaveBeenCalled()
    expect(history.findCall('processing_history', 'insert')?.[0]).toMatchObject({ event_type: 'BankTransactionTwinsIgnored' })
  })
})
