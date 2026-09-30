import { describe, it, expect } from 'vitest'
import { generateBankgiroPaymentBgLb } from '../bg-lb-generator'

const company = {
  name: 'Acme AB',
  senderBankgiro: '123-4567',
}

describe('generateBankgiroPaymentBgLb', () => {
  it('produces opening + TK14 + closing records', () => {
    const result = generateBankgiroPaymentBgLb(
      company,
      {
        receiverBankgiro: '5050-1055',
        ocr: '55601234566',
        amount: 12345.67,
        receiverName: 'Skatteverket',
      },
      { paymentDate: '2026-05-12', periodLabel: '2026-04' }
    )
    const lines = result.content.split('\r\n').filter((l) => l)
    expect(lines).toHaveLength(3)
    expect(lines[0].slice(0, 2)).toBe('11')
    expect(lines[1].slice(0, 2)).toBe('14')
    expect(lines[2].slice(0, 2)).toBe('29')
    expect(result.recordCount).toBe(1)
    expect(result.totalAmount).toBe(12345.67)
  })

  it('all records are exactly 80 characters', () => {
    const result = generateBankgiroPaymentBgLb(
      company,
      { receiverBankgiro: '5050-1055', ocr: '55601234566', amount: 1000 },
      { paymentDate: '2026-05-12', periodLabel: '2026-04' }
    )
    for (const line of result.content.split('\r\n').filter((l) => l)) {
      expect(line.length).toBe(80)
    }
  })

  it('encodes receiver bankgiro right-justified zero-padded', () => {
    const result = generateBankgiroPaymentBgLb(
      company,
      { receiverBankgiro: '5050-1055', ocr: '55601234566', amount: 1000 },
      { paymentDate: '2026-05-12', periodLabel: '2026-04' }
    )
    const paymentLine = result.content.split('\r\n')[1]
    // Pos 3-12 = receiver BG (10 digits)
    expect(paymentLine.slice(2, 12)).toBe('0050501055')
  })

  it('encodes OCR right-justified zero-padded in pos 13-37', () => {
    const result = generateBankgiroPaymentBgLb(
      company,
      { receiverBankgiro: '5050-1055', ocr: '55601234566', amount: 1000 },
      { paymentDate: '2026-05-12', periodLabel: '2026-04' }
    )
    const paymentLine = result.content.split('\r\n')[1]
    // OCR "55601234566" (11 digits) padded to 25 chars right-justified = 14 zeros + OCR
    expect(paymentLine.slice(12, 37)).toBe('00000000000000055601234566'.slice(-25))
    expect(paymentLine.slice(12, 37).length).toBe(25)
    expect(paymentLine.slice(12, 37).endsWith('55601234566')).toBe(true)
  })

  it('encodes amount in öre (no decimal)', () => {
    const result = generateBankgiroPaymentBgLb(
      company,
      { receiverBankgiro: '5050-1055', ocr: '55601234566', amount: 12345.67 },
      { paymentDate: '2026-05-12', periodLabel: '2026-04' }
    )
    const paymentLine = result.content.split('\r\n')[1]
    // Pos 38-49 = amount in öre (12 digits)
    expect(paymentLine.slice(37, 49)).toBe('000001234567')
  })

  it('rejects invalid receiver bankgiro', () => {
    expect(() =>
      generateBankgiroPaymentBgLb(
        company,
        { receiverBankgiro: 'invalid', ocr: '55601234566', amount: 100 },
        { paymentDate: '2026-05-12', periodLabel: '2026-04' }
      )
    ).toThrow(/mottagar-bankgiro/)
  })

  it('rejects invalid OCR (non-numeric)', () => {
    expect(() =>
      generateBankgiroPaymentBgLb(
        company,
        { receiverBankgiro: '5050-1055', ocr: 'abcdef', amount: 100 },
        { paymentDate: '2026-05-12', periodLabel: '2026-04' }
      )
    ).toThrow(/OCR/)
  })

  it('opening record: sender bankgiro, product, payment date for the section, SEK (TK11 per the LB manual)', () => {
    const result = generateBankgiroPaymentBgLb(
      company,
      { receiverBankgiro: '5050-1055', ocr: '55601234566', amount: 1000 },
      { paymentDate: '2026-05-12', periodLabel: '2026-04' }
    )
    const opening = result.content.split('\r\n')[0]
    expect(opening.slice(2, 12)).toBe('0001234567')
    expect(opening.slice(18, 40)).toBe('LEVERANTÖRSBETALNINGAR')
    expect(opening.slice(40, 46)).toBe('260512')
    expect(opening.slice(46, 59)).toBe(' '.repeat(13))
    expect(opening.slice(59, 62)).toBe('SEK')
    expect(opening.slice(62, 80)).toBe(' '.repeat(18))
  })

  it('payment record: date in pos 50-55, pos 56-60 blank, receiver name as sender information in pos 61-80', () => {
    const result = generateBankgiroPaymentBgLb(
      company,
      { receiverBankgiro: '5050-1055', ocr: '55601234566', amount: 1000, receiverName: 'Skatteverket' },
      { paymentDate: '2026-05-12', periodLabel: '2026-04' }
    )
    const paymentLine = result.content.split('\r\n')[1]
    expect(paymentLine.slice(49, 55)).toBe('260512')
    expect(paymentLine.slice(55, 60)).toBe(' '.repeat(5))
    expect(paymentLine.slice(60, 80)).toBe('Skatteverket'.padEnd(20, ' '))
  })

  it('closing record counts payment records only (one TK14), never the opening or closing record', () => {
    const result = generateBankgiroPaymentBgLb(
      company,
      { receiverBankgiro: '5050-1055', ocr: '55601234566', amount: 100.5 },
      { paymentDate: '2026-05-12', periodLabel: '2026-04' }
    )
    const closing = result.content.split('\r\n').filter((l) => l)[2]
    expect(closing.slice(2, 12)).toBe('0001234567')
    expect(closing.slice(12, 20)).toBe('00000001')
    expect(closing.slice(32, 33)).toBe(' ')
  })

  it('closing record sums total amount in öre', () => {
    const result = generateBankgiroPaymentBgLb(
      company,
      { receiverBankgiro: '5050-1055', ocr: '55601234566', amount: 100.5 },
      { paymentDate: '2026-05-12', periodLabel: '2026-04' }
    )
    const closing = result.content.split('\r\n').filter((l) => l)[2]
    expect(closing.slice(20, 32)).toBe('000000010050')  // 100.50 SEK = 10050 öre
  })
})
