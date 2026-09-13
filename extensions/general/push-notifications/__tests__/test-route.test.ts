import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import { pushNotificationsApiRoutes } from '../api-routes'

const sendTestPushToUser = vi.fn()

vi.mock('../notification-sender', () => ({
  getVapidPublicKey: () => 'synthetic-vapid-public',
  sendTestPushToUser: (...args: unknown[]) => sendTestPushToUser(...args),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ tag: 'supabase' }),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: async () => ({ error: new Error('unauthenticated') }),
}))

const USER_ID = '11111111-1111-4111-8111-111111111111'
const ctx = { userId: USER_ID } as unknown as ExtensionContext
const request = () =>
  new Request('http://localhost/api/extensions/ext/push-notifications/test', {
    method: 'POST',
  })

const route = () =>
  pushNotificationsApiRoutes.find((r) => r.method === 'POST' && r.path === '/test')!.handler

beforeEach(() => {
  sendTestPushToUser.mockReset()
})

describe('POST /test', () => {
  it('returns 401 without a user', async () => {
    const response = await route()(request())
    expect(response.status).toBe(401)
    expect(sendTestPushToUser).not.toHaveBeenCalled()
  })

  it('sends to the calling user and returns 200', async () => {
    sendTestPushToUser.mockResolvedValue({ sent: true })
    const response = await route()(request(), ctx)
    expect(response.status).toBe(200)
    expect(sendTestPushToUser).toHaveBeenCalledWith({ tag: 'supabase' }, USER_ID)
  })

  it('returns 409 when this user has no subscription', async () => {
    sendTestPushToUser.mockResolvedValue({ sent: false, reason: 'no_subscriptions' })
    const response = await route()(request(), ctx)
    expect(response.status).toBe(409)
  })
})
