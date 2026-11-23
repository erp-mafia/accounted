/**
 * The webhook event catalogue (lib/webhooks/public-events.ts) is the single
 * source for three surfaces that used to be hand-copied and drifted (24 vs
 * 28 events): the v1 create schema (and so the OpenAPI spec and the generated
 * agent skill), the docs page, and the fan-out handler. These tests pin each
 * surface back to the catalogue so a re-hardcoded list fails CI.
 */
import { describe, expect, it } from 'vitest'
import {
  PUBLIC_WEBHOOK_EVENTS,
  PUBLIC_WEBHOOK_EVENT_GROUPS,
  SCOPED_EVENT_FAMILIES,
  closedEventFamilies,
  isEventOfFamily,
  refusedEventFamily,
  type PublicWebhookEventGroup,
  type ScopedEventFamily,
} from '../public-events'
import { WEBHOOKS_MD } from '@/lib/docs/content/webhooks'
import { generateOpenApiSpec } from '@/lib/api/v1/registry'
// Side-effect import: populates the endpoint registry from every route file.
import '@/lib/api/v1/load-routes'

describe('public webhook event catalogue', () => {
  it('has no duplicate event types and no empty groups', () => {
    expect(new Set(PUBLIC_WEBHOOK_EVENTS).size).toBe(PUBLIC_WEBHOOK_EVENTS.length)
    for (const group of PUBLIC_WEBHOOK_EVENT_GROUPS) expect(group.events.length).toBeGreaterThan(0)
  })

  it('includes the reconciliation events the handler delivers', () => {
    expect(PUBLIC_WEBHOOK_EVENTS).toEqual(
      expect.arrayContaining([
        'reconciliation.matched',
        'reconciliation.unmatched',
        'reconciliation.signed_off',
        'reconciliation.reopened',
      ]),
    )
  })

  it('delivers the lock date move in the Periods group, documented with every payload field (#128)', () => {
    const periods = PUBLIC_WEBHOOK_EVENT_GROUPS.find((group) => group.title === 'Periods')
    const entry = periods?.events.find((event) => event.type === 'period.lock_date_changed') as
      | { type: string; description?: string }
      | undefined
    expect(entry?.description).toBeDefined()
    for (const field of ['previousLockDate', 'lockDate', 'direction', 'via', 'reopenedFiledVatPeriods']) {
      expect(entry?.description, field).toContain(`\`${field}\``)
    }
    // The door, never the person: the payload names no user.
    expect(entry?.description).not.toMatch(/user/i)
    expect(WEBHOOKS_MD).toContain('- `period.lock_date_changed`: ')
  })

  it('documents the payment reference invoice.sent carries (crm#1886)', () => {
    const invoicing = PUBLIC_WEBHOOK_EVENT_GROUPS.find((group) => group.title === 'Invoicing')
    const entry = invoicing?.events.find((event) => event.type === 'invoice.sent') as
      | { type: string; description?: string }
      | undefined
    for (const field of ['payment_reference', 'payment_reference_type']) {
      expect(entry?.description, field).toContain(`\`${field}\``)
    }
    expect(WEBHOOKS_MD).toContain('- `invoice.sent`: ')
  })

  it('delivers the five question list events in the Questions group, documented with their payload fields and scope', () => {
    const groups: ReadonlyArray<PublicWebhookEventGroup> = PUBLIC_WEBHOOK_EVENT_GROUPS
    const questions = groups.find((group) => group.title === 'Questions')
    expect(questions?.events.map((event) => event.type)).toEqual([
      'company_question.filed',
      'company_question.answered',
      'company_question.closed',
      'company_question.reopened',
      'company_question.prepared',
    ])
    expect(questions?.note).toContain('`agent:read`')

    // Each event documents exactly the fields its payload carries beside
    // companyId: the question by id and its state, or the operation that was
    // linked to it by id.
    const documentedFields: Record<string, string[]> = {
      'company_question.filed': ['questionId', 'status', 'createdAt'],
      'company_question.answered': ['questionId', 'status', 'answeredVia', 'answeredAt'],
      'company_question.closed': ['questionId', 'status', 'closeReason', 'answeredVia', 'answeredAt'],
      'company_question.reopened': ['questionId', 'status', 'createdAt'],
      'company_question.prepared': ['questionId', 'operationId'],
    }
    const allFields = [...new Set(Object.values(documentedFields).flat())]
    for (const event of questions?.events ?? []) {
      const fields = documentedFields[event.type] ?? []
      for (const field of fields) expect(event.description, `${event.type} ${field}`).toContain(`\`${field}\``)
      for (const field of allFields.filter((candidate) => !fields.includes(candidate))) {
        expect(event.description, `${event.type} ${field}`).not.toContain(`\`${field}\``)
      }
      // The door, never the person: the payload names no user.
      expect(event.description, event.type).not.toMatch(/user/i)
      expect(WEBHOOKS_MD).toContain(`- \`${event.type}\`: `)
    }
  })

  it('is exactly the event_type enum the v1 create endpoint advertises in the OpenAPI spec', () => {
    const spec = generateOpenApiSpec('https://unit.test')
    const op = (spec.paths['/api/v1/companies/{companyId}/webhooks'] as Record<string, unknown>).post as {
      requestBody: { content: Record<string, { schema: { properties: Record<string, { enum?: unknown[] }> } }> }
    }
    const enumValues = op.requestBody.content['application/json'].schema.properties.event_type.enum
    expect(enumValues).toEqual([...PUBLIC_WEBHOOK_EVENTS])
  })

  it('is exactly the item enum of the v1 create endpoint event_types list', () => {
    const spec = generateOpenApiSpec('https://unit.test')
    const op = (spec.paths['/api/v1/companies/{companyId}/webhooks'] as Record<string, unknown>).post as {
      requestBody: {
        content: Record<string, { schema: { properties: Record<string, { items?: { enum?: unknown[] } }> } }>
      }
    }
    const itemEnum = op.requestBody.content['application/json'].schema.properties.event_types.items?.enum
    expect(itemEnum).toEqual([...PUBLIC_WEBHOOK_EVENTS])
  })

  it('is exactly the list the docs page renders', () => {
    const section = WEBHOOKS_MD.split('## Event types')[1]?.split('## Payload shape')[0] ?? ''
    const documented = [...section.matchAll(/^- `([a-z_]+\.[a-z_]+)`/gm)].map((m) => m[1])
    expect(documented).toEqual([...PUBLIC_WEBHOOK_EVENTS])
    for (const group of PUBLIC_WEBHOOK_EVENT_GROUPS) expect(section).toContain(`**${group.title}**`)
  })
})

/**
 * The scoped event families are the one table the doors ask (webhook create,
 * update and retry, and GET /api/events) for the scope an event type needs on
 * top of the surface's own.
 */
describe('scoped event families', () => {
  const holding =
    (...held: Array<ScopedEventFamily['scope']>) =>
    (scope: ScopedEventFamily['scope']): boolean =>
      held.includes(scope)

  const scopeOf = (eventType: string): string[] =>
    SCOPED_EVENT_FAMILIES.filter((family) => isEventOfFamily(family, eventType)).map((family) => family.scope)

  it('puts the payroll events behind payroll:read and the question list events behind agent:read', () => {
    const scoped = Object.fromEntries(
      PUBLIC_WEBHOOK_EVENTS.filter((type) => scopeOf(type).length > 0).map((type) => [type, scopeOf(type)]),
    )
    expect(scoped).toEqual({
      'salary_run.created': ['payroll:read'],
      'salary_run.approved': ['payroll:read'],
      'salary_run.booked': ['payroll:read'],
      'agi.generated': ['payroll:read'],
      'company_question.filed': ['agent:read'],
      'company_question.answered': ['agent:read'],
      'company_question.closed': ['agent:read'],
      'company_question.reopened': ['agent:read'],
      'company_question.prepared': ['agent:read'],
    })
  })

  it('names the scope in the docs heading of every group that holds a scoped event', () => {
    const groups: ReadonlyArray<PublicWebhookEventGroup> = PUBLIC_WEBHOOK_EVENT_GROUPS
    for (const group of groups) {
      const scopes = [...new Set(group.events.flatMap((event) => scopeOf(event.type)))]
      for (const scope of scopes) expect(group.note ?? '', group.title).toContain(`\`${scope}\``)
    }
  })

  it('lists the families whose scope the caller does not hold', () => {
    expect(closedEventFamilies(holding()).map((family) => family.scope)).toEqual(['payroll:read', 'agent:read'])
    expect(closedEventFamilies(holding('payroll:read')).map((family) => family.scope)).toEqual(['agent:read'])
    expect(closedEventFamilies(holding('payroll:read', 'agent:read'))).toEqual([])
  })

  it('refuses a listed type of a family whose scope the caller does not hold, naming the scope and the types', () => {
    expect(refusedEventFamily(['invoice.paid', 'salary_run.booked', 'agi.generated'], holding())).toEqual({
      scope: 'payroll:read',
      eventTypes: ['salary_run.booked', 'agi.generated'],
    })
    expect(
      refusedEventFamily(['invoice.paid', 'company_question.filed', 'company_question.closed'], holding('payroll:read')),
    ).toEqual({ scope: 'agent:read', eventTypes: ['company_question.filed', 'company_question.closed'] })
  })

  it('refuses nothing when the caller holds the scope, or when no listed type is scoped', () => {
    expect(refusedEventFamily(['company_question.answered'], holding('agent:read'))).toBeNull()
    expect(refusedEventFamily(['salary_run.booked', 'company_question.answered'], holding('payroll:read', 'agent:read'))).toBeNull()
    expect(refusedEventFamily(['invoice.paid', 'period.locked'], holding())).toBeNull()
    expect(refusedEventFamily([], holding())).toBeNull()
  })
})
