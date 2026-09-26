import { describe, it, expect, vi, beforeEach } from 'vitest'

const { countUnbooked, countMissing, latestSignoffs } = vi.hoisted(() => ({
  countUnbooked: vi.fn(),
  countMissing: vi.fn(),
  latestSignoffs: vi.fn(),
}))
vi.mock('@/lib/transactions/unbooked', () => ({ countUnbookedBankTransactions: countUnbooked }))
vi.mock('@/lib/documents/missing-underlag', () => ({
  countMissingUnderlagInPeriod: countMissing,
  MISSING_UNDERLAG_MIN_GROSS_SEK: 4000,
}))
vi.mock('@/lib/reconciliation/signoff-store', () => ({ getLatestSignoffs: latestSignoffs }))

import { buildReportDataStatus, type ReportDataStatus } from '../data-status'

const NOW = new Date('2026-09-26T12:00:00.000Z')
const OPEN_PERIOD = {
  id: 'fp-1',
  name: '2026',
  period_start: '2026-01-01',
  period_end: '2026-12-31',
  is_closed: false,
  locked_at: null,
}

interface Tables {
  period?: Record<string, unknown> | null
  periodError?: { message: string }
  settings?: Record<string, unknown> | null
  drafts?: number
  lastSync?: string | null
  cashAccounts?: Array<{ id: string; iban: string | null; currency: string | null; updated_at: string | null }>
}

/** Table-routed double; every chain settles to the row(s) for its table. */
function makeSupabase(t: Tables) {
  const settle = (table: string) => {
    switch (table) {
      case 'fiscal_periods':
        return { data: t.periodError ? null : (t.period ?? OPEN_PERIOD), error: t.periodError ?? null }
      case 'company_settings':
        return { data: t.settings ?? { accounting_method: 'accrual', bookkeeping_locked_through: null }, error: null }
      case 'journal_entries':
        return { data: null, error: null, count: t.drafts ?? 0 }
      case 'bank_connections':
        return { data: t.lastSync ? { last_synced_at: t.lastSync } : null, error: null }
      case 'cash_accounts':
        return { data: t.cashAccounts ?? [], error: null }
      default:
        return { data: null, error: null }
    }
  }
  const from = (table: string) => {
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gte', 'lte', 'not', 'order', 'limit', 'is']) chain[m] = () => chain
    chain.single = async () => settle(table)
    chain.maybeSingle = async () => settle(table)
    chain.then = (resolve: (v: unknown) => void) => resolve(settle(table))
    return chain
  }
  return { from } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  countUnbooked.mockResolvedValue({ total: 0, untriaged: 0, business_unbooked: 0 })
  countMissing.mockResolvedValue(0)
  latestSignoffs.mockResolvedValue(new Map())
})

const build = (t: Tables, range: { fromDate?: string; toDate?: string } = {}) =>
  buildReportDataStatus(makeSupabase(t), 'co-1', { periodId: 'fp-1', now: NOW, ...range }) as Promise<ReportDataStatus>

describe('buildReportDataStatus', () => {
  it('marks an open period preliminary and counts unbooked rows over the report range', async () => {
    countUnbooked.mockResolvedValue({ total: 12, untriaged: 10, business_unbooked: 2 })
    const status = await build({}, { fromDate: '2026-03-01', toDate: '2026-03-31' })

    expect(countUnbooked).toHaveBeenCalledWith(expect.anything(), 'co-1', { fromDate: '2026-03-01', toDate: '2026-03-31' })
    expect(status.range).toEqual({ from: '2026-03-01', to: '2026-03-31' })
    expect(status.period).toEqual({ period_id: 'fp-1', name: '2026', status: 'open', lock_date: null })
    expect(status.unbooked_transactions).toBe(12)
    expect(status.preliminary).toBe(true)
    expect(status.caveats).toContain('Period 2026 is open: these figures can still change.')
    expect(status.caveats.some((c) => c.startsWith('12 bank transaction(s) dated 2026-03-01 to 2026-03-31'))).toBe(true)
  })

  it('treats a range behind the company lock date as locked and final when nothing is missing', async () => {
    const status = await build(
      { settings: { accounting_method: 'accrual', bookkeeping_locked_through: '2026-06-30' } },
      { toDate: '2026-03-31' },
    )
    expect(status.period.status).toBe('locked')
    expect(status.period.lock_date).toBe('2026-06-30')
    expect(status.preliminary).toBe(false)
    expect(status.caveats).toEqual([])
  })

  it('reports a closed period as closed', async () => {
    const status = await build({ period: { ...OPEN_PERIOD, is_closed: true, locked_at: '2027-02-01T00:00:00Z' } })
    expect(status.period.status).toBe('closed')
    expect(status.preliminary).toBe(false)
  })

  it('keeps a locked period preliminary while drafts remain in it', async () => {
    const status = await build({ period: { ...OPEN_PERIOD, locked_at: '2027-01-15T00:00:00Z' }, drafts: 2 })
    expect(status.period.status).toBe('locked')
    expect(status.draft_entries).toBe(2)
    expect(status.preliminary).toBe(true)
    expect(status.caveats).toContain('2 draft entries in the range are not posted and not included.')
  })

  it('names the cash method, since unpaid invoices are then missing from the figures', async () => {
    const status = await build({ settings: { accounting_method: 'cash', bookkeeping_locked_through: null } })
    expect(status.accounting_method).toBe('cash')
    expect(status.caveats.some((c) => c.startsWith('Cash method (kontantmetoden)'))).toBe(true)
  })

  it('flags a stale bank feed only when the range reaches past the last sync', async () => {
    const stale = await build({ lastSync: '2026-09-20T08:00:00Z' })
    expect(stale.bank.last_sync_at).toBe('2026-09-20T08:00:00Z')
    expect(stale.caveats.some((c) => c.includes('last synced 2026-09-20'))).toBe(true)

    const earlier = await build({ lastSync: '2026-09-20T08:00:00Z' }, { toDate: '2026-06-30' })
    expect(earlier.caveats.some((c) => c.includes('last synced'))).toBe(false)
  })

  it('reports the earliest bank sign-off, and null when any live account is unsigned', async () => {
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
    const signed = await build({ cashAccounts: accounts })
    expect(signed.bank.reconciled_through).toBe('2026-07-31')
    expect(signed.caveats).toContain('Bank reconciliation is signed off only through 2026-07-31.')

    latestSignoffs.mockResolvedValue(new Map([['bank:a2', { through_date: '2026-08-31' }]]))
    const partial = await build({ cashAccounts: accounts })
    expect(partial.bank.reconciled_through).toBeNull()
  })

  it('says nothing about reconciliation for a company with no bank account', async () => {
    const status = await build({ cashAccounts: [] })
    expect(status.bank.reconciled_through).toBeNull()
    expect(status.caveats.some((c) => c.includes('reconciliation'))).toBe(false)
  })

  it('fails soft: a read error comes back as unavailable instead of throwing', async () => {
    const status = await buildReportDataStatus(makeSupabase({ periodError: { message: 'boom' } }), 'co-1', {
      periodId: 'fp-1',
    })
    expect(status).toEqual({ unavailable: true, reason: 'fiscal period read failed: boom' })

    countUnbooked.mockRejectedValueOnce(new Error('anchor lookup failed'))
    const unbookedFail = await buildReportDataStatus(makeSupabase({}), 'co-1', { periodId: 'fp-1' })
    expect(unbookedFail).toEqual({ unavailable: true, reason: 'anchor lookup failed' })
  })
})
