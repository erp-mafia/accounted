import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DigitalMailboxConnection } from '../connections'

const listReceivingConnections = vi.hoisted(() => vi.fn())
const writeProviderMetaIfUnchanged = vi.hoisted(() => vi.fn())
const syncConnection = vi.hoisted(() => vi.fn())
const activatePendingKivra = vi.hoisted(() => vi.fn())
const loadCompanyIdentity = vi.hoisted(() => vi.fn())
const getDigitalMailboxProviders = vi.hoisted(() => vi.fn())

vi.mock('../connections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connections')>()),
  listReceivingConnections,
  writeProviderMetaIfUnchanged,
}))
vi.mock('../connect', () => ({ activatePendingKivra, loadCompanyIdentity }))
vi.mock('../providers', () => ({ getDigitalMailboxProviders }))
vi.mock('../receive', () => ({
  syncConnection,
  InboxUnavailableError: class InboxUnavailableError extends Error {},
}))

import { KIVRA_SAFETY_NET_MS, kivraDailyReadDue, sweepDigitalMailboxes } from '../sweep'

const logMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }
const log = logMock as never

const NOW = Date.parse('2026-11-01T12:03:00Z')
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

function row(overrides: Partial<DigitalMailboxConnection>): DigitalMailboxConnection {
  return {
    id: 'conn-kivra',
    company_id: '11111111-1111-4111-8111-111111111111',
    provider: 'kivra',
    receive_state: 'active',
    account_ref: 'ck1',
    mailbox_ref: null,
    receive_since: '2026-10-01T00:00:00Z',
    receive_connected_by: 'user-1',
    receive_connected_at: '2026-10-01T00:00:00Z',
    receive_ended_at: null,
    last_synced_at: minutesAgo(10),
    send_state: 'off',
    tenant_ref: null,
    send_activated_by: null,
    send_activated_at: null,
    last_error: null,
    last_error_at: null,
    provider_meta: {},
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...overrides,
  }
}

const billo = row({ id: 'conn-billo', provider: 'billo', account_ref: 'b1', last_synced_at: minutesAgo(10) })

/** The newest Kivra arrival's fetched_by, as the arrivals lookup answers it. */
function serviceStub(newest: { actor?: string; error?: boolean } | null) {
  const arrivalReads: Array<Record<string, unknown>> = []
  const from = (table: string) => {
    const filters: Record<string, unknown> = { table }
    const chain: Record<string, unknown> = {}
    const self = () => chain
    chain.select = self
    chain.order = self
    chain.limit = self
    chain.eq = (col: string, val: unknown) => {
      filters[col] = val
      return chain
    }
    chain.maybeSingle = async () => {
      arrivalReads.push(filters)
      if (newest?.error) return { data: null, error: { message: 'boom' } }
      if (!newest) return { data: null, error: null }
      return { data: { fetched_by: { type: newest.actor } }, error: null }
    }
    return chain
  }
  return { client: { from } as unknown as SupabaseClient, arrivalReads }
}

function providers(webhookSecret: string | null) {
  return {
    kivra: { receiver: { name: 'kivra-receiver' }, config: { webhookSecret } },
    billo: { receiver: { name: 'billo-receiver' } },
  }
}

const run = (service: SupabaseClient) => sweepDigitalMailboxes(service, { log, now: () => NOW })

describe('sweepDigitalMailboxes: Kivra daily safety net (crm#1524)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    syncConnection.mockResolvedValue({ filed: 0, already: 0, noFile: 0, failed: 0, more: false })
  })

  it('reads an active Kivra mailbox every run while no webhook secret is configured', async () => {
    getDigitalMailboxProviders.mockReturnValue(providers(null))
    listReceivingConnections.mockResolvedValue([row({}), billo])
    const { client, arrivalReads } = serviceStub({ actor: 'webhook' })

    const summary = await run(client)

    expect(syncConnection).toHaveBeenCalledTimes(2)
    expect(summary.resting).toBe(0)
    expect(arrivalReads).toHaveLength(0)
  })

  it('reads every run with the secret set while the newest Kivra document was not filed by the webhook', async () => {
    getDigitalMailboxProviders.mockReturnValue(providers('whsec'))
    listReceivingConnections.mockResolvedValue([row({})])

    for (const actor of ['cron', 'user']) {
      syncConnection.mockClear()
      const { client, arrivalReads } = serviceStub({ actor })
      const summary = await run(client)
      expect(syncConnection).toHaveBeenCalledTimes(1)
      expect(summary.resting).toBe(0)
      expect(arrivalReads[0]).toMatchObject({ table: 'arrivals', source: 'kivra', company_id: row({}).company_id })
    }
  })

  it('reads every run with the secret set while nothing has arrived from Kivra yet, or the lookup fails', async () => {
    getDigitalMailboxProviders.mockReturnValue(providers('whsec'))
    listReceivingConnections.mockResolvedValue([row({})])

    await run(serviceStub(null).client)
    await run(serviceStub({ error: true }).client)

    expect(syncConnection).toHaveBeenCalledTimes(2)
  })

  it('rests a mailbox the webhook carries until its daily read, and still reads Billo', async () => {
    getDigitalMailboxProviders.mockReturnValue(providers('whsec'))
    listReceivingConnections.mockResolvedValue([row({ last_synced_at: minutesAgo(60) }), billo])

    const summary = await run(serviceStub({ actor: 'webhook' }).client)

    expect(summary).toMatchObject({ connections: 2, resting: 1, deferred: 0 })
    expect(syncConnection).toHaveBeenCalledTimes(1)
    expect(syncConnection.mock.calls[0]![1].connection.provider).toBe('billo')
  })

  it('reads a webhook-carried mailbox once its day has passed, and one never read', async () => {
    getDigitalMailboxProviders.mockReturnValue(providers('whsec'))
    listReceivingConnections.mockResolvedValue([
      row({ last_synced_at: minutesAgo(24 * 60) }),
      row({ id: 'conn-2', company_id: '22222222-2222-4222-8222-222222222222', last_synced_at: null }),
    ])

    const summary = await run(serviceStub({ actor: 'webhook' }).client)

    expect(summary.resting).toBe(0)
    expect(syncConnection).toHaveBeenCalledTimes(2)
  })

  it('keeps looking up a pending Kivra connection every run', async () => {
    getDigitalMailboxProviders.mockReturnValue(providers('whsec'))
    const pending = row({ receive_state: 'pending', account_ref: null })
    listReceivingConnections.mockResolvedValue([pending])
    loadCompanyIdentity.mockResolvedValue({ orgNumber: '5560000000' })
    activatePendingKivra.mockResolvedValue({ ok: true, data: row({}) })

    const summary = await run(serviceStub({ actor: 'webhook' }).client)

    expect(activatePendingKivra).toHaveBeenCalledTimes(1)
    expect(summary).toMatchObject({ activated: 1, resting: 0 })
    expect(syncConnection).toHaveBeenCalledTimes(1)
  })
})

describe('sweepDigitalMailboxes: a connection that keeps failing', () => {
  const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60_000).toISOString()
  const failing = (meta: Record<string, unknown>, lastErrorAt = minutesAgo(10)) =>
    row({ id: 'conn-billo', provider: 'billo', account_ref: 'b1', last_error: 'Billo answered 401', last_error_at: lastErrorAt, provider_meta: meta })

  beforeEach(() => {
    vi.clearAllMocks()
    getDigitalMailboxProviders.mockReturnValue(providers(null))
    syncConnection.mockResolvedValue({ filed: 0, already: 0, noFile: 0, failed: 1, more: false })
    writeProviderMetaIfUnchanged.mockResolvedValue(true)
  })

  it('is reported to the team once its failure is a day old, and still retried', async () => {
    const stuck = failing({ failing_since: hoursAgo(25) })
    listReceivingConnections.mockResolvedValue([stuck])

    const summary = await run(serviceStub(null).client)

    expect(writeProviderMetaIfUnchanged).toHaveBeenCalledWith(expect.anything(), stuck, {
      failing_since: hoursAgo(25),
      failure_reported: hoursAgo(25),
    })
    expect(logMock.error).toHaveBeenCalledTimes(1)
    expect(logMock.error).toHaveBeenCalledWith('digital mailbox connections have failed for more than a day', {
      count: 1,
      connections: [{ companyId: stuck.company_id, provider: 'billo', failingSince: hoursAgo(25), reason: 'Billo answered 401' }],
    })
    expect(summary.stuck).toBe(1)
    expect(syncConnection).toHaveBeenCalledTimes(1)
  })

  it('starts the clock at the first sweep that sees the failure, and leaves last_error_at to mean the latest failed contact', async () => {
    const fresh = failing({}, minutesAgo(10))
    listReceivingConnections.mockResolvedValue([fresh])

    await run(serviceStub(null).client)

    expect(writeProviderMetaIfUnchanged).toHaveBeenCalledWith(expect.anything(), fresh, { failing_since: minutesAgo(10) })
    expect(logMock.error).not.toHaveBeenCalled()
  })

  it('is not reported before a day, nor a second time for the same failure, nor when another run wrote first', async () => {
    listReceivingConnections.mockResolvedValue([failing({ failing_since: hoursAgo(23) })])
    await run(serviceStub(null).client)
    listReceivingConnections.mockResolvedValue([failing({ failing_since: hoursAgo(49), failure_reported: hoursAgo(49) })])
    await run(serviceStub(null).client)
    expect(writeProviderMetaIfUnchanged).not.toHaveBeenCalled()

    writeProviderMetaIfUnchanged.mockResolvedValue(false)
    listReceivingConnections.mockResolvedValue([failing({ failing_since: hoursAgo(25) })])
    const summary = await run(serviceStub(null).client)
    expect(writeProviderMetaIfUnchanged).toHaveBeenCalledTimes(1)
    expect(logMock.error).not.toHaveBeenCalled()
    expect(summary.stuck).toBe(0)
  })

  it('clears the failure once the connection heals, so the next failure is reported in its turn', async () => {
    const healed = row({ id: 'conn-billo', provider: 'billo', account_ref: 'b1', provider_meta: { failing_since: hoursAgo(30), failure_reported: hoursAgo(30) } })
    listReceivingConnections.mockResolvedValue([healed])
    await run(serviceStub(null).client)
    expect(writeProviderMetaIfUnchanged).toHaveBeenCalledWith(expect.anything(), healed, {})
    expect(logMock.error).not.toHaveBeenCalled()
  })
})

describe('kivraDailyReadDue', () => {
  it('is due when never read or a day (less half a slot) has passed, not before', () => {
    expect(kivraDailyReadDue({ last_synced_at: null }, NOW)).toBe(true)
    expect(kivraDailyReadDue({ last_synced_at: new Date(NOW - KIVRA_SAFETY_NET_MS).toISOString() }, NOW)).toBe(true)
    expect(kivraDailyReadDue({ last_synced_at: new Date(NOW - KIVRA_SAFETY_NET_MS + 1000).toISOString() }, NOW)).toBe(false)
  })

  it('keeps the ten-minute slot when the previous read finished a little after its run started', () => {
    const yesterdaySlotEnd = new Date(NOW - 24 * 60 * 60 * 1000 + 2_000).toISOString()
    expect(kivraDailyReadDue({ last_synced_at: yesterdaySlotEnd }, NOW)).toBe(true)
  })
})
