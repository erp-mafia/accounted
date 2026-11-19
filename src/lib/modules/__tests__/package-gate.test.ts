import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import type * as Gate from '../package-gate'

// tests/unit/setup.ts answers "every package on" for every other test; this
// one exercises the real read.
const gate = await vi.importActual<typeof Gate>('../package-gate')

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'

function supabaseWith(tables: Parameters<typeof createTableMockSupabase>[0]) {
  const mock = createTableMockSupabase(tables)
  return { supabase: mock.supabase as unknown as SupabaseClient, mock }
}

describe('packageStartRefusal', () => {
  it('lets a start through for a package that is on: every company without a profile or a switch', async () => {
    const { supabase, mock } = supabaseWith({ company_capability_config: { data: null }, companies: { data: null } })
    expect(await gate.packageStartRefusal(supabase, COMPANY_ID, 'payroll')).toBeNull()
    // One key, the package's own, for the company.
    expect(mock.findCalls('company_capability_config', 'eq')).toEqual([
      ['company_id', COMPANY_ID],
      ['capability_key', 'package:payroll'],
    ])
  })

  it('refuses with PACKAGE_OFF, the package named, when the company switched it off', async () => {
    const { supabase } = supabaseWith({
      company_capability_config: { data: { enabled: false } },
      companies: { data: null },
    })
    const refusal = await gate.packageStartRefusal(supabase, COMPANY_ID, 'payroll')
    expect(refusal).toMatchObject({
      code: 'PACKAGE_OFF',
      packageId: 'payroll',
      status: 409,
      details: { package_id: 'payroll', package_name: 'Lön', reason: 'turned_off_by_company', resolution: 'Slå på Lön under Anpassa.' },
    })
    expect(refusal!.messageSv).toBe(
      'Paketet Lön är avstängt för företaget, så inget nytt kan startas där. Det som redan är öppet fungerar som vanligt. Slå på Lön under Anpassa.',
    )
    expect(refusal!.messageEn).toMatch(/gnubok_enable_package/)
  })

  it('refuses when the profile leaves the package off and the company made no choice, and not once it chose on', async () => {
    const profileOff = supabaseWith({
      company_capability_config: { data: null },
      companies: { data: { profile_id: 'limited-company-no-employees', profile_version: 1 } },
    })
    expect(await gate.packageStartRefusal(profileOff.supabase, COMPANY_ID, 'assets')).toMatchObject({
      details: { reason: 'off_in_profile' },
    })

    const chosenOn = supabaseWith({
      company_capability_config: { data: { enabled: true } },
      companies: { data: { profile_id: 'limited-company-no-employees', profile_version: 1 } },
    })
    expect(await gate.packageStartRefusal(chosenOn.supabase, COMPANY_ID, 'assets')).toBeNull()
  })

  it('lets the start through when the switch cannot be read', async () => {
    const { supabase } = supabaseWith({
      company_capability_config: { data: null, error: { message: 'down' } },
      companies: { data: null },
    })
    expect(await gate.packageStartRefusal(supabase, COMPANY_ID, 'expenses')).toBeNull()
  })
})

describe('packageOffToolError', () => {
  it('is the MCP error envelope with the switch to stage as its remediation', () => {
    const body = gate.packageOffToolError(gate.packageOffRefusal('pos-and-webshop', 'turned_off_by_company'))
    expect(body.error).toMatchObject({
      code: 'PACKAGE_OFF',
      retryable: false,
      remediation: { tool: 'gnubok_enable_package', args: { package_id: 'pos-and-webshop' } },
    })
    expect(body.error.message_sv).toMatch(/Slå på Kassa och webbshop under Anpassa\.$/)
  })
})
