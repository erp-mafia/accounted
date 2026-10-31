import { describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { applyProviderState } from '../apply-state'
import { order } from './fixtures'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
const RCVD = { providerStatus: 'RCVD', status: 'submitted' as const, messages: [] }

describe('applyProviderState', () => {
  it.each(['awaiting_signature', 'awaiting_second_signer', 'accepted'] as const)(
    'never moves a %s order backwards on RCVD: only the provider status is written',
    async (status) => {
      const db = createTableMockSupabase({ payment_orders: { data: [{ id: 'o1' }] }, payment_order_events: { data: null } })

      const next = await applyProviderState(db.supabase as never, order('o1', { status }), RCVD, null, log as never)

      expect(next).toBe(status)
      const [patch] = db.findCalls('payment_orders', 'update').map(([p]) => p as Record<string, unknown>)
      expect(patch).toMatchObject({ provider_status: 'RCVD', status: undefined, signed_at: undefined })
      expect(db.findCalls('payment_order_events', 'insert')).toEqual([])
    },
  )

  it('moves a signed order forward when the bank accepts it, on the status it read', async () => {
    const db = createTableMockSupabase({ payment_orders: { data: [{ id: 'o1' }] }, payment_order_events: { data: null } })

    const next = await applyProviderState(
      db.supabase as never,
      order('o1', { status: 'awaiting_signature' }),
      { providerStatus: 'ACSP', status: 'accepted', messages: [] },
      'user-1',
      log as never,
    )

    expect(next).toBe('accepted')
    expect(db.findCalls('payment_orders', 'update')[0]![0]).toMatchObject({ status: 'accepted', provider_status: 'ACSP' })
    expect(db.findCalls('payment_orders', 'eq')).toContainEqual(['status', 'awaiting_signature'])
  })

  it('keeps the bank reason on an order it rejects, where Betalningar, Att göra and the mail read it', async () => {
    const db = createTableMockSupabase({ payment_orders: { data: [{ id: 'o1' }] }, payment_order_events: { data: null } })

    const next = await applyProviderState(
      db.supabase as never,
      order('o1', { status: 'awaiting_second_signer' }),
      { providerStatus: 'RJCT', status: 'rejected', messages: ['PSU_RIGHTS_MISSING'], refusalCode: 'PSU_RIGHTS_MISSING' },
      null,
      log as never,
    )

    expect(next).toBe('rejected')
    expect(db.findCalls('payment_orders', 'update')[0]![0]).toMatchObject({ status: 'rejected', provider_error_code: 'PSU_RIGHTS_MISSING' })
  })

  it('writes no reason when the bank gave none, or when the order does not end', async () => {
    const db = createTableMockSupabase({ payment_orders: { data: [{ id: 'o1' }] }, payment_order_events: { data: null } })

    await applyProviderState(db.supabase as never, order('o1', { status: 'accepted' }), { providerStatus: 'RJCT', status: 'rejected', messages: [] }, null, log as never)
    await applyProviderState(
      db.supabase as never,
      order('o2', { status: 'awaiting_second_signer' }),
      { providerStatus: 'PATC', status: 'awaiting_second_signer', messages: ['AUTHORISATION_PENDING_API'], secondSignatureViaApi: true },
      null,
      log as never,
    )

    const [rejected, waiting] = db.findCalls('payment_orders', 'update').map(([p]) => p as Record<string, unknown>)
    expect(rejected!.provider_error_code).toBeUndefined()
    expect(waiting!.provider_error_code).toBeUndefined()
  })
})
