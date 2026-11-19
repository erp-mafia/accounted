import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { readDirectBookingSettings } from '../direct-booking-settings'

/** The company's one-click switch as every surface reads it (accounted#130). */
describe('readDirectBookingSettings', () => {
  async function read(result: { data?: unknown; error?: unknown }) {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue(result)
    const settings = await readDirectBookingSettings(supabase as unknown as SupabaseClient, 'company-1')
    return { settings, findCalls }
  }

  it('reads the company row, scoped to the company', async () => {
    const { settings, findCalls } = await read({ data: { direct_booking_enabled: false } })
    expect(settings).toEqual({ enabled: false })
    expect(findCalls('company_settings', 'eq')).toEqual([['company_id', 'company-1']])
  })

  it('is on where the company never touched it: no settings row, or a database the migration has not reached', async () => {
    expect((await read({ data: { direct_booking_enabled: true } })).settings).toEqual({ enabled: true })
    expect((await read({ data: null })).settings).toEqual({ enabled: true })
    expect((await read({ error: { code: '42703', message: 'column company_settings.direct_booking_enabled does not exist' } })).settings).toEqual({
      enabled: true,
    })
  })

  it('answers off on any other failure: a booking asks once more, never once less', async () => {
    expect((await read({ error: { code: '57014', message: 'statement timeout' } })).settings).toEqual({ enabled: false })
  })
})
