import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ companyId: 'company-1' as string | null, swr: vi.fn() }))
vi.mock('swr', () => ({ default: state.swr }))
vi.mock('@/contexts/CompanyContext', () => ({
  useCompanyOptional: () => ({ company: state.companyId ? { id: state.companyId } : null }),
}))
vi.mock('@/components/settings/useSettings', () => ({ useCompanySettings: vi.fn() }))

import { useAccounts } from '../hooks'

beforeEach(() => {
  state.companyId = 'company-1'
  state.swr.mockReset().mockReturnValue({ data: [], isLoading: false, mutate: vi.fn() })
})

describe('account reference subscriptions', () => {
  it.each([true, false])('retains the company-scoped key for activeOnly=%s', activeOnly => {
    useAccounts(activeOnly)
    expect(state.swr.mock.calls[0][0]).toEqual(['ref:accounts', 'company-1', activeOnly])
  })

  it('does not subscribe when the caller already has its account name', () => {
    useAccounts(false, { enabled: false })
    expect(state.swr.mock.calls[0][0]).toBeNull()
  })

  it('does not subscribe before an active company is available', () => {
    state.companyId = null
    useAccounts()
    expect(state.swr.mock.calls[0][0]).toBeNull()
  })
})
