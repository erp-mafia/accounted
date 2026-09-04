/**
 * Unit tests for the fiscal-year-reset service wrapper.
 *
 * The guards themselves live in the reset_fiscal_year RPC and are pinned by
 * tests/pg/reset-fiscal-year.pg.test.ts against real Postgres; these tests
 * pin the envelope mapping (RPC jsonb -> typed outcomes), the fail-closed
 * default code, and that the execution escalates through
 * rpcClientForBulkDelete with an explicit p_user_id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getFiscalYearResetEligibility,
  resetFiscalYear,
} from '@/lib/core/bookkeeping/fiscal-year-reset'
import type { SupabaseClient } from '@supabase/supabase-js'

const bulkRpcMock = vi.fn()
const bulkClient = { rpc: bulkRpcMock } as unknown as SupabaseClient
vi.mock('@/lib/import/sie-import', () => ({
  rpcClientForBulkDelete: vi.fn(async () => bulkClient),
}))

function sessionClient(rpcResult: { data?: unknown; error?: unknown }): SupabaseClient {
  return { rpc: vi.fn(async () => rpcResult) } as unknown as SupabaseClient
}

const SNAPSHOT = {
  ok: true,
  eligible: true,
  blockers: [],
  period: {
    id: 'period-1',
    name: '2026',
    period_start: '2026-01-01',
    period_end: '2026-12-31',
  },
  counts: { vouchers: 7, documents_to_detach: 2 },
  next_period: { id: 'period-2', name: '2027', has_opening_balances: true },
}

describe('getFiscalYearResetEligibility', () => {
  beforeEach(() => vi.clearAllMocks())

  it('maps the RPC snapshot to a typed eligibility', async () => {
    const supabase = sessionClient({ data: SNAPSHOT, error: null })

    const result = await getFiscalYearResetEligibility(supabase, 'company-1', 'period-1')

    expect(result).toEqual({
      ok: true,
      eligibility: {
        eligible: true,
        blockers: [],
        period: SNAPSHOT.period,
        counts: SNAPSHOT.counts,
        next_period: SNAPSHOT.next_period,
      },
    })
    expect(supabase.rpc).toHaveBeenCalledWith('get_fiscal_year_reset_eligibility', {
      p_company_id: 'company-1',
      p_period_id: 'period-1',
    })
  })

  it('passes through blockers for an ineligible year', async () => {
    const supabase = sessionClient({
      data: {
        ...SNAPSHOT,
        eligible: false,
        blockers: [{ code: 'period_locked' }, { code: 'vat_declared', count: 1 }],
      },
      error: null,
    })

    const result = await getFiscalYearResetEligibility(supabase, 'company-1', 'period-1')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.eligibility.eligible).toBe(false)
      expect(result.eligibility.blockers).toEqual([
        { code: 'period_locked' },
        { code: 'vat_declared', count: 1 },
      ])
    }
  })

  it('returns the RPC error code when the RPC refuses', async () => {
    const supabase = sessionClient({
      data: { ok: false, code: 'FISCAL_YEAR_RESET_FORBIDDEN' },
      error: null,
    })

    const result = await getFiscalYearResetEligibility(supabase, 'company-1', 'period-1')

    expect(result).toEqual({ ok: false, code: 'FISCAL_YEAR_RESET_FORBIDDEN' })
  })

  it('fails closed on a transport error', async () => {
    const supabase = sessionClient({ data: null, error: { message: 'boom' } })

    const result = await getFiscalYearResetEligibility(supabase, 'company-1', 'period-1')

    expect(result).toEqual({ ok: false, code: 'FISCAL_YEAR_RESET_FAILED' })
  })

  it('fails closed on a null RPC payload', async () => {
    const supabase = sessionClient({ data: null, error: null })

    const result = await getFiscalYearResetEligibility(supabase, 'company-1', 'period-1')

    expect(result).toEqual({ ok: false, code: 'FISCAL_YEAR_RESET_FAILED' })
  })
})

describe('resetFiscalYear', () => {
  beforeEach(() => vi.clearAllMocks())

  it('executes through the bulk-delete client with an explicit user id', async () => {
    bulkRpcMock.mockResolvedValue({
      data: { ok: true, deleted: 7, detached_documents: 2, period_name: '2026' },
      error: null,
    })
    const supabase = sessionClient({ data: null, error: null })

    const result = await resetFiscalYear(supabase, 'company-1', 'period-1', 'user-1', '2026')

    expect(result).toEqual({
      ok: true,
      deleted: 7,
      detachedDocuments: 2,
      periodName: '2026',
    })
    expect(bulkRpcMock).toHaveBeenCalledWith('reset_fiscal_year', {
      p_company_id: 'company-1',
      p_period_id: 'period-1',
      p_confirmed_name: '2026',
      p_user_id: 'user-1',
    })
  })

  it('passes through refusal codes and blockers', async () => {
    bulkRpcMock.mockResolvedValue({
      data: {
        ok: false,
        code: 'FISCAL_YEAR_RESET_INELIGIBLE',
        blockers: [{ code: 'company_lock_date', date: '2026-06-30' }],
      },
      error: null,
    })
    const supabase = sessionClient({ data: null, error: null })

    const result = await resetFiscalYear(supabase, 'company-1', 'period-1', 'user-1', '2026')

    expect(result).toEqual({
      ok: false,
      code: 'FISCAL_YEAR_RESET_INELIGIBLE',
      blockers: [{ code: 'company_lock_date', date: '2026-06-30' }],
    })
  })

  it('fails closed on a transport error', async () => {
    bulkRpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } })
    const supabase = sessionClient({ data: null, error: null })

    const result = await resetFiscalYear(supabase, 'company-1', 'period-1', 'user-1', '2026')

    expect(result).toEqual({ ok: false, code: 'FISCAL_YEAR_RESET_FAILED' })
  })
})
