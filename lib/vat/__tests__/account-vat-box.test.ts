/**
 * Per-account momsruta for 26xx VAT accounts: which accounts may carry one,
 * how an override projects into the declaration's dynamic mapping, and the
 * name-based deviation hint the account dialog shows. The motivating chart
 * (Easy Online Stores evaluation brief 2026-09-16, F1) books EU-förvärv on
 * 2615, import on 2616 and tjänster utanför EU on 2617.
 */
import { describe, it, expect } from 'vitest'
import {
  ACCOUNT_VAT_BOXES,
  ACCOUNT_VAT_BOX_CODES,
  basVatBox,
  isAccountVatBox,
  isVatBoxAccount,
  suggestVatBoxFromName,
  vatBoxDeviationFromName,
  vatBoxLabel,
  vatBoxRutaMapping,
} from '../account-vat-box'

describe('isVatBoxAccount', () => {
  it('accepts 26xx VAT accounts and refuses 2650 and everything else', () => {
    expect(isVatBoxAccount('2615')).toBe(true)
    expect(isVatBoxAccount('2617')).toBe(true)
    expect(isVatBoxAccount('2641')).toBe(true)
    expect(isVatBoxAccount('2650')).toBe(false)
    expect(isVatBoxAccount('2610')).toBe(true)
    expect(isVatBoxAccount('1650')).toBe(false)
    expect(isVatBoxAccount('4545')).toBe(false)
    expect(isVatBoxAccount('26150')).toBe(false)
    expect(isVatBoxAccount('261')).toBe(false)
  })
})

describe('isAccountVatBox', () => {
  it('accepts exactly the stored set', () => {
    for (const box of ACCOUNT_VAT_BOXES) expect(isAccountVatBox(box)).toBe(true)
    expect(isAccountVatBox('49')).toBe(false)
    expect(isAccountVatBox('50')).toBe(false)
    expect(isAccountVatBox('05')).toBe(false)
    expect(isAccountVatBox(10)).toBe(false)
    expect(isAccountVatBox(null)).toBe(false)
    expect(isAccountVatBox(undefined)).toBe(false)
  })

  it('keeps ruta 49 and the basis boxes out of the codes', () => {
    expect(ACCOUNT_VAT_BOX_CODES).toEqual(['10', '11', '12', '30', '31', '32', '60', '61', '62', '48'])
  })
})

describe('vatBoxRutaMapping', () => {
  it('routes output boxes by credit balance and ruta 48 by debit balance', () => {
    expect(vatBoxRutaMapping('30')).toEqual({ box: 'ruta30', side: 'credit' })
    expect(vatBoxRutaMapping('60')).toEqual({ box: 'ruta60', side: 'credit' })
    expect(vatBoxRutaMapping('10')).toEqual({ box: 'ruta10', side: 'credit' })
    expect(vatBoxRutaMapping('48')).toEqual({ box: 'ruta48', side: 'debit' })
  })

  it("maps 'none' nowhere", () => {
    expect(vatBoxRutaMapping('none')).toBeNull()
  })
})

describe('basVatBox', () => {
  it('reads the BAS box for known numbers and null for unknown ones', () => {
    expect(basVatBox('2615')).toBe('60')
    expect(basVatBox('2616')).toBe('10')
    expect(basVatBox('2614')).toBe('30')
    expect(basVatBox('2641')).toBe('48')
    expect(basVatBox('2617')).toBeNull()
    expect(basVatBox('2650')).toBeNull()
  })
})

describe('suggestVatBoxFromName', () => {
  it('reads the Fortnox layout from the account names', () => {
    expect(suggestVatBoxFromName('Utgående moms varuförvärv EU 25 %')).toBe('30')
    expect(suggestVatBoxFromName('Utgående moms import av varor 25 %')).toBe('60')
    expect(suggestVatBoxFromName('Utgående moms tjänster utanför EU 25 %')).toBe('30')
  })

  it('reads the rate into the box', () => {
    expect(suggestVatBoxFromName('Utgående moms import 12 %')).toBe('61')
    expect(suggestVatBoxFromName('Utgående moms omvänd skattskyldighet 6 %')).toBe('32')
    expect(suggestVatBoxFromName('Utgående moms 12 %')).toBe('11')
  })

  it('reads ingående moms as ruta 48 and plain utgående as ruta 10', () => {
    expect(suggestVatBoxFromName('Ingående moms')).toBe('48')
    expect(suggestVatBoxFromName('Beräknad ingående moms på förvärv från utlandet')).toBe('48')
    expect(suggestVatBoxFromName('Utgående moms 25 %')).toBe('10')
  })

  it('says nothing for names without moms or without a direction', () => {
    expect(suggestVatBoxFromName('Momsredovisning')).toBeNull()
    expect(suggestVatBoxFromName('Särskilda punktskatter')).toBeNull()
    expect(suggestVatBoxFromName('')).toBeNull()
  })
})

describe('vatBoxDeviationFromName', () => {
  it('flags the three Fortnox accounts that deviate from BAS', () => {
    expect(vatBoxDeviationFromName('2615', 'Utgående moms varuförvärv EU 25 %')).toBe('30')
    expect(vatBoxDeviationFromName('2616', 'Utgående moms import av varor 25 %')).toBe('60')
    expect(vatBoxDeviationFromName('2617', 'Utgående moms tjänster utanför EU 25 %')).toBe('30')
  })

  it('stays silent when name and BAS number agree, or the account cannot carry a box', () => {
    expect(vatBoxDeviationFromName('2615', 'Utgående moms import 25 %')).toBeNull()
    expect(vatBoxDeviationFromName('2614', 'Utgående moms omvänd skattskyldighet 25 %')).toBeNull()
    expect(vatBoxDeviationFromName('2641', 'Debiterad ingående moms')).toBeNull()
    expect(vatBoxDeviationFromName('2650', 'Utgående moms import')).toBeNull()
    expect(vatBoxDeviationFromName('4545', 'Import av varor 25 %')).toBeNull()
  })
})

describe('vatBoxLabel', () => {
  it('uses the declaration labels and a plain label for none', () => {
    expect(vatBoxLabel('30')).toBe('Utgående moms på inköp 25%')
    expect(vatBoxLabel('none')).toBe('Ingen ruta')
  })
})
