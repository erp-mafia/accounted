import { describe, expect, it } from 'vitest'
import { mailboxEntries } from '../mailboxes'

describe('mailboxEntries', () => {
  it('lists the doors in order, Billo and Kivra as coming soon', () => {
    expect(mailboxEntries({ whatsapp: true, mail: true })).toEqual([
      { door: 'intake_email', comingSoon: false },
      { door: 'whatsapp', comingSoon: false },
      { door: 'peppol', comingSoon: false },
      { door: 'mailbox', comingSoon: false },
      { door: 'billo', comingSoon: true },
      { door: 'kivra', comingSoon: true },
    ])
  })

  it('leaves out a door this deployment does not carry', () => {
    const doors = mailboxEntries({ whatsapp: false, mail: false }).map((e) => e.door)
    expect(doors).toEqual(['intake_email', 'peppol', 'billo', 'kivra'])
  })
})
