/**
 * The public webhook event catalogue: the single source of truth for which
 * CoreEventType values the v1 webhook surface delivers.
 *
 * Everything that enumerates webhook events derives from this module, so the
 * lists cannot drift apart again (they did: the handler delivered 28 events
 * while the create schema and the docs page listed 24, so nobody could
 * subscribe to the four reconciliation.* events):
 *
 *   1. lib/webhooks/handler.ts subscribes the fan-out handler to every event.
 *   2. app/api/v1/companies/[companyId]/webhooks/route.ts builds the create
 *      schema's `event_type` enum from it, which is what the OpenAPI spec and
 *      the generated agent skill (skills/accounted-api) advertise.
 *   3. lib/docs/content/webhooks.ts renders its "Event types" section from
 *      the groups below.
 *
 * Restricted to the resource-state-change events that are useful to external
 * integrations; MCP telemetry events and internal-only flows (event_log
 * writes, drafts, deletes) are deliberately excluded.
 *
 * Adding an event type here is a public-API change: add a changelog entry in
 * lib/docs/content/changelog.ts. Additive changes do not bump API_V1_VERSION.
 *
 * This module must stay a leaf (type-only imports): it is imported by docs
 * pages, route modules and the event-bus handler alike.
 */

import type { CoreEventType } from '@/lib/events/types'

export interface PublicWebhookEventEntry {
  type: CoreEventType
  /** Short docs prose, rendered after the event name on the docs page. */
  description?: string
}

export interface PublicWebhookEventGroup {
  /** Docs section heading, e.g. "Invoicing". */
  title: string
  /** Optional note rendered next to the heading (e.g. an extra scope requirement). */
  note?: string
  events: ReadonlyArray<PublicWebhookEventEntry>
}

export const PUBLIC_WEBHOOK_EVENT_GROUPS = [
  {
    title: 'Invoicing',
    events: [
      { type: 'invoice.created', description: 'draft invoice created' },
      { type: 'invoice.sent', description: 'invoice marked sent (email delivered or external)' },
      { type: 'invoice.paid', description: 'invoice fully paid' },
      { type: 'credit_note.created', description: 'credit note issued' },
    ],
  },
  {
    title: 'AP / suppliers',
    events: [
      { type: 'supplier.created' },
      { type: 'supplier_invoice.registered' },
      { type: 'supplier_invoice.approved' },
      { type: 'supplier_invoice.paid' },
      { type: 'supplier_invoice.credited' },
      { type: 'supplier_invoice.uncredited', description: 'credit reversal' },
    ],
  },
  {
    title: 'Customers',
    events: [{ type: 'customer.created' }],
  },
  {
    title: 'Bookkeeping',
    events: [
      { type: 'journal_entry.committed', description: 'voucher posted (immutable from this point)' },
      { type: 'journal_entry.reversed', description: 'storno entry posted' },
      { type: 'journal_entry.corrected', description: 'rättelse via `correctEntry` (BFL 5 kap 5 §)' },
    ],
  },
  {
    title: 'Transactions',
    events: [
      { type: 'transaction.categorized', description: 'bank transaction assigned an account + tax code' },
      { type: 'transaction.reconciled', description: 'transaction matched to a posted entry' },
    ],
  },
  {
    title: 'Reconciliation',
    events: [
      {
        type: 'reconciliation.matched',
        description: 'an outside item (bank row or skattekonto row) linked to a journal entry',
      },
      { type: 'reconciliation.unmatched', description: 'a reconciliation link removed' },
      { type: 'reconciliation.signed_off', description: 'an account signed off as reconciled through a date' },
      { type: 'reconciliation.reopened', description: 'a sign-off reopened' },
    ],
  },
  {
    title: 'Periods',
    events: [
      { type: 'period.locked', description: 'fiscal period closed for writes' },
      { type: 'period.unlocked', description: 'fiscal period reopened' },
      { type: 'period.year_closed', description: 'full year-end procedure complete' },
    ],
  },
  {
    title: 'Payroll',
    note: 'requires `payroll:read` scope alongside `webhooks:manage`',
    events: [
      { type: 'salary_run.created' },
      { type: 'salary_run.approved' },
      { type: 'salary_run.booked', description: 'journal entries posted' },
      { type: 'agi.generated', description: 'AGI XML produced' },
    ],
  },
  {
    title: 'Documents',
    events: [{ type: 'document.uploaded' }],
  },
] as const satisfies ReadonlyArray<PublicWebhookEventGroup>

/** Union of every deliverable event type, narrowed from the catalogue. */
export type PublicWebhookEventType = (typeof PUBLIC_WEBHOOK_EVENT_GROUPS)[number]['events'][number]['type']

/**
 * Flat, ordered list of every deliverable event type. Pass straight to
 * `z.enum(...)` or `new Set(...)`.
 */
export const PUBLIC_WEBHOOK_EVENTS: ReadonlyArray<PublicWebhookEventType> = PUBLIC_WEBHOOK_EVENT_GROUPS.flatMap(
  (group) => group.events.map((event) => event.type),
)
