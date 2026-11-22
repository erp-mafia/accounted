import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

const mocks = vi.hoisted(() => ({
  client: null as unknown,
  ensureTicSnapshot: vi.fn(),
  readTicPurposeSpent: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => mocks.client }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/agent/composer/tic-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent/composer/tic-fetch')>()),
  ensureTicSnapshot: mocks.ensureTicSnapshot,
}))
vi.mock('@/lib/tic-budget/status', () => ({ readTicPurposeSpent: mocks.readTicPurposeSpent }))

import { refreshCompanyProfileAction } from '../tic-refresh'

function stored(settings: string | null, company: string | null, entityType = 'aktiebolag', role = 'owner') {
  const mock = createTableMockSupabase({
    company_settings: { data: { org_number: settings, entity_type: entityType }, error: null },
    companies: { data: { org_number: company, entity_type: entityType }, error: null },
    company_members: { data: { role }, error: null },
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
    mocks.readTicPurposeSpent.mockResolvedValue({ spent: false, resumesOn: '2026-11-22' })
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

  it('says a member could not fill in the number, instead of fetching as if it was saved', async () => {
    const mock = stored(null, null, 'enskild_firma', 'member')

    expect(await refreshCompanyProfileAction('co-1', '19121212-1212')).toEqual({ error: 'persist_failed' })
    expect(mock.payloads('company_settings', 'update')).toEqual([])
    expect(mocks.ensureTicSnapshot).not.toHaveBeenCalled()
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

// Why a fetch gave no fresh profile decides what the panel says: only a real
// miss is "not found".
describe('refreshCompanyProfileAction: fetch outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.readTicPurposeSpent.mockResolvedValue({ spent: false, resumesOn: '2026-11-22' })
  })

  it('says not found only when TIC has no company under the number', async () => {
    stored('556012-5790', '5560125790')
    mocks.ensureTicSnapshot.mockResolvedValue({ snapshot: null, source: 'fallback', reason: 'not_found' })

    expect(await refreshCompanyProfileAction('co-1', '5560125790')).toEqual({ error: 'not_found' })
    expect(mocks.readTicPurposeSpent).not.toHaveBeenCalled()
  })

  it('says when fetching works again when the budget is spent', async () => {
    stored('556012-5790', '5560125790')
    mocks.ensureTicSnapshot.mockResolvedValue({ snapshot: { name: 'Gammal' }, source: 'fallback', reason: 'unavailable' })
    mocks.readTicPurposeSpent.mockResolvedValue({ spent: true, resumesOn: '2026-11-22' })

    expect(await refreshCompanyProfileAction('co-1', '5560125790')).toEqual({ error: 'paused', resumesOn: '2026-11-22' })
    expect(mocks.readTicPurposeSpent).toHaveBeenCalledWith('refresh')
  })

  it('says TIC is not answering when the budget is not the reason, or cannot be read', async () => {
    stored('556012-5790', '5560125790')
    mocks.ensureTicSnapshot.mockResolvedValue({ snapshot: null, source: 'fallback', reason: 'unavailable' })

    expect(await refreshCompanyProfileAction('co-1', '5560125790')).toEqual({ error: 'unavailable' })
    mocks.readTicPurposeSpent.mockResolvedValue(null)
    expect(await refreshCompanyProfileAction('co-1', '5560125790')).toEqual({ error: 'unavailable' })
  })

  it('returns a partial profile with the date the missing parts can be fetched', async () => {
    stored('556012-5790', '5560125790')
    const snapshot = { companyName: 'Bolaget', statuses: [], incompleteSections: ['statuses'] }
    mocks.ensureTicSnapshot.mockResolvedValue({ snapshot, source: 'fetched' })
    mocks.readTicPurposeSpent.mockResolvedValue({ spent: true, resumesOn: '2026-11-22' })

    const result = await refreshCompanyProfileAction('co-1', '5560125790')

    expect(result).toMatchObject({ ok: true, snapshot, resumesOn: '2026-11-22' })
  })

  it('does not read the budget for a complete profile', async () => {
    stored('556012-5790', '5560125790')
    mocks.ensureTicSnapshot.mockResolvedValue({ snapshot: { companyName: 'Bolaget', incompleteSections: [] }, source: 'fetched' })

    const result = await refreshCompanyProfileAction('co-1', '5560125790')

    expect(result.ok).toBe(true)
    expect(result).not.toHaveProperty('resumesOn')
    expect(mocks.readTicPurposeSpent).not.toHaveBeenCalled()
  })
})
