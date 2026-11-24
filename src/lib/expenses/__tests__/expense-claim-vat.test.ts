import { describe, it, expect } from 'vitest'
import { sumOre } from '@/lib/money'
import {
  EXPENSE_VAT_CASES,
  expenseClaimReverseChargeLines,
  expenseVatCasesForReceipt,
  reverseChargeForVatCase,
  vatCaseFromReceipt,
} from '../expense-claim-vat'

function legs(lines: ReturnType<typeof expenseClaimReverseChargeLines>) {
  return lines?.map((l) => [l.account_number, l.debit_amount, l.credit_amount]) ?? null
}

describe('vatCaseFromReceipt (crm#1028: never guess the moms)', () => {
  const answer = (currency: string, vatAmount: number | null | undefined, sellerVatNumber?: string | null) =>
    vatCaseFromReceipt({ currency, vatAmount, sellerVatNumber })

  it('answers only from VAT the receipt shows: SEK moms is Swedish, VAT in another currency is foreign', () => {
    expect(answer('SEK', 125)).toBe('domestic')
    expect(answer('sek', 25, 'SE556677889901')).toBe('domestic')
    expect(answer('EUR', 20)).toBe('abroad')
    expect(answer('EUR', 20, 'DE123456789')).toBe('abroad')
    expect(answer('USD', 4.5, 'EU372000041')).toBe('abroad')
  })

  it('leaves the answer to the user when the receipt shows no VAT, whatever the currency', () => {
    // A foreign SaaS receipt without VAT (omvänd skattskyldighet), a taxi
    // abroad (taxed where performed, booked gross) and a Swedish receipt
    // without moms look the same, in SEK as in USD.
    expect(answer('USD', 0)).toBeNull()
    expect(answer('EUR', 0, 'IE6388047V')).toBeNull()
    expect(answer('SEK', 0)).toBeNull()
  })

  it('leaves the answer to the user when the VAT was not read', () => {
    expect(answer('EUR', null)).toBeNull()
    expect(answer('SEK', undefined)).toBeNull()
  })

  it('does not call SEK moms Swedish when the seller VAT number is from another country', () => {
    expect(answer('SEK', 250, 'IE6388047V')).toBeNull()
    expect(answer('SEK', 250, 'ie 638 8047 v')).toBeNull()
    // A number without a country prefix says nothing about where the seller is.
    expect(answer('SEK', 250, '12-3456789')).toBe('domestic')
  })

  it('does not call VAT in another currency foreign when the VAT number is Swedish (crm#1028 review)', () => {
    // A Swedish seller billing in euro with Swedish moms, or the buyer's own
    // number read as the seller's: the person who paid answers.
    expect(answer('EUR', 25, 'SE556677889901')).toBeNull()
    expect(answer('usd', 25, 'se 5566778899 01')).toBeNull()
    expect(answer('EUR', 25, '12-3456789')).toBe('abroad')
  })

  it('does not call SEK moms Swedish when the Swedish VAT number sits beside an address abroad', () => {
    // A business established abroad can hold a Swedish VAT number; whether it
    // is established here for the sale decides whose VAT it is, and the
    // receipt does not tell (ML 2023:200 16 kap. 4 §).
    expect(vatCaseFromReceipt({ currency: 'SEK', vatAmount: 30, sellerVatNumber: 'SE502012345601', sellerAddress: '1 Example Road\nSingapore 123456' })).toBeNull()
    expect(vatCaseFromReceipt({ currency: 'SEK', vatAmount: 30, sellerVatNumber: 'SE556677889901', sellerAddress: 'Storgatan 1, 111 22 Stockholm' })).toBe('domestic')
  })
})

describe('expenseVatCasesForReceipt: what the dialog offers (crm#1028 review)', () => {
  it('offers every answer, the gross one before reverse charge, when the category says nothing', () => {
    expect(expenseVatCasesForReceipt({ merchantCategory: null })).toEqual([
      'domestic',
      'abroad',
      'reverse_charge_eu',
      'reverse_charge_non_eu',
    ])
    expect(expenseVatCasesForReceipt({ merchantCategory: 'other' })).toEqual(EXPENSE_VAT_CASES)
    expect(expenseVatCasesForReceipt({})).toEqual(EXPENSE_VAT_CASES)
  })

  it.each(['restaurant', 'cafe', 'taxi', 'parking', 'fuel', 'grocery', 'hotel'])(
    'offers no reverse charge for a %s receipt, taxed where it is bought',
    (merchantCategory) => {
      expect(expenseVatCasesForReceipt({ merchantCategory })).toEqual(['domestic', 'abroad'])
    },
  )

  it('asks for a foreign taxi receipt without VAT and offers the gross answer instead of reverse charge', () => {
    expect(vatCaseFromReceipt({ currency: 'USD', vatAmount: 0 })).toBeNull()
    const offered = expenseVatCasesForReceipt({ merchantCategory: 'taxi' })
    expect(offered).toContain('abroad')
    expect(offered.map(reverseChargeForVatCase).filter(Boolean)).toEqual([])
  })
})

describe('reverseChargeForVatCase', () => {
  it('maps the two reverse-charge answers to their kind and nothing else', () => {
    expect(EXPENSE_VAT_CASES.map((c) => [c, reverseChargeForVatCase(c)])).toEqual([
      ['domestic', undefined],
      ['abroad', undefined],
      ['reverse_charge_eu', 'eu_services'],
      ['reverse_charge_non_eu', 'non_eu_services'],
    ])
  })
})

describe('expenseClaimReverseChargeLines', () => {
  it('books the fiktiv moms and the ruta 21 basis pair on an ordinary cost account', () => {
    expect(legs(expenseClaimReverseChargeLines(1000, 'eu_services', '6540', null))).toEqual([
      ['2645', 250, 0],
      ['2614', 0, 250],
      ['4535', 1000, 0],
      ['4598', 0, 1000],
    ])
  })

  it('puts a seller outside the EU in ruta 22 (4531)', () => {
    expect(legs(expenseClaimReverseChargeLines(262.5, 'non_eu_services', '5420', null))).toEqual([
      ['2645', 65.63, 0],
      ['2614', 0, 65.63],
      ['4531', 262.5, 0],
      ['4598', 0, 262.5],
    ])
  })

  it('adds no basis pair on an account that reports the ruta itself, and takes its rate', () => {
    // 4531 is ruta 22 at 25 %; 4532 is ruta 22 at 12 %, so its fiktiv moms is 12 % on 2624.
    expect(legs(expenseClaimReverseChargeLines(1000, 'non_eu_services', '4531', null))).toEqual([
      ['2645', 250, 0],
      ['2614', 0, 250],
    ])
    expect(legs(expenseClaimReverseChargeLines(1000, 'non_eu_services', '4532', null))).toEqual([
      ['2645', 120, 0],
      ['2624', 0, 120],
    ])
  })

  it('reads the chart row as the declaration does: a reverse-charge momskod makes the account report its own ruta', () => {
    const configured = { default_vat_treatment: 'reverse_charge_eu_services', default_vat_rate: null }
    expect(legs(expenseClaimReverseChargeLines(1000, 'eu_services', '6541', configured))).toEqual([
      ['2645', 250, 0],
      ['2614', 0, 250],
    ])
    const ordinary = { default_vat_treatment: 'standard_25', default_vat_rate: 0.25 }
    expect(legs(expenseClaimReverseChargeLines(1000, 'eu_services', '6540', ordinary))).toHaveLength(4)
  })

  it('still books the complete set on a cost account outside class 4-6 (a course on 7610)', () => {
    const complete = [
      ['2645', 100, 0],
      ['2614', 0, 100],
      ['4535', 400, 0],
      ['4598', 0, 400],
    ]
    expect(legs(expenseClaimReverseChargeLines(400, 'eu_services', '7610', null))).toEqual(complete)
    // A momskod on a class 7 account puts nothing in a ruta, so the pair still books the base.
    const configured = { default_vat_treatment: 'reverse_charge_eu_services', default_vat_rate: 0.25 }
    expect(legs(expenseClaimReverseChargeLines(400, 'eu_services', '7610', configured))).toEqual(complete)
  })

  it('refuses an account that reports its own ruta for another purchase than the answer', () => {
    // 4531 is ruta 22 and 4535 ruta 21: the answer cannot move the base.
    expect(expenseClaimReverseChargeLines(1000, 'eu_services', '4531', null)).toBeNull()
    expect(expenseClaimReverseChargeLines(1000, 'non_eu_services', '4535', null)).toBeNull()
    expect(expenseClaimReverseChargeLines(1000, 'eu_services', '4515', null)).toBeNull()
    const domestic = { default_vat_treatment: 'reverse_charge_domestic', default_vat_rate: 0.25 }
    expect(expenseClaimReverseChargeLines(1000, 'eu_services', '4425', domestic)).toBeNull()
    const configured = { default_vat_treatment: 'reverse_charge_non_eu_services', default_vat_rate: 0.25 }
    expect(expenseClaimReverseChargeLines(1000, 'eu_services', '6541', configured)).toBeNull()
  })

  it('refuses a purchase account that declares another box itself instead of declaring the base twice (crm#1028 review)', () => {
    // A reverse-charge momskod without a Swedish rate still reports ruta 21 by its treatment.
    const rateless = { default_vat_treatment: 'reverse_charge_eu_services', default_vat_rate: 0 }
    expect(expenseClaimReverseChargeLines(1000, 'non_eu_services', '6541', rateless)).toBeNull()
    expect(expenseClaimReverseChargeLines(1000, 'eu_services', '6541', rateless)).toBeNull()
    // The import basis (ruta 50) and trepartshandel (ruta 37), by number or by momskod.
    expect(expenseClaimReverseChargeLines(1000, 'non_eu_services', '4545', null)).toBeNull()
    expect(expenseClaimReverseChargeLines(1000, 'eu_services', '4512', null)).toBeNull()
    const importBasis = { default_vat_treatment: 'import_goods', default_vat_rate: 0.25 }
    expect(expenseClaimReverseChargeLines(1000, 'non_eu_services', '6550', importBasis)).toBeNull()
    const triangulation = { default_vat_treatment: 'triangulation_eu_goods', default_vat_rate: 0 }
    expect(expenseClaimReverseChargeLines(1000, 'eu_services', '6550', triangulation)).toBeNull()
    // The basis offset is no cost account.
    expect(expenseClaimReverseChargeLines(1000, 'eu_services', '4598', null)).toBeNull()
  })

  it('nets to zero: the lines never change what the claim owes', () => {
    const lines = expenseClaimReverseChargeLines(1234.56, 'eu_services', '6540', null) ?? []
    expect(lines).toHaveLength(4)
    expect(sumOre(lines.map((l) => l.debit_amount))).toBe(sumOre(lines.map((l) => l.credit_amount)))
  })
})
