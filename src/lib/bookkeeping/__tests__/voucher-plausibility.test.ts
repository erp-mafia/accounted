import { describe, expect, it } from 'vitest'
import { booksPurchase, checkVoucherPlausibility, type PlausibilityLine } from '../voucher-plausibility'

const D = (account_number: string, amount: number): PlausibilityLine => ({ account_number, debit_amount: amount, credit_amount: 0 })
const C = (account_number: string, amount: number): PlausibilityLine => ({ account_number, debit_amount: 0, credit_amount: amount })

const codes = (lines: PlausibilityLine[]) => checkVoucherPlausibility(lines).map((w) => w.code)

/**
 * The flagged shapes are the hand-checked hits of the 2026-10-26 forensic
 * sweep (amounts as booked); the clean ones are the lawful look-alikes that
 * judge found or the VAT reference names.
 */
describe('checkVoucherPlausibility', () => {
  it('flags input VAT above 25 % of the cost: a receipt discount total typed as VAT', () => {
    const warnings = checkVoucherPlausibility([D('5460', 195.7), D('2641', 135.3), C('1930', 331)])
    expect(warnings.map((w) => w.code)).toEqual(['INPUT_VAT_ABOVE_RATE'])
    expect(warnings[0].details).toMatchObject({ input_vat: 135.3, cost_base: 195.7, share_percent: 69.1 })
    expect(warnings[0].message_sv).toContain('135,30 kr')
  })

  it('flags VAT kept on items left out of the cost', () => {
    expect(codes([D('5410', 11712.4), D('2641', 3112.6), C('2890', 14825)])).toEqual(['INPUT_VAT_ABOVE_RATE'])
  })

  it('warns, and only warns, on an insurer-paid repair invoice whose VAT exceeds the fee paid', () => {
    expect(codes([D('5613', 23.33), D('5613', 16.67), D('3740', 0.25), D('2641', 180.75), C('2440', 221)])).toEqual([
      'INPUT_VAT_ABOVE_RATE',
    ])
  })

  it('leaves VAT below the rate alone: a VAT-free fee line, representation, a mixed restaurant receipt', () => {
    expect(codes([D('6231', 759.2), D('2641', 189.8), D('6062', 60), C('2893', 1009)])).toEqual([])
    expect(codes([D('6071', 600), D('2641', 36), C('1930', 636)])).toEqual([])
    expect(codes([D('5831', 500), D('2641', 90), C('1930', 590)])).toEqual([])
  })

  it('stays within öre rounding of an exact 25 %', () => {
    expect(codes([D('5410', 100.01), D('2641', 26), C('1930', 126.01)])).toEqual([])
  })

  it('flags output VAT computed on the gross amount', () => {
    expect(codes([D('1930', 252.51), C('3000', 190.5), D('6570', 1.49), C('2610', 63.5)])).toEqual(['OUTPUT_VAT_ABOVE_RATE'])
  })

  it('flags a purchase whose VAT is debited to an output VAT account, with öresutjämning on the voucher', () => {
    const warnings = checkVoucherPlausibility([D('4010', 10158.48), D('2631', 609.51), C('1930', 10768), D('3740', 0.01)])
    expect(warnings.map((w) => w.code)).toEqual(['INPUT_VAT_ON_OUTPUT_ACCOUNT'])
    expect(warnings[0].details).toMatchObject({ accounts: ['2631'] })
  })

  it('leaves a bad-debt write-off and a sales credit note alone', () => {
    expect(codes([D('6352', 800), D('2611', 200), C('1510', 1000)])).toEqual([])
    expect(codes([D('3001', 800), D('2611', 200), C('1510', 1000)])).toEqual([])
  })

  it('flags reverse charge booked as a lone debit on 2614', () => {
    const warnings = checkVoucherPlausibility([C('1930', 195.3), D('6540', 156.24), D('2614', 39.06)])
    expect(warnings.map((w) => w.code)).toEqual(['REVERSE_CHARGE_ONE_SIDED'])
    expect(warnings[0].details).toMatchObject({ variant: 'output_debited' })
  })

  it('flags reverse-charge output with no input, and input with no output', () => {
    expect(checkVoucherPlausibility([D('4535', 1250), C('2614', 250), C('2440', 1000)])[0]?.details).toMatchObject({
      variant: 'output_without_input',
    })
    expect(checkVoucherPlausibility([D('6990', 72.12), D('2645', 4.34), C('1930', 76.46)])[0]?.details).toMatchObject({
      variant: 'input_without_output',
    })
  })

  it('leaves a paired reverse charge, an import and a reverse-charge credit note alone', () => {
    expect(codes([D('4535', 1000), D('2645', 250), C('2614', 250), C('2440', 1000)])).toEqual([])
    expect(codes([D('4545', 1000), C('4598', 1000), C('2615', 250), D('2641', 250), C('2440', 250)])).toEqual([])
    expect(codes([D('2440', 1000), C('4535', 1000), D('2614', 250), C('2645', 250)])).toEqual([])
  })

  it('flags a purchase debited to a revenue account, with input VAT or a supplier liability', () => {
    const kiosk = checkVoucherPlausibility([D('2641', 9.27), D('3020', 154.4), C('1931', 163.67)])
    expect(kiosk.map((w) => w.code)).toEqual(['REVENUE_DEBITED_IN_PURCHASE'])
    expect(kiosk[0].details).toMatchObject({ accounts: ['3020'] })
    expect(codes([D('3308', 2200), C('1930', 2200), D('2645', 550), C('2614', 550)])).toEqual(['REVENUE_DEBITED_IN_PURCHASE'])
    expect(codes([D('3001', 11), D('2641', 2.75), C('2440', 13.75)])).toEqual(['REVENUE_DEBITED_IN_PURCHASE'])
  })

  it('leaves refunds, reclasses and revenue deferrals alone', () => {
    expect(codes([D('3001', 800), D('2611', 200), C('1930', 1000)])).toEqual([])
    expect(codes([D('3001', 5000), C('3041', 5000)])).toEqual([])
    expect(codes([D('3001', 5000), C('2970', 5000)])).toEqual([])
  })

  it('passes an ordinary purchase and an ordinary sale', () => {
    expect(codes([D('5410', 800), D('2641', 200), C('1930', 1000)])).toEqual([])
    expect(codes([D('1510', 1250), C('3001', 1000), C('2611', 250)])).toEqual([])
  })
})

describe('booksPurchase', () => {
  it('finds the purchase in a cost, an asset, a supplier payment, a refund or a lone input VAT debit', () => {
    expect(booksPurchase([D('5890', 12000), C('1930', 12000)])).toBe(true)
    expect(booksPurchase([D('1220', 30000), C('1930', 30000)])).toBe(true)
    expect(booksPurchase([D('2440', 1249), C('1930', 1249)])).toBe(true)
    expect(booksPurchase([D('1930', 1120), C('5890', 1000), C('2641', 120)])).toBe(true)
    expect(booksPurchase([D('2641', 2400), C('1935', 2400)])).toBe(true)
  })

  it('finds none in a share issue, a transfer, a sale or a VAT settlement', () => {
    expect(booksPurchase([D('1931', 100000), C('2082', 100000)])).toBe(false)
    expect(booksPurchase([D('1940', 80000), C('1930', 80000)])).toBe(false)
    expect(booksPurchase([D('1686', 5000), C('2611', 1000), C('3001', 4000)])).toBe(false)
    expect(booksPurchase([D('2611', 2500), C('2641', 900), C('2650', 1600)])).toBe(false)
  })

  // crm#1783: shapes a payment-account company books, read as purchases by
  // their fee or exchange line and sent to the mailbox.
  it('finds none in a currency conversion, a cashback or a transfer to the own bank with its fee and exchange difference', () => {
    // Conversion between two currency accounts: fee and exchange gain.
    expect(booksPurchase([D('1941', 1000), C('1942', 990), C('1942', 5), C('3960', 10), D('6570', 5)])).toBe(false)
    // Transfer to the company's bank: fee and exchange loss.
    expect(booksPurchase([D('1930', 9800), C('1943', 9950), D('6570', 50), D('7960', 100)])).toBe(false)
    // Cashback credited by the payment account.
    expect(booksPurchase([D('1942', 300), D('1943', 400), C('8311', 700)])).toBe(false)
    // A bank charge or an exchange difference on its own, on liabilities too.
    expect(booksPurchase([D('6570', 99), C('1930', 99)])).toBe(false)
    expect(booksPurchase([D('8436', 12), C('1930', 12)])).toBe(false)
  })

  it('still finds the purchase when a fee or an exchange difference rides along with it', () => {
    expect(booksPurchase([D('5420', 900), D('6570', 15), C('1930', 915)])).toBe(true)
    expect(booksPurchase([D('2440', 5000), D('7960', 40), C('1930', 5040)])).toBe(true)
    expect(booksPurchase([D('6540', 400), D('2645', 100), C('2614', 100), C('1943', 400)])).toBe(true)
  })
})
