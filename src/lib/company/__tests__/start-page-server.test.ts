import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const getActiveCompanyIdMock = vi.fn()
vi.mock('@/lib/company/active-company', () => ({
  getActiveCompanyId: (...args: unknown[]) => getActiveCompanyIdMock(...args),
}))

import { resolveStartPath } from '../start-page-server'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const client = supabase as unknown as SupabaseClient

const COMPANY_A = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const COMPANY_B = '0b5f3c2a-9d41-4e6b-8a7c-1d2e3f4a5b6c'

function prefs(startPage: unknown) {
  return { data: { ui_state: { start_page: startPage } } }
}

const originalRollout = process.env.BOOKING_SCREEN_COMPANY_IDS

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  delete process.env.BOOKING_SCREEN_COMPANY_IDS
  getActiveCompanyIdMock.mockImplementation(async (_s: unknown, _u: unknown, facts?: { role?: string }) => {
    if (facts) facts.role = 'owner'
    return COMPANY_A
  })
})

afterEach(() => {
  if (originalRollout === undefined) delete process.env.BOOKING_SCREEN_COMPANY_IDS
  else process.env.BOOKING_SCREEN_COMPANY_IDS = originalRollout
})

describe('resolveStartPath', () => {
  it("answers / without a choice and reads nothing but the person's preferences", async () => {
    enqueue({ data: { ui_state: {} } })

    expect(await resolveStartPath(client, 'user-1')).toBe('/')
    expect(getActiveCompanyIdMock).not.toHaveBeenCalled()
    expect(findCalls('company_members', 'select')).toHaveLength(0)
  })

  it('answers the choice for the active company, with the role the resolution reported', async () => {
    enqueue(prefs({ [COMPANY_A]: 'bookkeeping', [COMPANY_B]: 'supplier_invoices' }))

    expect(await resolveStartPath(client, 'user-1')).toBe('/bookkeeping')
    expect(findCalls('company_members', 'select')).toHaveLength(0)
  })

  it('answers / when the active company has no choice of its own', async () => {
    enqueue(prefs({ [COMPANY_B]: 'supplier_invoices' }))

    expect(await resolveStartPath(client, 'user-1')).toBe('/')
  })

  it('uses the company it is given (the switch) and reads the role there', async () => {
    enqueue(prefs({ [COMPANY_A]: 'bookkeeping', [COMPANY_B]: 'supplier_invoices' }))
    enqueue({ data: { role: 'member' } })

    expect(await resolveStartPath(client, 'user-1', COMPANY_B)).toBe('/supplier-invoices')
    expect(getActiveCompanyIdMock).not.toHaveBeenCalled()
    expect(findCalls('company_members', 'eq')).toEqual([
      ['company_id', COMPANY_B],
      ['user_id', 'user-1'],
    ])
  })

  it('lands the invoicing role on / when its choice is a page it cannot open', async () => {
    enqueue(prefs({ [COMPANY_B]: 'bookkeeping' }))
    enqueue({ data: { role: 'invoicer' } })

    expect(await resolveStartPath(client, 'user-1', COMPANY_B)).toBe('/')
  })

  it('lands on Att bokföra only inside the booking screen rollout', async () => {
    enqueue(prefs({ [COMPANY_A]: 'to_book' }))
    expect(await resolveStartPath(client, 'user-1')).toBe('/')

    process.env.BOOKING_SCREEN_COMPANY_IDS = COMPANY_A
    enqueue(prefs({ [COMPANY_A]: 'to_book' }))
    expect(await resolveStartPath(client, 'user-1')).toBe('/att-bokfora')
  })

  it('answers / on any failed read', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    expect(await resolveStartPath(client, 'user-1')).toBe('/')

    enqueue(prefs({ [COMPANY_B]: 'reports' }))
    enqueue({ data: null, error: { message: 'boom' } })
    expect(await resolveStartPath(client, 'user-1', COMPANY_B)).toBe('/')

    enqueue(prefs({ [COMPANY_A]: 'reports' }))
    getActiveCompanyIdMock.mockRejectedValueOnce(new Error('resolution failed'))
    expect(await resolveStartPath(client, 'user-1')).toBe('/')
  })

  it('answers / for a person without a company', async () => {
    enqueue(prefs({ [COMPANY_A]: 'reports' }))
    getActiveCompanyIdMock.mockResolvedValueOnce(null)

    expect(await resolveStartPath(client, 'user-1')).toBe('/')
  })
})
