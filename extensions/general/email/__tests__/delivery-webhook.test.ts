import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebhookEventPayload } from 'resend'

const verifyMock = vi.fn()
const rpcMock = vi.fn()

vi.mock('resend', () => ({
  Resend: class {
    webhooks = { verify: verifyMock }
  },
}))

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => ({ rpc: rpcMock }),
}))

import { emailExtension } from '@/extensions/general/email'
import {
  ResendDeliverySignatureError,
  toDeliveryReport,
  verifyDeliveryWebhook,
} from '@/extensions/general/email/lib/delivery-webhook'

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    created_at: '2026-07-24T08:00:00.000Z',
    email_id: 'msg-1',
    from: 'noreply@example.com',
    to: ['customer@example.com'],
    subject: 'Faktura F-1001',
    ...overrides,
  }
}

const deliveryRoute = emailExtension.apiRoutes!.find(
  (route) => route.path === '/delivery-status',
)!

function webhookRequest(body: unknown = { type: 'email.delivered' }): Request {
  return new Request('https://example.test/api/extensions/ext/email/delivery-status', {
    method: 'POST',
    headers: {
      'svix-id': 'msg_1',
      'svix-timestamp': '1753344000',
      'svix-signature': 'v1,signature',
    },
    body: JSON.stringify(body),
  })
}

describe('toDeliveryReport', () => {
  it('maps arrival outcomes to a provider status', () => {
    const cases: Array<[string, string]> = [
      ['email.delivered', 'delivered'],
      ['email.delivery_delayed', 'delayed'],
      ['email.complained', 'complained'],
      ['email.bounced', 'bounced'],
      ['email.failed', 'failed'],
      ['email.suppressed', 'suppressed'],
    ]

    for (const [type, expected] of cases) {
      const event = {
        type,
        created_at: '2026-07-24T08:00:00.000Z',
        data: baseData({
          bounce: { message: 'Mailbox unavailable', subType: 'General', type: 'Permanent' },
          failed: { reason: 'Rejected by upstream' },
          suppressed: { message: 'On suppression list', type: 'bounce' },
        }),
      } as unknown as WebhookEventPayload

      expect(toDeliveryReport(event)?.status).toBe(expected)
    }
  })

  it('ignores events that say nothing about arrival', () => {
    for (const type of ['email.sent', 'email.scheduled', 'email.opened', 'email.clicked']) {
      const event = {
        type,
        created_at: '2026-07-24T08:00:00.000Z',
        data: baseData(),
      } as unknown as WebhookEventPayload

      expect(toDeliveryReport(event)).toBeNull()
    }
  })

  it('keeps the provider reason text for a bounce', () => {
    const event = {
      type: 'email.bounced',
      created_at: '2026-07-24T08:00:00.000Z',
      data: baseData({
        bounce: {
          message: '550 5.1.1 Recipient address rejected',
          subType: 'General',
          type: 'Permanent',
        },
      }),
    } as unknown as WebhookEventPayload

    expect(toDeliveryReport(event)).toEqual({
      providerMessageId: 'msg-1',
      status: 'bounced',
      occurredAt: '2026-07-24T08:00:00.000Z',
      detail: '550 5.1.1 Recipient address rejected Permanent/General',
      recipients: ['customer@example.com'],
    })
  })

  it('leaves the reason empty for a plain delivery', () => {
    const event = {
      type: 'email.delivered',
      created_at: '2026-07-24T08:00:00.000Z',
      data: baseData(),
    } as unknown as WebhookEventPayload

    expect(toDeliveryReport(event)?.detail).toBeNull()
  })

  it('falls back to ingestion time when the provider clock is unusable', () => {
    const event = {
      type: 'email.delivered',
      created_at: 'not-a-date',
      data: baseData(),
    } as unknown as WebhookEventPayload

    const report = toDeliveryReport(event)
    expect(report).not.toBeNull()
    expect(Number.isNaN(new Date(report!.occurredAt).getTime())).toBe(false)
  })

  it('degrades to no reason when the provider ships an unexpected payload shape', () => {
    const event = {
      type: 'email.bounced',
      created_at: '2026-07-24T08:00:00.000Z',
      data: baseData(),
    } as unknown as WebhookEventPayload

    expect(toDeliveryReport(event)).toEqual({
      providerMessageId: 'msg-1',
      status: 'bounced',
      occurredAt: '2026-07-24T08:00:00.000Z',
      detail: null,
      recipients: ['customer@example.com'],
    })
  })

  it('normalizes and deduplicates impacted recipients defensively', () => {
    const event = {
      type: 'email.delivered',
      created_at: '2026-07-24T08:00:00.000Z',
      data: baseData({
        to: [' Customer@example.com ', 'customer@example.com', 42, '', 'copy@example.org'],
      }),
    } as unknown as WebhookEventPayload

    expect(toDeliveryReport(event)?.recipients).toEqual([
      'Customer@example.com',
      'copy@example.org',
    ])
  })

  it('keeps a valid outcome when the impacted-recipient list is malformed', () => {
    const event = {
      type: 'email.bounced',
      created_at: '2026-07-24T08:00:00.000Z',
      data: baseData({ to: 'customer@example.com' }),
    } as unknown as WebhookEventPayload

    expect(toDeliveryReport(event)?.recipients).toEqual([])
  })

  it('drops an event without a provider message id', () => {
    const event = {
      type: 'email.delivered',
      created_at: '2026-07-24T08:00:00.000Z',
      data: baseData({ email_id: undefined }),
    } as unknown as WebhookEventPayload

    expect(toDeliveryReport(event)).toBeNull()
  })
})

describe('verifyDeliveryWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.RESEND_API_KEY = 'test-key'
    process.env.RESEND_DELIVERY_WEBHOOK_SECRET = 'whsec_test'
  })

  it('passes the Svix headers through to the provider verifier', () => {
    verifyMock.mockReturnValue({ type: 'email.delivered' })

    const headers = new Headers({
      'svix-id': 'msg_1',
      'svix-timestamp': '1753344000',
      'svix-signature': 'v1,signature',
    })
    verifyDeliveryWebhook('{"type":"email.delivered"}', headers)

    expect(verifyMock).toHaveBeenCalledWith({
      payload: '{"type":"email.delivered"}',
      headers: { id: 'msg_1', timestamp: '1753344000', signature: 'v1,signature' },
      webhookSecret: 'whsec_test',
    })
  })

  it('raises a signature error when verification fails', () => {
    verifyMock.mockImplementation(() => {
      throw new Error('No matching signature found')
    })

    expect(() => verifyDeliveryWebhook('{}', new Headers())).toThrow(ResendDeliverySignatureError)
  })
})

describe('POST /api/extensions/ext/email/delivery-status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.RESEND_API_KEY = 'test-key'
    process.env.RESEND_DELIVERY_WEBHOOK_SECRET = 'whsec_test'
  })

  it('is unauthenticated: the signature is the credential', () => {
    expect(deliveryRoute.skipAuth).toBe(true)
    expect(deliveryRoute.method).toBe('POST')
  })

  it('returns 503 when the webhook secret is not configured', async () => {
    delete process.env.RESEND_DELIVERY_WEBHOOK_SECRET

    const response = await deliveryRoute.handler(webhookRequest())

    expect(response.status).toBe(503)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('returns 401 on an invalid signature', async () => {
    verifyMock.mockImplementation(() => {
      throw new Error('No matching signature found')
    })

    const response = await deliveryRoute.handler(webhookRequest())

    expect(response.status).toBe(401)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('applies a verified bounce to the matching delivery', async () => {
    verifyMock.mockReturnValue({
      type: 'email.bounced',
      created_at: '2026-07-24T08:00:00.000Z',
      data: baseData({
        bounce: { message: 'Mailbox unavailable', subType: 'General', type: 'Permanent' },
      }),
    })
    rpcMock.mockResolvedValue({ data: 'delivery-1', error: null })

    const response = await deliveryRoute.handler(webhookRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toEqual({ applied: true })
    expect(rpcMock).toHaveBeenCalledWith('apply_invoice_delivery_provider_event', {
      p_provider: 'resend',
      p_provider_message_id: 'msg-1',
      p_status: 'bounced',
      p_occurred_at: '2026-07-24T08:00:00.000Z',
      p_detail: 'Mailbox unavailable Permanent/General',
      p_recipient_addresses: ['customer@example.com'],
    })
  })

  it('acknowledges events that are not about arrival without touching the database', async () => {
    verifyMock.mockReturnValue({
      type: 'email.opened',
      created_at: '2026-07-24T08:00:00.000Z',
      data: baseData(),
    })

    const response = await deliveryRoute.handler(webhookRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toEqual({ applied: false, reason: 'ignored_event' })
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('acknowledges mail that is not a tracked invoice delivery', async () => {
    verifyMock.mockReturnValue({
      type: 'email.delivered',
      created_at: '2026-07-24T08:00:00.000Z',
      data: baseData({ email_id: 'payslip-mail' }),
    })
    rpcMock.mockResolvedValue({ data: null, error: null })

    const response = await deliveryRoute.handler(webhookRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toEqual({ applied: false, reason: 'no_matching_delivery' })
  })

  it('fails loudly on a database error so the provider retries', async () => {
    verifyMock.mockReturnValue({
      type: 'email.delivered',
      created_at: '2026-07-24T08:00:00.000Z',
      data: baseData(),
    })
    rpcMock.mockResolvedValue({ data: null, error: { message: 'connection reset' } })

    const response = await deliveryRoute.handler(webhookRequest())

    expect(response.status).toBe(500)
  })
})
