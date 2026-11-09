import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), company: vi.fn(), detail: vi.fn() }))
vi.mock('@/app/(dashboard)/request-context', () => ({ getDashboardAuthContext: mocks.auth, getDashboardCompanyId: mocks.company }))
vi.mock('@/lib/core/bookkeeping/journal-entry-detail', () => ({ getJournalEntryDetail: mocks.detail }))
import { getInitialJournalEntryDetail } from '../initial-data'

const id = 'dc066288-3938-48e7-99f1-a14ce4b7a2e7'
const supabase = {}
const data = { entry: { id }, references: [] }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ supabase, user: { id: 'user-1' } })
  mocks.company.mockResolvedValue('company-1')
  mocks.detail.mockResolvedValue(data)
})

describe('request-local initial voucher data', () => {
  it('validates the identifier before resolving authentication or reading data', async () => {
    expect(await getInitialJournalEntryDetail('invalid')).toBeUndefined()
    expect(mocks.auth).not.toHaveBeenCalled()
    expect(mocks.detail).not.toHaveBeenCalled()
  })
  it('never reads vouchers for an unauthenticated request', async () => {
    mocks.auth.mockResolvedValue({ supabase, user: null })
    expect(await getInitialJournalEntryDetail(id)).toBeUndefined()
    expect(mocks.detail).not.toHaveBeenCalled()
  })
  it('never reads vouchers without an active company', async () => {
    mocks.company.mockResolvedValue(null)
    expect(await getInitialJournalEntryDetail(id)).toBeUndefined()
    expect(mocks.detail).not.toHaveBeenCalled()
  })
  it('uses the same company-scoped reader as API refreshes', async () => {
    expect(await getInitialJournalEntryDetail(id)).toEqual({ companyId: 'company-1', data })
    expect(mocks.detail).toHaveBeenCalledWith({ supabase, companyId: 'company-1', userId: 'user-1', log: expect.any(Object) }, id)
    expect(mocks.detail).toHaveBeenCalledTimes(1)
  })
  it('retains the existing client recovery path for a missing or foreign voucher', async () => {
    mocks.detail.mockResolvedValue(null)
    expect(await getInitialJournalEntryDetail(id)).toBeUndefined()
  })
  it('retains the client recovery path when the server read fails', async () => {
    mocks.detail.mockRejectedValue(new Error('temporarily unavailable'))
    expect(await getInitialJournalEntryDetail(id)).toBeUndefined()
  })
  it('fails closed when active-company resolution fails', async () => {
    mocks.company.mockRejectedValue(new Error('membership unavailable'))
    expect(await getInitialJournalEntryDetail(id)).toBeUndefined()
    expect(mocks.detail).not.toHaveBeenCalled()
  })
})
