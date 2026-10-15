/**
 * The event types a webhook subscription receives (migration
 * 20261016001000_webhooks_event_types): one or more catalogue types in
 * `event_types`. The v1 create and update bodies take that list and, for
 * clients written before it, still the single `event_type`. Both routes go
 * through this module so they resolve the two fields the same way.
 *
 * Stored: `event_types` is the list, `event_type` its first entry, which is
 * what every reader of the single column (and the database CHECK that it is
 * listed) expects.
 */
import { z } from 'zod'
import { PUBLIC_WEBHOOK_EVENTS, isPayrollEvent, type PublicWebhookEventType } from './public-events'

/** One deliverable event type, from the public catalogue. */
export const WebhookEventTypeSchema = z.enum(PUBLIC_WEBHOOK_EVENTS)

/** One or more deliverable event types; duplicates are collapsed when stored. */
export const WebhookEventTypeListSchema = z
  .array(WebhookEventTypeSchema)
  .min(1)
  .max(PUBLIC_WEBHOOK_EVENTS.length)

export interface WebhookEventTypeFields {
  event_type?: PublicWebhookEventType
  event_types?: PublicWebhookEventType[]
}

/**
 * Body refinement: when a client sends both fields, `event_type` must be one
 * of `event_types`. A contradiction is refused rather than guessed at.
 */
export function refineWebhookEventTypeFields(value: WebhookEventTypeFields, ctx: z.RefinementCtx): void {
  if (value.event_type && value.event_types && !value.event_types.includes(value.event_type)) {
    ctx.addIssue({
      code: 'custom',
      path: ['event_type'],
      message: 'event_type must be one of event_types when both are sent. Send event_types alone.',
    })
  }
}

/**
 * The list to store: `event_types` with duplicates collapsed (first
 * occurrence kept), else `[event_type]`. Null when the body sent neither.
 */
export function resolveWebhookEventTypes(value: WebhookEventTypeFields): PublicWebhookEventType[] | null {
  if (value.event_types && value.event_types.length > 0) return [...new Set(value.event_types)]
  if (value.event_type) return [value.event_type]
  return null
}

/** The payroll-grade types in a list (they need payroll:read to subscribe). */
export function payrollEventTypesIn(types: ReadonlyArray<string>): string[] {
  return types.filter(isPayrollEvent)
}
