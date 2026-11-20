import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/providers/provider-data-fetcher', () => ({ fetchCompanyInfoDirect: vi.fn() }))
import { fetchCompanyInfoDirect } from '@/lib/providers/provider-data-fetcher'
import { ExecutionBudgetExceeded } from '@/lib/http/execution-budget'
import { FortnoxApiError } from '@/lib/providers/fortnox/client'
import { BokioApiError } from '@/lib/providers/bokio/client'
import { ProviderCallError } from '@/lib/providers/with-provider-call'
import { readProviderRefusal } from '../read-refusal'

const companyInfo = vi.mocked(fetchCompanyInfoDirect)
const CONNECTION = { accessToken: 'synthetic-token', providerCompanyId: 'synthetic-account' }
const inAMinute = () => Date.now() + 60_000

beforeEach(() => vi.resetAllMocks())

describe('readProviderRefusal', () => {
  it('reads a 403 on a token that still answers as a refused resource', async () => {
    companyInfo.mockResolvedValueOnce({ name: 'Synthetic company' } as never)
    const read = await readProviderRefusal(new BokioApiError('Bokio API error: 403 Forbidden', 403), 'bokio', CONNECTION, inAMinute())
    expect(read).toBeInstanceOf(ProviderCallError)
    expect(read).toMatchObject({ code: 'PROVIDER_RESOURCE_FORBIDDEN', provider: 'bokio', status: 403 })
    expect(companyInfo).toHaveBeenCalledWith('bokio', 'synthetic-token', 'synthetic-account')
  })

  it('keeps the error when the token does not answer, or answers nothing', async () => {
    const refused = new FortnoxApiError('Fortnox API error: 403 Forbidden', 403)
    companyInfo.mockRejectedValueOnce(new FortnoxApiError('Fortnox API error: 401 Unauthorized', 401))
    expect(await readProviderRefusal(refused, 'fortnox', CONNECTION, inAMinute())).toBe(refused)
    companyInfo.mockResolvedValueOnce(null)
    expect(await readProviderRefusal(refused, 'fortnox', CONNECTION, inAMinute())).toBe(refused)
  })

  it('asks nothing about an error that is not a 403', async () => {
    const expired = new FortnoxApiError('Fortnox API error: 401 Unauthorized', 401)
    expect(await readProviderRefusal(expired, 'fortnox', CONNECTION, inAMinute())).toBe(expired)
    const plain = new Error('PROVIDER_AUTH_EXPIRED')
    expect(await readProviderRefusal(plain, 'fortnox', CONNECTION, inAMinute())).toBe(plain)
    expect(companyInfo).not.toHaveBeenCalled()
  })

  it('throws when there is no time left to ask', async () => {
    await expect(readProviderRefusal(new BokioApiError('Bokio API error: 403 Forbidden', 403), 'bokio', CONNECTION, Date.now() - 1))
      .rejects.toBeInstanceOf(ExecutionBudgetExceeded)
    expect(companyInfo).not.toHaveBeenCalled()
  })
})
