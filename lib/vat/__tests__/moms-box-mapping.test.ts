import { describe, it, expect } from 'vitest'
import {
  ACCOUNT_TO_BOX,
  BOX_LABELS,
  getBoxForAccount,
  getBoxLabel,
  type MomsBox,
} from '../moms-box-mapping'
import { ACCOUNT_RUTA } from '@/lib/reports/vat-declaration'

describe('ACCOUNT_TO_BOX', () => {
  it('has a label for every box ID used in the map', () => {
    const usedBoxes = new Set(Object.values(ACCOUNT_TO_BOX))
    for (const box of usedBoxes) {
      expect(BOX_LABELS[box]).toBeTruthy()
    }
  })

  it('maps all known revenue accounts to a sales box', () => {
    expect(ACCOUNT_TO_BOX['3001']).toBe('05')
    expect(ACCOUNT_TO_BOX['3002']).toBe('05')
    expect(ACCOUNT_TO_BOX['3003']).toBe('05')
    expect(ACCOUNT_TO_BOX['3108']).toBe('35')
    expect(ACCOUNT_TO_BOX['3308']).toBe('39')
    expect(ACCOUNT_TO_BOX['3105']).toBe('36')
    expect(ACCOUNT_TO_BOX['3305']).toBe('40')
  })

  it('maps all output VAT accounts including parent/summary and vilande', () => {
    expect(ACCOUNT_TO_BOX['2610']).toBe('10')
    expect(ACCOUNT_TO_BOX['2611']).toBe('10')
    expect(ACCOUNT_TO_BOX['2618']).toBe('10')
    expect(ACCOUNT_TO_BOX['2620']).toBe('11')
    expect(ACCOUNT_TO_BOX['2630']).toBe('12')
    expect(ACCOUNT_TO_BOX['2614']).toBe('30')
    expect(ACCOUNT_TO_BOX['2624']).toBe('31')
    expect(ACCOUNT_TO_BOX['2634']).toBe('32')
  })

  it('maps all input VAT accounts including parent and domestic RC', () => {
    expect(ACCOUNT_TO_BOX['2640']).toBe('48')
    expect(ACCOUNT_TO_BOX['2641']).toBe('48')
    expect(ACCOUNT_TO_BOX['2645']).toBe('48')
    expect(ACCOUNT_TO_BOX['2647']).toBe('48')
    expect(ACCOUNT_TO_BOX['2649']).toBe('48')
  })

  it('maps reverse-charge basis accounts to the correct ruta', () => {
    // EU goods → ruta 20
    expect(ACCOUNT_TO_BOX['4515']).toBe('20')
    expect(ACCOUNT_TO_BOX['4516']).toBe('20')
    expect(ACCOUNT_TO_BOX['4517']).toBe('20')
    // EU services → ruta 21
    expect(ACCOUNT_TO_BOX['4535']).toBe('21')
    expect(ACCOUNT_TO_BOX['4536']).toBe('21')
    expect(ACCOUNT_TO_BOX['4537']).toBe('21')
    // Non-EU services → ruta 22
    expect(ACCOUNT_TO_BOX['4531']).toBe('22')
    expect(ACCOUNT_TO_BOX['4532']).toBe('22')
    expect(ACCOUNT_TO_BOX['4533']).toBe('22')
    // Domestic goods RC → ruta 23
    expect(ACCOUNT_TO_BOX['4415']).toBe('23')
    expect(ACCOUNT_TO_BOX['4416']).toBe('23')
    expect(ACCOUNT_TO_BOX['4417']).toBe('23')
    // Domestic services RC → ruta 24
    expect(ACCOUNT_TO_BOX['4425']).toBe('24')
    expect(ACCOUNT_TO_BOX['4426']).toBe('24')
    expect(ACCOUNT_TO_BOX['4427']).toBe('24')
  })

  it('maps import beskattningsunderlag accounts to ruta 50', () => {
    expect(ACCOUNT_TO_BOX['4545']).toBe('50')
    expect(ACCOUNT_TO_BOX['4546']).toBe('50')
    expect(ACCOUNT_TO_BOX['4547']).toBe('50')
  })

  it('maps import output VAT accounts to ruta 60/61/62', () => {
    expect(ACCOUNT_TO_BOX['2615']).toBe('60')
    expect(ACCOUNT_TO_BOX['2625']).toBe('61')
    expect(ACCOUNT_TO_BOX['2635']).toBe('62')
  })

  it('maps momspliktiga uttag accounts to ruta 06', () => {
    expect(ACCOUNT_TO_BOX['3401']).toBe('06')
    expect(ACCOUNT_TO_BOX['3402']).toBe('06')
    expect(ACCOUNT_TO_BOX['3403']).toBe('06')
  })
})

describe('getBoxForAccount', () => {
  it('returns the box for known accounts', () => {
    expect(getBoxForAccount('2611')).toBe('10')
    expect(getBoxForAccount('4535')).toBe('21')
  })

  it('returns undefined for unknown accounts', () => {
    expect(getBoxForAccount('9999')).toBeUndefined()
    expect(getBoxForAccount('1930')).toBeUndefined() // bank account, not VAT-related
  })
})

describe('getBoxLabel', () => {
  it('returns Swedish labels for every box', () => {
    expect(getBoxLabel('10')).toMatch(/Utgående moms 25%/)
    expect(getBoxLabel('30')).toMatch(/inköp 25%/)
    expect(getBoxLabel('48')).toMatch(/Ingående moms/)
    expect(getBoxLabel('49')).toMatch(/Moms att betala/)
  })
})

// Regression guard: ACCOUNT_TO_BOX must stay aligned with the source-of-truth
// mapping in vat-declaration.ts. If a new account is added to one map without
// the other, the calculation and the cross-validation labels drift apart.
describe('ACCOUNT_TO_BOX ↔ ACCOUNT_RUTA alignment', () => {
  const RUTA_TO_BOX: Record<string, MomsBox> = {
    ruta05: '05', ruta06: '06', ruta07: '07', ruta08: '08',
    ruta10: '10', ruta11: '11', ruta12: '12',
    ruta20: '20', ruta21: '21', ruta22: '22', ruta23: '23', ruta24: '24',
    ruta30: '30', ruta31: '31', ruta32: '32',
    ruta35: '35', ruta36: '36', ruta37: '37', ruta38: '38',
    ruta39: '39', ruta40: '40', ruta41: '41', ruta42: '42',
    ruta48: '48', ruta49: '49',
    ruta50: '50', ruta60: '60', ruta61: '61', ruta62: '62',
  }

  it('every account in ACCOUNT_RUTA exists in ACCOUNT_TO_BOX with the matching box', () => {
    const drift: string[] = []
    for (const [account, mapping] of Object.entries(ACCOUNT_RUTA)) {
      const expectedBox = RUTA_TO_BOX[mapping.box]
      const actualBox = ACCOUNT_TO_BOX[account]
      if (!actualBox) {
        drift.push(`missing in ACCOUNT_TO_BOX: ${account} (should be box ${expectedBox})`)
      } else if (actualBox !== expectedBox) {
        drift.push(`mismatched box for ${account}: ACCOUNT_TO_BOX=${actualBox}, ACCOUNT_RUTA=${expectedBox}`)
      }
    }
    expect(drift).toEqual([])
  })

  it('every account in ACCOUNT_TO_BOX exists in ACCOUNT_RUTA (or is an extra cross-validation hint)', () => {
    // Allowed extras: accounts in ACCOUNT_TO_BOX that don't feed the declaration
    // but are useful for the Export VAT Monitor / EU Sales List. Currently these
    // are the frakter accounts that follow goods treatment.
    const allowedExtras = new Set<string>(['3521', '3522', '3109'])

    const drift: string[] = []
    for (const account of Object.keys(ACCOUNT_TO_BOX)) {
      if (allowedExtras.has(account)) continue
      if (!ACCOUNT_RUTA[account]) {
        drift.push(`extra in ACCOUNT_TO_BOX: ${account} (not in ACCOUNT_RUTA: consider adding to declaration mapping or to allowedExtras)`)
      }
    }
    expect(drift).toEqual([])
  })
})
