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

  it('identifies the debtor (company) by its own IBAN and org number', () => {
    const xml = generatePain001(company, employees, options)

    // The payer is the company's IBAN, inside DbtrAcct.
    expect(xml).toContain('<IBAN>SE1234567890123456789012</IBAN>')
    // Org number digits on InitgPty and Dbtr.
    expect(xml).toContain('<Othr><Id>5561234567</Id></Othr>')
  })

  it('omits the org id blocks when the org number is missing', () => {
    const xml = generatePain001({ ...company, orgNumber: '' }, employees, options)
    expect(xml).not.toContain('<OrgId>')
  })

  it('marks the batch as salary with SALA and nothing else in PmtTpInf', () => {
    const xml = generatePain001(company, employees, options)
    expect(xml).toContain('<CtgyPurp><Cd>SALA</Cd></CtgyPurp>')
    // SvcLvl SEPA means an EUR SEPA credit transfer: never valid for domestic
    // SEK salaries. The element must be absent (banks default to NURG).
    expect(xml).not.toContain('<SvcLvl>')
    expect(xml).not.toContain('SEPA')
  })

  it('includes per-employee credit transfers', () => {
    const xml = generatePain001(company, employees, options)

    expect(xml).toContain('<Nm>Anna Andersson</Nm>')
    expect(xml).toContain('<InstdAmt Ccy="SEK">28000.00</InstdAmt>')
    expect(xml).toContain('<Nm>Erik Eriksson</Nm>')
    expect(xml).toContain('<InstdAmt Ccy="SEK">32000.00</InstdAmt>')
  })

  it('addresses employees with SESBA clearing + BBAN account without clearing', () => {
    const xml = generatePain001(company, employees, options)

    // Clearing goes in CdtrAgt as a SESBA clearing-system member id...
    expect(xml).toContain('<ClrSysId><Cd>SESBA</Cd></ClrSysId>')
    expect(xml).toContain('<MmbId>5678</MmbId>')
    expect(xml).toContain('<MmbId>1234</MmbId>')
    // ...and the account (WITHOUT clearing) in CdtrAcct with SchmeNm BBAN.
    expect(xml).toContain('<Id>1234567890</Id>')
    expect(xml).toContain('<Id>9876543210</Id>')
    expect(xml).toContain('<SchmeNm><Cd>BBAN</Cd></SchmeNm>')
    // The old concatenated clearing+account form must be gone.
    expect(xml).not.toContain('56781234567890')
    expect(xml).not.toContain('12349876543210')
  })

  it('places CdtrAgt before Cdtr within each transaction (XSD order)', () => {
    const xml = generatePain001(company, [employees[0]], options)
    const agtIndex = xml.indexOf('<CdtrAgt>')
    const cdtrIndex = xml.indexOf('<Cdtr>')
    expect(agtIndex).toBeGreaterThan(-1)
    expect(cdtrIndex).toBeGreaterThan(-1)
    expect(agtIndex).toBeLessThan(cdtrIndex)
  })

  it('splits a Swedbank 5-digit clearing the same way as the LB file', () => {
    const swedbankEmployee = [
      { name: 'Sara Svensson', clearingNumber: '83279', bankAccountNumber: '1234567890', netSalary: 30000 },
    ]
    const xml = generatePain001(company, swedbankEmployee, options)

    expect(xml).toContain('<MmbId>8327</MmbId>')
    expect(xml).toContain('<Id>91234567890</Id>')
  })

  it('strips the duplicated clearing prefix from a Nordea personkonto', () => {
    const personkontoEmployee = [
      { name: 'Nils Nilsson', clearingNumber: '1708', bankAccountNumber: '17082042825', netSalary: 25000 },
    ]
    const xml = generatePain001(company, personkontoEmployee, options)

    expect(xml).toContain('<MmbId>1708</MmbId>')
    expect(xml).toContain('<Id>2042825</Id>')
    expect(xml).not.toContain('<Id>17082042825</Id>')
  })

  it('throws on an invalid clearing number instead of emitting a broken file', () => {
    const badEmployee = [
      { name: 'Fel Felsson', clearingNumber: '123', bankAccountNumber: '1234567', netSalary: 20000 },
    ]
    expect(() => generatePain001(company, badEmployee, options)).toThrow('Ogiltigt clearingnummer')
  })

  it('omits remittance info entirely (not allowed for salary payments)', () => {
    const xml = generatePain001(company, employees, options)
    expect(xml).not.toContain('<RmtInf>')
    expect(xml).not.toContain('<Ustrd>')
  })

  it('keeps MsgId, PmtInfId and transaction ids within Max35Text', () => {
    const longOptions = {
      ...options,
      messageId: 'A-VERY-LONG-WHITELABEL-NAME-5561234567-2026-04',
    }
    const xml = generatePain001(company, employees, longOptions)

    const ids = [
      ...xml.matchAll(/<(MsgId|PmtInfId|InstrId|EndToEndId)>([^<]+)<\/\1>/g),
    ].map((m) => m[2])
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) {
      expect(id.length).toBeLessThanOrEqual(35)
    }
    // The per-transaction counter must survive truncation intact.
    expect(xml).toMatch(/<EndToEndId>[^<]*-TX0001<\/EndToEndId>/)
    expect(xml).toMatch(/<EndToEndId>[^<]*-TX0002<\/EndToEndId>/)
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
      { name: 'Test', clearingNumber: '1234', bankAccountNumber: '56789', netSalary: 28333.33 },
    ]
    const xml = generatePain001(company, empWithDecimals, options)
    expect(xml).toContain('28333.33')
  })
})
