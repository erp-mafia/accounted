/**
 * checkPeriodLock answers the v1 write routes' "can a verifikat land on this
 * date". It is now resolvePeriodStatusForDate's verdict in v1's shape, so a
 * failed lookup answers locked (fail closed) instead of open.
 */
import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { checkPeriodLock } from '../check-period-lock'

const COMPANY = 'company-1'
const DATE = '2026-03-15'

describe('checkPeriodLock', () => {
  it('fails closed when the company lock date cannot be read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'connection reset' } })
    enqueue({ data: null })

    await expect(checkPeriodLock(supabase as never, COMPANY, DATE)).resolves.toEqual({
      locked: true,
      reason: 'lookup_failed',
    })
  })

  it('fails closed when the covering fiscal period cannot be read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { bookkeeping_locked_through: null } })
    enqueue({ error: { message: 'more than one row' } })

    await expect(checkPeriodLock(supabase as never, COMPANY, DATE)).resolves.toEqual({
      locked: true,
      reason: 'lookup_failed',
    })
  })

  it('reports the company lock date covering the date', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { bookkeeping_locked_through: '2026-03-31' } })
    enqueue({ data: { id: 'fp-1' } })

    await expect(checkPeriodLock(supabase as never, COMPANY, DATE)).resolves.toMatchObject({
      locked: true,
      reason: 'company_lock_date_covers',
    })
  })

  it.each([
    [{ id: 'fp-1', is_closed: true, locked_at: null }, { locked: true, reason: 'period_is_closed', fiscal_period_id: 'fp-1' }],
    [{ id: 'fp-1', is_closed: false, locked_at: '2026-04-02T10:00:00Z' }, { locked: true, reason: 'period_locked_at_set', fiscal_period_id: 'fp-1' }],
    [{ id: 'fp-1', is_closed: false, locked_at: null }, { locked: false, fiscal_period_id: 'fp-1' }],
    [null, { locked: false, reason: 'no_fiscal_period' }],
  ])('maps the fiscal period %o to %o', async (period, verdict) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { bookkeeping_locked_through: '2025-12-31' } })
    enqueue({ data: period })

    await expect(checkPeriodLock(supabase as never, COMPANY, DATE)).resolves.toEqual(verdict)
  })
})
