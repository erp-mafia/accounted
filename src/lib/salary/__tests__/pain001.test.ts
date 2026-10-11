import { afterEach, describe, it, expect, vi } from 'vitest'
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
    expect(() => generatePain001(company, badEmployee, options)).toThrow(
      'Fel Felsson: clearingnumret är ogiltigt',
    )
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

/** The first <tag>...</tag> block of the file. */
function block(xml: string, tag: string): string {
  const start = xml.indexOf(`<${tag}>`)
  const end = xml.indexOf(`</${tag}>`, start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return xml.slice(start, end + tag.length + 3)
}

/** Every <tag>...</tag> block of the file, in order. */
function blocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'))].map((m) => m[0])
}

// Swedbank's file service validates uploads against its MIG 2.0 (crm#1117):
// the shapes below follow Swedbank's own "Salaries example.xml".
describe('generatePain001 for a Swedbank debtor (MIG 2.0)', () => {
  const swedbankCompany = {
    name: "Kalle's Bygg AB",
    orgNumber: '556123-4567',
    iban: 'SE4580000832790000012345',
    bic: 'SWEDSESS',
    city: 'Uppsala',
    swedbank: { signerId: '260637712ORI0003', corporatePayId: '260637712CPO0001' },
  }
  const swedbankEmployees = [
    { name: 'Anna Andersson', clearingNumber: '5678', bankAccountNumber: '1234567890', netSalary: 28000, city: 'Arboga' },
    { name: 'Karl Karlsson', clearingNumber: '8911-2', bankAccountNumber: '4245210', netSalary: 35550, city: null },
  ]
  // Payday Monday 27 April 2026.
  const swedbankOptions = { messageId: 'ACCOUNTED-5561234567-2026-04', paymentDate: '2026-04-27', periodLabel: '2026-04' }

  it('identifies the sender by the SignerID with SchmeNm BANK, never the org number', () => {
    const xml = generatePain001(swedbankCompany, swedbankEmployees, swedbankOptions)
    expect(block(xml, 'InitgPty')).toContain(
      '<Othr><Id>260637712ORI0003</Id><SchmeNm><Cd>BANK</Cd></SchmeNm></Othr>',
    )
    expect(xml).not.toContain('5561234567</Id>')
  })

  it('identifies the agreement by the Corporate Pay id after a postal address in Dbtr', () => {
    const dbtr = block(generatePain001(swedbankCompany, swedbankEmployees, swedbankOptions), 'Dbtr')
    expect(dbtr).toContain('<PstlAdr>')
    expect(dbtr).toContain('<TwnNm>Uppsala</TwnNm>')
    expect(dbtr).toContain('<Ctry>SE</Ctry>')
    expect(dbtr).toContain('<Othr><Id>260637712CPO0001</Id><SchmeNm><Cd>BANK</Cd></SchmeNm></Othr>')
    // XSD order: Nm, PstlAdr, Id.
    expect(dbtr.indexOf('<Nm>')).toBeLessThan(dbtr.indexOf('<PstlAdr>'))
    expect(dbtr.indexOf('<PstlAdr>')).toBeLessThan(dbtr.indexOf('<Id>'))
  })

  it('writes a country-only debtor address when the company town is unknown', () => {
    const dbtr = block(generatePain001({ ...swedbankCompany, city: null }, swedbankEmployees, swedbankOptions), 'Dbtr')
    expect(dbtr).toContain('<PstlAdr>')
    expect(dbtr).not.toContain('<TwnNm>')
    expect(dbtr).toContain('<Ctry>SE</Ctry>')
  })

  it('states service level NURG before category purpose SALA', () => {
    const pmtTpInf = block(generatePain001(swedbankCompany, swedbankEmployees, swedbankOptions), 'PmtTpInf')
    expect(pmtTpInf).toContain('<SvcLvl><Cd>NURG</Cd></SvcLvl>')
    expect(pmtTpInf).toContain('<CtgyPurp><Cd>SALA</Cd></CtgyPurp>')
    expect(pmtTpInf.indexOf('<SvcLvl>')).toBeLessThan(pmtTpInf.indexOf('<CtgyPurp>'))
  })

  it('asks for the banking day before payday, the day Swedbank debits', () => {
    // Monday payday: Swedbank debits on Friday and the salary arrives Monday.
    expect(generatePain001(swedbankCompany, swedbankEmployees, swedbankOptions)).toContain(
      '<ReqdExctnDt>2026-04-24</ReqdExctnDt>',
    )
    // Tuesday after Easter: annandag påsk, the weekend and långfredagen are skipped.
    expect(
      generatePain001(swedbankCompany, swedbankEmployees, { ...swedbankOptions, paymentDate: '2026-04-07' }),
    ).toContain('<ReqdExctnDt>2026-04-02</ReqdExctnDt>')
  })

  it('names Swedbank by SWEDSESS with country SE as the debtor agent', () => {
    const xml = generatePain001({ ...swedbankCompany, bic: 'swedsessxxx' }, swedbankEmployees, swedbankOptions)
    const dbtrAgt = block(xml, 'DbtrAgt')
    expect(dbtrAgt).toContain('<BIC>SWEDSESS</BIC>')
    expect(dbtrAgt).toContain('<PstlAdr><Ctry>SE</Ctry></PstlAdr>')
    expect(xml).not.toContain('swedsessxxx')
  })

  it('writes an 8xxxx clearing as MmbId 8CCCC and a 15-digit BBAN, a 4-digit clearing separately', () => {
    const txs = blocks(generatePain001(swedbankCompany, swedbankEmployees, swedbankOptions), 'CdtTrfTxInf')
    expect(txs).toHaveLength(2)
    expect(txs[0]).toContain('<MmbId>5678</MmbId>')
    expect(txs[0]).toContain('<Id>1234567890</Id>')
    // Swedbank's own example: clearing 8911-2, account 424 521-0.
    expect(txs[1]).toContain('<MmbId>89112</MmbId>')
    expect(txs[1]).toContain('<Id>891120004245210</Id>')
  })

  it('derives the fifth digit of an 8xxx clearing stored with four', () => {
    const tx = block(
      generatePain001(
        swedbankCompany,
        [{ name: 'Sara Svensson', clearingNumber: '8901', bankAccountNumber: '9146168423', netSalary: 30000 }],
        swedbankOptions,
      ),
      'CdtTrfTxInf',
    )
    // Swedbank's Validex example: 8901-1, 914 616 842-3.
    expect(tx).toContain('<MmbId>89011</MmbId>')
    expect(tx).toContain('<Id>890119146168423</Id>')
  })

  it('gives every employee a postal address, with the town when known', () => {
    const cdtrs = blocks(generatePain001(swedbankCompany, swedbankEmployees, swedbankOptions), 'Cdtr')
    expect(cdtrs[0]).toContain('<TwnNm>Arboga</TwnNm>')
    expect(cdtrs[0]).toContain('<Ctry>SE</Ctry>')
    expect(cdtrs[0].indexOf('<Nm>')).toBeLessThan(cdtrs[0].indexOf('<PstlAdr>'))
    expect(cdtrs[1]).not.toContain('<TwnNm>')
    expect(cdtrs[1]).toContain('<Ctry>SE</Ctry>')
  })

  it('keeps names to the MIG 2.0 character set, which has no apostrophe', () => {
    const xml = generatePain001(swedbankCompany, swedbankEmployees, swedbankOptions)
    expect(block(xml, 'InitgPty')).toContain('<Nm>Kalles Bygg AB</Nm>')
    expect(block(xml, 'Dbtr')).toContain('<Nm>Kalles Bygg AB</Nm>')
    expect(xml).not.toContain('&apos;')
  })

  it('carries no remittance information and no purpose code', () => {
    const xml = generatePain001(swedbankCompany, swedbankEmployees, swedbankOptions)
    expect(xml).not.toContain('<RmtInf>')
    expect(xml).not.toContain('<Purp>')
  })

  it('keeps the PmtInf elements in XSD order', () => {
    const pmtInf = block(generatePain001(swedbankCompany, swedbankEmployees, swedbankOptions), 'PmtInf')
    const order = ['<PmtTpInf>', '<ReqdExctnDt>', '<Dbtr>', '<DbtrAcct>', '<DbtrAgt>', '<CdtTrfTxInf>']
    const positions = order.map((tag) => pmtInf.indexOf(tag))
    expect(positions.every((p) => p > -1)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })
})

describe('generatePain001 for every other bank', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ignores town and Swedbank fields without Swedbank ids: the file is unchanged', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-20T08:00:00Z'))
    const company = { name: "Kalle's Bygg AB", orgNumber: '556123-4567', iban: 'SE1234567890123456789012', bic: 'ESSESESS' }
    const employees = [
      { name: 'Anna Andersson', clearingNumber: '5678', bankAccountNumber: '1234567890', netSalary: 28000 },
      { name: 'Sara Svensson', clearingNumber: '83279', bankAccountNumber: '1234567890', netSalary: 30000 },
    ]
    const options = { messageId: 'ACCOUNTED-5561234567-2026-04', paymentDate: '2026-04-27', periodLabel: '2026-04' }

    const plain = generatePain001(company, employees, options)
    const withExtras = generatePain001(
      { ...company, city: 'Uppsala', swedbank: null },
      employees.map((e) => ({ ...e, city: 'Arboga' })),
      options,
    )

    expect(withExtras).toBe(plain)
    expect(plain).toContain('<ReqdExctnDt>2026-04-27</ReqdExctnDt>')
    expect(plain).not.toContain('<PstlAdr>')
    expect(plain).not.toContain('<SvcLvl>')
    expect(plain).toContain('<Nm>Kalle&apos;s Bygg AB</Nm>')
  })
})
