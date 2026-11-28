import { describe, expect, it } from 'vitest'
import type { ConnectionSummary } from '@/lib/digital-mailboxes/connections'
import { billoLeftOutForKivra, mailboxEntries } from '../mailboxes'

const ALL = { whatsapp: true, mail: true, kivra: true, billo: true }

describe('mailboxEntries', () => {
  it('lists the doors in order, Billo and Kivra live where the deployment can receive from them', () => {
    expect(mailboxEntries(ALL)).toEqual([
      { door: 'intake_email', comingSoon: false },
      { door: 'whatsapp', comingSoon: false },
      { door: 'peppol', comingSoon: false },
      { door: 'mailbox', comingSoon: false },
      { door: 'billo', comingSoon: false },
      { door: 'kivra', comingSoon: false },
    ])
  })

  it('keeps Billo and Kivra listed as coming soon where the deployment holds no credentials for them', () => {
    const entries = mailboxEntries({ ...ALL, kivra: false, billo: false })
    expect(entries.filter((e) => e.comingSoon).map((e) => e.door)).toEqual(['billo', 'kivra'])
    expect(entries.map((e) => e.door)).toEqual(['intake_email', 'whatsapp', 'peppol', 'mailbox', 'billo', 'kivra'])
  })

  it('decides Billo and Kivra each on their own', () => {
    const soon = (available: typeof ALL) =>
      mailboxEntries(available)
        .filter((e) => e.comingSoon)
        .map((e) => e.door)
    expect(soon({ ...ALL, kivra: false })).toEqual(['kivra'])
    expect(soon({ ...ALL, billo: false })).toEqual(['billo'])
  })

  it('leaves out a door this deployment does not carry', () => {
    const doors = mailboxEntries({ whatsapp: false, mail: false, kivra: false, billo: false }).map((e) => e.door)
    expect(doors).toEqual(['intake_email', 'peppol', 'billo', 'kivra'])
  })

  it('lists Kivra directly after the intake address when the company already has a mailbox there', () => {
    expect(mailboxEntries(ALL, 'has').map((e) => e.door)).toEqual(['intake_email', 'kivra', 'whatsapp', 'peppol', 'mailbox', 'billo'])
    expect(mailboxEntries({ ...ALL, whatsapp: false, mail: false }, 'has').map((e) => e.door)).toEqual(['intake_email', 'kivra', 'peppol', 'billo'])
  })

  it('keeps the usual order for none, unknown and no answer', () => {
    const usual = mailboxEntries(ALL).map((e) => e.door)
    expect(mailboxEntries(ALL, 'none').map((e) => e.door)).toEqual(usual)
    expect(mailboxEntries(ALL, 'unknown').map((e) => e.door)).toEqual(usual)
    expect(mailboxEntries(ALL, null).map((e) => e.door)).toEqual(usual)
  })
})

describe('billoLeftOutForKivra', () => {
  const available = { receive: true, send: true }
  const connection = (provider: 'kivra' | 'billo', receive_state: 'off' | 'pending' | 'active' | 'ended'): ConnectionSummary => ({
    provider,
    receive_state,
    receive_connected_at: null,
    last_synced_at: null,
    send_state: 'off',
    send_activated_at: null,
    send_request: null,
    last_error: null,
    last_error_at: null,
    postal_address: null,
  })
  const answered = (
    kivra: { company_mailbox?: 'has' | 'none' | 'unknown'; receive?: 'off' | 'pending' | 'active' | 'ended' } = {},
    billo: { receive?: 'off' | 'pending' | 'active' | 'ended' } = {},
  ) => ({
    status: 'ready' as const,
    providers: {
      kivra: { available, connection: kivra.receive ? connection('kivra', kivra.receive) : null, company_mailbox: kivra.company_mailbox },
      billo: { available, connection: billo.receive ? connection('billo', billo.receive) : null },
    },
  })

  it('leaves Billo out for a company that already has its mailbox at Kivra, or has connected Kivra', () => {
    expect(billoLeftOutForKivra(answered({ company_mailbox: 'has' }))).toBe(true)
    expect(billoLeftOutForKivra(answered({ receive: 'active' }))).toBe(true)
    expect(billoLeftOutForKivra(answered({ receive: 'pending' }))).toBe(true)
  })

  it('offers Billo where Kivra does not have the company, or cannot say', () => {
    expect(billoLeftOutForKivra(answered({ company_mailbox: 'none' }))).toBe(false)
    expect(billoLeftOutForKivra(answered({ company_mailbox: 'unknown' }))).toBe(false)
    expect(billoLeftOutForKivra(answered())).toBe(false)
  })

  it('keeps a connected Billo listed whatever Kivra says', () => {
    expect(billoLeftOutForKivra(answered({ company_mailbox: 'has' }, { receive: 'active' }))).toBe(false)
    expect(billoLeftOutForKivra(answered({ receive: 'active' }, { receive: 'pending' }))).toBe(false)
  })

  it('reads a connection that ended as not connected', () => {
    // A Billo that was disconnected leaves its row: Kivra connected still leaves Billo out.
    expect(billoLeftOutForKivra(answered({ receive: 'active' }, { receive: 'ended' }))).toBe(true)
    expect(billoLeftOutForKivra(answered({ company_mailbox: 'has' }, { receive: 'off' }))).toBe(true)
    // A Kivra that was disconnected does not hide Billo.
    expect(billoLeftOutForKivra(answered({ company_mailbox: 'none', receive: 'ended' }))).toBe(false)
  })

  it('holds Billo back until the answer is in, and lists it when the read failed', () => {
    expect(billoLeftOutForKivra({ status: 'loading' })).toBe(true)
    expect(billoLeftOutForKivra({ status: 'failed' })).toBe(false)
  })
})
