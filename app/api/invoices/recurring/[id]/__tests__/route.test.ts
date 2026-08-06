import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

// Capturing mock: one shared chain whose .single() resolves the schedule row,
// whose bare await resolves { error: null }, and whose .update() records the
// payload so tests can assert exactly what gets written.
const updatePayloads: Record<string, unknown>[] = []
let scheduleRow: Record<string, unknown> | null = null
let customerRow: Record<string, unknown> | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chain: any = {
  select: () => chain,
  update: (payload: Record<string, unknown>) => {
    updatePayloads.push(payload)
    return chain
  },
  delete: () => chain,
  insert: () => chain,
  eq: () => chain,
  single: () => Promise.resolve({ data: scheduleRow, error: null }),
  maybeSingle: () => Promise.resolve({ data: customerRow, error: null }),
  then: (resolve: (v: unknown) => void) => resolve({ error: null }),
}

const mockSupabase = {
  auth: { getUser: vi.fn() },
  // The table name is unused by the shared chain, but declared so a test can
  // install a table-aware implementation of its own.
  from: vi.fn((_table?: string) => chain),
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { PATCH } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }
const params = { params: Promise.resolve({ id: 's-1' }) }
const patchReq = (body: unknown) =>
  createMockRequest('/api/invoices/recurring/s-1', { method: 'PATCH', body })

describe('PATCH /api/invoices/recurring/[id] reactivation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updatePayloads.length = 0
    customerRow = null
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    vi.useFakeTimers()
    // 08:30 UTC = 10:30 Stockholm (CEST) -> today is 2026-07-06 in Sweden.
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rolls a stale next_run_date forward and clears the warning on reactivation', async () => {
    scheduleRow = { next_run_date: '2026-07-05', day_of_month: 5 }

    const { status } = await parseJsonResponse(await PATCH(patchReq({ status: 'active' }), params))
    expect(status).toBe(200)
    expect(updatePayloads).toHaveLength(1)
    expect(updatePayloads[0]).toMatchObject({
      status: 'active',
      next_run_date: '2026-08-05',
      last_run_warning: null,
    })
  })

  it('rolls strictly into the future when reactivated on the schedule day itself', async () => {
    scheduleRow = { next_run_date: '2026-07-06', day_of_month: 6 }

    await PATCH(patchReq({ status: 'active' }), params)
    // Never today: today's invoice is the explicit run-now action instead.
    expect(updatePayloads[0].next_run_date).toBe('2026-08-06')
  })

  it('keeps a future next_run_date untouched but still clears the warning', async () => {
    scheduleRow = { next_run_date: '2026-07-20', day_of_month: 20 }

    await PATCH(patchReq({ status: 'active' }), params)
    expect(updatePayloads[0]).not.toHaveProperty('next_run_date')
    expect(updatePayloads[0]).toHaveProperty('last_run_warning', null)
  })

  it('recomputes next_run_date to the new day when day_of_month is edited', async () => {
    // Paused schedule, day 5 -> user edits to day 20. Today is 2026-07-06, so
    // the next day-20 occurrence is later this month.
    scheduleRow = { next_run_date: '2026-08-05', day_of_month: 5 }

    await PATCH(patchReq({ day_of_month: 20 }), params)
    expect(updatePayloads[0]).toMatchObject({ day_of_month: 20, next_run_date: '2026-07-20' })
    // Not a reactivation, so the warning is left as-is.
    expect(updatePayloads[0]).not.toHaveProperty('last_run_warning')
  })

  it('leaves next_run_date alone when the edited day is unchanged', async () => {
    scheduleRow = { next_run_date: '2026-07-20', day_of_month: 20 }

    await PATCH(patchReq({ day_of_month: 20, name: 'Renamed' }), params)
    expect(updatePayloads[0]).not.toHaveProperty('next_run_date')
    expect(updatePayloads[0]).toMatchObject({ day_of_month: 20, name: 'Renamed' })
  })

  it('keeps a quarterly schedule on its month grid when day_of_month is edited', async () => {
    // Quarterly schedule anchored on October; editing the day must stay in
    // October (a today-anchored recompute would bill a quarter early).
    scheduleRow = { next_run_date: '2026-10-15', day_of_month: 15, interval_months: 3 }

    await PATCH(patchReq({ day_of_month: 20 }), params)
    expect(updatePayloads[0]).toMatchObject({ day_of_month: 20, next_run_date: '2026-10-20' })
  })

  it('rolls a stale quarterly schedule forward by whole quarters on reactivation', async () => {
    // Jan/Apr/Jul/Oct schedule missed Apr 5; today is 2026-07-06, so Jul 5
    // has also passed. Next strictly-future grid slot is Oct 5.
    scheduleRow = { next_run_date: '2026-04-05', day_of_month: 5, interval_months: 3 }

    await PATCH(patchReq({ status: 'active' }), params)
    expect(updatePayloads[0]).toMatchObject({
      status: 'active',
      next_run_date: '2026-10-05',
      last_run_warning: null,
    })
  })

  it('reactivating a quarterly schedule on its own day rolls strictly past today', async () => {
    scheduleRow = { next_run_date: '2026-01-06', day_of_month: 6, interval_months: 3 }

    await PATCH(patchReq({ status: 'active' }), params)
    // Grid: Jan 6 -> Apr 6 -> Jul 6 (today, excluded) -> Oct 6.
    expect(updatePayloads[0].next_run_date).toBe('2026-10-06')
  })

  it('changing interval_months alone leaves next_run_date untouched', async () => {
    scheduleRow = { next_run_date: '2026-07-20', day_of_month: 20, interval_months: 1 }

    await PATCH(patchReq({ interval_months: 3 }), params)
    expect(updatePayloads[0]).toEqual({ interval_months: 3 })
  })

  it('does not touch next_run_date or warning when pausing', async () => {
    scheduleRow = { next_run_date: '2026-07-05', day_of_month: 5 }

    await PATCH(patchReq({ status: 'paused' }), params)
    expect(updatePayloads[0]).toEqual({ status: 'paused' })
  })

  it('returns 404 when reactivating a schedule that does not exist', async () => {
    scheduleRow = null

    const { status, body } = await parseJsonResponse<{ type: string }>(
      await PATCH(patchReq({ status: 'active' }), params),
    )
    expect(status).toBe(404)
    expect(body.type).toBe('not_found')
    expect(updatePayloads).toHaveLength(0)
  })

  it('rejects enabling auto_send when the customer has no email', async () => {
    scheduleRow = { auto_send: false, customer_id: 'c-1' }
    customerRow = { email: null }

    const { status, body } = await parseJsonResponse<{ type: string }>(
      await PATCH(patchReq({ auto_send: true }), params),
    )
    expect(status).toBe(400)
    expect(body.type).toBe('validation_error')
    expect(updatePayloads).toHaveLength(0)
  })

  it('allows enabling auto_send when the customer has an email', async () => {
    scheduleRow = { auto_send: false, customer_id: 'c-1' }
    customerRow = { email: 'kund@test.se' }

    const { status } = await parseJsonResponse(await PATCH(patchReq({ auto_send: true }), params))
    expect(status).toBe(200)
    expect(updatePayloads[0]).toEqual({ auto_send: true })
  })
})

/**
 * A combined edit (header fields + items) writes two tables, which PostgREST
 * cannot do atomically. Issue #1275: an item-insert failure used to leave the
 * header update committed. These tests pin the compensating rollback and the
 * partial-state error when a compensation itself fails.
 */
describe('PATCH /api/invoices/recurring/[id] combined edit rollback', () => {
  const SCHEDULES = 'recurring_invoice_schedules'
  const STAMP = '2026-07-30T09:00:00.000Z'
  const headerRow: Record<string, unknown> = {
    id: 's-1',
    name: 'Månadsavgift',
    day_of_month: 25,
    next_run_date: '2026-08-25',
    updated_at: '2026-07-01T00:00:00Z',
  }

  const storedItem = {
    id: 'i-1',
    created_at: '2026-07-01T00:00:00Z',
    schedule_id: 's-1',
    sort_order: 0,
    description: 'Gammal rad',
    quantity: 1,
    unit: 'st',
    unit_price: 500,
    vat_rate: 25,
    dimensions: {},
  }

  let itemsInsertErrors: (Record<string, unknown> | null)[] = []
  let itemsSnapshot: Record<string, unknown>[] = []
  let headerExists = true
  const itemsInserts: Record<string, unknown>[][] = []

  beforeEach(() => {
    vi.clearAllMocks()
    updatePayloads.length = 0
    itemsInserts.length = 0
    itemsInsertErrors = []
    itemsSnapshot = []
    headerExists = true
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })

    let headerUpdateCall = 0
    let itemsInsertCall = 0
    mockSupabase.from.mockImplementation((table?: string) => {
      if (table === SCHEDULES) {
        const selectChain: Record<string, unknown> = {
          eq: () => selectChain,
          single: () => Promise.resolve({ data: headerExists ? headerRow : null, error: null }),
          maybeSingle: () =>
            Promise.resolve({ data: headerExists ? headerRow : null, error: null }),
        }
        return {
          select: () => selectChain,
          update: (payload: Record<string, unknown>) => {
            updatePayloads.push(payload)
            const call = headerUpdateCall
            headerUpdateCall += 1
            const chain: Record<string, unknown> = {
              eq: () => chain,
              // The first update reads back updated_at; the rollback update
              // reads back the matched ids.
              select: () =>
                call === 0
                  ? { maybeSingle: () => Promise.resolve({ data: { updated_at: STAMP }, error: null }) }
                  : Promise.resolve({ data: [{ id: 's-1' }], error: null }),
            }
            return chain
          },
        }
      }
      const itemsChain: Record<string, unknown> = {
        // The snapshot is read through fetchAllRows, hence .order().range().
        select: () => ({
          eq: () => ({
            order: () => ({
              range: () => Promise.resolve({ data: itemsSnapshot, error: null }),
            }),
          }),
        }),
        delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
        insert: (rows: Record<string, unknown>[]) => {
          itemsInserts.push(rows)
          const error = itemsInsertErrors[itemsInsertCall] ?? null
          itemsInsertCall += 1
          return Promise.resolve({ error })
        },
      }
      return itemsChain
    })
  })

  afterEach(() => {
    // clearAllMocks does not reset implementations, so hand the shared chain
    // back or the first describe breaks when the file order changes.
    mockSupabase.from.mockImplementation(() => chain)
  })

  const items = [{ description: 'Rad A', quantity: 1, unit: 'st', unit_price: 1000 }]

  it('restores the prior header fields when the items insert fails', async () => {
    itemsSnapshot = [storedItem]
    itemsInsertErrors = [{ message: 'check violation', code: '23514' }, null]

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await PATCH(patchReq({ name: 'Nytt namn', items }), params),
    )

    expect(status).toBe(400)
    // Clean rollback keeps the PG-mapped error, not the partial-state one.
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(updatePayloads).toHaveLength(2)
    expect(updatePayloads[1]).toEqual({ name: 'Månadsavgift' })
    // Items back too: the failed replace, then the snapshot restore.
    expect(itemsInserts).toHaveLength(2)
    expect(itemsInserts[1][0]).toMatchObject({ description: 'Gammal rad', schedule_id: 's-1' })
  })

  it('returns the partial-state error when the items restore also fails', async () => {
    itemsSnapshot = [storedItem]
    itemsInsertErrors = [
      { message: 'check violation', code: '23514' },
      { message: 'restore boom' },
    ]

    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string }
    }>(await PATCH(patchReq({ name: 'Nytt namn', items }), params))

    expect(status).toBe(500)
    expect(body.error.code).toBe('INVOICE_RECURRING_UPDATE_PARTIAL')
    expect(body.error.message).toMatch(/halvsparat/)
  })

  it('writes no header row for an item-only edit', async () => {
    const { status } = await parseJsonResponse(await PATCH(patchReq({ items }), params))

    expect(status).toBe(200)
    expect(updatePayloads).toHaveLength(0)
    expect(itemsInserts).toHaveLength(1)
  })

  it('404s before writing the header when the schedule does not exist', async () => {
    headerExists = false

    const { status, body } = await parseJsonResponse<{ type: string }>(
      await PATCH(patchReq({ name: 'Nytt namn', items }), params),
    )

    expect(status).toBe(404)
    expect(body.type).toBe('not_found')
    expect(updatePayloads).toHaveLength(0)
  })
})
