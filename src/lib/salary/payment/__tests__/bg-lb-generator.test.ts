import { describe, it, expect } from 'vitest'
import { generateBgLb } from '../bg-lb-generator'
import type { BgLbCompanyData, BgLbEmployee, BgLbOptions } from '../bg-lb-generator'

const company: BgLbCompanyData = {
  name: 'Acme AB',
  senderBankgiro: '123-4567',
}

const baseOptions: BgLbOptions = {
  paymentDate: '2026-04-25',
  periodLabel: '2026-04',
}

describe('generateBgLb', () => {
  it('produces a file with opening, payment, and closing records', () => {
    const employees: BgLbEmployee[] = [
      {
        name: 'Anna Andersson',
        clearingNumber: '6000',
        bankAccountNumber: '1234567',
        netSalary: 25000,
      },
      {
        name: 'Bo Bergström',
        clearingNumber: '6000',
        bankAccountNumber: '7654321',
        netSalary: 30500.5,
      },
    ]

    const result = generateBgLb(company, employees, baseOptions)
    const lines = result.content.split('\r\n').filter((l) => l.length > 0)

    expect(lines).toHaveLength(4)  // 1 opening + 2 payments + 1 closing
    expect(lines[0]).toMatch(/^11/)
    expect(lines[1]).toMatch(/^54/)
    expect(lines[2]).toMatch(/^54/)
    expect(lines[3]).toMatch(/^29/)
    expect(result.recordCount).toBe(2)
    expect(result.totalAmount).toBe(55500.5)
  })

  it('writes records exactly 80 characters wide', () => {
    const employees: BgLbEmployee[] = [
      { name: 'Cecilia Carlsson', clearingNumber: '6000', bankAccountNumber: '1234567', netSalary: 28000 },
    ]
    const result = generateBgLb(company, employees, baseOptions)
    const lines = result.content.split('\r\n').filter((l) => l.length > 0)
    for (const line of lines) {
      expect(line.length).toBe(80)
    }
  })

  it('encodes amounts in öre (no decimal)', () => {
    const employees: BgLbEmployee[] = [
      { name: 'Test', clearingNumber: '6000', bankAccountNumber: '1234567', netSalary: 12345.67 },
    ]
    const result = generateBgLb(company, employees, baseOptions)
    const paymentLine = result.content.split('\r\n')[1]
    // Amount field for TK 54 is positions 42-53 (12 chars, zero-padded)
    const amountField = paymentLine.slice(41, 53)
    expect(amountField).toBe('000001234567')  // 12345.67 SEK = 1234567 öre
  })

  it('handles 5-digit Swedbank clearings by shifting the 5th digit into the account', () => {
    const employees: BgLbEmployee[] = [
      { name: 'Swedbank', clearingNumber: '83271', bankAccountNumber: '123456789', netSalary: 1000 },
    ]
    const result = generateBgLb(company, employees, baseOptions)
    const paymentLine = result.content.split('\r\n')[1]
    // Pos 3-6 = clearing (4 digits)
    expect(paymentLine.slice(2, 6)).toBe('8327')
    // Pos 7-16 = account (10 digits): 5th clearing digit "1" + account "123456789"
    expect(paymentLine.slice(6, 16)).toBe('1123456789')
  })

  it('refuses by name an account that needs 11 positions in the 10-wide account field', () => {
    // Invented number: 5-digit clearing + 10-digit account. It used to throw
    // "Numeriskt fält för långt (11 > 10): 996..." with the number in the text.
    const employees: BgLbEmployee[] = [
      { name: 'Anna Andersson', clearingNumber: '6000', bankAccountNumber: '1234567', netSalary: 1000 },
      { name: 'Sara Svensson', clearingNumber: '8327-9', bankAccountNumber: '9612345678', netSalary: 1000 },
    ]
    expect(() => generateBgLb(company, employees, baseOptions)).toThrow(
      'Sara Svensson: kontonumret ryms inte i Bankgirot LB-filen',
    )
    expect(() => generateBgLb(company, employees, baseOptions)).not.toThrow(/996|9612345678|Numeriskt/)
  })

  it('rejects invalid bankgiro number', () => {
    expect(() =>
      generateBgLb({ ...company, senderBankgiro: 'invalid' }, [], baseOptions)
    ).toThrow(/Ogiltigt bankgironummer/)
  })

  it('rejects 5-digit clearing not starting with 8', () => {
    const employees: BgLbEmployee[] = [
      { name: 'X', clearingNumber: '90001', bankAccountNumber: '1234567', netSalary: 100 },
    ]
    expect(() => generateBgLb(company, employees, baseOptions)).toThrow(/clearing/)
  })

  it('skips employees with zero or negative net salary', () => {
    const employees: BgLbEmployee[] = [
      { name: 'A', clearingNumber: '6000', bankAccountNumber: '1234567', netSalary: 25000 },
      { name: 'B', clearingNumber: '6000', bankAccountNumber: '7654321', netSalary: 0 },
      { name: 'C', clearingNumber: '6000', bankAccountNumber: '1111111', netSalary: -500 },
    ]
    const result = generateBgLb(company, employees, baseOptions)
    expect(result.recordCount).toBe(1)
    expect(result.totalAmount).toBe(25000)
  })

  it('opening record contains LEVERANTÖRSBETALNINGAR and LEVE markers', () => {
    const result = generateBgLb(company, [
      { name: 'X', clearingNumber: '6000', bankAccountNumber: '1234567', netSalary: 100 },
    ], baseOptions)
    const opening = result.content.split('\r\n')[0]
    expect(opening.slice(18, 40)).toBe('LEVERANTÖRSBETALNINGAR')
    expect(opening.slice(40, 44)).toBe('LEVE')
  })

  it('closing record sums total amount in öre across all payments', () => {
    const employees: BgLbEmployee[] = [
      { name: 'A', clearingNumber: '6000', bankAccountNumber: '1234567', netSalary: 100 },
      { name: 'B', clearingNumber: '6000', bankAccountNumber: '7654321', netSalary: 250.5 },
    ]
    const result = generateBgLb(company, employees, baseOptions)
    const lines = result.content.split('\r\n').filter((l) => l)
    const closing = lines[lines.length - 1]
    expect(closing.startsWith('29')).toBe(true)
    // Pos 21-32 = total amount in öre (12 digits)
    expect(closing.slice(20, 32)).toBe('000000035050')  // 350.50 SEK = 35050 öre
  })

  it('encodes payment date as YYMMDD on opening and payment records', () => {
    const result = generateBgLb(company, [
      { name: 'X', clearingNumber: '6000', bankAccountNumber: '1234567', netSalary: 100 },
    ], { ...baseOptions, paymentDate: '2026-12-31' })
    const lines = result.content.split('\r\n')
    // Opening: pos 45-50 = payment date YYMMDD
    expect(lines[0].slice(44, 50)).toBe('261231')
    // Payment: pos 54-59 = payment date YYMMDD
    expect(lines[1].slice(53, 59)).toBe('261231')
  })

  it('truncates over-long employee names safely', () => {
    const longName = 'A'.repeat(50)
    const result = generateBgLb(company, [
      { name: longName, clearingNumber: '6000', bankAccountNumber: '1234567', netSalary: 100 },
    ], baseOptions)
    const paymentLine = result.content.split('\r\n')[1]
    // Pos 17-41 = receiver name (25 chars)
    expect(paymentLine.slice(16, 41)).toBe('A'.repeat(25))
  })

  it('preserves Swedish characters å ä ö in receiver name', () => {
    const result = generateBgLb(company, [
      { name: 'Åke Östberg', clearingNumber: '6000', bankAccountNumber: '1234567', netSalary: 100 },
    ], baseOptions)
    const paymentLine = result.content.split('\r\n')[1]
    expect(paymentLine.slice(16, 41).trimEnd()).toBe('Åke Östberg')
  })
})
