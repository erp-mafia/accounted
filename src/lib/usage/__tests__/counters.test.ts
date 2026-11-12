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
    enqueue({ data: Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, status: 'accepted', signed_at: '2026-10-05T08:00:00.000Z' })) })

    expect(await countCompanyUsage(db, 'c1', 'bank_payment', '2026-10')).toBe(7)
    expect(findCalls('payment_orders', 'select')).toEqual([['id, status, signed_at']])
    expect(findCalls('payment_orders', 'not')).toEqual([['provider_payment_id', 'is', null]])
    expect(findCalls('payment_orders', 'gte')[0]?.[0]).toBe('submitted_at')
  })

  it('leaves out a bank payment that ended unpaid before anybody signed it', async () => {
    enqueue({
      data: [
        { id: 'refused', status: 'rejected', signed_at: null },
        { id: 'unsigned', status: 'cancelled', signed_at: null },
        { id: 'failed', status: 'failed', signed_at: null },
        { id: 'signed-then-cancelled', status: 'cancelled', signed_at: '2026-10-05T08:00:00.000Z' },
        { id: 'waiting', status: 'submitted', signed_at: null },
        { id: 'paid', status: 'executed', signed_at: '2026-10-05T08:00:00.000Z' },
      ],
    })

    expect(await countCompanyUsage(db, 'c1', 'bank_payment', '2026-10')).toBe(3)
  })

  it('counts completed signings, leaving out the annual report', async () => {
    enqueue({ count: 1 })

    expect(await countCompanyUsage(db, 'c1', 'signing', '2026-10')).toBe(1)
    expect(findCalls('signing_requests', 'eq')).toContainEqual(['status', 'completed'])
    expect(findCalls('signing_requests', 'is')).toEqual([['annual_report_version_id', null]])
    expect(findCalls('signing_requests', 'gte')[0]?.[0]).toBe('completed_at')
  })

  it('counts every signing before the month began, for an amount included once', async () => {
    enqueue({ count: 4 })

    expect(await countCompanyUsage(db, 'c1', 'signing', '2026-11', { before: true })).toBe(4)
    expect(findCalls('signing_requests', 'gte')).toEqual([])
    expect(findCalls('signing_requests', 'lt')).toEqual([['completed_at', usagePeriodBounds('2026-11').start]])
    expect(findCalls('signing_requests', 'eq')).toContainEqual(['status', 'completed'])
  })

  it('counts inbox documents our AI read, never those a customer\'s own agent read', async () => {
    enqueue({ count: 31 })

    expect(await countCompanyUsage(db, 'c1', 'ai_document', '2026-10')).toBe(31)
    expect(findCalls('invoice_inbox_items', 'eq')).toEqual([
      ['company_id', 'c1'],
      ['extraction_skipped', 'false'],
    ])
    expect(findCalls('invoice_inbox_items', 'gte')[0]?.[0]).toBe('created_at')
  })

  it('counts live bank accounts as they are now, whatever the month', async () => {
    enqueue({
      data: [
        { id: 'k1', accounts_data: [{ uid: 'a', iban: 'SE11', enabled: true }, { uid: 'b', iban: 'SE22', enabled: false }] },
        { id: 'k2', accounts_data: [{ uid: 'a2', iban: 'SE11', enabled: true }, { uid: 'c', iban: 'SE33', enabled: true }] },
      ],
    })

    expect(await countCompanyUsage(db, 'c1', 'bank_account', '2026-01')).toBe(2)
    expect(findCalls('bank_connections', 'eq')).toEqual([
      ['company_id', 'c1'],
      ['status', 'active'],
    ])
    expect(findCalls('bank_connections', 'is')).toEqual([['superseded_at', null]])
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

  it('leaves unsigned, unpaid bank payments off every company\'s statement', async () => {
    enqueue({
      data: [
        { id: 'a', company_id: 'c1', status: 'accepted', signed_at: '2026-10-05T08:00:00.000Z' },
        { id: 'b', company_id: 'c1', status: 'rejected', signed_at: null },
        { id: 'c', company_id: 'c2', status: 'cancelled', signed_at: null },
      ],
    })

    const counts = await countUsageByCompany(db, 'bank_payment', '2026-10')

    expect(counts).toEqual(new Map([['c1', 1]]))
    expect(findCalls('payment_orders', 'select')).toEqual([['id, company_id, status, signed_at']])
  })
})
