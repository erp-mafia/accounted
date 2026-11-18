/**
 * PUT /api/settings and the lock date (company_settings.bookkeeping_locked_through).
 *
 * Moving the lock date back over a momsperiod whose declaration is filed
 * reopens that period for writes. The API and MCP doors have asked before
 * doing that since 2026-09-26; the settings page did not (the decision of
 * that day left it out until the founder decided). It asks now: the save is
 * refused with 409 BOOKKEEPING_LOCK_REOPENS_FILED_VAT naming the periods, the
 * page shows them, and the save comes again with
 * acknowledge_filed_vat_periods. A move that reopens no filed period, and
 * every forward move, is saved as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import type { VatFilingRecord } from '@/lib/vat/filing-record'

const { supabase, enqueueMany, reset, findCalls } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const isAdminMock = vi.fn()
// The real envelope builder stays: only the database predicate is mocked.
vi.mock('@/lib/auth/require-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/require-write')>()
  return {
    ...actual,
    requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
    isCompanyAdmin: (...args: unknown[]) => isAdminMock(...args),
  }
})

// The filing record is its own unit (lib/vat/__tests__/filing-record-store.test.ts).
// Which of its periods a move reopens is the real filedVatPeriodsReopenedBy.
const listVatFilings = vi.hoisted(() => vi.fn<() => Promise<VatFilingRecord[]>>(async () => []))
vi.mock('@/lib/vat/filing-record-store', () => ({ listVatFilings: () => listVatFilings() }))

import { eventBus } from '@/lib/events/bus'
import { PUT } from '../route'

const STORED = {
  id: 'cs-1',
  company_id: 'company-1',
  entity_type: 'aktiebolag',
  company_name: 'Test AB',
  bookkeeping_locked_through: '2026-09-30' as string | null,
}
const HAS_DEADLINES = { data: null, count: 5 }

function filed(tax_period: string, period_start: string, period_end: string, filed_on: string): VatFilingRecord {
  return {
    deadline_id: `dl-${tax_period}`,
    period_type: 'quarterly',
    year: Number(tax_period.slice(0, 4)),
    period: Number(tax_period.slice(-1)),
    tax_period,
    period_start,
    period_end,
    filed_on,
    source: 'manual',
    reference: null,
  }
}
const FILED_Q2 = filed('2026-Q2', '2026-04-01', '2026-06-30', '2026-08-12')
const FILED_Q3 = filed('2026-Q3', '2026-07-01', '2026-09-30', '2026-11-12')

/**
 * One save of the page, on a company whose stored lock date is `before`. The
 * row the update returns carries what the save sent.
 */
async function save(before: string | null, body: Record<string, unknown>) {
  const stored = { ...STORED, bookkeeping_locked_through: before }
  const { acknowledge_filed_vat_periods: _acknowledged, ...columns } = body
  enqueueMany([
    { data: stored }, // the stored row
    { data: { ...stored, ...columns } }, // update ... returning
    HAS_DEADLINES,
  ])
  const response = await PUT(createMockRequest('/api/settings', { method: 'PUT', body }), {
    params: Promise.resolve({}),
  })
  const { status, body: answer } = await parseJsonResponse<Record<string, unknown>>(response)
  return { status, answer, updates: findCalls('company_settings', 'update') }
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  reset()
  listVatFilings.mockResolvedValue([])
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  isAdminMock.mockResolvedValue(true)
})

describe('PUT /api/settings: a lock date moved back over a filed momsperiod', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const { status } = await save('2026-09-30', { bookkeeping_locked_through: '2026-03-31' })

    expect(status).toBe(401)
  })

  it('refuses with 409 naming the filed periods, and writes nothing', async () => {
    listVatFilings.mockResolvedValue([FILED_Q3, FILED_Q2])

    const { status, answer, updates } = await save('2026-09-30', { bookkeeping_locked_through: '2026-03-31' })

    expect(status).toBe(409)
    expect(answer.error).toMatchObject({
      code: 'BOOKKEEPING_LOCK_REOPENS_FILED_VAT',
      details: {
        // Earliest period first, each with the range it declares and when it was filed.
        filed_periods: [
          { tax_period: '2026-Q2', period_start: '2026-04-01', period_end: '2026-06-30', filed_on: '2026-08-12' },
          { tax_period: '2026-Q3', period_start: '2026-07-01', period_end: '2026-09-30', filed_on: '2026-11-12' },
        ],
        acknowledge_with: 'acknowledge_filed_vat_periods',
      },
    })
    expect(updates).toEqual([])
  })

  it('names only the periods the move reopens: one still behind the new lock date stays out', async () => {
    listVatFilings.mockResolvedValue([FILED_Q3, FILED_Q2])

    const { status, answer } = await save('2026-09-30', { bookkeeping_locked_through: '2026-06-30' })

    expect(status).toBe(409)
    const periods = (answer.error as { details: { filed_periods: Array<{ tax_period: string }> } }).details.filed_periods
    expect(periods.map((period) => period.tax_period)).toEqual(['2026-Q3'])
  })

  it('refuses removing the lock date over a filed period the same way', async () => {
    listVatFilings.mockResolvedValue([FILED_Q2])

    const { status, answer, updates } = await save('2026-09-30', { bookkeeping_locked_through: null })

    expect(status).toBe(409)
    expect(answer.error).toMatchObject({ code: 'BOOKKEEPING_LOCK_REOPENS_FILED_VAT' })
    expect(updates).toEqual([])
  })

  it('an acknowledgment that is false is no acknowledgment', async () => {
    listVatFilings.mockResolvedValue([FILED_Q2])

    const { status, updates } = await save('2026-09-30', {
      bookkeeping_locked_through: '2026-03-31',
      acknowledge_filed_vat_periods: false,
    })

    expect(status).toBe(409)
    expect(updates).toEqual([])
  })

  it('saves with the acknowledgment, which never reaches the table', async () => {
    listVatFilings.mockResolvedValue([FILED_Q3, FILED_Q2])

    const { status, answer, updates } = await save('2026-09-30', {
      bookkeeping_locked_through: '2026-03-31',
      acknowledge_filed_vat_periods: true,
    })

    expect(status).toBe(200)
    expect(answer.data).toMatchObject({ bookkeeping_locked_through: '2026-03-31' })
    expect(updates).toHaveLength(1)
    const payload = updates[0][0] as Record<string, unknown>
    expect(payload.bookkeeping_locked_through).toBe('2026-03-31')
    expect(payload).not.toHaveProperty('acknowledge_filed_vat_periods')
  })

  it('refuses the rest of the form with it: nothing is half saved', async () => {
    listVatFilings.mockResolvedValue([FILED_Q2])

    const { status, updates } = await save('2026-09-30', {
      bookkeeping_locked_through: '2026-03-31',
      default_voucher_series: 'B',
    })

    expect(status).toBe(409)
    expect(updates).toEqual([])
  })

  it('rejects an acknowledgment that is not a boolean (400)', async () => {
    const { status, updates } = await save('2026-09-30', {
      bookkeeping_locked_through: '2026-03-31',
      acknowledge_filed_vat_periods: 'yes',
    })

    expect(status).toBe(400)
    expect(updates).toEqual([])
  })
})

describe('PUT /api/settings: lock date moves that reopen no filed momsperiod', () => {
  it('saves a move back that reopens only dates outside every filed period', async () => {
    // Q2 is filed and stays behind the new lock date; July to September is not filed.
    listVatFilings.mockResolvedValue([FILED_Q2])

    const { status, answer, updates } = await save('2026-09-30', { bookkeeping_locked_through: '2026-06-30' })

    expect(status).toBe(200)
    expect(answer.data).toMatchObject({ bookkeeping_locked_through: '2026-06-30' })
    expect(updates).toHaveLength(1)
  })

  it('saves a move back when nothing is filed at all', async () => {
    const { status, updates } = await save('2026-09-30', { bookkeeping_locked_through: null })

    expect(status).toBe(200)
    expect(updates).toHaveLength(1)
  })

  it('saves a forward move without reading the filing record', async () => {
    listVatFilings.mockResolvedValue([FILED_Q3, FILED_Q2])

    const { status, answer } = await save('2026-09-30', { bookkeeping_locked_through: '2026-10-31' })

    expect(status).toBe(200)
    expect(answer.data).toMatchObject({ bookkeeping_locked_through: '2026-10-31' })
    expect(listVatFilings).not.toHaveBeenCalled()
  })

  it('saves a first lock date (the Moms page offers it on a filed period)', async () => {
    listVatFilings.mockResolvedValue([FILED_Q3])

    const { status, answer } = await save(null, { bookkeeping_locked_through: '2026-09-30' })

    expect(status).toBe(200)
    expect(answer.data).toMatchObject({ bookkeeping_locked_through: '2026-09-30' })
    expect(listVatFilings).not.toHaveBeenCalled()
  })

  it('saves the form when it resends the stored lock date, as every save of the page does', async () => {
    listVatFilings.mockResolvedValue([FILED_Q3, FILED_Q2])

    const { status } = await save('2026-09-30', { bookkeeping_locked_through: '2026-09-30', default_voucher_series: 'B' })

    expect(status).toBe(200)
    expect(listVatFilings).not.toHaveBeenCalled()
  })

  it('saves settings that leave the lock date alone', async () => {
    listVatFilings.mockResolvedValue([FILED_Q3, FILED_Q2])

    const { status, answer } = await save('2026-09-30', { default_voucher_series: 'B' })

    expect(status).toBe(200)
    expect(answer.data).toMatchObject({ bookkeeping_locked_through: '2026-09-30', default_voucher_series: 'B' })
    expect(listVatFilings).not.toHaveBeenCalled()
  })
})
