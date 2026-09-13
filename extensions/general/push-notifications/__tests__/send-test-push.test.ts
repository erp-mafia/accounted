import { beforeAll, describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const sendNotification = vi.fn()

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
}))

const USER_ID = '11111111-1111-4111-8111-111111111111'
const SUB = {
  endpoint: 'https://push.example.test/v1/synthetic-endpoint',
  p256dh: 'synthetic-p256dh',
  auth: 'synthetic-auth',
}

let sendTestPushToUser: typeof import('../notification-sender').sendTestPushToUser
let subscriptions: typeof SUB[] = []

function supabase(): SupabaseClient {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: async () =>
            table === 'push_subscriptions'
              ? { data: subscriptions, error: null }
              : { data: null, error: null },
        }),
      }),
      update: () => ({
        in: async () => ({ data: null, error: null }),
      }),
    }),
  } as unknown as SupabaseClient
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'synthetic-vapid-public-key'
  process.env.VAPID_PRIVATE_KEY = 'synthetic-vapid-private-key'
  ;({ sendTestPushToUser } = await import('../notification-sender'))
})

beforeEach(() => {
  subscriptions = []
  sendNotification.mockReset()
})

describe('sendTestPushToUser', () => {
  it('does not send when the user has no subscription', async () => {
    const result = await sendTestPushToUser(supabase(), USER_ID)
    expect(result).toEqual({ sent: false, reason: 'no_subscriptions' })
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('sends on the stored endpoint', async () => {
    subscriptions = [SUB]
    sendNotification.mockResolvedValue(undefined)
    const result = await sendTestPushToUser(supabase(), USER_ID)
    expect(result).toEqual({ sent: true })
    expect(sendNotification).toHaveBeenCalledOnce()
    const [target, body] = sendNotification.mock.calls[0]
    expect(target.endpoint).toBe(SUB.endpoint)
    expect(JSON.parse(body as string).tag).toBe('pwa-push-test')
  })
})
