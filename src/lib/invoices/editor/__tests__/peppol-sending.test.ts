import { describe, it, expect, vi } from 'vitest'
import { fetchPeppolSending, peppolSendingFromSettings } from '@/lib/invoices/editor/peppol-sending'

/** The GET /api/settings/peppol body, as peppol-settings-service.ts answers it. */
function body(transportAvailable: boolean, access: { send_enabled: boolean; remaining_sends: number | null }) {
  return {
    data: {
      transport: { available: transportAvailable, provider: transportAvailable ? 'connector' : null },
      receiving_supported: true,
      access: { status: access.send_enabled ? 'enabled' : 'none', receive_enabled: false, max_sends: 10, sent_count: 0, ...access },
      participant: { ok: true, code: null },
      registration: null,
    },
  }
}

describe('peppolSendingFromSettings', () => {
  it('is open with the sends left when the transport is up and access is granted', () => {
    expect(peppolSendingFromSettings(body(true, { send_enabled: true, remaining_sends: 10 }))).toEqual({
      remainingSends: 10,
    })
    expect(peppolSendingFromSettings(body(true, { send_enabled: true, remaining_sends: 0 }))).toEqual({
      remainingSends: 0,
    })
    expect(peppolSendingFromSettings(body(true, { send_enabled: true, remaining_sends: null }))).toEqual({
      remainingSends: null,
    })
  })

  it('is closed without access or without a transport', () => {
    expect(peppolSendingFromSettings(body(true, { send_enabled: false, remaining_sends: null }))).toBeNull()
    expect(peppolSendingFromSettings(body(false, { send_enabled: true, remaining_sends: 10 }))).toBeNull()
  })

  it('reads anything that is not the route answer as closed', () => {
    expect(peppolSendingFromSettings(null)).toBeNull()
    expect(peppolSendingFromSettings('nope')).toBeNull()
    expect(peppolSendingFromSettings({ error: { code: 'INTERNAL_ERROR' } })).toBeNull()
    expect(peppolSendingFromSettings({ data: { transport: { available: 'yes' }, access: { send_enabled: true } } })).toBeNull()
  })
})

describe('fetchPeppolSending', () => {
  it('reads GET /api/settings/peppol once', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(body(true, { send_enabled: true, remaining_sends: 7 })), { status: 200 }),
    )
    await expect(fetchPeppolSending(fetchImpl)).resolves.toEqual({ remainingSends: 7 })
    expect(fetchImpl).toHaveBeenCalledWith('/api/settings/peppol')
  })

  it('never throws: a refused or failed read is closed', async () => {
    await expect(fetchPeppolSending(async () => new Response('{}', { status: 500 }))).resolves.toBeNull()
    await expect(
      fetchPeppolSending(async () => {
        throw new TypeError('offline')
      }),
    ).resolves.toBeNull()
    await expect(fetchPeppolSending(async () => new Response('not json', { status: 200 }))).resolves.toBeNull()
  })
})
