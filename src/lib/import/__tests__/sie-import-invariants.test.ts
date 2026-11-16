import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DUPLICATE_SCAN_COMPANY_PAGE,
  checkFailure,
  checkSieImportJobInvariants,
  scanSieImportDuplicateVouchers,
} from '../sie-import-invariants'

const rpc = vi.fn()
const supabase = { rpc } as unknown as SupabaseClient

type Page = {
  companies_checked: number
  last_company_id: string | null
  done: boolean
  duplicate_groups: number
  extra_vouchers: number
  duplicate_samples: unknown[]
  legacy_duplicate_groups?: number
  legacy_extra_vouchers?: number
}
const page = (overrides: Partial<Page>): { data: Page; error: null } => ({
  data: {
    companies_checked: 1,
    last_company_id: 'company-1',
    done: false,
    duplicate_groups: 0,
    extra_vouchers: 0,
    duplicate_samples: [],
    ...overrides,
  },
  error: null,
})
const sample = (n: number) => ({ company_id: `company-${n}`, n: 2 })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('scanSieImportDuplicateVouchers', () => {
  it('walks the company pages in order and sums them', async () => {
    rpc
      .mockResolvedValueOnce(page({ companies_checked: 500, last_company_id: 'company-500', duplicate_groups: 1, extra_vouchers: 2, duplicate_samples: [sample(3)], legacy_duplicate_groups: 3424, legacy_extra_vouchers: 3424 }))
      .mockResolvedValueOnce(page({ companies_checked: 120, last_company_id: 'company-620', done: true, duplicate_groups: 2, extra_vouchers: 2, duplicate_samples: [sample(510), sample(600)], legacy_duplicate_groups: 1437, legacy_extra_vouchers: 1440 }))

    const scan = await scanSieImportDuplicateVouchers(supabase, { deadline: Date.now() + 60_000 })

    expect(rpc.mock.calls).toEqual([
      ['check_sie_import_duplicate_vouchers', { p_after_company_id: null, p_company_limit: DUPLICATE_SCAN_COMPANY_PAGE }],
      ['check_sie_import_duplicate_vouchers', { p_after_company_id: 'company-500', p_company_limit: DUPLICATE_SCAN_COMPANY_PAGE }],
    ])
    expect(scan).toEqual({
      duplicate_groups: 3,
      extra_vouchers: 4,
      duplicate_samples: [sample(3), sample(510), sample(600)],
      legacy_duplicate_groups: 4861,
      legacy_extra_vouchers: 4864,
      companies_checked: 620,
      last_company_id: 'company-620',
      finished: true,
      stopped: null,
      failure: null,
    })
  })

  it('keeps the first 20 samples across pages, in page order', async () => {
    const first = Array.from({ length: 15 }, (_, i) => sample(i))
    const second = Array.from({ length: 15 }, (_, i) => sample(100 + i))
    rpc
      .mockResolvedValueOnce(page({ last_company_id: 'company-a', duplicate_groups: 15, duplicate_samples: first }))
      .mockResolvedValueOnce(page({ last_company_id: 'company-b', done: true, duplicate_groups: 15, duplicate_samples: second }))

    const scan = await scanSieImportDuplicateVouchers(supabase, { deadline: Date.now() + 60_000 })

    expect(scan.duplicate_groups).toBe(30)
    expect(scan.duplicate_samples).toEqual([...first, ...second.slice(0, 5)])
  })

  it('starts no page once the run budget is spent, and says so', async () => {
    let clock = 0
    rpc.mockImplementation(async () => {
      clock += 40_000
      return page({ companies_checked: 500, last_company_id: `company-${clock}` })
    })

    const scan = await scanSieImportDuplicateVouchers(supabase, { deadline: 100_000, now: () => clock })

    expect(rpc).toHaveBeenCalledTimes(3)
    expect(scan).toMatchObject({ finished: false, stopped: 'run_budget', companies_checked: 1500, last_company_id: 'company-120000' })
  })

  it('stops at a failed page and keeps what the pages before it found', async () => {
    rpc
      .mockResolvedValueOnce(page({ companies_checked: 500, last_company_id: 'company-500', duplicate_groups: 1, extra_vouchers: 1 }))
      .mockResolvedValueOnce({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } })

    const scan = await scanSieImportDuplicateVouchers(supabase, { deadline: Date.now() + 60_000 })

    expect(rpc).toHaveBeenCalledTimes(2)
    expect(scan).toMatchObject({
      finished: false,
      stopped: 'page_failed',
      failure: { code: '57014', message: 'canceling statement due to statement timeout' },
      companies_checked: 500,
      last_company_id: 'company-500',
      duplicate_groups: 1,
      extra_vouchers: 1,
    })
  })

  it('never asks for the same page twice', async () => {
    rpc
      .mockResolvedValueOnce(page({ last_company_id: 'company-1' }))
      .mockResolvedValueOnce(page({ last_company_id: 'company-1' }))

    const scan = await scanSieImportDuplicateVouchers(supabase, { deadline: Date.now() + 60_000 })

    expect(rpc).toHaveBeenCalledTimes(2)
    expect(scan).toMatchObject({ finished: false, stopped: 'no_progress', last_company_id: 'company-1' })
  })

  it('finishes on an empty last page', async () => {
    rpc.mockResolvedValueOnce(page({ companies_checked: 0, last_company_id: null, done: true }))

    const scan = await scanSieImportDuplicateVouchers(supabase, { deadline: Date.now() + 60_000 })

    expect(scan).toMatchObject({ finished: true, stopped: null, companies_checked: 0, last_company_id: null })
  })
})

describe('checkFailure', () => {
  it('keeps the database error code apart from the message', () => {
    expect(checkFailure({ code: '57014', message: 'canceling statement due to statement timeout' })).toEqual({
      code: '57014',
      message: 'canceling statement due to statement timeout',
    })
    expect(checkFailure(new Error('fetch failed'))).toEqual({ code: null, message: 'fetch failed' })
    expect(checkFailure('boom')).toEqual({ code: null, message: 'boom' })
  })
})

describe('checkSieImportJobInvariants', () => {
  it('reads the hold and job counts', async () => {
    rpc.mockResolvedValueOnce({
      data: { missing_holds: 1, stale_holds: '2', paused_jobs: 0, expired_leases: 3, oldest_unresolved: '2026-11-01T00:00:00Z' },
      error: null,
    })

    expect(await checkSieImportJobInvariants(supabase)).toEqual({
      missing_holds: 1,
      stale_holds: 2,
      paused_jobs: 0,
      expired_leases: 3,
      oldest_unresolved: '2026-11-01T00:00:00Z',
    })
    expect(rpc).toHaveBeenCalledWith('check_sie_import_job_invariants')
  })

  it('throws when the check cannot run', async () => {
    const error = { message: 'statement timeout' }
    rpc.mockResolvedValueOnce({ data: null, error })

    await expect(checkSieImportJobInvariants(supabase)).rejects.toBe(error)
  })
})
