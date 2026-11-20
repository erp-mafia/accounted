/**
 * Webhook delivery of the dimension value events (accounted#193): an event
 * emitted by a door reaches the webhooks subscribed to its type as a
 * webhook_deliveries row, with the value, its dimension and the previous
 * name, and without the actor's user id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }))
vi.mock('@/lib/logger', () => ({ createLogger: () => logMock }))

const inlineClient = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => inlineClient.current) }))

const kick = vi.hoisted(() => vi.fn())
vi.mock('../dispatch-kick', () => ({ kickWebhookDispatch: kick }))

import { eventBus } from '@/lib/events/bus'
import { dimensionValueSnapshot, emitDimensionValueEvents } from '@/lib/dimensions/value-events'
import { PUBLIC_WEBHOOK_EVENTS } from '../public-events'
import { fanOutEvent } from '../handler'

const COMPANY = '00000000-0000-4000-8000-000000000001'
const VERIFIED = { verified_at: '2026-10-01T00:00:00Z', verification_grace_ends_at: null }

function mockClient() {
  const insert = vi.fn(async (_rows: unknown) => ({ error: null }))
  const contains = vi.fn(() => query)
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    contains,
    is: vi.fn(async () => ({ data: [{ id: 'wh-1', api_version_pinned: null, ...VERIFIED }], error: null })),
  }
  const from = vi.fn((table: string) => (table === 'webhooks' ? query : { insert }))
  return { client: { from } as unknown as SupabaseClient, insert, contains }
}

const TYPES = ['dimension_value.created', 'dimension_value.renamed', 'dimension_value.archived', 'dimension_value.unarchived'] as const

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  for (const type of TYPES) eventBus.on(type, (payload) => fanOutEvent(type, payload))
})

describe('dimension value webhooks', () => {
  it('are public, subscribable event types', () => {
    for (const type of TYPES) expect(PUBLIC_WEBHOOK_EVENTS).toContain(type)
  })

  it('a rename reaches the subscribed webhook with the value, its dimension and the old name, never the actor', async () => {
    const { client, insert, contains } = mockClient()
    inlineClient.current = client

    await emitDimensionValueEvents({
      companyId: COMPANY,
      userId: 'user-1',
      before: { name: 'Villa Almgren tak', is_active: true },
      after: dimensionValueSnapshot(
        {
          id: 'val-1',
          dimension_id: 'dim-6',
          code: 'P1042',
          name: 'Villa Almgren tak och fasad',
          is_active: true,
          start_date: null,
          end_date: null,
        },
        { sie_dim_no: 6, name: 'Projekt' },
      ),
    })

    // The lookup asks for webhooks subscribed to this very type.
    expect(contains).toHaveBeenCalledWith('event_types', ['dimension_value.renamed'])
    const rows = insert.mock.calls[0]![0] as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ webhook_id: 'wh-1', company_id: COMPANY, event_type: 'dimension_value.renamed' })
    expect(rows[0]!.payload).toEqual({
      dimensionValue: {
        id: 'val-1',
        dimension_id: 'dim-6',
        sie_dim_no: 6,
        dimension_name: 'Projekt',
        code: 'P1042',
        name: 'Villa Almgren tak och fasad',
        is_active: true,
        start_date: null,
        end_date: null,
      },
      previousName: 'Villa Almgren tak',
      companyId: COMPANY,
    })
    expect(kick).toHaveBeenCalledTimes(1)
  })
})
