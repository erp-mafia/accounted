/**
 * Tests for a Skatteverket response that carries one dedup_key twice.
 *
 * The sync upserts every row of the response in one statement on
 * (company_id, dedup_key), and Postgres refuses a statement that proposes the
 * same key twice: "ON CONFLICT DO UPDATE command cannot affect row a second
 * time". One repeated key in the response failed the whole sync for the
 * company, every hour, until Skatteverket's answer changed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { computeDedupKey } from '@/lib/skatteverket/skattekonto-dedup'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const getSaldoMock = vi.fn()
const getTransaktionerMock = vi.fn()
vi.mock('../lib/skattekonto-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/skattekonto-client')>()),
  getSaldo: (...args: unknown[]) => getSaldoMock(...args),
  getTransaktioner: (...args: unknown[]) => getTransaktionerMock(...args),
}))

vi.mock('../lib/agi-tax-settlement', () => ({
  settleAgiTaxPayments: vi.fn().mockResolvedValue(undefined),
}))

const warnMock = vi.fn()
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: (...args: unknown[]) => warnMock(...args),
    error: vi.fn(),
    debug: vi.fn(),
  }),
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
      clear: vi.fn().mockResolvedValue(undefined),
    },
    emit: vi.fn().mockResolvedValue(undefined),
  } as unknown as ExtensionContext
}

function makeSaldo() {
  return {
    nastaAvstamningsdatum: '2026-12-05',
    senastUppdaterad: '2026-11-25T05:04:57Z',
    informationstext: [],
    saldoSkatteverket: 1200,
    saldoKronofogden: 0,
    rantaSkatteverket: 0,
    rantaKronofogden: 0,
    ocrNummer: '1234567897',
  }
}

/** The rows of the one upsert the sync made. Postgres takes each dedup_key at most once per statement. */
function upsertedRows(): { dedup_key: string; status: string; belopp_skatteverket: number }[] {
  const upserts = findCalls('skattekonto_transactions', 'upsert')
  expect(upserts).toHaveLength(1)
  const rows = upserts[0][0] as { dedup_key: string; status: string; belopp_skatteverket: number }[]
  expect(new Set(rows.map(r => r.dedup_key)).size).toBe(rows.length)
  return rows
}

/** The queue for a response with booked rows nobody has seen: no stored rows, no hash rows to take over. */
function enqueueFreshCompany() {
  enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
  enqueue({ data: [] }) // fiscal_periods: none
  enqueue({ data: [] }) // existing dedup_key lookup: none stored
  enqueue({ data: [] }) // hash rows to take over: none
  enqueue({ data: null }) // upsert
  enqueue({ data: [] }) // stored upcoming rows: none
}

const BOOKED = {
  transaktionsidentitet: 4711,
  transaktionsdatum: '2026-11-12',
  ranteberakningsdatum: '2026-11-12',
  transaktionstext: 'Avdragen skatt okt 2026',
  beloppSkatteverket: -10500,
  beloppKronofogden: null,
}

describe('syncSkattekonto: a response that repeats a dedup_key', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    getSaldoMock.mockResolvedValue(makeSaldo())
  })

  it('stores a transaction listed as both booked and upcoming once, as the booked row', async () => {
    // Same transaktionsidentitet in both lists, the forecast with another amount.
    const stillUpcoming = { ...BOOKED, forfallodatum: '2026-11-12', beloppSkatteverket: -10450 }
    getTransaktionerMock.mockResolvedValue({ tidigareTransaktioner: [BOOKED], kommandeTransaktioner: [stillUpcoming], listed: true })
    enqueueFreshCompany()
    const ctx = makeCtx()

    await expect(syncSkattekonto(ctx)).resolves.toMatchObject({ booked: 1 })

    const rows = upsertedRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ dedup_key: 'id:4711', status: 'booked', belopp_skatteverket: -10500 })
    // The row left out is named, without text or amounts.
    expect(warnMock).toHaveBeenCalledWith('skattekonto response repeated a transaction, one row kept per key', {
      companyId: 'company-1',
      rows: [{ transaktionsidentitet: 4711, transaktionsdatum: '2026-11-12', droppedStatus: 'upcoming', keptStatus: 'booked', amountDiffers: true }],
    })
    // Nothing announces as upcoming a transaction that was stored as booked.
    const emitted = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls.map(c => (c[0] as { type: string }).type)
    expect(emitted).not.toContain('skattekonto.transaction.upcoming')
  })

  it('stores two identical upcoming rows without an id once and announces it once', async () => {
    // No transaktionsidentitet: both rows hash to the same key.
    const forecast = {
      transaktionsidentitet: null,
      transaktionsdatum: '2026-12-14',
      forfallodatum: '2026-12-14',
      ranteberakningsdatum: '2026-12-15',
      transaktionstext: 'Debiterad preliminärskatt',
      beloppSkatteverket: -2100,
      beloppKronofogden: null,
    }
    getTransaktionerMock.mockResolvedValue({ tidigareTransaktioner: [], kommandeTransaktioner: [forecast, { ...forecast }], listed: true })
    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [] }) // fiscal_periods: none
    enqueue({ data: [] }) // existing dedup_key lookup: none stored
    enqueue({ data: null }) // upsert
    enqueue({ data: [] }) // stored upcoming rows: none
    const ctx = makeCtx()

    await syncSkattekonto(ctx)

    const rows = upsertedRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ dedup_key: computeDedupKey(forecast), status: 'upcoming' })
    const announced = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls.filter(c => (c[0] as { type: string }).type === 'skattekonto.transaction.upcoming')
    expect(announced).toHaveLength(1)
  })

  it('keeps the first of two booked rows with the same id', async () => {
    getTransaktionerMock.mockResolvedValue({ tidigareTransaktioner: [BOOKED, { ...BOOKED, beloppSkatteverket: -10600 }], kommandeTransaktioner: [], listed: true })
    enqueueFreshCompany()

    await syncSkattekonto(makeCtx())

    const rows = upsertedRows()
    expect(rows).toEqual([expect.objectContaining({ dedup_key: 'id:4711', status: 'booked', belopp_skatteverket: -10500 })])
    expect(warnMock).toHaveBeenCalledWith('skattekonto response repeated a transaction, one row kept per key', {
      companyId: 'company-1',
      rows: [{ transaktionsidentitet: 4711, transaktionsdatum: '2026-11-12', droppedStatus: 'booked', keptStatus: 'booked', amountDiffers: true }],
    })
  })
})
