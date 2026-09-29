import { describe, it, expect } from 'vitest'

import { isMirrorCardAccount, MIRROR_CARD_ACCOUNT_NAMES } from '../mirror-card-account'

describe('isMirrorCardAccount', () => {
  it('flags the Svea card accounts when they carry no IBAN and no BBAN', () => {
    expect(isMirrorCardAccount({ name: 'BOKIO_Debit_Business' })).toBe(true)
    expect(isMirrorCardAccount({ name: 'SVEA_MQ_Debit_B2B' })).toBe(true)
    expect(isMirrorCardAccount({ name: 'BOKIO_Debit_Business', iban: undefined, bban: undefined })).toBe(true)
    // Whitespace around a system identifier is noise, not a different name.
    expect(isMirrorCardAccount({ name: ' BOKIO_Debit_Business ' })).toBe(true)
    // Empty identifier strings count as absent.
    expect(isMirrorCardAccount({ name: 'BOKIO_Debit_Business', iban: '', bban: '  ' })).toBe(true)
  })

  it('never flags an account that has its own IBAN or BBAN, whatever its name', () => {
    expect(isMirrorCardAccount({ name: 'BOKIO_Debit_Business', iban: 'SE5796600000096603145318' })).toBe(false)
    expect(isMirrorCardAccount({ name: 'BOKIO_Debit_Business', bban: '96603145318' })).toBe(false)
  })

  it('never flags an unknown account without identifiers', () => {
    expect(isMirrorCardAccount({ name: 'Kortkonto' })).toBe(false)
    expect(isMirrorCardAccount({ name: 'bokio_debit_business' })).toBe(false)
    expect(isMirrorCardAccount({ name: undefined })).toBe(false)
    expect(isMirrorCardAccount({})).toBe(false)
  })

  it('keeps the known-name list explicit', () => {
    expect([...MIRROR_CARD_ACCOUNT_NAMES]).toEqual(['BOKIO_Debit_Business', 'SVEA_MQ_Debit_B2B'])
  })
})
