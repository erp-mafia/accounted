import { describe, it, expect } from 'vitest'
import { NE_ACCOUNT_MAPPINGS } from '../ne-engine'

/**
 * Helper to check if an account falls into a specific ruta
 */
function findRutaForAccount(accountNumber: string): string | null {
  for (const mapping of NE_ACCOUNT_MAPPINGS) {
    for (const range of mapping.accountRanges) {
      if (accountNumber >= range.start && accountNumber <= range.end) {
        if (range.exclude && range.exclude.includes(accountNumber)) {
          continue
        }
        return mapping.ruta
      }
    }
  }
  return null
}

describe('NE Account Mappings', () => {
  describe('R1 - Försäljning med moms', () => {
    it('includes standard revenue accounts 3001-3003', () => {
      expect(findRutaForAccount('3001')).toBe('R1')
      expect(findRutaForAccount('3002')).toBe('R1')
      expect(findRutaForAccount('3003')).toBe('R1')
    })

    it('excludes 3100 (momsfria intäkter)', () => {
      expect(findRutaForAccount('3100')).not.toBe('R1')
    })

    it('includes 3500 (Fakturerade kostnader)', () => {
      expect(findRutaForAccount('3500')).toBe('R1')
    })

    it('includes 3500-3599 range', () => {
      expect(findRutaForAccount('3510')).toBe('R1')
      expect(findRutaForAccount('3599')).toBe('R1')
    })

    it('includes 3700-3799 (Lämnade rabatter)', () => {
      expect(findRutaForAccount('3700')).toBe('R1')
      expect(findRutaForAccount('3731')).toBe('R1')
      expect(findRutaForAccount('3799')).toBe('R1')
    })
  })

  describe('R2 - Momsfria intäkter', () => {
    it('includes 3100', () => {
      expect(findRutaForAccount('3100')).toBe('R2')
    })

    it('includes 3900 (Övriga rörelseintäkter)', () => {
      expect(findRutaForAccount('3900')).toBe('R2')
    })

    it('includes 3910 (Hyresintäkter)', () => {
      expect(findRutaForAccount('3910')).toBe('R2')
    })

    it('includes 3920 (Provisionsintäkter)', () => {
      expect(findRutaForAccount('3920')).toBe('R2')
    })

    it('includes 3950 (Återvunna kundfordringar)', () => {
      expect(findRutaForAccount('3950')).toBe('R2')
    })

    it('includes 3960 (Valutakursvinster)', () => {
      expect(findRutaForAccount('3960')).toBe('R2')
    })

    it('includes 3970-3980 range', () => {
      expect(findRutaForAccount('3970')).toBe('R2')
      expect(findRutaForAccount('3980')).toBe('R2')
    })

    it('includes 3981-3999 range', () => {
      expect(findRutaForAccount('3981')).toBe('R2')
      expect(findRutaForAccount('3990')).toBe('R2')
      expect(findRutaForAccount('3999')).toBe('R2')
    })
  })

  describe('accounts are not silently dropped', () => {
    it('3500 is mapped (not dropped)', () => {
      expect(findRutaForAccount('3500')).not.toBeNull()
    })

    it('3700 is mapped (not dropped)', () => {
      expect(findRutaForAccount('3700')).not.toBeNull()
    })

    it('3910 is mapped (not dropped)', () => {
      expect(findRutaForAccount('3910')).not.toBeNull()
    })

    it('3960 is mapped (not dropped)', () => {
      expect(findRutaForAccount('3960')).not.toBeNull()
    })

    it('3990 is mapped (not dropped)', () => {
      expect(findRutaForAccount('3990')).not.toBeNull()
    })
  })

  describe('no overlap between R1 and R2', () => {
    it('3100 is in R2 not R1', () => {
      expect(findRutaForAccount('3100')).toBe('R2')
    })

    it('3001 is in R1 not R2', () => {
      expect(findRutaForAccount('3001')).toBe('R1')
    })

    it('3900 is in R2 not R1', () => {
      expect(findRutaForAccount('3900')).toBe('R2')
    })
  })
})
