import { describe, it, expect } from 'vitest'
import { getAccountDescription, ACCOUNT_DESCRIPTIONS } from '../account-descriptions'

describe('account-descriptions', () => {
  describe('getAccountDescription', () => {
    it('returns description for known accounts', () => {
      const desc = getAccountDescription('1510')
      expect(desc).toBeDefined()
      expect(desc!.name).toBe('Kundfordringar')
      expect(desc!.type).toBe('asset')
    })

    it('returns undefined for unknown accounts', () => {
      expect(getAccountDescription('9999')).toBeUndefined()
      expect(getAccountDescription('')).toBeUndefined()
    })

    it('has no entry for 1580 (removed from BAS; was mislabeled as tax receivable)', () => {
      // Tax receivables are 1640/1650. Card/coupon receivables moved from
      // 1580 to 1686. 1580 must stay undefined so a company's own account
      // name is what renders.
      expect(getAccountDescription('1580')).toBeUndefined()
    })
  })

  describe('data completeness', () => {
    const KEY_ACCOUNTS = [
      '1510', '1930', '2013', '2440', '2611', '2621', '2631',
      '2614', '2641', '2645', '2893', '3001', '3002', '3003',
      '3305', '3308', '3960', '7960',
    ]

    it.each(KEY_ACCOUNTS)('includes key BAS account %s', (account) => {
      expect(getAccountDescription(account)).toBeDefined()
    })

    it('all entries have non-empty required fields', () => {
      for (const [number, desc] of Object.entries(ACCOUNT_DESCRIPTIONS)) {
        expect(desc.name, `${number} missing name`).toBeTruthy()
        expect(desc.classLabel, `${number} missing classLabel`).toBeTruthy()
        expect(desc.type, `${number} missing type`).toBeTruthy()
        expect(desc.explanation, `${number} missing explanation`).toBeTruthy()
      }
    })

    it('type values are valid', () => {
      const validTypes = ['asset', 'liability', 'equity', 'revenue', 'expense']
      for (const [number, desc] of Object.entries(ACCOUNT_DESCRIPTIONS)) {
        expect(validTypes, `${number} has invalid type: ${desc.type}`).toContain(desc.type)
      }
    })
  })
})
