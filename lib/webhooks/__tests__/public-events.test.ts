/**
 * The webhook event catalogue (lib/webhooks/public-events.ts) is the single
 * source for three surfaces that used to be hand-copied and drifted (24 vs
 * 28 events): the v1 create schema (and so the OpenAPI spec and the generated
 * agent skill), the docs page, and the fan-out handler. These tests pin each
 * surface back to the catalogue so a re-hardcoded list fails CI.
 */
import { describe, expect, it } from 'vitest'
import { PUBLIC_WEBHOOK_EVENTS, PUBLIC_WEBHOOK_EVENT_GROUPS } from '../public-events'
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

  it('is exactly the event_type enum the v1 create endpoint advertises in the OpenAPI spec', () => {
    const spec = generateOpenApiSpec('https://unit.test')
    const op = (spec.paths['/api/v1/companies/{companyId}/webhooks'] as Record<string, unknown>).post as {
      requestBody: { content: Record<string, { schema: { properties: Record<string, { enum?: unknown[] }> } }> }
    }
    const enumValues = op.requestBody.content['application/json'].schema.properties.event_type.enum
    expect(enumValues).toEqual([...PUBLIC_WEBHOOK_EVENTS])
  })

  it('is exactly the list the docs page renders', () => {
    const section = WEBHOOKS_MD.split('## Event types')[1]?.split('## Payload shape')[0] ?? ''
    const documented = [...section.matchAll(/^- `([a-z_]+\.[a-z_]+)`/gm)].map((m) => m[1])
    expect(documented).toEqual([...PUBLIC_WEBHOOK_EVENTS])
    for (const group of PUBLIC_WEBHOOK_EVENT_GROUPS) expect(section).toContain(`**${group.title}**`)
  })
})
