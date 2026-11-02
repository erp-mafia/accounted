import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { usagePeriodBounds } from '@/lib/payments/usage'
import { countCompanyUsage, countUsageByCompany } from '../counters'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const db = supabase as unknown as SupabaseClient

beforeEach(() => {
  reset()
})

describe('countCompanyUsage', () => {
  it('counts Kivra invoices and payslips together, only those Kivra accepted, in the Stockholm month', async () => {
    enqueue({ count: 3 })
    enqueue({ count: 2 })

    expect(await countCompanyUsage(db, 'c1', 'kivra_send', '2026-10')).toBe(5)

    const { start, end } = usagePeriodBounds('2026-10')
    for (const table of ['digital_mailbox_dispatches', 'salary_payslip_deliveries']) {
      expect(findCalls(table, 'select')).toEqual([['id', { count: 'exact', head: true }]])
      expect(findCalls(table, 'eq')).toEqual([
        ['company_id', 'c1'],
        ['provider', 'kivra'],
        ['status', 'sent'],
      ])
      expect(findCalls(table, 'gte')).toEqual([['created_at', start]])
      expect(findCalls(table, 'lt')).toEqual([['created_at', end]])
    }
  })

  it('counts bank payments that reached the provider, by when they were sent', async () => {
    enqueue({ count: 7 })

    expect(await countCompanyUsage(db, 'c1', 'bank_payment', '2026-10')).toBe(7)
    expect(findCalls('payment_orders', 'not')).toEqual([['provider_payment_id', 'is', null]])
    expect(findCalls('payment_orders', 'gte')[0]?.[0]).toBe('submitted_at')
  })

  it('counts completed signings, leaving out the annual report', async () => {
    enqueue({ count: 1 })

    expect(await countCompanyUsage(db, 'c1', 'signing', '2026-10')).toBe(1)
    expect(findCalls('signing_requests', 'eq')).toContainEqual(['status', 'completed'])
    expect(findCalls('signing_requests', 'is')).toEqual([['annual_report_version_id', null]])
    expect(findCalls('signing_requests', 'gte')[0]?.[0]).toBe('completed_at')
  })

  it('throws on a failed read instead of counting zero', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(countCompanyUsage(db, 'c1', 'peppol_send', '2026-10')).rejects.toThrow(/peppol_deliveries.*boom/)
  })
})

describe('countUsageByCompany', () => {
  it('adds up every source per company', async () => {
    enqueue({ data: [{ id: 'a', company_id: 'c1' }, { id: 'b', company_id: 'c2' }, { id: 'c', company_id: 'c1' }] })
    enqueue({ data: [{ id: 'd', company_id: 'c2' }] })

    const counts = await countUsageByCompany(db, 'billo_send', '2026-10')

    expect(counts).toEqual(new Map([['c1', 2], ['c2', 2]]))
    expect(findCalls('digital_mailbox_dispatches', 'order')).toEqual([['id']])
  })
})
