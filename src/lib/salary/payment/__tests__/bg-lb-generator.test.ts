import { describe, it, expect } from 'vitest'
import { generateBgLb, utbetalningsnummer, PAYEE_NUMBER_MAX } from '../bg-lb-generator'
import type { BgLbCompanyData, BgLbEmployee, BgLbOptions } from '../bg-lb-generator'
import { luhnValidate } from '@/lib/bankgiro/luhn'

// Every number in this file is invented.

const company: BgLbCompanyData = {
  name: 'Acme AB',
  senderBankgiro: '123-4567',
}

const baseOptions: BgLbOptions = {
  paymentDate: '2026-04-25',
  periodLabel: '2026-04',
}

const anna: BgLbEmployee = {
  name: 'Anna Andersson',
  clearingNumber: '6000',
  bankAccountNumber: '1234567',
  payeeNumber: 1,
  netSalary: 25000,
}
const bo: BgLbEmployee = {
  name: 'Bo Bergström',
  clearingNumber: '6000',
  bankAccountNumber: '7654321',
  payeeNumber: 2,
  netSalary: 30500.5,
}

function lines(content: string): string[] {
  return content.split('\r\n').filter((l) => l.length > 0)
}

/** 1-based inclusive positions, as the Bankgirot manual numbers them. */
function pos(line: string, from: number, to: number): string {
  return line.slice(from - 1, to)
}

describe('utbetalningsnummer', () => {
  it('is the base zero-filled to five digits plus a Luhn check digit', () => {
    expect(utbetalningsnummer(1)).toBe('000018')
    expect(utbetalningsnummer(12)).toHaveLength(6)
    expect(utbetalningsnummer(PAYEE_NUMBER_MAX)).toHaveLength(6)
    for (const n of [1, 12, 345, 99999]) expect(luhnValidate(utbetalningsnummer(n))).toBe(true)
  })

  it('is never all zeros and refuses anything outside 1..99999', () => {
    for (const n of [0, -1, 1.5, 100000, Number.NaN]) {
      expect(() => utbetalningsnummer(n)).toThrow(/heltal mellan 1 och 99999/)
    }
  })
})

describe('generateBgLb', () => {
  it('writes an opening record, a TK40 + TK14 pair per employee, and a closing record', () => {
    const result = generateBgLb(company, [anna, bo], baseOptions)
    const rows = lines(result.content)

    expect(rows).toHaveLength(6) // TK11 + 2 x (TK40 + TK14) + TK29
    expect(rows.map((r) => r.slice(0, 2))).toEqual(['11', '40', '14', '40', '14', '29'])
    expect(result.recordCount).toBe(2)
    expect(result.totalAmount).toBe(55500.5)
    expect(result.filename).toBe('bg_lb_lon_2026-04.txt')
    expect(result.content.endsWith('\r\n')).toBe(true)
  })

  it('writes records exactly 80 characters wide', () => {
    const result = generateBgLb(company, [anna, bo], baseOptions)
    for (const line of lines(result.content)) expect(line).toHaveLength(80)
  })

  it('TK11: sender bankgiro, write date, product, payment date for the section, SEK', () => {
    const opening = lines(generateBgLb(company, [anna], baseOptions).content)[0]
    expect(pos(opening, 1, 2)).toBe('11')
    expect(pos(opening, 3, 12)).toBe('0001234567')
    expect(pos(opening, 13, 18)).toMatch(/^\d{6}$/)
    expect(pos(opening, 19, 40)).toBe('LEVERANTÖRSBETALNINGAR')
    expect(pos(opening, 41, 46)).toBe('260425')
    expect(pos(opening, 47, 59)).toBe(' '.repeat(13))
    expect(pos(opening, 60, 62)).toBe('SEK')
    expect(pos(opening, 63, 80)).toBe(' '.repeat(18))
  })

  it('TK40: utbetalningsnummer, 4-digit clearing, 12-wide account, statement text, code L', () => {
    const account = lines(generateBgLb(company, [anna], baseOptions).content)[1]
    expect(pos(account, 1, 2)).toBe('40')
    expect(pos(account, 3, 6)).toBe('0000')
    expect(pos(account, 7, 12)).toBe('000018')
    expect(pos(account, 13, 16)).toBe('6000')
    expect(pos(account, 17, 28)).toBe('000001234567')
    expect(pos(account, 29, 40)).toBe('Lön 2026-04 ')
    expect(pos(account, 41, 41)).toBe('L')
    expect(pos(account, 42, 80)).toBe(' '.repeat(39))
  })

  it('TK14: the same utbetalningsnummer as the receiver, reference, amount in öre, date, payee name', () => {
    const payment = lines(generateBgLb(company, [{ ...anna, netSalary: 12345.67 }], baseOptions).content)[2]
    expect(pos(payment, 1, 2)).toBe('14')
    expect(pos(payment, 3, 12)).toBe('0000000018')
    expect(pos(payment, 13, 37)).toBe('Lön 2026-04'.padEnd(25, ' '))
    expect(pos(payment, 38, 49)).toBe('000001234567') // 12345.67 SEK = 1234567 öre
    expect(pos(payment, 50, 55)).toBe('260425')
    expect(pos(payment, 56, 60)).toBe(' '.repeat(5))
    expect(pos(payment, 61, 80)).toBe('Anna Andersson'.padEnd(20, ' '))
  })

  it('TK29: the number of payment records (not opening, account or closing records) and the total', () => {
    const rows = lines(generateBgLb(company, [anna, { ...bo, netSalary: 250.5 }], baseOptions).content)
    const closing = rows[rows.length - 1]
    expect(pos(closing, 1, 2)).toBe('29')
    expect(pos(closing, 3, 12)).toBe('0001234567')
    expect(pos(closing, 13, 20)).toBe('00000002')
    expect(pos(closing, 21, 32)).toBe('000002525050') // 25000 + 250.50 SEK = 2525050 öre
    expect(pos(closing, 33, 33)).toBe(' ')
    expect(pos(closing, 34, 80)).toBe(' '.repeat(47))
  })

  it('ties each TK40 to its TK14 with the same utbetalningsnummer, distinct per employee', () => {
    const rows = lines(generateBgLb(company, [anna, { ...bo, payeeNumber: 345 }], baseOptions).content)
    const first = pos(rows[1], 7, 12)
    const second = pos(rows[3], 7, 12)
    expect(pos(rows[2], 3, 12)).toBe(first.padStart(10, '0'))
    expect(pos(rows[4], 3, 12)).toBe(second.padStart(10, '0'))
    expect(first).not.toBe(second)
    expect(luhnValidate(first)).toBe(true)
    expect(luhnValidate(second)).toBe(true)
  })

  it('handles 5-digit Swedbank clearings by shifting the 5th digit into the account', () => {
    const swedbank = { ...anna, name: 'Swedbank', clearingNumber: '83271', bankAccountNumber: '123456789' }
    const account = lines(generateBgLb(company, [swedbank], baseOptions).content)[1]
    expect(pos(account, 13, 16)).toBe('8327')
    expect(pos(account, 17, 28)).toBe('001123456789')
  })

  it('carries a 5-digit clearing with a 10-digit account: 11 digits in the 12-wide TK40 field (crm#174)', () => {
    // Invented number: the support-ticket shape. The old TK54 layout had a
    // 10-wide account field and refused this employee by name.
    const sara = { ...anna, name: 'Sara Svensson', clearingNumber: '8327-9', bankAccountNumber: '9612345678', payeeNumber: 7 }
    const result = generateBgLb(company, [anna, sara], baseOptions)
    const rows = lines(result.content)
    expect(result.recordCount).toBe(2)
    expect(pos(rows[3], 13, 16)).toBe('8327')
    expect(pos(rows[3], 17, 28)).toBe('099612345678')
    for (const line of rows) expect(line).toHaveLength(80)
  })

  it('refuses two employees with the same utbetalningsnummer, by name', () => {
    const twin = { ...bo, payeeNumber: anna.payeeNumber }
    expect(() => generateBgLb(company, [anna, twin], baseOptions)).toThrow(
      'Anna Andersson, Bo Bergström: samma utbetalningsnummer i LB-filen',
    )
  })

  it('refuses an employee without a usable specification number, by name and without numbers', () => {
    for (const payeeNumber of [0, 100000, 2.5]) {
      const bad = { ...anna, payeeNumber }
      const error = (() => {
        try {
          generateBgLb(company, [bad], baseOptions)
        } catch (err) {
          return err as Error
        }
        return null
      })()
      expect(error?.message).toContain('Anna Andersson: saknar ett giltigt specifikationsnummer')
      expect(error?.message).not.toContain('1234567')
    }
  })

  it('rejects invalid bankgiro number', () => {
    expect(() =>
      generateBgLb({ ...company, senderBankgiro: 'invalid' }, [], baseOptions)
    ).toThrow(/Ogiltigt bankgironummer/)
  })

  it('rejects 5-digit clearing not starting with 8, by name', () => {
    const bad = { ...anna, name: 'X', clearingNumber: '90001' }
    expect(() => generateBgLb(company, [bad], baseOptions)).toThrow(/X: clearingnumret är ogiltigt/)
    expect(() => generateBgLb(company, [bad], baseOptions)).not.toThrow(/90001|1234567/)
  })

  it('skips employees with zero or negative net salary', () => {
    const employees: BgLbEmployee[] = [
      anna,
      { ...bo, netSalary: 0 },
      { ...bo, payeeNumber: 3, bankAccountNumber: '1111111', netSalary: -500 },
    ]
    const result = generateBgLb(company, employees, baseOptions)
    expect(result.recordCount).toBe(1)
    expect(result.totalAmount).toBe(25000)
    expect(lines(result.content)).toHaveLength(4) // TK11 + TK40 + TK14 + TK29
  })

  it('encodes the payment date as YYMMDD on the opening and payment records', () => {
    const rows = lines(generateBgLb(company, [anna], { ...baseOptions, paymentDate: '2026-12-31' }).content)
    expect(pos(rows[0], 41, 46)).toBe('261231')
    expect(pos(rows[2], 50, 55)).toBe('261231')
  })

  it('truncates an over-long employee name to the 20-char sender information field', () => {
    const longName = 'A'.repeat(50)
    const payment = lines(generateBgLb(company, [{ ...anna, name: longName }], baseOptions).content)[2]
    expect(pos(payment, 61, 80)).toBe('A'.repeat(20))
    expect(payment).toHaveLength(80)
  })

  it('preserves Swedish characters å ä ö in the payee name', () => {
    const payment = lines(generateBgLb(company, [{ ...anna, name: 'Åke Östberg' }], baseOptions).content)[2]
    expect(pos(payment, 61, 80).trimEnd()).toBe('Åke Östberg')
  })
})
