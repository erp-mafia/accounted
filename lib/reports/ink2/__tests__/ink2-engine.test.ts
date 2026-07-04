import { describe, it, expect } from 'vitest'
import { INK2R_ACCOUNT_MAPPINGS, isAccountInMapping, checkBalanceWarning } from '../ink2-engine'
import type { INK2RSRUCode } from '../types'

/**
 * Helper to find which SRU code an account maps to
 */
function findSRUCodeForAccount(accountNumber: string): INK2RSRUCode | null {
  for (const mapping of INK2R_ACCOUNT_MAPPINGS) {
    if (isAccountInMapping(accountNumber, mapping)) {
      return mapping.sruCode
    }
  }
  return null
}

describe('INK2R Account Mappings', () => {
  describe('completeness', () => {
    it('has mappings covering all INK2R balance sheet and income statement fields', () => {
      // 26 asset + 21 equity/liability + 20 income statement = 67 mappings
      expect(INK2R_ACCOUNT_MAPPINGS.length).toBeGreaterThanOrEqual(60)
    })

    it('covers all expected SRU codes', () => {
      const codes = new Set(INK2R_ACCOUNT_MAPPINGS.map(m => m.sruCode))
      // Balance sheet asset codes
      for (const code of ['7201', '7202', '7214', '7215', '7216', '7217', '7281']) {
        expect(codes.has(code as INK2RSRUCode)).toBe(true)
      }
      // Equity/liability codes
      for (const code of ['7301', '7302', '7321', '7322', '7365', '7368', '7370']) {
        expect(codes.has(code as INK2RSRUCode)).toBe(true)
      }
      // Income statement codes
      for (const code of ['7410', '7513', '7514', '7515', '7522', '7528']) {
        expect(codes.has(code as INK2RSRUCode)).toBe(true)
      }
    })
  })

  describe('Balance sheet - Assets (per bas.se/kontoplaner/sru/)', () => {
    it('1010-1079, 1090-1099 -> 7201 (Immateriella AT excl. förskott)', () => {
      expect(findSRUCodeForAccount('1010')).toBe('7201')
      expect(findSRUCodeForAccount('1050')).toBe('7201')
      expect(findSRUCodeForAccount('1079')).toBe('7201')
      expect(findSRUCodeForAccount('1090')).toBe('7201')
      expect(findSRUCodeForAccount('1099')).toBe('7201')
    })

    it('1080-1089 -> 7202 (Förskott immateriella)', () => {
      expect(findSRUCodeForAccount('1080')).toBe('7202')
      expect(findSRUCodeForAccount('1089')).toBe('7202')
    })

    it('1100-1119, 1130-1179, 1190-1199 -> 7214 (Byggnader och mark)', () => {
      expect(findSRUCodeForAccount('1100')).toBe('7214')
      expect(findSRUCodeForAccount('1110')).toBe('7214')
      expect(findSRUCodeForAccount('1130')).toBe('7214')
      expect(findSRUCodeForAccount('1190')).toBe('7214')
    })

    it('1120-1129 -> 7216 (Förbättringsutgifter annans fastighet)', () => {
      expect(findSRUCodeForAccount('1120')).toBe('7216')
      expect(findSRUCodeForAccount('1129')).toBe('7216')
    })

    it('1180-1189 -> 7217 (Pågående nyanläggningar)', () => {
      expect(findSRUCodeForAccount('1180')).toBe('7217')
      expect(findSRUCodeForAccount('1189')).toBe('7217')
    })

    it('1200-1299 -> 7215 (Maskiner och inventarier)', () => {
      expect(findSRUCodeForAccount('1200')).toBe('7215')
      expect(findSRUCodeForAccount('1250')).toBe('7215')
      expect(findSRUCodeForAccount('1299')).toBe('7215')
    })

    it('1500-1519 -> 7251 (Kundfordringar)', () => {
      expect(findSRUCodeForAccount('1500')).toBe('7251')
      expect(findSRUCodeForAccount('1510')).toBe('7251')
      expect(findSRUCodeForAccount('1519')).toBe('7251')
    })

    it('1520-1559 -> 7261 (Övriga fordringar, not 7251)', () => {
      expect(findSRUCodeForAccount('1520')).toBe('7261')
      expect(findSRUCodeForAccount('1550')).toBe('7261')
    })

    it('1700-1799 -> 7263 (Förutbetalda kostnader)', () => {
      expect(findSRUCodeForAccount('1700')).toBe('7263')
      expect(findSRUCodeForAccount('1790')).toBe('7263')
    })

    it('1900-1999 -> 7281 (Kassa och bank)', () => {
      expect(findSRUCodeForAccount('1900')).toBe('7281')
      expect(findSRUCodeForAccount('1930')).toBe('7281')
      expect(findSRUCodeForAccount('1999')).toBe('7281')
    })
  })

  describe('Balance sheet - Equity & Liabilities', () => {
    it('2010-2089 -> 7301 (Bundet EK)', () => {
      expect(findSRUCodeForAccount('2010')).toBe('7301')
      expect(findSRUCodeForAccount('2081')).toBe('7301')
      expect(findSRUCodeForAccount('2089')).toBe('7301')
    })

    it('2090-2099 -> 7302 (Fritt EK)', () => {
      expect(findSRUCodeForAccount('2090')).toBe('7302')
      expect(findSRUCodeForAccount('2099')).toBe('7302')
    })

    it('2110-2129 -> 7321 (Periodiseringsfonder)', () => {
      expect(findSRUCodeForAccount('2110')).toBe('7321')
      expect(findSRUCodeForAccount('2120')).toBe('7321')
    })

    it('2150-2159 -> 7322 (Ackumulerade överavskrivningar)', () => {
      expect(findSRUCodeForAccount('2150')).toBe('7322')
      expect(findSRUCodeForAccount('2159')).toBe('7322')
    })

    it('2440-2449 -> 7365 (Leverantörsskulder)', () => {
      expect(findSRUCodeForAccount('2440')).toBe('7365')
      expect(findSRUCodeForAccount('2449')).toBe('7365')
    })

    it('2500-2599 -> 7368 (Skatteskulder)', () => {
      expect(findSRUCodeForAccount('2500')).toBe('7368')
      expect(findSRUCodeForAccount('2510')).toBe('7368')
    })

    it('2600-2799 -> 7369 (Övriga skulder kortfristiga, e.g. moms)', () => {
      expect(findSRUCodeForAccount('2611')).toBe('7369')
      expect(findSRUCodeForAccount('2710')).toBe('7369')
    })

    it('2900-2999 -> 7370 (Upplupna kostnader)', () => {
      expect(findSRUCodeForAccount('2900')).toBe('7370')
      expect(findSRUCodeForAccount('2999')).toBe('7370')
    })
  })

  describe('Income statement (per bas.se: CRITICAL: 5000-6999 ALL → 7513)', () => {
    it('3000-3799 -> 7410 (Nettoomsättning)', () => {
      expect(findSRUCodeForAccount('3000')).toBe('7410')
      expect(findSRUCodeForAccount('3001')).toBe('7410')
      expect(findSRUCodeForAccount('3100')).toBe('7410')
      expect(findSRUCodeForAccount('3799')).toBe('7410')
    })

    it('3900-3999 -> 7413 (Övriga rörelseintäkter)', () => {
      expect(findSRUCodeForAccount('3900')).toBe('7413')
      expect(findSRUCodeForAccount('3999')).toBe('7413')
    })

    it('4000-4499 -> 7511 (Råvaror)', () => {
      expect(findSRUCodeForAccount('4000')).toBe('7511')
      expect(findSRUCodeForAccount('4010')).toBe('7511')
      expect(findSRUCodeForAccount('4499')).toBe('7511')
    })

    it('4600-4699 -> 7512 (Handelsvaror)', () => {
      expect(findSRUCodeForAccount('4600')).toBe('7512')
      expect(findSRUCodeForAccount('4699')).toBe('7512')
    })

    it('5000-6999 ALL -> 7513 (Övriga externa kostnader)', () => {
      expect(findSRUCodeForAccount('5000')).toBe('7513')
      expect(findSRUCodeForAccount('5460')).toBe('7513')
      expect(findSRUCodeForAccount('6200')).toBe('7513')
      expect(findSRUCodeForAccount('6999')).toBe('7513')
    })

    it('7000-7699 -> 7514 (Personalkostnader)', () => {
      expect(findSRUCodeForAccount('7000')).toBe('7514')
      expect(findSRUCodeForAccount('7210')).toBe('7514')
      expect(findSRUCodeForAccount('7699')).toBe('7514')
    })

    it('7800-7899 -> 7515 (Avskrivningar)', () => {
      expect(findSRUCodeForAccount('7800')).toBe('7515')
      expect(findSRUCodeForAccount('7820')).toBe('7515')
      expect(findSRUCodeForAccount('7899')).toBe('7515')
    })

    it('7700-7799 -> 7516 (Nedskrivningar OT)', () => {
      expect(findSRUCodeForAccount('7700')).toBe('7516')
      expect(findSRUCodeForAccount('7799')).toBe('7516')
    })

    it('7900-7999 -> 7517 (Övriga rörelsekostnader)', () => {
      expect(findSRUCodeForAccount('7900')).toBe('7517')
      expect(findSRUCodeForAccount('7999')).toBe('7517')
    })

    it('8300-8399 -> 7417 (Ränteintäkter)', () => {
      expect(findSRUCodeForAccount('8300')).toBe('7417')
      expect(findSRUCodeForAccount('8310')).toBe('7417')
    })

    it('8400-8499 -> 7522 (Räntekostnader)', () => {
      expect(findSRUCodeForAccount('8400')).toBe('7522')
      expect(findSRUCodeForAccount('8499')).toBe('7522')
    })

    it('8900-8989 -> 7528 (Skatt)', () => {
      expect(findSRUCodeForAccount('8900')).toBe('7528')
      expect(findSRUCodeForAccount('8910')).toBe('7528')
    })

    describe('bokslutsdispositioner (BAS 2020-aligned)', () => {
      // These mappings were corrected when the Phase 2 bokslut calculators
      // landed: the previous ranges (8810/8830/8840) targeted accounts that
      // BAS doesn't seed. Locking the corrected mapping prevents regression.
      it('8811 -> 7525 (Avsättning till periodiseringsfond)', () => {
        expect(findSRUCodeForAccount('8811')).toBe('7525')
      })
      it('8819 -> 7420 (Återföring av periodiseringsfond)', () => {
        expect(findSRUCodeForAccount('8819')).toBe('7420')
      })
      it('8820 -> 7419 (Mottagna koncernbidrag)', () => {
        expect(findSRUCodeForAccount('8820')).toBe('7419')
      })
      it('8830 -> 7524 (Lämnade koncernbidrag)', () => {
        expect(findSRUCodeForAccount('8830')).toBe('7524')
      })
      it('8850-8859 -> 7421 (Förändring av överavskrivningar)', () => {
        expect(findSRUCodeForAccount('8850')).toBe('7421')
        expect(findSRUCodeForAccount('8853')).toBe('7421') // M&I sub-cat
        expect(findSRUCodeForAccount('8859')).toBe('7421')
      })
      it('8840 + 8860-8899 -> 7422 (Övriga bokslutsdispositioner)', () => {
        expect(findSRUCodeForAccount('8840')).toBe('7422')
        expect(findSRUCodeForAccount('8860')).toBe('7422')
        expect(findSRUCodeForAccount('8899')).toBe('7422')
      })
    })
  })

  describe('no overlap between mappings', () => {
    it('representative boundary accounts match exactly one mapping', () => {
      const testAccounts = [
        '1079', '1080', // 7201/7202 boundary
        '1089', '1090', // 7202/7201 boundary
        '1099', '1100', // 7201/7214 boundary
        '1119', '1120', // 7214/7216 boundary
        '1129', '1130', // 7216/7214 boundary
        '1199', '1200', // 7214/7215 boundary
        '1299', '1311', // 7215/7230 boundary
        '1519', '1520', // 7251/7261 boundary
        '1559', '1560', // 7261/7252 boundary
        '1930', '1999', // 7281 bank accounts
        '2089', '2090', // 7301/7302 boundary
        '2099', '2110', // 7302/7321 boundary
        '2439', '2440', // 7361/7365 boundary
        '2449', '2450', // 7365/7363 boundary
        '2499', '2500', // 7369/7368 boundary
        '2599', '2600', // 7368/7369 boundary
        '2899', '2900', // 7369/7370 boundary
        '3799', '3800', // 7410/7412 boundary
        '3899', '3900', // 7412/7413 boundary
        '3999', '4000', // 7413/7511 boundary
        '4499', '4600', // 7511/7512 boundary (4500-4599 unmapped)
        '5000', '6999', // 7513 (övriga externa)
        '7699', '7700', // 7514/7516 boundary
        '7799', '7800', // 7516/7515 boundary
        '7899', '7900', // 7515/7517 boundary
        '8399', '8400', // 7417/7522 boundary
      ]

      for (const account of testAccounts) {
        let matchCount = 0
        for (const mapping of INK2R_ACCOUNT_MAPPINGS) {
          if (isAccountInMapping(account, mapping)) {
            matchCount++
          }
        }
        expect(matchCount, `Account ${account} should match exactly one mapping, got ${matchCount}`).toBe(1)
      }
    })
  })

  describe('section assignments', () => {
    it('all asset mappings have section "assets"', () => {
      const assetMappings = INK2R_ACCOUNT_MAPPINGS.filter(m => m.section === 'assets')
      expect(assetMappings.length).toBe(26)
      for (const m of assetMappings) {
        expect(m.normalBalance).toBe('debit')
      }
    })

    it('all equity/liability mappings have section "equity_liabilities"', () => {
      const eqMappings = INK2R_ACCOUNT_MAPPINGS.filter(m => m.section === 'equity_liabilities')
      expect(eqMappings.length).toBe(24)
      for (const m of eqMappings) {
        expect(m.normalBalance).toBe('credit')
      }
    })

    it('income statement mappings have correct normal balance types', () => {
      const isMappings = INK2R_ACCOUNT_MAPPINGS.filter(m => m.section === 'income_statement')
      expect(isMappings.length).toBeGreaterThanOrEqual(20)

      // Revenue accounts are credit-normal
      const revenue = isMappings.find(m => m.sruCode === '7410')
      expect(revenue?.normalBalance).toBe('credit')

      // Cost accounts are debit-normal
      const costs = isMappings.find(m => m.sruCode === '7513')
      expect(costs?.normalBalance).toBe('debit')

      // Net items
      const net = isMappings.find(m => m.sruCode === '7414')
      expect(net?.normalBalance).toBe('net')
    })
  })
})

describe('checkBalanceWarning', () => {
  it('returns null when perfectly balanced', () => {
    expect(checkBalanceWarning(100000, 100000)).toBeNull()
  })

  it('returns null for 1 kr difference (within rounding tolerance)', () => {
    expect(checkBalanceWarning(100000, 100001)).toBeNull()
    expect(checkBalanceWarning(100001, 100000)).toBeNull()
  })

  it('returns null for 2 kr difference (within rounding tolerance)', () => {
    expect(checkBalanceWarning(100000, 100002)).toBeNull()
    expect(checkBalanceWarning(100002, 100000)).toBeNull()
  })

  it('returns warning for 3 kr difference (exceeds tolerance)', () => {
    expect(checkBalanceWarning(100000, 100003)).not.toBeNull()
    expect(checkBalanceWarning(100003, 100000)).not.toBeNull()
  })

  it('returns null when totals are zero', () => {
    expect(checkBalanceWarning(0, 0)).toBeNull()
  })

  it('returns null when both totals are zero (no data)', () => {
    expect(checkBalanceWarning(0, 0)).toBeNull()
  })

  it('returns warning when assets are zero but equity/liabilities exist', () => {
    expect(checkBalanceWarning(0, 5)).not.toBeNull()
  })

  it('includes amounts in warning message', () => {
    const warning = checkBalanceWarning(100000, 100005)
    expect(warning).toContain('100000')
    expect(warning).toContain('100005')
    expect(warning).toContain('5')
  })
})
