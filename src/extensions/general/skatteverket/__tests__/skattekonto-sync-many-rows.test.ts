/**
 * syncSkattekonto for a busy skattekonto: a response of every row in SKV's
 * window, read back by dedup_key to tell new rows from stored ones.
 *
 * supabase-js puts the keys in the GET query string. In one list a large
 * response ran past the gateway's limit, the refusal was not read, and the
 * sync went on as if nothing were stored: an upcoming row without an id then
 * overwrote the row stored as booked under the same key, and every upcoming
 * row was announced again. The fake gateway (tests/gateway-supabase.ts)
 * refuses a URL past a self-hosted Kong's 8 KB, the stricter of the two
 * limits.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createGatewaySupabase, GATEWAY_URL_LIMIT, inListOf, type GatewayRequest } from '@/tests/gateway-supabase'
import { computeDedupKey } from '@/lib/skatteverket/skattekonto-dedup'

const getSaldoMock = vi.fn()
const getTransaktionerMock = vi.fn()
vi.mock('../lib/skattekonto-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/skattekonto-client')>()),
  getSaldo: (...args: unknown[]) => getSaldoMock(...args),
  getTransaktioner: (...args: unknown[]) => getTransaktionerMock(...args),
}))
// The steps after the upsert read other tables; they are not what this file tests.
vi.mock('../lib/agi-tax-settlement', () => ({ settleAgiTaxPayments: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/skattekonto-proposals', () => ({ refreshSkattekontoProposals: vi.fn().mockResolvedValue({ proposed: 0, cleared: 0 }) }))
vi.mock('@/lib/skatteverket/skattekonto-account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/skatteverket/skattekonto-account')>()),
  ensureSkattekontoAccountDerived: vi.fn().mockResolvedValue('1630'),
}))
vi.mock('@/lib/reconciliation/skattekonto-reconciliation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reconciliation/skattekonto-reconciliation')>()),
  getSkattekontoReconciliationStatus: vi.fn().mockResolvedValue(null),
}))

import { syncSkattekonto, SKATTEKONTO_SKIPPED_ROWS_KEY } from '../lib/skattekonto-sync'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { SupabaseClient } from '@supabase/supabase-js'

const COMPANY = '5b0c3c1e-0000-4000-8000-000000000001'
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const day = (n: number) => `2026-${String(1 + (n % 10)).padStart(2, '0')}-${String(1 + (n % 28)).padStart(2, '0')}`

/** A booked row of the response: Skatteverket's ids run to ten digits. */
const booked = (n: number) => ({
  transaktionsidentitet: 1_000_000_000 + n,
  transaktionsdatum: day(n),
  ranteberakningsdatum: day(n),
  transaktionstext: `Inbetalning bokförd ${n}`,
  beloppSkatteverket: 1000 + n,
  beloppKronofogden: null,
})
/** An upcoming row without an id: its key is the hash of its content. */
const forecast = {
  transaktionsidentitet: null,
  transaktionsdatum: '2026-12-12',
  forfallodatum: '2026-12-12',
  ranteberakningsdatum: '2026-12-13',
  transaktionstext: 'Debiterad preliminärskatt',
  beloppSkatteverket: -2100,
  beloppKronofogden: null,
}
const FORECAST_KEY = computeDedupKey(forecast)
const ROWS = 450

/** Every booked row stored by an earlier sync, and the forecast's key stored as booked by a statement file. */
function storedBooks() {
  const rows: Record<string, unknown>[] = Array.from({ length: ROWS }, (_, i) => ({
    id: uuid(i + 1), company_id: COMPANY, dedup_key: computeDedupKey(booked(i + 1)), status: 'booked', source: 'api',
    transaktionsdatum: day(i + 1), transaktionstext: `Inbetalning bokförd ${i + 1}`, belopp_skatteverket: 1001 + i,
    journal_entry_id: null, is_ignored: false,
  }))
  rows.push({
    id: uuid(9999), company_id: COMPANY, dedup_key: FORECAST_KEY, status: 'booked', source: 'file',
    transaktionsdatum: '2026-12-12', transaktionstext: 'Debiterad preliminärskatt', belopp_skatteverket: -2100,
    journal_entry_id: null, is_ignored: false,
  })
  return {
    company_settings: [{ company_id: COMPANY, org_number: '556677-8899', entity_type: 'aktiebolag' }],
    companies: [{ id: COMPANY, org_number: '556677-8899', entity_type: 'aktiebolag' }],
    skattekonto_transactions: rows,
  }
}

function makeCtx(supabase: SupabaseClient): ExtensionContext {
  return {
    supabase,
    companyId: COMPANY,
    userId: 'user-1',
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
    emit: vi.fn().mockResolvedValue(undefined),
  } as unknown as ExtensionContext
}

const keyReads = (requests: GatewayRequest[]) =>
  requests.filter((r) => r.table === 'skattekonto_transactions' && r.method === 'GET' && inListOf(r, 'dedup_key').length > 0)
const upserts = (requests: GatewayRequest[]) =>
  requests.filter((r) => r.table === 'skattekonto_transactions' && r.method === 'POST')

describe('syncSkattekonto: a response larger than one URL holds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSaldoMock.mockResolvedValue({
      nastaAvstamningsdatum: '2026-12-05', senastUppdaterad: '2026-11-25T05:04:57Z', informationstext: [],
      saldoSkatteverket: 1200, saldoKronofogden: 0, rantaSkatteverket: 0, rantaKronofogden: 0, ocrNummer: '1234567897',
    })
    getTransaktionerMock.mockResolvedValue({
      tidigareTransaktioner: Array.from({ length: ROWS }, (_, i) => booked(i + 1)),
      kommandeTransaktioner: [forecast],
      listed: true,
    })
  })

  it('reads the stored rows back in slices the gateway takes, and leaves the row stored as booked alone', async () => {
    const { supabase, requests, unmodelled } = createGatewaySupabase(storedBooks())
    const ctx = makeCtx(supabase)

    await expect(syncSkattekonto(ctx)).resolves.toMatchObject({ booked: ROWS })

    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    expect(keyReads(requests).map((r) => inListOf(r, 'dedup_key').length)).toEqual([100, 100, 100, 100, 51])
    const written = upserts(requests).flatMap((r) => r.body as Array<{ dedup_key: string; status: string }>)
    expect(written).toHaveLength(ROWS)
    expect(written.some((row) => row.dedup_key === FORECAST_KEY)).toBe(false)
    const emitted = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { type: string }).type)
    expect(emitted).not.toContain('skattekonto.transaction.upcoming')
    expect(unmodelled).toEqual([])
  })

  it('fails the sync, storing nothing, when a slice of the stored rows cannot be read', async () => {
    let keyRead = 0
    const { supabase, requests } = createGatewaySupabase(storedBooks(), {
      refuse: (request) =>
        request.table === 'skattekonto_transactions' && request.method === 'GET' && inListOf(request, 'dedup_key').length > 0 && ++keyRead === 2,
    })

    await expect(syncSkattekonto(makeCtx(supabase))).rejects.toThrow('Kunde inte läsa sparade skattekonto-transaktioner')

    expect(upserts(requests)).toEqual([])
  })

  it('keeps a skipped row in the trace while a failed sync leaves its now complete row unstored', async () => {
    // Skipped by an earlier sync for a missing amount; complete in this response.
    const complete = booked(1)
    const previousTrace = {
      updatedAt: '2026-08-01T00:00:00.000Z',
      rows: [{
        status: 'booked', missing: ['beloppSkatteverket'], row: { ...complete, beloppSkatteverket: null },
        firstSeenAt: '2026-08-01T00:00:00.000Z', lastSeenAt: '2026-08-01T00:00:00.000Z',
      }],
    }
    getTransaktionerMock.mockResolvedValue({ tidigareTransaktioner: [complete], kommandeTransaktioner: [], listed: true })
    const { supabase, requests } = createGatewaySupabase(
      { ...storedBooks(), skattekonto_transactions: [] },
      { refuse: (request) => request.table === 'skattekonto_transactions' && request.method === 'GET' && inListOf(request, 'dedup_key').length > 0 },
    )
    const ctx = makeCtx(supabase)
    ;(ctx.settings.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) =>
      Promise.resolve(key === SKATTEKONTO_SKIPPED_ROWS_KEY ? previousTrace : null),
    )

    await expect(syncSkattekonto(ctx)).rejects.toThrow('Kunde inte läsa sparade skattekonto-transaktioner')

    const traceWrites = (ctx.settings.set as ReturnType<typeof vi.fn>).mock.calls.filter(([key]) => key === SKATTEKONTO_SKIPPED_ROWS_KEY)
    expect(traceWrites.at(-1)?.[1]).toMatchObject({
      rows: [expect.objectContaining({ row: expect.objectContaining({ transaktionsidentitet: complete.transaktionsidentitet }) })],
    })
    expect(upserts(requests)).toEqual([])
  })
})
