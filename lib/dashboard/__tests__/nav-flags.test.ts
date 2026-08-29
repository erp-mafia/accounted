import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getDashboardNavFlags } from '../nav-flags'

function makeSupabase(
  rpcResult: { data?: unknown; error?: { code?: string; message?: string } | null },
  probes: Record<string, unknown[]> = {},
) {
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    const self: unknown = new Proxy(chain, {
      get: (_t, prop) => {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve({ data: probes[table] ?? [], error: null })
        }
        return () => self
      },
    })
    return self
  })
  const rpc = vi.fn(async () => ({ data: rpcResult.data ?? null, error: rpcResult.error ?? null }))
  return { supabase: { from, rpc } as unknown as SupabaseClient, from, rpc }
}

describe('getDashboardNavFlags', () => {
  it('reads both flags from the RPC row and never touches the tables', async () => {
    const { supabase, from, rpc } = makeSupabase({ data: [{ has_webshop: true, has_mileage_trips: false }] })
    expect(await getDashboardNavFlags(supabase, 'c1')).toEqual({ hasWebshop: true, hasMileageTrips: false })
    expect(rpc).toHaveBeenCalledWith('get_dashboard_nav_flags', { p_company_id: 'c1' })
    expect(from).not.toHaveBeenCalled()
  })

  it('accepts a single-object payload and treats null flags as false', async () => {
    const { supabase } = makeSupabase({ data: { has_webshop: null, has_mileage_trips: true } })
    expect(await getDashboardNavFlags(supabase, 'c1')).toEqual({ hasWebshop: false, hasMileageTrips: true })
  })

  it.each(['PGRST202', '42883', '42501'])('falls back to the four probes when the RPC is unavailable (%s)', async (code) => {
    const { supabase, from } = makeSupabase({ error: { code } }, { webshop_orders: [{ id: 'o1' }] })
    expect(await getDashboardNavFlags(supabase, 'c1')).toEqual({ hasWebshop: true, hasMileageTrips: false })
    expect(from.mock.calls.map((c) => c[0]).sort()).toEqual([
      'mileage_trips',
      'shopify_connections',
      'webshop_orders',
      'woocommerce_connections',
    ])
  })

  it('degrades to hidden rows on any other error instead of probing', async () => {
    const { supabase, from } = makeSupabase({ error: { code: '57014', message: 'timeout' } })
    expect(await getDashboardNavFlags(supabase, 'c1')).toEqual({ hasWebshop: false, hasMileageTrips: false })
    expect(from).not.toHaveBeenCalled()
  })
})
