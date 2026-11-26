import { describe, expect, it } from 'vitest'
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
  const answered = { read: 'ready' as const, kivraCompanyMailbox: 'none' as const, kivraConnected: false, billoConnected: false }

  it('leaves Billo out for a company that already has its mailbox at Kivra, or has connected Kivra', () => {
    expect(billoLeftOutForKivra({ ...answered, kivraCompanyMailbox: 'has' })).toBe(true)
    expect(billoLeftOutForKivra({ ...answered, kivraCompanyMailbox: null, kivraConnected: true })).toBe(true)
  })

  it('offers Billo where Kivra does not have the company, or cannot say', () => {
    expect(billoLeftOutForKivra(answered)).toBe(false)
    expect(billoLeftOutForKivra({ ...answered, kivraCompanyMailbox: 'unknown' })).toBe(false)
    expect(billoLeftOutForKivra({ ...answered, kivraCompanyMailbox: null })).toBe(false)
  })

  it('keeps a connected Billo listed whatever Kivra says', () => {
    expect(billoLeftOutForKivra({ ...answered, kivraCompanyMailbox: 'has', billoConnected: true })).toBe(false)
  })

  it('holds Billo back until the answer is in, and lists it when the read failed', () => {
    expect(billoLeftOutForKivra({ ...answered, read: 'loading' })).toBe(true)
    expect(billoLeftOutForKivra({ ...answered, read: 'failed', kivraCompanyMailbox: 'has' })).toBe(false)
  })
})
