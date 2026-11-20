import { describe, it, expect, vi } from 'vitest'
import {
  activeSendingProviders,
  DIGITAL_MAILBOX_PROVIDER_NAMES,
  fetchActiveSendingProviders,
} from '@/lib/digital-mailboxes/sending-status'

function body(providers: Record<string, unknown>) {
  return { data: { providers } }
}

const active = { available: { receive: true, send: true }, connection: { send_state: 'active' } }

describe('activeSendingProviders', () => {
  it('lists the providers the company sends through, in provider order', () => {
    expect(activeSendingProviders(body({ billo: active, kivra: active }))).toEqual(['kivra', 'billo'])
    expect(activeSendingProviders(body({ kivra: active, billo: { ...active, connection: null } }))).toEqual(['kivra'])
  })

  it('skips a provider whose sending is off or ended, or that this deployment cannot send through', () => {
    expect(
      activeSendingProviders(
        body({
          kivra: { ...active, connection: { send_state: 'ended' } },
          billo: { ...active, connection: { send_state: 'off' } },
        }),
      ),
    ).toEqual([])
    expect(
      activeSendingProviders(body({ kivra: { available: { receive: true, send: false }, connection: { send_state: 'active' } } })),
    ).toEqual([])
  })

  it('reads anything that is not the route answer as none', () => {
    expect(activeSendingProviders(null)).toEqual([])
    expect(activeSendingProviders('nope')).toEqual([])
    expect(activeSendingProviders({ error: { code: 'FORBIDDEN' } })).toEqual([])
    expect(activeSendingProviders({ data: { providers: null } })).toEqual([])
  })

  it('names the providers by their brand', () => {
    expect(DIGITAL_MAILBOX_PROVIDER_NAMES).toEqual({ kivra: 'Kivra', billo: 'Billo' })
  })
})

describe('fetchActiveSendingProviders', () => {
  it('reads GET /api/digital-mailboxes', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body({ billo: active })), { status: 200 }))
    await expect(fetchActiveSendingProviders(fetchImpl)).resolves.toEqual(['billo'])
    expect(fetchImpl).toHaveBeenCalledWith('/api/digital-mailboxes')
  })

  it('is none on a refused or failed read, never a throw', async () => {
    const refused = vi.fn(async () => new Response(JSON.stringify(body({ billo: active })), { status: 403 }))
    await expect(fetchActiveSendingProviders(refused)).resolves.toEqual([])
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(fetchActiveSendingProviders(offline)).resolves.toEqual([])
    const notJson = vi.fn(async () => new Response('<html>', { status: 200 }))
    await expect(fetchActiveSendingProviders(notJson)).resolves.toEqual([])
  })
})
