import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { countPaymentsToSignDue, listPaymentsToSignDue } from '../categories'

const order = (status: string, amount: number, day: string) => ({ id: `po-${status}-${day}`, status, amount, currency: 'SEK', requested_execution_date: day })

const seed = (orders: unknown[] | null, error: unknown = null) =>
  createTableMockSupabase({ payment_orders: { data: orders, error } }).supabase as unknown as SupabaseClient

afterEach(() => {
  vi.restoreAllMocks()
})

describe('listPaymentsToSignDue (payments_to_sign, crm#1925)', () => {
  it('gives one row for the payments an agent prepared and nobody approved or signed', async () => {
    const supabase = seed([order('draft', 12500, '2026-11-27'), order('draft', 3999.5, '2026-11-20')])
    expect(await listPaymentsToSignDue(supabase, 'c1')).toEqual({ count: 2, to_approve: 2, next_date: '2026-11-20', amount: 16499.5, currency: 'SEK' })
    expect(await countPaymentsToSignDue(supabase, 'c1')).toBe(2)
  })

  it('gives one row for approved payments whose BankID nobody finished', async () => {
    const supabase = seed([order('approved', 800, '2026-11-24')])
    expect(await listPaymentsToSignDue(supabase, 'c1')).toEqual({ count: 1, to_approve: 0, next_date: '2026-11-24', amount: 800, currency: 'SEK' })
  })

  it('gives no row when nothing waits', async () => {
    const supabase = seed([])
    expect(await listPaymentsToSignDue(supabase, 'c1')).toBeNull()
    expect(await countPaymentsToSignDue(supabase, 'c1')).toBe(0)
  })

  it('soft-fails to no row when the read fails: a broken count never takes Hem down', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = seed(null, { message: 'permission denied', code: '42501' })
    expect(await listPaymentsToSignDue(supabase, 'c1')).toBeNull()
    expect(await countPaymentsToSignDue(supabase, 'c1')).toBe(0)
    logged.mockRestore()
  })
})
