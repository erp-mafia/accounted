import { describe, expect, it } from 'vitest'
import { generateSupplierBgLb, type BgLbSupplierPayment } from '../bg-lb'

const payments: BgLbSupplierPayment[] = [
  { payee: { type: 'bankgiro', bankgiro: '5050-1055' }, reference: '55601234566', amount: 980, paymentDate: '2026-11-02', payeeName: 'Derome Bygg & Industri AB' },
  { payee: { type: 'plusgiro', plusgiro: '123456-6' }, reference: 'F-2026-118', amount: 12345.67, paymentDate: '2026-11-05', payeeName: 'Åkeri Öst' },
]

function records(content: string): string[] {
  return content.split('\r\n').filter((line) => line)
}

describe('generateSupplierBgLb', () => {
  it('writes TK11, one TK14 per bankgiro and one TK54 per PlusGiro payment, and TK29, every record 80 characters and CRLF', () => {
    const content = generateSupplierBgLb('991-2346', payments, { writeDate: '2026-10-25' })

    expect(content.endsWith('\r\n')).toBe(true)
    const lines = records(content)
    expect(lines.map((line) => line.slice(0, 2))).toEqual(['11', '14', '54', '29'])
    for (const line of lines) expect(line).toHaveLength(80)
  })

  it('opens with the sender bankgiro, the write date and no section date, so each payment keeps its own (manual 4.3.4)', () => {
    const [opening] = records(generateSupplierBgLb('991-2346', payments, { writeDate: '2026-10-25' }))

    expect(opening.slice(2, 12)).toBe('0009912346')
    expect(opening.slice(12, 18)).toBe('261025')
    expect(opening.slice(18, 40)).toBe('LEVERANTÖRSBETALNINGAR')
    expect(opening.slice(40, 46)).toBe('      ')
    expect(opening.slice(59, 62)).toBe('SEK')
  })

  it('puts the receiver, the reference left-justified as in Bankgirot\'s LBin examples, the amount in öre and the date in each payment record', () => {
    const [, bankgiro, plusgiro] = records(generateSupplierBgLb('991-2346', payments, { writeDate: '2026-10-25' }))

    expect(bankgiro.slice(2, 12)).toBe('0050501055')
    expect(bankgiro.slice(12, 37)).toBe('55601234566'.padEnd(25, ' '))
    expect(bankgiro.slice(37, 49)).toBe('000000098000')
    expect(bankgiro.slice(49, 55)).toBe('261102')
    expect(bankgiro.slice(55, 60)).toBe('     ')
    expect(bankgiro.slice(60, 80)).toBe('Derome Bygg & Indust')

    expect(plusgiro.slice(2, 12)).toBe('0001234566')
    expect(plusgiro.slice(12, 37)).toBe('F-2026-118'.padEnd(25, ' '))
    expect(plusgiro.slice(37, 49)).toBe('000001234567')
    expect(plusgiro.slice(49, 55)).toBe('261105')
    expect(plusgiro.slice(60, 80)).toBe('Åkeri Öst'.padEnd(20, ' '))
  })

  it('closes with the TK14 and TK54 count and their total in öre', () => {
    const lines = records(generateSupplierBgLb('991-2346', payments, { writeDate: '2026-10-25' }))
    const closing = lines[lines.length - 1]

    expect(closing.slice(2, 12)).toBe('0009912346')
    expect(closing.slice(12, 20)).toBe('00000002')
    expect(closing.slice(20, 32)).toBe('000001332567')
    expect(closing.slice(32, 33)).toBe(' ')
  })

  it('reads no clock: the same payments and write date give the same bytes', () => {
    expect(generateSupplierBgLb('991-2346', payments, { writeDate: '2026-10-25' })).toBe(
      generateSupplierBgLb('991-2346', payments, { writeDate: '2026-10-25' }),
    )
  })

  it('refuses an invalid sender bankgiro, an empty section and an amount that is not above zero', () => {
    expect(() => generateSupplierBgLb('12', payments, { writeDate: '2026-10-25' })).toThrow('Ogiltigt avsändar-bankgiro')
    expect(() => generateSupplierBgLb('991-2346', [], { writeDate: '2026-10-25' })).toThrow('minst en betalning')
    expect(() => generateSupplierBgLb('991-2346', [{ ...payments[0], amount: 0 }], { writeDate: '2026-10-25' })).toThrow('större än noll')
  })
})
