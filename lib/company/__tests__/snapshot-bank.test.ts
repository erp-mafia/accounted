import { describe, it, expect } from 'vitest'
import { bankgiroFromTicSnapshot } from '../snapshot-bank'

// 5402-9681 is a Luhn-valid synthetic bankgiro; 5402-9682 fails the check.
const VALID_BG = '54029681'
const INVALID_BG = '54029682'
const ORG = '5566778899'

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    orgNumber: ORG,
    bankAccounts: [{ type: 'bankgiro', accountNumber: VALID_BG }],
    ...overrides,
  }
}

describe('bankgiroFromTicSnapshot', () => {
  it('returns null for null, undefined and non-object snapshots', () => {
    expect(bankgiroFromTicSnapshot(null, ORG)).toBeNull()
    expect(bankgiroFromTicSnapshot(undefined, ORG)).toBeNull()
    expect(bankgiroFromTicSnapshot('a string', ORG)).toBeNull()
  })

  it('returns null when bankAccounts is missing or not an array', () => {
    expect(bankgiroFromTicSnapshot(snapshot({ bankAccounts: undefined }), ORG)).toBeNull()
    expect(bankgiroFromTicSnapshot(snapshot({ bankAccounts: 'nope' }), ORG)).toBeNull()
    expect(bankgiroFromTicSnapshot(snapshot({ bankAccounts: null }), ORG)).toBeNull()
  })

  it('returns null when only non-bankgiro accounts exist', () => {
    expect(
      bankgiroFromTicSnapshot(
        snapshot({ bankAccounts: [{ type: 'plusgiro', accountNumber: '1234567' }] }),
        ORG,
      ),
    ).toBeNull()
  })

  it('returns the digits of a valid bankgiro account', () => {
    expect(bankgiroFromTicSnapshot(snapshot(), ORG)).toBe(VALID_BG)
  })

  it('strips hyphens and spaces from the registry value', () => {
    expect(
      bankgiroFromTicSnapshot(
        snapshot({ bankAccounts: [{ type: 'bankgiro', accountNumber: '5402-9681' }] }),
        ORG,
      ),
    ).toBe(VALID_BG)
  })

  it('skips bankgiro entries that fail the Luhn check', () => {
    expect(
      bankgiroFromTicSnapshot(
        snapshot({ bankAccounts: [{ type: 'bankgiro', accountNumber: INVALID_BG }] }),
        ORG,
      ),
    ).toBeNull()
  })

  it('skips malformed entries and finds a later valid one', () => {
    expect(
      bankgiroFromTicSnapshot(
        snapshot({
          bankAccounts: [
            null,
            { type: 'bankgiro' },
            { type: 'bankgiro', accountNumber: 12345 },
            { type: 'bankgiro', accountNumber: VALID_BG },
          ],
        }),
        ORG,
      ),
    ).toBe(VALID_BG)
  })

  describe('snapshot identity guard', () => {
    it('returns null when the snapshot describes a different org', () => {
      expect(bankgiroFromTicSnapshot(snapshot({ orgNumber: '5511223344' }), ORG)).toBeNull()
    })

    it('returns null when the snapshot has no orgNumber to prove identity', () => {
      expect(bankgiroFromTicSnapshot(snapshot({ orgNumber: undefined }), ORG)).toBeNull()
      expect(bankgiroFromTicSnapshot(snapshot({ orgNumber: 5566778899 }), ORG)).toBeNull()
    })

    it('returns null when the company org number is missing or empty', () => {
      expect(bankgiroFromTicSnapshot(snapshot(), null)).toBeNull()
      expect(bankgiroFromTicSnapshot(snapshot(), undefined)).toBeNull()
      expect(bankgiroFromTicSnapshot(snapshot(), '')).toBeNull()
    })

    it('matches org numbers regardless of hyphenation', () => {
      expect(bankgiroFromTicSnapshot(snapshot({ orgNumber: '556677-8899' }), ORG)).toBe(VALID_BG)
      expect(bankgiroFromTicSnapshot(snapshot(), '556677-8899')).toBe(VALID_BG)
    })

    it('matches a 12-digit personnummer against its 10-digit form', () => {
      expect(
        bankgiroFromTicSnapshot(snapshot({ orgNumber: '198012311234' }), '801231-1234'),
      ).toBe(VALID_BG)
      expect(
        bankgiroFromTicSnapshot(snapshot({ orgNumber: '8012311234' }), '19801231-1234'),
      ).toBe(VALID_BG)
    })

    it('does not match on partial digit overlap', () => {
      expect(bankgiroFromTicSnapshot(snapshot({ orgNumber: '66778899' }), ORG)).toBeNull()
    })
  })
})
