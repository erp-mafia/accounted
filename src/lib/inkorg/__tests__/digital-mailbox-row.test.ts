import { describe, expect, it } from 'vitest'
import type { ConnectionSummary } from '@/lib/digital-mailboxes/connections'
import { billoPostalAddress, digitalMailboxRowView } from '../digital-mailbox-row'

const RECEIVE_ONLY = { receive: true, send: false }
const BOTH = { receive: true, send: true }

function connection(overrides: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    provider: 'billo',
    receive_state: 'active',
    receive_connected_at: '2026-10-19T08:00:00Z',
    last_synced_at: '2026-10-19T09:13:00Z',
    send_state: 'off',
    send_activated_at: null,
    send_request: null,
    last_error: null,
    last_error_at: null,
    postal_address: null,
    ...overrides,
  }
}

describe('digitalMailboxRowView', () => {
  it('offers to connect when there is no connection', () => {
    expect(digitalMailboxRowView(RECEIVE_ONLY, null)).toEqual({
      receive: 'off',
      lastSyncedAt: null,
      postalAddress: null,
      sending: null,
      error: null,
    })
  })

  it('reads off and ended alike: nothing reads the mailbox, so the row connects again', () => {
    for (const receive_state of ['off', 'ended'] as const) {
      expect(digitalMailboxRowView(RECEIVE_ONLY, connection({ receive_state })).receive).toBe('off')
    }
  })

  it('carries pending through, without a last read', () => {
    const view = digitalMailboxRowView(RECEIVE_ONLY, connection({ provider: 'kivra', receive_state: 'pending', last_synced_at: null }))
    expect(view.receive).toBe('pending')
    expect(view.lastSyncedAt).toBeNull()
  })

  it('shows when an active mailbox was last read', () => {
    const view = digitalMailboxRowView(RECEIVE_ONLY, connection())
    expect(view).toMatchObject({ receive: 'active', lastSyncedAt: '2026-10-19T09:13:00Z' })
  })

  it('drops the last read and the scanning address of a disconnected mailbox', () => {
    const view = digitalMailboxRowView(
      RECEIVE_ONLY,
      connection({ receive_state: 'ended', postal_address: { line1: 'Box 1', postalCode: '11122', city: 'Stockholm' } }),
    )
    expect(view.lastSyncedAt).toBeNull()
    expect(view.postalAddress).toBeNull()
  })

  it('shows the scanning address of an active Billo mailbox', () => {
    const view = digitalMailboxRowView(
      RECEIVE_ONLY,
      connection({ postal_address: { careOf: 'c/o Billo 123456', line1: 'Box 1', postalCode: '11122', city: 'Stockholm' } }),
    )
    expect(view.postalAddress).toBe('c/o Billo 123456, Box 1, 11122 Stockholm')
  })

  it('shows the sending line only where the deployment can send, on or off by the connection', () => {
    expect(digitalMailboxRowView(RECEIVE_ONLY, connection({ send_state: 'active' })).sending).toBeNull()
    expect(digitalMailboxRowView(BOTH, null).sending).toBe('off')
    expect(digitalMailboxRowView(BOTH, connection({ send_state: 'ended' })).sending).toBe('off')
    expect(digitalMailboxRowView(BOTH, connection({ send_state: 'active' })).sending).toBe('active')
  })

  it('shows an access request to a sender the company has through another service as waiting, or declined', () => {
    expect(digitalMailboxRowView(BOTH, connection({ send_request: 'pending' })).sending).toBe('pending')
    expect(digitalMailboxRowView(BOTH, connection({ send_state: 'ended', send_request: 'rejected' })).sending).toBe('rejected')
    // Active wins: the summary carries no request once sending is on.
    expect(digitalMailboxRowView(BOTH, connection({ send_state: 'active', send_request: null })).sending).toBe('active')
    expect(digitalMailboxRowView(RECEIVE_ONLY, connection({ send_request: 'pending' })).sending).toBeNull()
  })

  it('shows a failure, with its time and never its text, while the mailbox is read or waits', () => {
    const failed = { last_error: 'HTTP 500 from provider', last_error_at: '2026-10-19T09:20:00Z' }
    expect(digitalMailboxRowView(RECEIVE_ONLY, connection(failed)).error).toEqual({ at: '2026-10-19T09:20:00Z' })
    expect(digitalMailboxRowView(RECEIVE_ONLY, connection({ ...failed, receive_state: 'pending' })).error).toEqual({
      at: '2026-10-19T09:20:00Z',
    })
  })

  it('leaves the failure of a disconnected mailbox out', () => {
    const failed = { last_error: 'HTTP 500 from provider', last_error_at: '2026-10-19T09:20:00Z' }
    expect(digitalMailboxRowView(RECEIVE_ONLY, connection({ ...failed, receive_state: 'ended' })).error).toBeNull()
  })

  it('has no failure line when the last read went through', () => {
    expect(digitalMailboxRowView(RECEIVE_ONLY, connection({ last_error_at: '2026-10-19T09:20:00Z' })).error).toBeNull()
  })
})

describe('billoPostalAddress', () => {
  it('puts the address on one line in postal order', () => {
    expect(
      billoPostalAddress({
        careOf: '123456',
        line1: 'Box 1234',
        line2: 'Skanning',
        postalCode: '11122',
        city: 'Stockholm',
        state: null,
        country: 'SE',
      }),
    ).toBe('123456, Box 1234, Skanning, 11122 Stockholm')
  })

  it('skips empty and non-text parts', () => {
    expect(billoPostalAddress({ careOf: '  ', line1: 'Box 1', line2: null, postalCode: 11122, city: 'Stockholm' })).toBe(
      'Box 1, Stockholm',
    )
  })

  it('is null for anything that is not an address', () => {
    for (const value of [null, undefined, '', 'Box 1', 42, [], {}, { careOf: 'c/o only' }, { country: 'SE' }]) {
      expect(billoPostalAddress(value)).toBeNull()
    }
  })
})
