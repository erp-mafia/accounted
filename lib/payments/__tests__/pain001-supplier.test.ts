import { describe, expect, it } from 'vitest'
import {
  generateSupplierPain001,
  type SupplierPain001Payment,
} from '@/lib/payments/pain001-supplier'

const debtor = {
  name: 'Testbolaget AB',
  orgNumber: '556677-8899',
  iban: 'SE3550000000054910000003',
  bic: 'ESSESESS',
}

const options = {
  messageId: 'ACCOUNTED-5566778899-B1A2B3C4D',
  createdAt: '2026-08-10T12:34:56.789Z',
}

function bgPayment(overrides: Partial<SupplierPain001Payment> = {}): SupplierPain001Payment {
  return {
    payee: { type: 'bankgiro', bankgiro: '50501055' },
    payeeName: 'Derome Bygg & Industri AB',
    amount: 737.5,
    paymentDate: '2026-08-15',
    reference: { type: 'ocr', value: '12345678' },
    ...overrides,
  }
}

describe('generateSupplierPain001', () => {
  it('is byte-identical for identical inputs (deterministic regeneration)', () => {
    const a = generateSupplierPain001(debtor, [bgPayment()], options)
    const b = generateSupplierPain001(debtor, [bgPayment()], options)
    expect(a).toBe(b)
  })

  it('derives CreDtTm from createdAt, never the clock', () => {
    const xml = generateSupplierPain001(debtor, [bgPayment()], options)
    expect(xml).toContain('<CreDtTm>2026-08-10T12:34:56Z</CreDtTm>')
  })

  it('carries no SvcLvl and no CtgyPurp (domestic NURG supplier transfer)', () => {
    const xml = generateSupplierPain001(debtor, [bgPayment()], options)
    expect(xml).not.toContain('<SvcLvl>')
    expect(xml).not.toContain('<CtgyPurp>')
  })

  it('addresses a bankgiro payee through Bankgirot (SESBA 9900, BGNR proprietary scheme)', () => {
    const xml = generateSupplierPain001(debtor, [bgPayment()], options)
    expect(xml).toContain('<ClrSysId><Cd>SESBA</Cd></ClrSysId>')
    expect(xml).toContain('<MmbId>9900</MmbId>')
    expect(xml).toContain('<Id>50501055</Id>')
    expect(xml).toContain('<SchmeNm><Prtry>BGNR</Prtry></SchmeNm>')
  })

  it('addresses a plusgiro payee via SESBA 9960 with BBAN scheme', () => {
    const xml = generateSupplierPain001(
      debtor,
      [bgPayment({ payee: { type: 'plusgiro', plusgiro: '1234567' } })],
      options,
    )
    expect(xml).toContain('<MmbId>9960</MmbId>')
    expect(xml).toContain('<Id>1234567</Id>')
    expect(xml).toContain('<SchmeNm><Cd>BBAN</Cd></SchmeNm>')
  })

  it('addresses a bank-account payee via its clearing with the salary routing rules', () => {
    const xml = generateSupplierPain001(
      debtor,
      [
        bgPayment({
          // Swedbank 5-digit clearing: 5th digit shifts into the account.
          payee: { type: 'bank_account', clearing: '83279', account: '123456789' },
        }),
      ],
      options,
    )
    expect(xml).toContain('<MmbId>8327</MmbId>')
    expect(xml).toContain('<Id>9123456789</Id>')
    expect(xml).toContain('<SchmeNm><Cd>BBAN</Cd></SchmeNm>')
  })

  it('renders exactly one structured SCOR reference with the remitted amount', () => {
    const xml = generateSupplierPain001(debtor, [bgPayment()], options)
    expect(xml.match(/<CdtrRefInf>/g)).toHaveLength(1)
    expect(xml).toContain('<CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry>')
    expect(xml).toContain('<Ref>12345678</Ref>')
    // Swedbank MIG (Validex PFH_217): Strd must carry RfrdDocAmt.
    expect(xml).toContain('<RmtdAmt Ccy="SEK">737.50</RmtdAmt>')
    expect(xml.indexOf('<RfrdDocAmt>')).toBeLessThan(xml.indexOf('<CdtrRefInf>'))
    expect(xml).not.toContain('<Ustrd>')
  })

  it('always carries the creditor postal country and the initiator OrgId', () => {
    const xml = generateSupplierPain001(debtor, [bgPayment()], options)
    // Swedbank MIG rules 020/237 and 002 (Validex run 2026-08-10).
    expect(xml).toContain('<PstlAdr>')
    expect(xml).toContain('<Ctry>SE</Ctry>')
    expect(xml.match(/<OrgId>/g)!.length).toBeGreaterThanOrEqual(2)
    expect(xml).toContain('<Othr><Id>5566778899</Id></Othr>')
  })

  it('refuses a debtor without an organisation number', () => {
    expect(() =>
      generateSupplierPain001({ ...debtor, orgNumber: '' }, [bgPayment()], options),
    ).toThrow(/Organisationsnummer/)
  })

  it('debits the company bankgiro for bankgiro payees and the IBAN for others', () => {
    const xml = generateSupplierPain001(
      { ...debtor, bankgiro: '9912346' },
      [
        bgPayment(),
        bgPayment({ payee: { type: 'plusgiro', plusgiro: '1234567' }, amount: 100 }),
      ],
      options,
    )
    // Same date, two debit forms -> two PmtInf groups (Swedbank rule 219:
    // BGNR creditors debit the bankgiro; the plusgiro payment debits the IBAN).
    expect(xml.match(/<PmtInf>/g)).toHaveLength(2)
    const debtorAccounts = xml.match(/<DbtrAcct>[\s\S]*?<\/DbtrAcct>/g) ?? []
    expect(debtorAccounts).toHaveLength(2)
    expect(debtorAccounts.filter((block) => block.includes('BGNR'))).toHaveLength(1)
    expect(debtorAccounts.find((block) => block.includes('BGNR'))).toContain(
      '<Id>9912346</Id>',
    )
    expect(debtorAccounts.filter((block) => block.includes(debtor.iban))).toHaveLength(1)
  })

  it('keeps everything on the IBAN when the company has no bankgiro', () => {
    const xml = generateSupplierPain001(debtor, [bgPayment()], options)
    const debtorAccounts = xml.match(/<DbtrAcct>[\s\S]*?<\/DbtrAcct>/g) ?? []
    expect(debtorAccounts).toHaveLength(1)
    expect(debtorAccounts[0]).toContain(`<IBAN>${debtor.iban}</IBAN>`)
    expect(debtorAccounts[0]).not.toContain('BGNR')
  })

  it('carries the creditor address on the BGNR path too (rule 237 is absolute)', () => {
    const xml = generateSupplierPain001(
      { ...debtor, bankgiro: '9912346' },
      [bgPayment({ payeeCity: 'Veddige' })],
      options,
    )
    const creditor = xml.match(/<Cdtr>[\s\S]*?<\/Cdtr>/)![0]
    expect(creditor).toContain('<TwnNm>Veddige</TwnNm>')
    expect(creditor).toContain('<Ctry>SE</Ctry>')
  })

  it('carries the supplier town on IBAN-debited payments when known', () => {
    const xml = generateSupplierPain001(
      debtor,
      [bgPayment({ payeeCity: 'Göteborg' })],
      options,
    )
    const creditor = xml.match(/<Cdtr>[\s\S]*?<\/Cdtr>/)![0]
    expect(creditor).toContain('<TwnNm>Göteborg</TwnNm>')
    expect(creditor.indexOf('<TwnNm>')).toBeLessThan(creditor.indexOf('<Ctry>'))
  })

  it('carries the company town on the debtor when known', () => {
    const xml = generateSupplierPain001(
      { ...debtor, city: 'Stockholm' },
      [bgPayment()],
      options,
    )
    const debtorBlock = xml.match(/<Dbtr>[\s\S]*?<\/Dbtr>/)![0]
    expect(debtorBlock).toContain('<TwnNm>Stockholm</TwnNm>')
    expect(debtorBlock.indexOf('<PstlAdr>')).toBeLessThan(debtorBlock.indexOf('<Id>'))
  })

  it('transliterates disallowed characters in names (MIG character set)', () => {
    const xml = generateSupplierPain001(
      debtor,
      [bgPayment({ payeeName: 'Demokafé & Crème AB' })],
      options,
    )
    expect(xml).toContain('<Nm>Demokafe + Creme AB</Nm>')
  })

  it('folds decomposed Unicode before transliterating', () => {
    // 'e' + combining acute (U+0301) and 'a' + combining ring (U+030A):
    // NFC folds them to é and å, which then map per the MIG set.
    const xml = generateSupplierPain001(
      debtor,
      [bgPayment({ payeeName: 'Café Ångby' })],
      options,
    )
    expect(xml).toContain('<Nm>Cafe Ångby</Nm>')
  })

  it('renders an invoice-number reference as unstructured text, truncated to 25 chars', () => {
    const xml = generateSupplierPain001(
      debtor,
      [
        bgPayment({
          reference: { type: 'invoice_number', value: 'F-12345678901234567890123456789' },
        }),
      ],
      options,
    )
    expect(xml).toContain('<Ustrd>F-12345678901234567890123</Ustrd>')
    expect(xml).not.toContain('<Strd>')
  })

  it('groups payments into one PmtInf per distinct execution date, dates ascending', () => {
    const xml = generateSupplierPain001(
      debtor,
      [
        bgPayment({ paymentDate: '2026-08-20', amount: 100 }),
        bgPayment({ paymentDate: '2026-08-15', amount: 200 }),
        bgPayment({ paymentDate: '2026-08-20', amount: 300 }),
      ],
      options,
    )
    expect(xml.match(/<PmtInf>/g)).toHaveLength(2)
    const first15 = xml.indexOf('<ReqdExctnDt>2026-08-15</ReqdExctnDt>')
    const first20 = xml.indexOf('<ReqdExctnDt>2026-08-20</ReqdExctnDt>')
    expect(first15).toBeGreaterThan(-1)
    expect(first20).toBeGreaterThan(first15)
    // Group control sums: 200.00 for the 15th, 400.00 for the 20th, 600.00 total.
    expect(xml).toContain('<CtrlSum>600.00</CtrlSum>')
    expect(xml).toContain('<CtrlSum>200.00</CtrlSum>')
    expect(xml).toContain('<CtrlSum>400.00</CtrlSum>')
    // The tx counter runs across groups so ids stay unique file-wide.
    expect(xml).toContain('-TX0001')
    expect(xml).toContain('-TX0002')
    expect(xml).toContain('-TX0003')
    expect(xml.match(/<PmtInfId>[^<]*-P1<\/PmtInfId>/)).not.toBeNull()
    expect(xml.match(/<PmtInfId>[^<]*-P2<\/PmtInfId>/)).not.toBeNull()
  })

  it('maps ampersands to + per the MIG character set (Swedish å ä ö survive)', () => {
    const xml = generateSupplierPain001(
      debtor,
      [bgPayment({ payeeName: 'Derome Bygg & Industri Åängö AB' })],
      options,
    )
    expect(xml).toContain('<Nm>Derome Bygg + Industri Åängö AB</Nm>')
  })

  it('keeps all ids within Max35Text with the suffix intact', () => {
    const xml = generateSupplierPain001(
      debtor,
      [bgPayment()],
      { ...options, messageId: 'X'.repeat(60) },
    )
    const ids = [...xml.matchAll(/<(MsgId|PmtInfId|InstrId|EndToEndId)>([^<]+)<\/\1>/g)].map(
      (m) => m[2],
    )
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(35)
    expect(xml).toContain('-TX0001</InstrId>')
  })

  it('formats amounts with two decimals and a dot separator', () => {
    const xml = generateSupplierPain001(debtor, [bgPayment({ amount: 199.291 })], options)
    expect(xml).toContain('<InstdAmt Ccy="SEK">199.29</InstdAmt>')
  })

  it('control sums equal the sum of the rendered amounts, not the raw floats', () => {
    // Raw floats: 0.014 + 0.014 = 0.028 -> rounded once = 0.03, but each
    // InstdAmt renders as 0.01. Banks reject CtrlSum != sum(InstdAmt).
    const xml = generateSupplierPain001(
      debtor,
      [bgPayment({ amount: 0.014 }), bgPayment({ amount: 0.014 })],
      options,
    )
    expect(xml.match(/<InstdAmt Ccy="SEK">0\.01<\/InstdAmt>/g)).toHaveLength(2)
    expect(xml).toContain('<CtrlSum>0.02</CtrlSum>')
    expect(xml).not.toContain('<CtrlSum>0.03</CtrlSum>')
  })

  it('refuses an empty batch', () => {
    expect(() => generateSupplierPain001(debtor, [], options)).toThrow()
  })
})
