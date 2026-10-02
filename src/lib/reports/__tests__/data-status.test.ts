import { describe, it, expect, vi, beforeEach } from 'vitest'

const { countUnbooked, latestSignoffs } = vi.hoisted(() => ({
  countUnbooked: vi.fn(),
  latestSignoffs: vi.fn(),
}))
vi.mock('@/lib/transactions/unbooked', () => ({ countUnbookedBankTransactions: countUnbooked }))
vi.mock('@/lib/reconciliation/signoff-store', () => ({ getLatestSignoffs: latestSignoffs }))

import { buildReportDataStatus, type ReportDataStatus } from '../data-status'

// Last month end relative to NOW is 2026-08-31.
const NOW = new Date('2026-09-26T12:00:00.000Z')
const OPEN_PERIOD = {
  id: 'fp-1',
  name: '2026',
  period_start: '2026-01-01',
  period_end: '2026-12-31',
  is_closed: false,
  locked_at: null,
}
const BANK_ACCOUNT = { id: 'ca-1', iban: 'SE1', currency: 'SEK', updated_at: '2026-01-01' }

interface Tables {
  period?: Record<string, unknown> | null
  periodError?: { message: string }
  settings?: Record<string, unknown> | null
  drafts?: number
  connections?: Array<{ status: string; last_synced_at: string | null }>
  cashAccounts?: Array<{ id: string; iban: string | null; currency: string | null; updated_at: string | null }>
}

/**
 * Table-routed double that records every builder call, so the filters the
 * builder applies (company, range, status) are asserted, not only what the
 * tables return. bank_connections honours an in('status', [...]) filter like
 * PostgREST would. It has no rpc(): any RPC call would throw and surface as
 * { unavailable }.
 */
function makeSupabase(t: Tables) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const settle = (table: string, local: Array<{ method: string; args: unknown[] }>) => {
    switch (table) {
      case 'fiscal_periods':
        return { data: t.periodError ? null : (t.period ?? OPEN_PERIOD), error: t.periodError ?? null }
      case 'company_settings':
        return { data: t.settings ?? { accounting_method: 'accrual', bookkeeping_locked_through: null }, error: null }
      case 'journal_entries':
        return { data: null, error: null, count: t.drafts ?? 0 }
      case 'bank_connections': {
        const statusIn = local.find((c) => c.method === 'in' && c.args[0] === 'status')?.args[1] as string[] | undefined
        const rows = (t.connections ?? []).filter((r) => !statusIn || statusIn.includes(r.status))
        return { data: rows, error: null }
      }
      case 'cash_accounts':
        return { data: t.cashAccounts ?? [], error: null }
      default:
        return { data: null, error: null }
    }
  }
  const from = (table: string) => {
    const local: Array<{ method: string; args: unknown[] }> = []
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gte', 'lte', 'not', 'order', 'limit', 'is', 'in']) {
      chain[m] = (...args: unknown[]) => {
        calls.push({ table, method: m, args })
        local.push({ method: m, args })
        return chain
      }
    }
    chain.single = async () => settle(table, local)
    chain.maybeSingle = async () => settle(table, local)
    chain.then = (resolve: (v: unknown) => void) => resolve(settle(table, local))
    return chain
  }
  const find = (table: string, method: string) =>
    calls.filter((c) => c.table === table && c.method === method).map((c) => c.args)
  return { supabase: { from } as never, calls, find }
}

beforeEach(() => {
  vi.clearAllMocks()
  countUnbooked.mockResolvedValue({ total: 0, untriaged: 0, business_unbooked: 0 })
  latestSignoffs.mockResolvedValue(new Map())
})

async function build(t: Tables, range: { fromDate?: string; toDate?: string } = {}) {
  const double = makeSupabase(t)
  const status = (await buildReportDataStatus(double.supabase, 'co-1', {
    periodId: 'fp-1',
    now: NOW,
    ...range,
  })) as ReportDataStatus
  return { status, ...double }
}

describe('buildReportDataStatus', () => {
  it('marks an open period preliminary and counts unbooked rows over the report range', async () => {
    countUnbooked.mockResolvedValue({ total: 12, untriaged: 10, business_unbooked: 2 })
    const { status } = await build({}, { fromDate: '2026-03-01', toDate: '2026-03-31' })

    expect(countUnbooked).toHaveBeenCalledWith(expect.anything(), 'co-1', { fromDate: '2026-03-01', toDate: '2026-03-31' })
    expect(status.range).toEqual({ from: '2026-03-01', to: '2026-03-31' })
    expect(status.period).toEqual({ period_id: 'fp-1', name: '2026', status: 'open', lock_date: null })
    expect(status.unbooked_transactions).toBe(12)
    expect(status.preliminary).toBe(true)
    expect(status.caveats).toContain('Period 2026 is open: these figures can still change.')
    expect(status.caveats.some((c) => c.startsWith('12 bank transaction(s) dated 2026-03-01 to 2026-03-31'))).toBe(true)
  })

  it('scopes every read to the company and the drafts count to the report range', async () => {
    const { find, calls } = await build({ cashAccounts: [BANK_ACCOUNT] }, { fromDate: '2026-03-01', toDate: '2026-03-31' })

    const tables = [...new Set(calls.map((c) => c.table))].sort()
    expect(tables).toEqual(['bank_connections', 'cash_accounts', 'company_settings', 'fiscal_periods', 'journal_entries'])
    for (const table of tables) {
      expect(find(table, 'eq'), table).toContainEqual(['company_id', 'co-1'])
    }
    expect(find('fiscal_periods', 'eq')).toContainEqual(['id', 'fp-1'])
    expect(find('journal_entries', 'eq')).toContainEqual(['status', 'draft'])
    expect(find('journal_entries', 'gte')).toEqual([['entry_date', '2026-03-01']])
    expect(find('journal_entries', 'lte')).toEqual([['entry_date', '2026-03-31']])
    expect(latestSignoffs).toHaveBeenCalledWith(expect.anything(), 'co-1')
  })

  it('defaults the range to the fiscal period bounds', async () => {
    const { status, find } = await build({})
    expect(status.range).toEqual({ from: '2026-01-01', to: '2026-12-31' })
    expect(countUnbooked).toHaveBeenCalledWith(expect.anything(), 'co-1', { fromDate: '2026-01-01', toDate: '2026-12-31' })
    expect(find('journal_entries', 'gte')).toEqual([['entry_date', '2026-01-01']])
    expect(find('journal_entries', 'lte')).toEqual([['entry_date', '2026-12-31']])
  })

  it('treats a range behind the company lock date as locked and final when nothing is missing', async () => {
    const { status } = await build(
      { settings: { accounting_method: 'accrual', bookkeeping_locked_through: '2026-06-30' } },
      { toDate: '2026-03-31' },
    )
    expect(status.period.status).toBe('locked')
    expect(status.period.lock_date).toBe('2026-06-30')
    expect(status.preliminary).toBe(false)
    expect(status.caveats).toEqual([])
  })

  it('returns lock_date as a YYYY-MM-DD date when the period itself carries a locked_at timestamp', async () => {
    const locked = await build({ period: { ...OPEN_PERIOD, locked_at: '2027-01-15T10:22:33.123+00:00' } })
    expect(locked.status.period).toMatchObject({ status: 'locked', lock_date: '2027-01-15' })

    const closed = await build({ period: { ...OPEN_PERIOD, is_closed: true, locked_at: '2027-02-01T08:00:00Z' } })
    expect(closed.status.period).toMatchObject({ status: 'closed', lock_date: '2027-02-01' })
    expect(closed.status.preliminary).toBe(false)
  })

  it('keeps a locked period preliminary while drafts remain in it', async () => {
    const { status } = await build({ period: { ...OPEN_PERIOD, locked_at: '2027-01-15T00:00:00Z' }, drafts: 2 })
    expect(status.period.status).toBe('locked')
    expect(status.draft_entries).toBe(2)
    expect(status.preliminary).toBe(true)
    expect(status.caveats).toContain('2 draft entries in the range are not posted and not included.')
  })

  it('states the cash method in words true for every report, including after the year-end cut-off', async () => {
    const { status } = await build({ settings: { accounting_method: 'cash', bookkeeping_locked_through: null } })
    expect(status.accounting_method).toBe('cash')
    expect(status.caveats).toContain(
      'Cash method (kontantmetoden): invoices are booked when paid; unpaid customer and supplier invoices enter the books only through the year-end (bokslut) entries.',
    )
  })

  it('does not scan for missing underlag: a missing receipt changes no figure', async () => {
    const { status } = await build({})
    expect(status).not.toHaveProperty('missing_underlag')
    expect(status.caveats.some((c) => /underlag/i.test(c))).toBe(false)
  })

  describe('bank feed freshness', () => {
    const feedCaveat = (st: ReportDataStatus) => st.caveats.find((c) => /bank feed/i.test(c))

    it('reads only the company\'s active, error and expired connections', async () => {
      const { find } = await build({})
      expect(find('bank_connections', 'eq')).toEqual([['company_id', 'co-1']])
      expect(find('bank_connections', 'in')).toEqual([['status', ['active', 'error', 'expired']]])
    })

    it('only active connections: the oldest sync decides, stale flags and fresh does not', async () => {
      const stale = await build({
        connections: [
          { status: 'active', last_synced_at: '2026-09-26T06:00:00Z' },
          { status: 'active', last_synced_at: '2026-09-20T08:00:00Z' },
        ],
      })
      expect(stale.status.bank).toMatchObject({ feed_status: 'active', last_sync_at: '2026-09-20T08:00:00Z' })
      expect(feedCaveat(stale.status)).toBe('A bank feed last synced 2026-09-20: its transactions after that date are not imported yet.')

      const fresh = await build({ connections: [{ status: 'active', last_synced_at: '2026-09-26T06:00:00Z' }] })
      expect(fresh.status.bank.feed_status).toBe('active')
      expect(feedCaveat(fresh.status)).toBeUndefined()

      const earlierRange = await build(
        { connections: [{ status: 'active', last_synced_at: '2026-09-20T08:00:00Z' }] },
        { toDate: '2026-06-30' },
      )
      expect(feedCaveat(earlierRange.status)).toBeUndefined()
    })

    it('an active connection wins over an expired one', async () => {
      const { status } = await build({
        connections: [
          { status: 'expired', last_synced_at: '2026-08-01T05:00:00Z' },
          { status: 'active', last_synced_at: '2026-09-26T06:00:00Z' },
        ],
      })
      expect(status.bank).toMatchObject({ feed_status: 'active', last_sync_at: '2026-09-26T06:00:00Z' })
      expect(feedCaveat(status)).toBeUndefined()
    })

    it('only error or expired connections: names the stopped feed from its newest sync, whatever its age', async () => {
      const { status } = await build({
        connections: [
          { status: 'expired', last_synced_at: '2026-07-10T05:00:00Z' },
          { status: 'error', last_synced_at: '2026-08-12T05:00:00Z' },
          { status: 'error', last_synced_at: null },
        ],
      })
      expect(status.bank).toMatchObject({ feed_status: 'stopped', last_sync_at: '2026-08-12T05:00:00Z' })
      expect(feedCaveat(status)).toBe(
        'The bank feed has stopped syncing (last synced 2026-08-12): transactions after that date are not imported unless added another way.',
      )

      // A feed that stopped hours ago is still stopped: no 36 h grace.
      const recent = await build({ connections: [{ status: 'error', last_synced_at: '2026-09-26T06:00:00Z' }] })
      expect(recent.status.bank.feed_status).toBe('stopped')
      expect(feedCaveat(recent.status)).toMatch(/^The bank feed has stopped syncing \(last synced 2026-09-26\)/)

      // A range that ends before the last sync lost nothing.
      const earlier = await build(
        { connections: [{ status: 'expired', last_synced_at: '2026-08-12T05:00:00Z' }] },
        { toDate: '2026-06-30' },
      )
      expect(feedCaveat(earlier.status)).toBeUndefined()
    })

    it('ignores revoked and pending_selection connections', async () => {
      const { status } = await build({
        connections: [
          { status: 'revoked', last_synced_at: '2026-05-01T05:00:00Z' },
          { status: 'pending_selection', last_synced_at: null },
        ],
      })
      expect(status.bank).toMatchObject({ feed_status: null, last_sync_at: null })
      expect(feedCaveat(status)).toBeUndefined()
    })
  })

  describe('bank reconciliation', () => {
    const hasCaveat = (s: ReportDataStatus) => s.caveats.some((c) => /reconciliation/i.test(c))

    it('stays silent for a company that never signed anything off, even with unsigned bank accounts', async () => {
      const { status } = await build({ cashAccounts: [BANK_ACCOUNT] })
      expect(status.bank.reconciled_through).toBeNull()
      expect(hasCaveat(status)).toBe(false)
    })

    it('flags a sign-off behind the last month end before today', async () => {
      latestSignoffs.mockResolvedValue(new Map([['bank:ca-1', { through_date: '2026-07-31' }]]))
      const { status } = await build({ cashAccounts: [BANK_ACCOUNT] })
      expect(status.bank.reconciled_through).toBe('2026-07-31')
      expect(status.caveats).toContain('Bank reconciliation is signed off only through 2026-07-31.')
    })

    it('measures a current-year report against the last month end, not the future period end', async () => {
      // Period end 2026-12-31 is in the future; signed through 2026-08-31 is current.
      latestSignoffs.mockResolvedValue(new Map([['bank:ca-1', { through_date: '2026-08-31' }]]))
      const { status } = await build({ cashAccounts: [BANK_ACCOUNT] })
      expect(status.range.to).toBe('2026-12-31')
      expect(status.bank.reconciled_through).toBe('2026-08-31')
      expect(hasCaveat(status)).toBe(false)
    })

    it('measures a past range against its own end', async () => {
      latestSignoffs.mockResolvedValue(new Map([['bank:ca-1', { through_date: '2026-02-28' }]]))
      const behind = await build({ cashAccounts: [BANK_ACCOUNT] }, { toDate: '2026-03-31' })
      expect(behind.status.caveats).toContain('Bank reconciliation is signed off only through 2026-02-28.')

      latestSignoffs.mockResolvedValue(new Map([['bank:ca-1', { through_date: '2026-06-30' }]]))
      const covered = await build({ cashAccounts: [BANK_ACCOUNT] }, { toDate: '2026-03-31' })
      expect(hasCaveat(covered.status)).toBe(false)
    })

    it('names an unsigned bank account once the company signs off elsewhere', async () => {
      latestSignoffs.mockResolvedValue(new Map([['skattekonto', { through_date: '2026-08-31' }]]))
      const { status } = await build({ cashAccounts: [BANK_ACCOUNT] })
      expect(status.bank.reconciled_through).toBeNull()
      expect(status.caveats).toContain('At least one bank account has no reconciliation sign-off.')
    })

    it('reports the earliest sign-off across live accounts, a reconnect duplicate counting once', async () => {
      const accounts = [
        { id: 'a', iban: 'SE1', currency: 'SEK', updated_at: '2026-01-01' },
        { id: 'b', iban: null, currency: 'SEK', updated_at: null },
        // Reconnect duplicate of 'a': the newer row is the live one.
        { id: 'a2', iban: 'SE1', currency: 'SEK', updated_at: '2026-05-01' },
      ]
      latestSignoffs.mockResolvedValue(
        new Map([
          ['bank:a2', { through_date: '2026-08-31' }],
          ['bank:b', { through_date: '2026-07-31' }],
        ]),
      )
      const { status } = await build({ cashAccounts: accounts })
      expect(status.bank.reconciled_through).toBe('2026-07-31')
    })

    it('says nothing for a company with no bank account', async () => {
      latestSignoffs.mockResolvedValue(new Map([['skattekonto', { through_date: '2026-08-31' }]]))
      const { status } = await build({ cashAccounts: [] })
      expect(status.bank.reconciled_through).toBeNull()
      expect(hasCaveat(status)).toBe(false)
    })
  })

  it('fails soft: a read error comes back as unavailable instead of throwing', async () => {
    const periodFail = await buildReportDataStatus(makeSupabase({ periodError: { message: 'boom' } }).supabase, 'co-1', {
      periodId: 'fp-1',
    })
    expect(periodFail).toEqual({ unavailable: true, reason: 'fiscal period read failed: boom' })

    countUnbooked.mockRejectedValueOnce(new Error('anchor lookup failed'))
    const unbookedFail = await buildReportDataStatus(makeSupabase({}).supabase, 'co-1', { periodId: 'fp-1' })
    expect(unbookedFail).toEqual({ unavailable: true, reason: 'anchor lookup failed' })
  })
})
