import { describe, it, expect } from 'vitest'
import { generatePain001 } from '../payment/pain001-generator'

describe('generatePain001', () => {
  const company = {
    name: 'Test AB',
    orgNumber: '556123-4567',
    iban: 'SE1234567890123456789012',
    bic: 'ESSESESS',
  }

  const employees = [
    { name: 'Anna Andersson', clearingNumber: '5678', bankAccountNumber: '1234567890', netSalary: 28000 },
    { name: 'Erik Eriksson', clearingNumber: '1234', bankAccountNumber: '9876543210', netSalary: 32000 },
  ]

  const options = {
    messageId: 'GNUBOK-5561234567-2026-04',
    paymentDate: '2026-04-25',
    periodLabel: '2026-04',
  }

  it('generates valid XML structure', () => {
    const xml = generatePain001(company, employees, options)

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('pain.001.001.03')
    expect(xml).toContain('<CstmrCdtTrfInitn>')
    expect(xml).toContain('</Document>')
  })

  it('includes group header with correct counts', () => {
    const xml = generatePain001(company, employees, options)

    expect(xml).toContain(`<NbOfTxs>2</NbOfTxs>`)
    expect(xml).toContain(`<CtrlSum>60000.00</CtrlSum>`)
  })

  it('includes company details', () => {
    const xml = generatePain001(company, employees, options)

    expect(xml).toContain('<Nm>Test AB</Nm>')
    expect(xml).toContain('ESSESESS')
  })

  it('identifies the debtor (company) by its own IBAN', () => {
    const xml = generatePain001(company, employees, options)

    // The payer is the company's IBAN, inside DbtrAcct.
    expect(xml).toContain('<IBAN>SE1234567890123456789012</IBAN>')
    // Employees are still domestic BBAN (clearing+account), never IBAN.
    expect(xml).toContain('<Othr><Id>56781234567890</Id></Othr>')
  })

  it('includes SALA category purpose for salary', () => {
    const xml = generatePain001(company, employees, options)
    expect(xml).toContain('<Cd>SALA</Cd>')
  })

  it('includes per-employee credit transfers', () => {
    const xml = generatePain001(company, employees, options)

    expect(xml).toContain('<Nm>Anna Andersson</Nm>')
    expect(xml).toContain('<InstdAmt Ccy="SEK">28000.00</InstdAmt>')
    expect(xml).toContain('<Nm>Erik Eriksson</Nm>')
    expect(xml).toContain('<InstdAmt Ccy="SEK">32000.00</InstdAmt>')
  })

  it('includes bank account details per employee', () => {
    const xml = generatePain001(company, employees, options)

    expect(xml).toContain('56781234567890')  // Anna's clearing + account
    expect(xml).toContain('12349876543210')  // Erik's clearing + account
  })

  it('includes remittance info with period label', () => {
    const xml = generatePain001(company, employees, options)
    expect(xml).toContain('Lon 2026-04')
  })

  it('includes payment date', () => {
    const xml = generatePain001(company, employees, options)
    expect(xml).toContain('<ReqdExctnDt>2026-04-25</ReqdExctnDt>')
  })

  it('escapes XML special characters', () => {
    const specialCompany = { ...company, name: 'Test & Sons <AB>' }
    const xml = generatePain001(specialCompany, employees, options)
    expect(xml).toContain('Test &amp; Sons &lt;AB&gt;')
    expect(xml).not.toContain('Test & Sons <AB>')
  })

  it('formats amounts with 2 decimal places', () => {
    const empWithDecimals = [
      { name: 'Test', clearingNumber: '1234', bankAccountNumber: '5678', netSalary: 28333.33 },
    ]
    const xml = generatePain001(company, empWithDecimals, options)
    expect(xml).toContain('28333.33')
  })
})
