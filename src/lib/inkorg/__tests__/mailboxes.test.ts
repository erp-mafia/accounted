import { describe, expect, it } from 'vitest'
import { mailboxEntries } from '../mailboxes'

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
})
