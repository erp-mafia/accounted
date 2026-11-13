import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { CONNECTION_STUCK_AFTER_MS, failureBookkeeping, writeProviderMetaIfUnchanged } from '../connections'

const NOW = Date.parse('2026-11-13T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60_000).toISOString()

describe('failureBookkeeping', () => {
  const connection = (lastErrorAt: string | null, meta: Record<string, unknown> = {}) => ({
    last_error: lastErrorAt ? 'Billo answered 401' : null,
    last_error_at: lastErrorAt,
    provider_meta: { billo_address: { line1: 'Box 1' }, ...meta },
  })

  it('starts the clock at the first sweep that sees a failure, beside what provider_meta holds', () => {
    expect(failureBookkeeping(connection(hoursAgo(0.1)), NOW)).toEqual({
      providerMeta: { billo_address: { line1: 'Box 1' }, failing_since: hoursAgo(0.1) },
      report: false,
    })
  })

  it('leaves a failure alone until it is a day old, then marks it reported once', () => {
    // last_error_at moves on every retry (it is the latest failed contact the
    // Inkorg shows); the start of the failure stays where it was recorded.
    expect(failureBookkeeping(connection(hoursAgo(0.1), { failing_since: hoursAgo(23) }), NOW)).toBeNull()
    expect(failureBookkeeping(connection(hoursAgo(0.1), { failing_since: hoursAgo(25) }), NOW)).toEqual({
      providerMeta: { billo_address: { line1: 'Box 1' }, failing_since: hoursAgo(25), failure_reported: hoursAgo(25) },
      report: true,
    })
    expect(failureBookkeeping(connection(hoursAgo(0.1), { failing_since: hoursAgo(25), failure_reported: hoursAgo(25) }), NOW)).toBeNull()
    expect(CONNECTION_STUCK_AFTER_MS).toBe(24 * 60 * 60_000)
  })

  it('clears both keys when the connection heals, and writes nothing for a healthy one', () => {
    expect(failureBookkeeping(connection(null, { failing_since: hoursAgo(30), failure_reported: hoursAgo(30) }), NOW)).toEqual({
      providerMeta: { billo_address: { line1: 'Box 1' } },
      report: false,
    })
    expect(failureBookkeeping(connection(null), NOW)).toBeNull()
  })
})

describe('writeProviderMetaIfUnchanged', () => {
  const connection = {
    id: 'conn-1',
    company_id: '11111111-1111-4111-8111-111111111111',
    updated_at: '2026-11-13T11:50:00.123456+00:00',
  }

  it('writes provider_meta only onto the row as it was read', async () => {
    const mock = createTableMockSupabase({ digital_mailbox_connections: { data: [{ id: 'conn-1' }] } })

    const written = await writeProviderMetaIfUnchanged(mock.supabase as unknown as SupabaseClient, connection, { failing_since: 'x' })

    expect(written).toBe(true)
    expect(mock.payloads('digital_mailbox_connections', 'update')).toEqual([{ provider_meta: { failing_since: 'x' } }])
    expect(mock.findCalls('digital_mailbox_connections', 'eq')).toEqual([
      ['id', 'conn-1'],
      ['company_id', connection.company_id],
      ['updated_at', connection.updated_at],
    ])
  })

  it('answers false when the row changed meanwhile, so the run that lost does not report', async () => {
    const mock = createTableMockSupabase({ digital_mailbox_connections: { data: [] } })
    expect(await writeProviderMetaIfUnchanged(mock.supabase as unknown as SupabaseClient, connection, {})).toBe(false)
  })
})
