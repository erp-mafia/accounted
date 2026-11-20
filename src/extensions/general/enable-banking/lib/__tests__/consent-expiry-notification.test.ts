import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ sendCore: vi.fn() }))
vi.mock('@/lib/bank-sync/consent-expiry-notification', () => ({
  sendConsentExpiryNotification: (...args: unknown[]) => mocks.sendCore(...args),
}))

import { sendConsentExpiryNotification } from '../consent-expiry-notification'

const supabase = {} as never
const connection = { id: 'conn-1', user_id: 'user-1', company_id: 'co-1', bank_name: 'SEB' }

describe('sendConsentExpiryNotification (Enable Banking)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sendCore.mockResolvedValue(undefined)
  })
  afterEach(() => vi.unstubAllEnvs())

  it('passes through to the shared mail while the feed runs', async () => {
    vi.stubEnv('OPENPAYMENTS_SWITCH_DEADLINE', '2099-01-01')
    await sendConsentExpiryNotification(supabase, connection, 3, false, 'https://app.test')
    expect(mocks.sendCore).toHaveBeenCalledWith(supabase, connection, 3, false, 'https://app.test')
  })

  it('sends nothing once the Enable Banking feed has ended: the consent is moot', async () => {
    vi.stubEnv('OPENPAYMENTS_SWITCH_DEADLINE', '2026-01-01')
    await sendConsentExpiryNotification(supabase, connection, 0, true, 'https://app.test')
    expect(mocks.sendCore).not.toHaveBeenCalled()
  })
})
