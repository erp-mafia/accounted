import { beforeEach, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(), createClient: vi.fn() }))
vi.mock('@/lib/providers/fortnox/oauth', async original => ({
  ...await original<typeof import('@/lib/providers/fortnox/oauth')>(), exchangeFortnoxCode: vi.fn(),
}))
vi.mock('@/lib/providers/provider-data-fetcher', () => ({ fetchCompanyInfoDirect: vi.fn().mockResolvedValue(null) }))
import { createServiceClient } from '@/lib/supabase/server'
import { exchangeFortnoxCode } from '@/lib/providers/fortnox/oauth'
import { exchangeAuthToken } from '../provider-client'
beforeEach(() => vi.clearAllMocks())
it('does not acknowledge reconnect when storing replacement tokens fails', async () => {
  const mock = createQueuedMockSupabase()
  vi.mocked(createServiceClient).mockReturnValue(mock.supabase as never)
  vi.mocked(exchangeFortnoxCode).mockResolvedValue({ access_token: 'synthetic', refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'Bearer' })
  mock.enqueue({ data: null, error: { message: 'write failed' } })
  await expect(exchangeAuthToken('synthetic-consent', 'fortnox', 'synthetic-code')).rejects.toThrow('could not be saved')
  expect(mock.findCall('provider_consents', 'update')).toBeUndefined()
})
