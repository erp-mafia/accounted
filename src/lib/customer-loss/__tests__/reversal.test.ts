import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// The annulment is recorded as the service role (write-off-rpc.ts).
const service = vi.hoisted(() => ({
  rpc: null as unknown as (...args: unknown[]) => unknown,
  member: { role: 'member' } as { role: string } | null,
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'neq']) chain[m] = () => chain
    chain.maybeSingle = () => Promise.resolve({ data: service.member, error: null })
    return { from: () => chain, rpc: (...args: unknown[]) => service.rpc(...args) }
  },
}))
import { CustomerLossReversalRefusedError } from '../errors'
import { decisionId } from '../ids'
import { assertCustomerLossReversible, syncCustomerLossAfterReversal } from '../reversal'

const INVOICE = '11111111-1111-4111-8111-111111111111'

function row(id: string, kind: string, decidedAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    invoice_id: INVOICE,
    kind,
    amount: 625,
    net_amount: 500,
    vat_amount: 125,
    vat_by_rate: [{ account: '2611', rate: 25, vat: 125, base: 500 }],
    reserve_released: 0,
    journal_entry_id: `je-${id}`,
    reverses_id: null,
    decided_at: decidedAt,
    ...extra,
  }
}

function mockSupabase(rows: ReturnType<typeof row>[], found: boolean = true) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    neq: () => chain,
    maybeSingle: () => Promise.resolve({ data: found ? { invoice_id: INVOICE } : null, error: null }),
    order: () => Promise.resolve({ data: rows, error: null }),
  }
  const rpc = vi.fn().mockResolvedValue({ data: {}, error: null })
  service.rpc = rpc
  const sessionRpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'permission denied' } })
  return { supabase: { from: () => chain, rpc: sessionRpc } as unknown as SupabaseClient, rpc, sessionRpc }
}

beforeEach(() => {
  service.member = { role: 'member' }
})

describe('storno of a kundförlust voucher', () => {
  const confirmed = row('g', 'confirmed', '2026-06-01T00:00:00Z')
  const recovered = row('h', 'recovered', '2026-07-01T00:00:00Z', { amount: 125, net_amount: 100, vat_amount: 25 })

  it('is refused while a later decision stands, and allowed for the latest', async () => {
    const { supabase } = mockSupabase([confirmed, recovered])
    await expect(assertCustomerLossReversible(supabase, 'c', 'je-g')).rejects.toBeInstanceOf(CustomerLossReversalRefusedError)
    await expect(assertCustomerLossReversible(supabase, 'c', 'je-h')).resolves.toBeUndefined()
  })

  it('is allowed once the later decision is annulled, and for a voucher without a decision', async () => {
    const annul = row('x', 'annulled', '2026-07-02T00:00:00Z', { reverses_id: 'h' })
    await expect(assertCustomerLossReversible(mockSupabase([confirmed, recovered, annul]).supabase, 'c', 'je-g')).resolves.toBeUndefined()
    await expect(assertCustomerLossReversible(mockSupabase([], false).supabase, 'c', 'je-z')).resolves.toBeUndefined()
  })

  it('records the annulment on the storno voucher and date', async () => {
    const { supabase, rpc } = mockSupabase([confirmed])
    await syncCustomerLossAfterReversal(supabase, 'c', 'u', 'je-g', { id: 'je-storno', entry_date: '2026-06-10' })
    expect(rpc).toHaveBeenCalledWith(
      'record_invoice_write_off',
      expect.objectContaining({
        p_id: await decisionId(INVOICE, 'annulled', 0),
        p_kind: 'annulled',
        p_reverses_id: 'g',
        p_journal_entry_id: 'je-storno',
        p_entry_date: '2026-06-10',
        p_amount: 625,
        p_vat_by_rate: confirmed.vat_by_rate,
        p_company_id: 'c',
        p_decided_by: 'u',
      }),
    )
  })

  it('records it as the service role, never on the person\'s own client, and not for a person who may not write', async () => {
    const { supabase, rpc, sessionRpc } = mockSupabase([confirmed])
    await syncCustomerLossAfterReversal(supabase, 'c', 'u', 'je-g', { id: 'je-storno', entry_date: '2026-06-10' })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(sessionRpc).not.toHaveBeenCalled()

    service.member = null
    const viewer = mockSupabase([confirmed])
    // The storno stands; the annulment is not recorded (and logged), never thrown.
    await expect(
      syncCustomerLossAfterReversal(viewer.supabase, 'c', 'viewer', 'je-g', { id: 'je-storno', entry_date: '2026-06-10' }),
    ).resolves.toBeUndefined()
    expect(viewer.rpc).not.toHaveBeenCalled()
  })
})
