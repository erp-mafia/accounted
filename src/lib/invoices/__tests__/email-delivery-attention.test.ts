import { describe, expect, it } from 'vitest'
import {
  emailDeliveryAttention,
  type EmailDeliveryAttentionInput,
} from '../email-delivery-attention'

function delivery(overrides: Partial<EmailDeliveryAttentionInput> = {}): EmailDeliveryAttentionInput {
  return {
    channel: 'email',
    status: 'sent',
    to_addresses: ['***@kund.example'],
    cc_addresses: [],
    provider_status: null,
    provider_recipient_statuses: {},
    created_at: '2026-11-02T09:00:00.000Z',
    ...overrides,
  }
}

const bounced = delivery({ provider_status: 'bounced' })

describe('emailDeliveryAttention', () => {
  it('says nothing without deliveries', () => {
    expect(emailDeliveryAttention('sent', [])).toBeNull()
  })

  it('warns when the only email delivery bounced, naming the To address', () => {
    expect(emailDeliveryAttention('sent', [bounced])).toEqual({
      status: 'bounced',
      addresses: ['***@kund.example'],
    })
  })

  it('warns for every outcome that means the mail did not arrive', () => {
    for (const status of ['bounced', 'failed', 'suppressed'] as const) {
      expect(emailDeliveryAttention('overdue', [delivery({ provider_status: status })])?.status).toBe(status)
    }
  })

  it('warns while the invoice is owed, partly paid included', () => {
    expect(emailDeliveryAttention('partially_paid', [bounced])?.status).toBe('bounced')
  })

  it('says nothing for an arrival, a delay, a spam complaint or no report yet', () => {
    for (const status of ['delivered', 'delayed', 'complained', null] as const) {
      expect(emailDeliveryAttention('sent', [delivery({ provider_status: status })])).toBeNull()
    }
  })

  it('says nothing once the invoice is paid, credited, cancelled or still a draft', () => {
    for (const status of ['paid', 'credited', 'cancelled', 'written_off', 'draft']) {
      expect(emailDeliveryAttention(status, [bounced])).toBeNull()
    }
  })

  it('clears when a later resend was delivered or has no report yet', () => {
    const resend = { created_at: '2026-11-03T09:00:00.000Z' }
    expect(emailDeliveryAttention('sent', [delivery({ ...resend, provider_status: 'delivered' }), bounced])).toBeNull()
    expect(emailDeliveryAttention('sent', [delivery({ ...resend }), bounced])).toBeNull()
  })

  it('reads the newest handover whatever the order of the list', () => {
    const delivered = delivery({ created_at: '2026-11-03T09:00:00.000Z', provider_status: 'delivered' })
    expect(emailDeliveryAttention('sent', [bounced, delivered])).toBeNull()
  })

  it('warns again when the resend bounced too', () => {
    const resend = delivery({
      created_at: '2026-11-03T09:00:00.000Z',
      provider_status: 'bounced',
      to_addresses: ['***@ny.example'],
    })
    expect(emailDeliveryAttention('sent', [resend, bounced])?.addresses).toEqual(['***@ny.example'])
  })

  it('keeps warning when an earlier send arrived and the newest one bounced', () => {
    const earlier = delivery({ created_at: '2026-11-01T09:00:00.000Z', provider_status: 'delivered' })
    expect(emailDeliveryAttention('sent', [bounced, earlier])?.status).toBe('bounced')
  })

  it('ignores a resend that failed before it left, and an unfinished one', () => {
    const later = { created_at: '2026-11-03T09:00:00.000Z' }
    expect(emailDeliveryAttention('sent', [delivery({ ...later, status: 'failed' }), bounced])?.status).toBe('bounced')
    expect(emailDeliveryAttention('sent', [delivery({ ...later, status: 'pending' }), bounced])?.status).toBe('bounced')
  })

  it('clears after a later manual mark, but not after an imported copy', () => {
    const later = { created_at: '2026-11-03T09:00:00.000Z', to_addresses: [], provider_status: null }
    expect(
      emailDeliveryAttention('sent', [delivery({ ...later, channel: 'manual', status: 'marked_sent' }), bounced]),
    ).toBeNull()
    expect(
      emailDeliveryAttention('sent', [delivery({ ...later, channel: 'import', status: 'marked_sent' }), bounced])?.status,
    ).toBe('bounced')
  })

  it('clears when the invoice was sent another way after the bounce', () => {
    expect(emailDeliveryAttention('sent', [bounced], ['2026-11-03T09:00:00.000Z'])).toBeNull()
  })

  it('keeps warning when the other way was used before the bounced send', () => {
    expect(emailDeliveryAttention('sent', [bounced], ['2026-11-01T09:00:00.000Z', null, 'not a date'])?.status)
      .toBe('bounced')
  })

  it('names the recipients the provider reported as failed', () => {
    const partly = delivery({
      provider_status: 'bounced',
      to_addresses: ['***@kund.example', '***@kund2.example'],
      cc_addresses: ['***@cc.example'],
      provider_recipient_statuses: {
        'to:1': { status: 'delivered', status_at: '2026-11-02T09:01:00.000Z' },
        'to:2': { status: 'bounced', status_at: '2026-11-02T09:01:00.000Z' },
        'cc:1': { status: 'suppressed', status_at: '2026-11-02T09:01:00.000Z' },
      },
    })
    expect(emailDeliveryAttention('sent', [partly])?.addresses).toEqual(['***@kund2.example', '***@cc.example'])
  })

  it('falls back to the To addresses when the report names none of the listed recipients', () => {
    const forwarded = delivery({
      provider_status: 'bounced',
      cc_addresses: ['***@cc.example'],
      provider_recipient_statuses: {
        'to:1': { status: 'delivered', status_at: '2026-11-02T09:01:00.000Z' },
      },
    })
    expect(emailDeliveryAttention('sent', [forwarded])?.addresses).toEqual(['***@kund.example'])
  })
})
