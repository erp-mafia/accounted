import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  MISSING_UNDERLAG_PAGE_MAX,
  MissingUnderlagQueryError,
  listAllMissingUnderlagIds,
  listMissingUnderlagPage,
  missingUnderlagOrder,
} from '@/lib/bookkeeping/missing-underlag'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const client = supabase as unknown as SupabaseClient

const E1 = '11111111-1111-4111-8111-111111111111'
const E2 = '22222222-2222-4222-8222-222222222222'

const rpcArgs = (call: number) =>
  (supabase.rpc.mock.calls[call] as unknown[])[1] as Record<string, unknown>

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('missingUnderlagOrder: the list sort as RPC order terms', () => {
  it('defaults to series+number ascending with an ascending id tiebreak', () => {
    expect(missingUnderlagOrder([], null)).toEqual([
      { column: 'voucher_series', ascending: true },
      { column: 'voucher_number', ascending: true },
      { column: 'id', ascending: true },
    ])
  })

  it('maps the legacy sort_date to date, series, number and id in that direction', () => {
    expect(missingUnderlagOrder([], 'desc')).toEqual([
      { column: 'entry_date', ascending: false },
      { column: 'voucher_series', ascending: false },
      { column: 'voucher_number', ascending: false },
      { column: 'id', ascending: false },
    ])
  })

  it('keeps the stack order, sorts amounts by display_amount and tiebreaks in the last direction', () => {
    expect(
      missingUnderlagOrder(
        [
          { column: 'total', ascending: false },
          { column: 'description', ascending: true },
        ],
        'desc',
      ),
    ).toEqual([
      { column: 'display_amount', ascending: false },
      { column: 'description', ascending: true },
      { column: 'voucher_series', ascending: true },
      { column: 'voucher_number', ascending: true },
      { column: 'id', ascending: true },
    ])
  })

  it('adds no second voucher tiebreak when voucher is already a key', () => {
    expect(
      missingUnderlagOrder(
        [
          { column: 'voucher', ascending: false },
          { column: 'date', ascending: true },
        ],
        null,
      ),
    ).toEqual([
      { column: 'voucher_series', ascending: false },
      { column: 'voucher_number', ascending: false },
      { column: 'entry_date', ascending: true },
      { column: 'id', ascending: true },
    ])
  })
})

describe('listMissingUnderlagPage (crm#1390)', () => {
  it('resolves the page and the total in ONE rpc call, with no table reads', async () => {
    enqueue({ data: { ok: true, total_count: 4600, ids: [E1, E2] }, error: null })

    const page = await listMissingUnderlagPage(
      client,
      'company-1',
      { periodId: 'period-1', series: 'A', dateFrom: '2026-01-01', dateTo: '2026-12-31' },
      { order: missingUnderlagOrder([{ column: 'date', ascending: false }], null), limit: 20, offset: 40 },
    )

    expect(page).toEqual({ total: 4600, ids: [E1, E2] })
    // The cost no longer follows the ledger: a 4,600-verifikat scope used to
    // read every candidate and probe it 150 ids at a time.
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.from).not.toHaveBeenCalled()
    expect(supabase.rpc.mock.calls[0][0]).toBe('list_verifikat_missing_underlag')
    expect(rpcArgs(0)).toEqual({
      p_company_id: 'company-1',
      p_period_id: 'period-1',
      p_series: 'A',
      p_date_from: '2026-01-01',
      p_date_to: '2026-12-31',
      p_search_pattern: null,
      p_search_voucher_series: null,
      p_search_voucher_number: null,
      p_order: ['entry_date.desc', 'voucher_series.desc', 'voucher_number.desc', 'id.desc'],
      p_limit: 20,
      p_offset: 40,
    })
  })

  it('sends an escaped ILIKE pattern, plus series+number for a voucher-label search', async () => {
    enqueue({ data: { ok: true, total_count: 0, ids: [] }, error: null })
    enqueue({ data: { ok: true, total_count: 0, ids: [] }, error: null })

    await listMissingUnderlagPage(client, 'company-1', { search: ' a209 ' }, { limit: 20 })
    await listMissingUnderlagPage(client, 'company-1', { search: '50%_off' }, { limit: 20 })

    expect(rpcArgs(0)).toMatchObject({
      p_search_pattern: '%a209%',
      p_search_voucher_series: 'A',
      p_search_voucher_number: 209,
    })
    expect(rpcArgs(1)).toMatchObject({
      p_search_pattern: '%50\\%\\_off%',
      p_search_voucher_series: null,
      p_search_voucher_number: null,
    })
  })

  it('carries the driver error as cause alongside the user-facing Swedish text', async () => {
    const driverError = { message: 'canceling statement due to statement timeout', code: '57014', details: null, hint: null }
    enqueue({ data: null, error: driverError })

    const thrown = await listMissingUnderlagPage(client, 'company-1', {}, { limit: 20 }).catch((e) => e)

    expect(thrown).toBeInstanceOf(MissingUnderlagQueryError)
    // The raw driver error survives for the server log, unmapped (#2395).
    expect(thrown.cause).toBe(driverError)
    expect(thrown.userMessage).toBe(getErrorMessage(driverError))
    expect(thrown.message).toBe(thrown.userMessage)
  })

  it('throws with the refusal code as cause when the RPC answers not-ok', async () => {
    enqueue({ data: { ok: false, code: 'LIST_VERIFIKAT_MISSING_UNDERLAG_FORBIDDEN' }, error: null })

    const thrown = await listMissingUnderlagPage(client, 'company-1', {}, { limit: 20 }).catch((e) => e)

    expect(thrown).toBeInstanceOf(MissingUnderlagQueryError)
    expect(thrown.cause).toBe('LIST_VERIFIKAT_MISSING_UNDERLAG_FORBIDDEN')
  })
})

describe('listAllMissingUnderlagIds', () => {
  const ids = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => `${String(from + i).padStart(8, '0')}-0000-4000-8000-000000000000`)

  it('pages in id order at the RPC ceiling: one call per 1,000 missing, not per ledger chunk', async () => {
    enqueue({ data: { ok: true, total_count: 2500, ids: ids(0, 1000) }, error: null })
    enqueue({ data: { ok: true, total_count: 2500, ids: ids(1000, 1000) }, error: null })
    enqueue({ data: { ok: true, total_count: 2500, ids: ids(2000, 500) }, error: null })

    const all = await listAllMissingUnderlagIds(client, 'company-1', { periodId: 'period-1' })

    expect(all).toHaveLength(2500)
    expect(new Set(all).size).toBe(2500)
    expect(supabase.rpc).toHaveBeenCalledTimes(3)
    expect([0, 1, 2].map((c) => rpcArgs(c).p_offset)).toEqual([0, 1000, 2000])
    for (const c of [0, 1, 2]) {
      expect(rpcArgs(c)).toMatchObject({
        p_period_id: 'period-1',
        p_order: ['id.asc'],
        p_limit: MISSING_UNDERLAG_PAGE_MAX,
      })
    }
  })

  it('stops after one call when nothing is missing', async () => {
    enqueue({ data: { ok: true, total_count: 0, ids: [] }, error: null })

    expect(await listAllMissingUnderlagIds(client, 'company-1', {})).toEqual([])
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('stops on a short page even if the set shrank under it', async () => {
    enqueue({ data: { ok: true, total_count: 1500, ids: ids(0, 1000) }, error: null })
    enqueue({ data: { ok: true, total_count: 1200, ids: ids(1000, 200) }, error: null })

    expect(await listAllMissingUnderlagIds(client, 'company-1', {})).toHaveLength(1200)
    expect(supabase.rpc).toHaveBeenCalledTimes(2)
  })
})
