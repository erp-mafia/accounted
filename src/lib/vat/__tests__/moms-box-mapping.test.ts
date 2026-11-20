import { describe, it, expect } from 'vitest'
import {
  ACCOUNT_TO_BOX,
  BOX_LABELS,
  getBoxForAccount,
  isDeclarationVatAccount,
  VAT_ACCOUNT_TABLE,
  vatBasisAccount,
  VILANDE_VAT_ACCOUNTS,
  type VatBasisKind,
} from '../moms-box-mapping'
import { ACCOUNT_RUTA } from '@/lib/reports/vat-declaration'
import { RC_BASIS_ACCOUNTS } from '@/lib/bookkeeping/vat-entries'
import { RC_BASIS_ACCOUNTS_BY_RATE } from '@/lib/reports/vat-filing-gate'

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

  it('maps domestic reverse-charge sales accounts to ruta 41', () => {
    expect(ACCOUNT_TO_BOX['3231']).toBe('41')
    expect(ACCOUNT_TO_BOX['3232']).toBe('41')
    expect(ACCOUNT_TO_BOX['3233']).toBe('41')
  })

  it('maps all output VAT accounts including parent/summary', () => {
    expect(ACCOUNT_TO_BOX['2610']).toBe('10')
    expect(ACCOUNT_TO_BOX['2611']).toBe('10')
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

  it('maps no vilande account to a ruta: its moms is declared once moved (crm#1562)', () => {
    for (const account of ['2618', '2628', '2638', '2648']) {
      expect(VILANDE_VAT_ACCOUNTS.has(account)).toBe(true)
      expect(ACCOUNT_TO_BOX[account]).toBeUndefined()
      expect(VAT_ACCOUNT_TABLE[account]).toBeUndefined()
      // Not a moms account the declaration misses either.
      expect(isDeclarationVatAccount(account)).toBe(false)
    }
    expect(isDeclarationVatAccount('2641')).toBe(true)
    expect(isDeclarationVatAccount('2644')).toBe(true)
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

  it('maps rent under frivillig skattskyldighet (3913) to ruta 08', () => {
    expect(ACCOUNT_TO_BOX['3913']).toBe('08')
    expect(ACCOUNT_RUTA['3913']).toEqual({ box: 'ruta08', side: 'credit' })
    // Hyres- and Arrendeintäkter hold exempt rent too: the momskod decides.
    expect(ACCOUNT_TO_BOX['3911']).toBeUndefined()
    expect(ACCOUNT_TO_BOX['3912']).toBeUndefined()
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

describe('BOX_LABELS', () => {
  it('carries the Swedish label of each box', () => {
    expect(BOX_LABELS['10']).toMatch(/Utgående moms 25%/)
    expect(BOX_LABELS['30']).toMatch(/inköp 25%/)
    expect(BOX_LABELS['48']).toMatch(/Ingående moms/)
    expect(BOX_LABELS['49']).toMatch(/Moms att betala/)
  })
})

// Parity: ACCOUNT_RUTA, ACCOUNT_TO_BOX and the reverse-charge basis lists are
// derived from VAT_ACCOUNT_TABLE. Before, they were four hand-kept copies held
// together by a drift test; these are those copies as they stood (account,
// ruta, side), and the derived maps must equal them exactly. Deliberate
// changes since: the vilande accounts 2618/2628/2638/2648 left (crm#1562),
// and 3913 joined ruta 08.
describe('VAT_ACCOUNT_TABLE: parity with the copies it replaced', () => {
  const OLD_ACCOUNT_RUTA =
    '2610:10:c 2611:10:c 2612:10:c 2613:10:c 2616:10:c 2620:11:c 2621:11:c 2622:11:c 2623:11:c ' +
    '2626:11:c 2630:12:c 2631:12:c 2632:12:c 2633:12:c 2636:12:c 2614:30:c 2624:31:c ' +
    '2634:32:c 2640:48:d 2641:48:d 2642:48:d 2645:48:d 2646:48:d 2647:48:d 2649:48:d 2615:60:c ' +
    '2625:61:c 2635:62:c 3000:05:c 3001:05:c 3002:05:c 3003:05:c 3401:06:c 3402:06:c 3403:06:c 3913:08:c 3108:35:c ' +
    '3107:38:c 3308:39:c 3105:36:c 3305:40:c 3004:42:c 3100:42:c 3404:42:c 3980:42:c 3994:42:c 3231:41:c ' +
    '3232:41:c 3233:41:c 4512:37:d 4515:20:d 4516:20:d 4517:20:d 4535:21:d 4536:21:d 4537:21:d 4531:22:d ' +
    '4532:22:d 4533:22:d 4415:23:d 4416:23:d 4417:23:d 4425:24:d 4426:24:d 4427:24:d 4545:50:d 4546:50:d ' +
    '4547:50:d'
  const OLD_ACCOUNT_TO_BOX =
    '3000:05 3001:05 3002:05 3003:05 3401:06 3402:06 3403:06 3913:08 3107:38 4512:37 3108:35 3521:35 3105:36 ' +
    '3522:36 3109:38 3308:39 3305:40 3231:41 3232:41 3233:41 3004:42 3100:42 3404:42 3980:42 3994:42 ' +
    '2610:10 2611:10 2612:10 2613:10 2616:10 2620:11 2621:11 2622:11 2623:11 2626:11 ' +
    '2630:12 2631:12 2632:12 2633:12 2636:12 2614:30 2624:31 2634:32 2615:60 2625:61 2635:62 ' +
    '2640:48 2641:48 2642:48 2645:48 2646:48 2647:48 2649:48 4515:20 4516:20 4517:20 4535:21 ' +
    '4536:21 4537:21 4531:22 4532:22 4533:22 4415:23 4416:23 4417:23 4425:24 4426:24 4427:24 4545:50 ' +
    '4546:50 4547:50'

  it('ACCOUNT_RUTA equals the old declaration map', () => {
    const expected = Object.fromEntries(
      OLD_ACCOUNT_RUTA.split(' ').map((row) => {
        const [account, box, side] = row.split(':')
        return [account, { box: `ruta${box}`, side: side === 'c' ? 'credit' : 'debit' }]
      }),
    )
    expect(ACCOUNT_RUTA).toEqual(expected)
  })

  it('ACCOUNT_TO_BOX equals the old box map, label-only accounts included', () => {
    const expected = Object.fromEntries(OLD_ACCOUNT_TO_BOX.split(' ').map((row) => row.split(':')))
    expect(ACCOUNT_TO_BOX).toEqual(expected)
  })

  it('the reverse-charge basis lists equal the old ones', () => {
    expect([...RC_BASIS_ACCOUNTS].sort()).toEqual([
      '4515', '4516', '4517', '4535', '4536', '4537', '4531', '4532', '4533',
      '4415', '4416', '4417', '4425', '4426', '4427',
    ].sort())
    // Membership per sats is what the readers use (sum, includes, a Map).
    const sorted = (accounts: readonly string[]) => [...accounts].sort()
    expect(sorted(RC_BASIS_ACCOUNTS_BY_RATE.r25)).toEqual(sorted(['4515', '4535', '4531', '4415', '4425']))
    expect(sorted(RC_BASIS_ACCOUNTS_BY_RATE.r12)).toEqual(sorted(['4516', '4536', '4532', '4416', '4426']))
    expect(sorted(RC_BASIS_ACCOUNTS_BY_RATE.r6)).toEqual(sorted(['4517', '4537', '4533', '4417', '4427']))
  })

  it('the basis account per purchase type and sats equals the old pickers', () => {
    const old: Record<VatBasisKind, string[]> = {
      eu_goods: ['4515', '4516', '4517'],
      eu_services: ['4535', '4536', '4537'],
      non_eu_services: ['4531', '4532', '4533'],
      domestic_goods: ['4415', '4416', '4417'],
      domestic_services: ['4425', '4426', '4427'],
      import: ['4545', '4546', '4547'],
    }
    for (const [kind, accounts] of Object.entries(old) as Array<[VatBasisKind, string[]]>) {
      expect([0.25, 0.12, 0.06].map((rate) => vatBasisAccount(kind, rate))).toEqual(accounts)
      expect(vatBasisAccount(kind, 0)).toBeNull()
    }
  })
})
