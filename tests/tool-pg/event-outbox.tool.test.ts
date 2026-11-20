/**
 * The event outbox through a real supabase-js client and a real PostgREST:
 * the writer the event bus calls in shadow mode (writeShadowDeliveries), the
 * dispatcher (dispatchEventOutbox) and the prune and reconciliation RPCs, with
 * the exact argument shapes the code sends (a jsonb payload and map, a text[]
 * of consumer ids, parallel bigint[], text[] and integer[] arrays). The SQL
 * behind them is covered by tests/pg/event-outbox.pg.test.ts; this file
 * proves the doors reach it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupplierInvoice } from '@/types'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'
import { createToolPgClient } from './client'

vi.mock('@/lib/supabase/service-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/service-client')>()
  const { createToolPgClient: toolClient } = await import('./client')
  return { ...actual, createServiceRoleClient: () => toolClient() }
})

// The kick would run a dispatch cycle in the background, racing the one this
// test runs on purpose; capture it instead.
const afterMock = vi.hoisted(() => vi.fn())
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: afterMock }
})

import { writeShadowDeliveries } from '@/lib/events/outbox'
import { dispatchEventOutbox } from '@/lib/events/outbox-dispatcher'
import type { CoreEvent } from '@/lib/events/types'

beforeEach(async () => {
  afterMock.mockReset()
  vi.stubEnv('EVENT_OUTBOX_MODE', 'shadow')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://tool-pg.invalid')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'tool-pg')
  await getPool().query(`DELETE FROM public.event_outbox`)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

afterAll(async () => {
  await getPool().query(`DELETE FROM public.event_outbox`)
})

describe('event outbox over PostgREST', () => {
  it('enqueues through the writer, dispatches in shadow, prunes and reconciles', async () => {
    const { userId, companyId } = await seedCompany()
    const event: CoreEvent = {
      type: 'supplier_invoice.registered',
      payload: { supplierInvoice: { id: 'si-1', total: 1250 } as unknown as SupplierInvoice, userId, companyId },
    }

    await writeShadowDeliveries(event, [
      { consumerId: 'supplier-invoice-retro-match', inline: 'ok' },
      { consumerId: 'attest-notify', inline: 'failed' },
      { consumerId: 'webhooks', inline: 'ok' },
    ])
    expect(afterMock).toHaveBeenCalledTimes(1)

    const { rows: events } = await getPool().query(
      `SELECT company_id, event_type, payload FROM public.event_outbox`,
    )
    expect(events).toEqual([{ company_id: companyId, event_type: 'supplier_invoice.registered', payload: event.payload }])
    const { rows: queued } = await getPool().query(
      `SELECT consumer_id, status, inline_result FROM public.event_deliveries ORDER BY consumer_id`,
    )
    expect(queued).toEqual([
      { consumer_id: 'attest-notify', status: 'pending', inline_result: 'failed' },
      { consumer_id: 'supplier-invoice-retro-match', status: 'pending', inline_result: 'ok' },
      { consumer_id: 'webhooks', status: 'pending', inline_result: 'ok' },
    ])

    const summary = await dispatchEventOutbox({ supabase: createToolPgClient() })
    expect(summary).toMatchObject({ mode: 'shadow', batches: 1, claimed: 3, completed: 3, notDeployed: false })
    const { rows: finished } = await getPool().query(
      `SELECT DISTINCT status, attempts FROM public.event_deliveries`,
    )
    expect(finished).toEqual([{ status: 'done', attempts: 1 }])

    const supabase = createToolPgClient()
    const pruned = await supabase.rpc('prune_event_outbox')
    expect(pruned).toMatchObject({ data: 0, error: null })

    const counts = await supabase.rpc('event_outbox_shadow_counts', {
      p_since: new Date(Date.now() - 3_600_000).toISOString(),
    })
    expect(counts.error).toBeNull()
    expect(
      (counts.data as Array<Record<string, unknown>>).map((r) => [r.consumer_id, r.enqueued, r.inline_ok, r.inline_failed, r.done]),
    ).toEqual([
      ['attest-notify', 1, 0, 1, 1],
      ['supplier-invoice-retro-match', 1, 1, 0, 1],
      ['webhooks', 1, 1, 0, 1],
    ])
  })
})
