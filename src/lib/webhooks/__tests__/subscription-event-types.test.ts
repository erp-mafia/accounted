import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  WebhookEventTypeListSchema,
  refineWebhookEventTypeFields,
  resolveWebhookEventTypes,
} from '../subscription-event-types'
import { PUBLIC_WEBHOOK_EVENTS } from '../public-events'

describe('resolveWebhookEventTypes', () => {
  it('prefers event_types and collapses duplicates, keeping first-seen order', () => {
    expect(
      resolveWebhookEventTypes({ event_types: ['invoice.paid', 'period.locked', 'invoice.paid'] }),
    ).toEqual(['invoice.paid', 'period.locked'])
  })

  it('falls back to the single event_type', () => {
    expect(resolveWebhookEventTypes({ event_type: 'customer.created' })).toEqual(['customer.created'])
  })

  it('returns null when neither field is present', () => {
    expect(resolveWebhookEventTypes({})).toBeNull()
  })
})

describe('refineWebhookEventTypeFields', () => {
  const schema = z
    .object({ event_type: z.string().optional(), event_types: z.array(z.string()).optional() })
    .superRefine((v, ctx) => refineWebhookEventTypeFields(v as never, ctx))

  it('accepts both fields when event_type is listed', () => {
    expect(schema.safeParse({ event_type: 'invoice.paid', event_types: ['period.locked', 'invoice.paid'] }).success).toBe(true)
  })

  it('refuses both fields when event_type is not listed', () => {
    const result = schema.safeParse({ event_type: 'invoice.paid', event_types: ['period.locked'] })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].path).toEqual(['event_type'])
  })
})

describe('WebhookEventTypeListSchema', () => {
  it('accepts every catalogue type and nothing outside it', () => {
    expect(WebhookEventTypeListSchema.safeParse([...PUBLIC_WEBHOOK_EVENTS]).success).toBe(true)
    expect(WebhookEventTypeListSchema.safeParse(['journal_entry.drafted']).success).toBe(false)
    expect(WebhookEventTypeListSchema.safeParse([]).success).toBe(false)
  })

  it('accepts the four question list types', () => {
    expect(
      WebhookEventTypeListSchema.safeParse([
        'company_question.filed',
        'company_question.answered',
        'company_question.closed',
        'company_question.reopened',
      ]).success,
    ).toBe(true)
  })
})
