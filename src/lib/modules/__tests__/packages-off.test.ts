import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { readPackagesOff } from '../packages-off'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const TODAY = '2026-10-17'

function supabaseWith(tables: Parameters<typeof createTableMockSupabase>[0]) {
  const mock = createTableMockSupabase(tables)
  return { supabase: mock.supabase as unknown as SupabaseClient, mock }
}

const choice = (packageId: string, enabled: boolean) => ({ capability_key: `package:${packageId}`, enabled })

describe('readPackagesOff', () => {
  it('reads the switches and the profile once, and probes nothing, for a company with every package on', async () => {
    const { supabase, mock } = supabaseWith({ company_capability_config: { data: [] }, companies: { data: null } })
    const off = await readPackagesOff(supabase, COMPANY_ID, ['customer-invoices', 'supplier-invoices-and-payments'], { today: TODAY })
    expect([...off!]).toEqual([])
    expect(mock.tables().sort()).toEqual(['companies', 'company_capability_config'])
    expect(mock.findCall('company_capability_config', 'in')).toEqual([
      'capability_key',
      ['package:customer-invoices', 'package:supplier-invoices-and-payments'],
    ])
    expect(mock.findCall('company_capability_config', 'eq')).toEqual(['company_id', COMPANY_ID])
  })

  it('counts a package the company switched off with nothing open', async () => {
    const { supabase, mock } = supabaseWith({
      company_capability_config: { data: [choice('customer-invoices', false)] },
      companies: { data: null },
    })
    const off = await readPackagesOff(supabase, COMPANY_ID, ['customer-invoices', 'supplier-invoices-and-payments'], { today: TODAY })
    expect([...off!]).toEqual(['customer-invoices'])
    // Only the switched-off package is probed.
    expect(mock.tables()).toContain('rot_rut_payout_requests')
    expect(mock.tables()).not.toContain('supplier_invoices')
  })

  it('leaves out a switched-off package that is winding down: an open ROT/RUT begäran keeps Kundfakturor running', async () => {
    const { supabase } = supabaseWith({
      company_capability_config: { data: [choice('customer-invoices', false)] },
      companies: { data: null },
      rot_rut_payout_requests: { data: [{ id: 'rr-1' }] },
    })
    expect([...(await readPackagesOff(supabase, COMPANY_ID, ['customer-invoices'], { today: TODAY }))!]).toEqual([])
  })

  it('applies the profile, and the company choice over it', async () => {
    const profile = { data: { profile_id: 'sole-trader', profile_version: 1 } }
    const byProfile = supabaseWith({ company_capability_config: { data: [] }, companies: profile })
    expect([
      ...(await readPackagesOff(byProfile.supabase, COMPANY_ID, ['customer-invoices', 'supplier-invoices-and-payments'], {
        today: TODAY,
      }))!,
    ]).toEqual(['supplier-invoices-and-payments'])

    const switchedBackOn = supabaseWith({
      company_capability_config: { data: [choice('supplier-invoices-and-payments', true)] },
      companies: profile,
    })
    expect([...(await readPackagesOff(switchedBackOn.supabase, COMPANY_ID, ['supplier-invoices-and-payments'], { today: TODAY }))!]).toEqual([])
  })

  it('answers null when the switch read fails or throws, so the caller runs everything', async () => {
    const failed = supabaseWith({ company_capability_config: { data: null, error: { message: 'down' } }, companies: { data: null } })
    expect(await readPackagesOff(failed.supabase, COMPANY_ID, ['customer-invoices'], { today: TODAY })).toBeNull()

    const throwing = {
      from: (table: string) => {
        if (table === 'company_capability_config') throw new Error('connection reset')
        return createTableMockSupabase({}).supabase.from(table)
      },
    } as unknown as SupabaseClient
    expect(await readPackagesOff(throwing, COMPANY_ID, ['customer-invoices'], { today: TODAY })).toBeNull()
  })

  it('reads a failed profile as Standard: only the company\'s own choices count', async () => {
    const { supabase } = supabaseWith({
      company_capability_config: { data: [choice('customer-invoices', false)] },
      companies: { data: null, error: { message: 'down' } },
    })
    expect([
      ...(await readPackagesOff(supabase, COMPANY_ID, ['customer-invoices', 'supplier-invoices-and-payments'], { today: TODAY }))!,
    ]).toEqual(['customer-invoices'])
  })

  it('never counts Bokföring, and reads nothing when no switchable package is asked about', async () => {
    const { supabase, mock } = supabaseWith({})
    expect([...(await readPackagesOff(supabase, COMPANY_ID, ['bookkeeping'], { today: TODAY }))!]).toEqual([])
    expect([...(await readPackagesOff(supabase, COMPANY_ID, [], { today: TODAY }))!]).toEqual([])
    expect(mock.tables()).toEqual([])
  })
})
