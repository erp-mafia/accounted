import { describe, it, expect } from 'vitest'
import { makeTransaction } from '@/tests/helpers'
import { isSkatteverketPayment } from '../skatteverket-payment'

describe('isSkatteverketPayment', () => {
  const out = (description: string, extra: Parameters<typeof makeTransaction>[0] = {}) =>
    makeTransaction({ amount: -12225, merchant_name: null, description, original_description: description, ...extra })

  it('recognises the name with the padded skattekonto bankgiro (crm#1275)', () => {
    expect(isSkatteverketPayment(out('SKATTEVERKET     BG 0000050501055 Bg-bet. via internet'))).toBe(true)
  })

  it('recognises the bank short name "SKV:"', () => {
    expect(isSkatteverketPayment(out('SKV: Bg-bet. via internet'))).toBe(true)
  })

  it('recognises the bankgiro alone, written either way', () => {
    expect(isSkatteverketPayment(out('BG 5050-1055 OCR 1655952499460'))).toBe(true)
    expect(isSkatteverketPayment(out('Bankgiro 50501055'))).toBe(true)
  })

  it('recognises the counterparty account when the text says nothing', () => {
    expect(isSkatteverketPayment(out('Bg-bet. via internet', { counterparty_account: '5050-1055' }))).toBe(true)
  })

  it('reads the merchant name too', () => {
    expect(isSkatteverketPayment(out('INTERNET BET 4', { merchant_name: 'Skatteverket' }))).toBe(true)
  })

  it('leaves money in from Skatteverket alone: a ROT/RUT payout is not a payment to it', () => {
    expect(isSkatteverketPayment(out('SKATTEVERKET ROT UTBETALNING', { amount: 4500 }))).toBe(false)
  })

  it('does not match other payees, words that only start like it, or another bankgiro', () => {
    expect(isSkatteverketPayment(out('TELIA SVERIGE AB BG 5051-6905'))).toBe(false)
    expect(isSkatteverketPayment(out('SKVALLERBUTIKEN AB'))).toBe(false)
    expect(isSkatteverketPayment(out('Faktura 50501055'))).toBe(false)
  })
})
