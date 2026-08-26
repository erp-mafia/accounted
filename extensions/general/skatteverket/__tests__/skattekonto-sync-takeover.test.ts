/**
 * Tests for the sync-time takeover of file-imported rows.
 *
 * A skattekontoutdrag file import writes booked rows with `h:` dedup keys
 * (statements carry no transaktionsidentitet); the API identifies the same
 * transactions with `id:` keys. When a company connects the API after a file
 * import, syncSkattekonto must adopt the existing rows in place (keeping row
 * id and journal_entry_id) instead of inserting duplicates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { computeDedupKey } from '@/lib/skatteverket/skattekonto-dedup'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const getSaldoMock = vi.fn()
const getTransaktionerMock = vi.fn()
vi.mock('../lib/skattekonto-client', () => ({
  getSaldo: (...args: unknown[]) => getSaldoMock(...args),
  getTransaktioner: (...args: unknown[]) => getTransaktionerMock(...args),
}))

vi.mock('../lib/agi-tax-settlement', () => ({
  settleAgiTaxPayments: vi.fn().mockResolvedValue(undefined),
}))

import { syncSkattekonto } from '../lib/skattekonto-sync'
import type { ExtensionContext } from '@/lib/extensions/types'

function makeCtx(): ExtensionContext {
  return {
    supabase,
    companyId: 'company-1',
    userId: 'user-1',
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    emit: vi.fn().mockResolvedValue(undefined),
  } as unknown as ExtensionContext
}

const AGI_BOOKED = {
  transaktionsidentitet: 9001,
  transaktionsdatum: '2026-07-13',
  ranteberakningsdatum: '2026-07-13',
  transaktionstext: 'Arbetsgivaravgift juni 2026',
  beloppSkatteverket: -15710,
  beloppKronofogden: 0,
}

const FILE_ROW_HASH_KEY = computeDedupKey({
  transaktionsidentitet: null,
  transaktionsdatum: '2026-07-13',
  beloppSkatteverket: -15710,
  transaktionstext: 'Arbetsgivaravgift juni 2026',
})

function makeSaldo() {
  return {
    nastaAvstamningsdatum: '2026-09-05',
    senastUppdaterad: '2026-08-17',
    informationstext: [],
    saldoSkatteverket: 1000,
    saldoKronofogden: 0,
    rantaSkatteverket: 0,
    rantaKronofogden: 0,
    ocrNummer: '1234567897',
  }
}

describe('syncSkattekonto: takeover of file-imported rows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    getSaldoMock.mockResolvedValue(makeSaldo())
  })

  it('adopts a matching hash-keyed row in place instead of duplicating it', async () => {
    getTransaktionerMock.mockResolvedValue({
      tidigareTransaktioner: [AGI_BOOKED],
      kommandeTransaktioner: [],
    })

    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [] }) // fiscal_periods (earliest period start: none)
    enqueue({ data: [] }) // existing dedup_key lookup: id:9001 not present
    enqueue({
      data: [
        {
          id: 'file-row-1',
          dedup_key: FILE_ROW_HASH_KEY,
          status: 'booked',
          transaktionsdatum: '2026-07-13',
          transaktionstext: 'Arbetsgivaravgift juni 2026',
          belopp_skatteverket: -15710,
        },
      ],
    }) // takeover candidate scan
    enqueue({ data: null }) // takeover update
    enqueue({ data: null }) // upsert

    await syncSkattekonto(makeCtx())

    const updates = findCalls('skattekonto_transactions', 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0][0]).toEqual({
      dedup_key: 'id:9001',
      transaktionsidentitet: 9001,
      source: 'api',
    })

    // The upsert then resolves onto the adopted key: no fresh insert path.
    const upserts = findCalls('skattekonto_transactions', 'upsert')
    expect(upserts).toHaveLength(1)
    const rows = upserts[0][0] as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0].dedup_key).toBe('id:9001')
  })

  it('prefers the booked candidate even when it is last in a 3-candidate queue', async () => {
    getTransaktionerMock.mockResolvedValue({
      tidigareTransaktioner: [AGI_BOOKED],
      kommandeTransaktioner: [],
    })

    const candidate = {
      dedup_key: FILE_ROW_HASH_KEY,
      transaktionsdatum: '2026-07-13',
      transaktionstext: 'Arbetsgivaravgift juni 2026',
      belopp_skatteverket: -15710,
    }
    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [] }) // fiscal_periods (earliest period start: none)
    enqueue({ data: [] }) // existing dedup_key lookup
    enqueue({
      data: [
        { id: 'stale-upcoming-1', status: 'upcoming', ...candidate },
        { id: 'stale-upcoming-2', status: 'upcoming', ...candidate },
        { id: 'file-row-booked', status: 'booked', ...candidate },
      ],
    }) // takeover candidate scan
    enqueue({ data: null }) // takeover update
    enqueue({ data: null }) // upsert

    await syncSkattekonto(makeCtx())

    const updates = findCalls('skattekonto_transactions', 'update')
    expect(updates).toHaveLength(1)
    // The eq('id', ...) filter must target the booked file row, not a stale
    // upcoming candidate that happened to sort first.
    const eqCalls = findCalls('skattekonto_transactions', 'eq')
    expect(eqCalls).toContainEqual(['id', 'file-row-booked'])
  })

  it('does not scan for takeover candidates when the id keys already exist', async () => {
    getTransaktionerMock.mockResolvedValue({
      tidigareTransaktioner: [AGI_BOOKED],
      kommandeTransaktioner: [],
    })

    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [] }) // fiscal_periods (earliest period start: none)
    enqueue({ data: [{ dedup_key: 'id:9001', status: 'booked' }] }) // key already known
    enqueue({ data: null }) // upsert

    await syncSkattekonto(makeCtx())

    expect(findCalls('skattekonto_transactions', 'update')).toHaveLength(0)
    expect(findCalls('skattekonto_transactions', 'like')).toHaveLength(0)
    expect(findCalls('skattekonto_transactions', 'upsert')).toHaveLength(1)
  })

  it('never flips a booked row back to upcoming on hash-key collision', async () => {
    const kommande = {
      transaktionsidentitet: null,
      transaktionsdatum: '2026-07-13',
      forfallodatum: '2026-07-14',
      ranteberakningsdatum: null,
      transaktionstext: 'Arbetsgivaravgift juni 2026',
      beloppSkatteverket: -15710,
      beloppKronofogden: 0,
    }
    getTransaktionerMock.mockResolvedValue({
      tidigareTransaktioner: [],
      kommandeTransaktioner: [kommande],
    })

    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [] }) // fiscal_periods (earliest period start: none)
    enqueue({ data: [{ dedup_key: FILE_ROW_HASH_KEY, status: 'booked' }] }) // same key, already booked

    await syncSkattekonto(makeCtx())

    // The colliding upcoming row is dropped: nothing left to upsert.
    expect(findCalls('skattekonto_transactions', 'upsert')).toHaveLength(0)
  })
})

/** ISO date `days` days before today (UTC), matching the sync's clamp math. */
function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

describe('syncSkattekonto: fiscal-year lower bound on the fetch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    getSaldoMock.mockResolvedValue(makeSaldo())
  })

  it('passes the earliest fiscal period start as datumFrom when inside the SKV window', async () => {
    getTransaktionerMock.mockResolvedValue({
      tidigareTransaktioner: [],
      kommandeTransaktioner: [],
    })

    const periodStart = isoDaysAgo(100)
    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [{ period_start: periodStart }] }) // fiscal_periods earliest

    await syncSkattekonto(makeCtx())

    // Without the bound, SKV defaults to ~555 days of history, which for an
    // enskild firma imports the owner's private pre-company transactions.
    expect(getTransaktionerMock).toHaveBeenCalledTimes(1)
    expect(getTransaktionerMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      periodStart,
    )
  })

  it('omits datumFrom when bookkeeping started before the 555-day default window', async () => {
    getTransaktionerMock.mockResolvedValue({
      tidigareTransaktioner: [],
      kommandeTransaktioner: [],
    })

    // 800 days ago: still ACCEPTED by SKV (limit ~915 days) but OLDER than
    // the 555-day default. Sending it would silently widen the window past
    // what an unbounded fetch returns; omitting it is identical to what we
    // want, so nothing is sent.
    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [{ period_start: isoDaysAgo(800) }] }) // fiscal_periods earliest

    await syncSkattekonto(makeCtx())

    expect(getTransaktionerMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      undefined,
    )
  })

  it('omits datumFrom when bookkeeping started past the ~915-day SKV limit (felkod 2)', async () => {
    getTransaktionerMock.mockResolvedValue({
      tidigareTransaktioner: [],
      kommandeTransaktioner: [],
    })

    // 1690 days ago: a datumFrom this old is rejected by SKV with felkod 2
    // and would break the whole sync. The clamp must omit it.
    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [{ period_start: isoDaysAgo(1690) }] }) // fiscal_periods earliest

    await syncSkattekonto(makeCtx())

    expect(getTransaktionerMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      undefined,
    )
  })

  it('passes no datumFrom when the company has no fiscal period yet', async () => {
    getTransaktionerMock.mockResolvedValue({
      tidigareTransaktioner: [],
      kommandeTransaktioner: [],
    })

    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [] }) // fiscal_periods: none yet (brand-new company)

    await syncSkattekonto(makeCtx())

    // Fall back to today's unbounded behavior rather than blocking the sync.
    expect(getTransaktionerMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      undefined,
    )
  })
})
