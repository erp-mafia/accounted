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
      {
        type: 'invoice.sent',
        description:
          'invoice marked sent (email delivered or external). `invoice` carries `payment_reference`, the reference its PDF asks the payer to quote, and `payment_reference_type` (`ocr`: the digits of the invoice number and a Luhn check digit; `invoice_number`: the number as it is), as `GET /invoices/{id}` answers them; both `null` on a document that asks for no payment under a reference',
      },
      {
        type: 'invoice.paid',
        description: 'invoice fully paid, whichever way it was settled (mark-paid, bank match, voucher link); never on a partial payment',
      },
      { type: 'credit_note.created', description: 'credit note issued' },
    ],
  },
  {
    title: 'AP / suppliers',
    events: [
      { type: 'supplier.created' },
      { type: 'supplier_invoice.registered' },
      { type: 'supplier_invoice.approved' },
      {
        type: 'supplier_invoice.paid',
        description: 'supplier invoice fully paid, whichever way it was settled; never on a partial payment',
      },
      { type: 'supplier_invoice.credited' },
      { type: 'supplier_invoice.uncredited', description: 'credit reversal' },
    ],
  },
  {
    title: 'Customers',
    events: [{ type: 'customer.created' }],
  },
  {
    title: 'Dimensions',
    note: 'projects, cost centres and other dimension values (SIE #OBJEKT); every door fires them: the app, the API, MCP and imports. Deleting a value no line uses is not announced',
    events: [
      {
        type: 'dimension_value.created',
        description:
          'a value was created under a dimension (sie_dim_no 6 is Projekt, 1 Kostnadsställe). Carries `dimensionValue` (`id`, `dimension_id`, `sie_dim_no`, `dimension_name`, `code`, `name`, `is_active`, `start_date`, `end_date`; `is_active` false means archived, as for a code registered from history)',
      },
      {
        type: 'dimension_value.renamed',
        description: 'a value got a new name; `previousName` holds the old one. The code never changes',
      },
      { type: 'dimension_value.archived', description: 'a value was archived (`is_active` false): kept on history, refused on new lines' },
      { type: 'dimension_value.unarchived', description: 'an archived value was made active again' },
    ],
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
      {
        type: 'period.lock_date_changed',
        description:
          'the company-wide lock date ("Bokföring låst t.o.m.", nothing on or before it can be booked or changed) was set, moved or removed. Carries `previousLockDate` and `lockDate` (YYYY-MM-DD, `null` when there is none), `direction` (`forward` or `backward`; removing the lock is `backward`), `via` (`app`, `api`, `approval` of a staged change, or `auto_lock` when the nightly automatic lock of `auto_lock_period_days` moved it forward) and `reopenedFiledVatPeriods` (the filed momsdeklaration periods a backward move reopened, each with `tax_period`, `period_start`, `period_end`, `filed_on`; empty otherwise). Fires only when the stored date changes',
      },
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
  {
    title: 'Signing',
    events: [
      { type: 'signing.signer_signed', description: 'one signer signed a signing request with BankID' },
      { type: 'signing.declined', description: 'a signer declined; the request is closed' },
      {
        type: 'signing.completed',
        description: 'everyone signed; signed_document_id and evidence_document_id are the signed PDF and the evidence package in the archive (null if the seal is still running: read the request)',
      },
    ],
  },
  {
    title: 'Questions',
    note: "the company's question list; requires `agent:read` scope alongside `webhooks:manage`. A payload names the question and its state, never the text of the question, its options, its evidence or an answer: read those with `accounted_list_questions`",
    events: [
      {
        type: 'company_question.filed',
        description: 'a question was put on the list. Carries `questionId`, `status` (`open`) and `createdAt` (when it was filed)',
      },
      {
        type: 'company_question.answered',
        description:
          'an open question was answered. Carries `questionId`, `status` (`answered`), `answeredVia` (the door the answer came through: `app`, `whatsapp`, or for an MCP connection the label of the connected client; `null` when none was recorded) and `answeredAt`',
      },
      {
        type: 'company_question.closed',
        description:
          'an open question was closed without an answer. Carries `questionId`, `status` (`closed`), `closeReason` (`dont_know`, `not_relevant`, `settled` or `withdrawn`), `answeredVia` (the door the close came through) and `answeredAt` (when it was closed)',
      },
      {
        type: 'company_question.reopened',
        description:
          'an answer or a close was undone and the question is open again. Carries `questionId`, `status` (`open`) and `createdAt` (when it was first filed)',
      },
      {
        type: 'company_question.prepared',
        description:
          'a staged operation was linked to a question that is answered, or closed as settled: the operation was staged because of the answer. Carries `questionId` and `operationId` (the pending operation, as `GET /pending-operations/{id}` reads it). Sent once per question and operation',
      },
    ],
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

/**
 * An event family that is read from outside only with a scope of its own, on
 * top of the surface's scope (`webhooks:manage` or `events:read`).
 */
export interface ScopedEventFamily {
  /** The scope the caller needs in addition to the surface's own. */
  scope: 'payroll:read' | 'agent:read'
  /** An event type belongs to the family when it starts with one of these. */
  prefixes: ReadonlyArray<string>
}

/**
 * The scoped families, asked by every door that hands an event out: pushed
 * (webhook create, update and delivery retry) or polled (GET /api/events).
 *   - salary_run.* and agi.* describe lönesummor and skatteavdrag, so they
 *     need `payroll:read`.
 *   - company_question.* announce the question list, which is read with
 *     `agent:read` (gnubok_list_questions), so they need the same scope.
 * A new family is a line here; no door keeps a list of its own.
 */
export const SCOPED_EVENT_FAMILIES: ReadonlyArray<ScopedEventFamily> = [
  { scope: 'payroll:read', prefixes: ['salary_run.', 'agi.'] },
  { scope: 'agent:read', prefixes: ['company_question.'] },
]

/** Whether the event type belongs to the family. */
export function isEventOfFamily(family: ScopedEventFamily, eventType: string): boolean {
  return family.prefixes.some((prefix) => eventType.startsWith(prefix))
}

/** The families whose scope the caller does not hold. */
export function closedEventFamilies(
  holdsScope: (scope: ScopedEventFamily['scope']) => boolean,
): ScopedEventFamily[] {
  return SCOPED_EVENT_FAMILIES.filter((family) => !holdsScope(family.scope))
}

/**
 * The first family that has a type among `eventTypes` and whose scope the
 * caller does not hold, with those types; null when the caller may read
 * every listed type.
 */
export function refusedEventFamily(
  eventTypes: ReadonlyArray<string>,
  holdsScope: (scope: ScopedEventFamily['scope']) => boolean,
): { scope: ScopedEventFamily['scope']; eventTypes: string[] } | null {
  for (const family of closedEventFamilies(holdsScope)) {
    const refused = eventTypes.filter((eventType) => isEventOfFamily(family, eventType))
    if (refused.length > 0) return { scope: family.scope, eventTypes: refused }
  }
  return null
}
