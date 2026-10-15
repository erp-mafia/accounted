import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

const mocks = vi.hoisted(() => ({
  client: null as unknown,
  ensureTicSnapshot: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => mocks.client }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/agent/composer/tic-fetch', () => ({ ensureTicSnapshot: mocks.ensureTicSnapshot }))

import { refreshCompanyProfileAction } from '../tic-refresh'

function stored(settings: string | null, company: string | null, entityType = 'aktiebolag') {
  const mock = createTableMockSupabase({
    company_settings: { data: { org_number: settings, entity_type: entityType }, error: null },
    companies: { data: { org_number: company, entity_type: entityType }, error: null },
  })
  ;(mock.supabase as unknown as { auth: unknown }).auth = {
    getUser: async () => ({ data: { user: { id: 'user-1' } } }),
  }
  mocks.client = mock.supabase
  return mock
}

// The Bolagsuppgifter fetch follows the settings rule for the org number
// (lib/company/org-number-rule.ts); it used to overwrite both copies.
describe('refreshCompanyProfileAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.ensureTicSnapshot.mockResolvedValue({ snapshot: { name: 'Bolaget' }, source: 'fetched' })
  })

  it('refuses another number when the company has a valid one, and writes nothing', async () => {
    const mock = stored('556012-5790', '5560125790')

    expect(await refreshCompanyProfileAction('co-1', '202100-5489')).toEqual({ error: 'org_number_locked' })
    expect(mock.payloads('companies', 'update')).toEqual([])
    expect(mock.payloads('company_settings', 'update')).toEqual([])
    expect(mocks.ensureTicSnapshot).not.toHaveBeenCalled()
  })

  it('refetches with the company\'s own number without rewriting it', async () => {
    const mock = stored('556012-5790', '5560125790')

    const result = await refreshCompanyProfileAction('co-1', '5560125790')

    expect(result.ok).toBe(true)
    expect(mock.payloads('companies', 'update')).toEqual([{ tic_snapshot_fetched_at: null }])
    expect(mock.payloads('company_settings', 'update')).toEqual([])
  })

  it('gives the company row the valid settings number when it lacks one', async () => {
    const mock = stored('556012-5790', null)

    await refreshCompanyProfileAction('co-1', '556012-5790')

    expect(mock.payloads('companies', 'update')).toEqual([{ tic_snapshot_fetched_at: null, org_number: '5560125790' }])
    expect(mock.payloads('company_settings', 'update')).toEqual([])
  })

  it('fills in a missing number on both copies', async () => {
    const mock = stored(null, null, 'enskild_firma')

    const result = await refreshCompanyProfileAction('co-1', '19121212-1212')

    expect(result.ok).toBe(true)
    expect(mock.payloads('companies', 'update')).toEqual([{ tic_snapshot_fetched_at: null, org_number: '1212121212' }])
    expect(mock.payloads('company_settings', 'update')).toEqual([{ org_number: '1212121212' }])
  })

  it('refuses a wrong check digit, an invalid stored number typed back, and the wrong legal form', async () => {
    stored(null, null)
    expect(await refreshCompanyProfileAction('co-1', '556012-5791')).toEqual({ error: 'org_number_invalid' })
    stored('5560125791', '5560125791')
    expect(await refreshCompanyProfileAction('co-1', '5560125791')).toEqual({ error: 'org_number_invalid' })
    stored(null, null, 'aktiebolag')
    expect(await refreshCompanyProfileAction('co-1', '121212-1212')).toEqual({ error: 'org_number_legal_entity_required' })
    stored(null, null, 'enskild_firma')
    expect(await refreshCompanyProfileAction('co-1', '556012-5790')).toEqual({ error: 'org_number_personnummer_required' })
    expect(mocks.ensureTicSnapshot).not.toHaveBeenCalled()
  })
})
