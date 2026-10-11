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

// ============================================================
// The debit account for a bankgiro payee follows the debtor's bank
// ============================================================

/** Minimal element tree for structure assertions: names, order and leaf text. */
interface XmlNode {
  name: string
  children: XmlNode[]
  text: string
}

function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#document', children: [], text: '' }
  const stack: XmlNode[] = [root]
  for (const match of xml.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([A-Za-z][\w.:-]*)[^>]*>|([^<]+)/g)) {
    const top = stack[stack.length - 1]
    if (match[3] !== undefined) {
      top.text += match[3].trim()
    } else if (match[1]) {
      if (top.name !== match[2]) throw new Error(`</${match[2]}> closes <${top.name}>`)
      stack.pop()
    } else {
      const node: XmlNode = { name: match[2], children: [], text: '' }
      top.children.push(node)
      stack.push(node)
    }
  }
  if (stack.length !== 1) throw new Error(`unclosed <${stack[stack.length - 1].name}>`)
  return root
}

function findAll(node: XmlNode, name: string): XmlNode[] {
  const own = node.name === name ? [node] : []
  return own.concat(node.children.flatMap((child) => findAll(child, name)))
}

function childNames(node: XmlNode): string[] {
  return node.children.map((child) => child.name)
}

/** Element names only, nested: "DbtrAcct(Id(IBAN),Ccy)". */
function shape(node: XmlNode): string {
  return node.children.length === 0 ? node.name : `${node.name}(${node.children.map(shape).join(',')})`
}

function debtorAccounts(xml: string): string[] {
  return xml.match(/<DbtrAcct>[\s\S]*?<\/DbtrAcct>/g) ?? []
}

const IBAN_DEBIT = 'DbtrAcct(Id(IBAN),Ccy)'
const BANKGIRO_DEBIT = 'DbtrAcct(Id(Othr(Id,SchmeNm(Prtry))),Ccy)'

// The debtor account of Danske Bank's own Swedish samples (Examples v5.3, 2026-08-18).
const danske = {
  name: 'Testbolaget AB',
  orgNumber: '556677-8899',
  iban: 'SE7212000000012200111878',
  bic: 'DABASESX',
  bankgiro: '9912346',
}

const plusgiroPayee = { type: 'plusgiro', plusgiro: '1234567' } as const
const bankAccountPayee = { type: 'bank_account', clearing: '83279', account: '123456789' } as const

/** Bankgiro, plusgiro and bank account on the 15th, one more bankgiro on the 20th. */
function mixedBatch(): SupplierPain001Payment[] {
  return [
    bgPayment({ amount: 100 }),
    bgPayment({ payee: plusgiroPayee, amount: 200 }),
    bgPayment({ payee: bankAccountPayee, amount: 300 }),
    bgPayment({ amount: 400, paymentDate: '2026-08-20' }),
  ]
}

describe('debit account for bankgiro payees follows the debtor bank', () => {
  it('Danske Bank: a bankgiro payee is debited from the IBAN, with DbtrAgt BIC DABASESX', () => {
    const xml = generateSupplierPain001(danske, [bgPayment()], options)

    const accounts = debtorAccounts(xml)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toContain(`<IBAN>${danske.iban}</IBAN>`)
    expect(accounts[0]).not.toContain('BGNR')
    // The company bankgiro appears nowhere in the file.
    expect(xml).not.toContain(danske.bankgiro)
    expect(xml.match(/<DbtrAgt>[\s\S]*?<\/DbtrAgt>/)![0]).toContain('<BIC>DABASESX</BIC>')
    // The payee is still addressed as a bankgiro number.
    expect(xml.match(/<CdtrAcct>[\s\S]*?<\/CdtrAcct>/)![0]).toContain(
      '<SchmeNm><Prtry>BGNR</Prtry></SchmeNm>',
    )
  })

  it('Danske Bank: the file is the one a blanked company bankgiro produces (the manual workaround)', () => {
    const withBankgiro = generateSupplierPain001(danske, mixedBatch(), options)
    const blanked = generateSupplierPain001({ ...danske, bankgiro: null }, mixedBatch(), options)
    expect(withBankgiro).toBe(blanked)
  })

  it('Danske Bank: a mixed batch is one PmtInf per date, every payee debited from the IBAN', () => {
    const doc = parseXml(generateSupplierPain001(danske, mixedBatch(), options))
    const groups = findAll(doc, 'PmtInf')

    expect(groups.map((g) => findAll(g, 'ReqdExctnDt')[0].text)).toEqual(['2026-08-15', '2026-08-20'])
    expect(groups.map((g) => shape(findAll(g, 'DbtrAcct')[0]))).toEqual([IBAN_DEBIT, IBAN_DEBIT])
    expect(findAll(doc, 'IBAN').map((n) => n.text)).toEqual([danske.iban, danske.iban])
    // Batch order survives inside the group: bankgiro, plusgiro, bank account.
    expect(groups.map((g) => findAll(g, 'MmbId').map((n) => n.text))).toEqual([
      ['9900', '9960', '8327'],
      ['9900'],
    ])
    expect(groups.map((g) => g.children.find((c) => c.name === 'NbOfTxs')!.text)).toEqual(['3', '1'])
    expect(groups.map((g) => g.children.find((c) => c.name === 'CtrlSum')!.text)).toEqual(['600.00', '400.00'])
    expect(findAll(doc, 'GrpHdr')[0].children.find((c) => c.name === 'CtrlSum')!.text).toBe('1000.00')
  })

  it('Swedbank is unchanged: bankgiro payees debit the company bankgiro in their own PmtInf', () => {
    const doc = parseXml(generateSupplierPain001({ ...danske, bic: 'SWEDSESS' }, mixedBatch(), options))
    const groups = findAll(doc, 'PmtInf')

    // (15th, IBAN), (15th, bankgiro), (20th, bankgiro): sorted by date, then form.
    expect(groups.map((g) => shape(findAll(g, 'DbtrAcct')[0]))).toEqual([
      IBAN_DEBIT,
      BANKGIRO_DEBIT,
      BANKGIRO_DEBIT,
    ])
    expect(groups.map((g) => findAll(g, 'MmbId').map((n) => n.text))).toEqual([
      ['9960', '8327'],
      ['9900'],
      ['9900'],
    ])
    const bankgiroDebtor = findAll(groups[1], 'DbtrAcct')[0]
    expect(findAll(bankgiroDebtor, 'Id')[1].text).toBe('9912346')
    expect(findAll(bankgiroDebtor, 'Prtry')[0].text).toBe('BGNR')
  })

  it.each(['DABASESXXXX', 'dabasesx', ' DABASESX ', 'dabasesxxxx', 'DABA SESX', '\tDabaSesx\n'])(
    'reads Danske Bank from the BIC however it is written: %j',
    (bic) => {
      const accounts = debtorAccounts(generateSupplierPain001({ ...danske, bic }, [bgPayment()], options))
      expect(accounts).toHaveLength(1)
      expect(accounts[0]).toContain(`<IBAN>${danske.iban}</IBAN>`)
      expect(accounts[0]).not.toContain('BGNR')
    },
  )

  // Nordea, Corporate Access Payables Appendix Sweden (2026-10-08) s. 2.3.4:
  // "Bankgiro number is not to be used as a debtors account."
  it.each(['NDEASESS', 'NDEASESSXXX', 'ndeasess', ' NDEASESS '])(
    'Nordea: a bankgiro payee is debited from the IBAN, BIC written as %j',
    (bic) => {
      const xml = generateSupplierPain001({ ...danske, bic }, mixedBatch(), options)
      const accounts = debtorAccounts(xml)
      // One PmtInf per date, each debited from the IBAN.
      expect(accounts).toHaveLength(2)
      for (const account of accounts) {
        expect(account).toContain(`<IBAN>${danske.iban}</IBAN>`)
        expect(account).not.toContain('BGNR')
      }
      expect(xml).not.toContain(danske.bankgiro)
      // Same file as the one a blanked company bankgiro produces.
      expect(xml).toBe(generateSupplierPain001({ ...danske, bic, bankgiro: null }, mixedBatch(), options))
    },
  )

  it.each([
    ['SEB', 'ESSESESS'],
    ['SEB, 11 characters', 'ESSESESSXXX'],
    ['Handelsbanken', 'HANDSESS'],
    ['Nordea in Finland', 'NDEAFIHH'],
    ['Svea Bank', 'SVEASESS'],
    ['Länsförsäkringar Bank', 'ELLFSESS'],
    ['a bank nobody has looked at', 'XXXXSESS'],
    ['Danske Bank in Denmark', 'DABADKKK'],
    ['a BIC too short to name a bank', 'DABA'],
    ['no BIC at all', ''],
  ])('%s keeps the bankgiro debit: no other bank changes', (_bank, bic) => {
    const accounts = debtorAccounts(generateSupplierPain001({ ...danske, bic }, [bgPayment()], options))
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toContain('<Id>9912346</Id>')
    expect(accounts[0]).toContain('<SchmeNm><Prtry>BGNR</Prtry></SchmeNm>')
  })
})

/**
 * Danske Bank Message Implementation Guide, "Supported payment types and
 * examples", version 5.3 (2026-08-18): the samples "Swedish Bankgiro payment -
 * OCR reference" and "Swedish account transfer with Bankgiro Alias -
 * structured reference (reference)" share the element structure transcribed
 * here. Element order is fixed by the pain.001.001.03 schema.
 */
describe('Danske Bank bankgiro payment: structure against the bank sample', () => {
  const SAMPLE_PMTINF = [
    'PmtInfId', 'PmtMtd', 'PmtTpInf', 'ReqdExctnDt', 'Dbtr', 'DbtrAcct', 'DbtrAgt', 'CdtTrfTxInf',
  ]
  const SAMPLE_CDTTRFTXINF = ['PmtId', 'Amt', 'CdtrAgt', 'Cdtr', 'CdtrAcct', 'RmtInf']

  const doc = parseXml(
    generateSupplierPain001({ ...danske, city: 'Stockholm' }, [bgPayment({ payeeCity: 'Solna' })], options),
  )
  const pmtInf = findAll(doc, 'PmtInf')[0]
  const tx = findAll(doc, 'CdtTrfTxInf')[0]

  it('states the debtor account and agent as the sample does, in the sample order', () => {
    const ours = childNames(pmtInf)
    // Our PmtInf, in pain.001.001.03 schema order (BtchBookg, NbOfTxs and CtrlSum are optional extras).
    expect(ours).toEqual([
      'PmtInfId', 'PmtMtd', 'BtchBookg', 'NbOfTxs', 'CtrlSum', 'ReqdExctnDt',
      'Dbtr', 'DbtrAcct', 'DbtrAgt', 'CdtTrfTxInf',
    ])
    // Every element of the sample, in the sample's order, except PmtTpInf
    // (SvcLvl NURG): the generator omits it at every bank. That is a known
    // difference from Danske's samples, not something this test clears.
    expect(ours.filter((name) => SAMPLE_PMTINF.includes(name))).toEqual(
      SAMPLE_PMTINF.filter((name) => name !== 'PmtTpInf'),
    )

    const dbtrAcct = pmtInf.children.find((c) => c.name === 'DbtrAcct')!
    expect(shape(dbtrAcct)).toBe(IBAN_DEBIT)
    expect(findAll(dbtrAcct, 'IBAN')[0].text).toBe(danske.iban)
    expect(findAll(dbtrAcct, 'Ccy')[0].text).toBe('SEK')

    // The sample adds FinInstnId/PstlAdr/Ctry after the BIC; the BIC is what the guide requires.
    const dbtrAgt = pmtInf.children.find((c) => c.name === 'DbtrAgt')!
    expect(shape(dbtrAgt)).toBe('DbtrAgt(FinInstnId(BIC))')
    expect(findAll(dbtrAgt, 'BIC')[0].text).toBe('DABASESX')
  })

  it('addresses the bankgiro payee and its OCR reference as the sample does', () => {
    expect(childNames(tx)).toEqual(SAMPLE_CDTTRFTXINF)

    const cdtrAcct = tx.children.find((c) => c.name === 'CdtrAcct')!
    expect(shape(cdtrAcct)).toBe('CdtrAcct(Id(Othr(Id,SchmeNm(Prtry))))')
    expect(findAll(cdtrAcct, 'Prtry')[0].text).toBe('BGNR')
    expect(findAll(cdtrAcct, 'Id')[1].text).toBe('50501055')

    const strd = findAll(tx, 'Strd')[0]
    const cdtrRefInf = strd.children.find((c) => c.name === 'CdtrRefInf')!
    expect(shape(cdtrRefInf)).toBe('CdtrRefInf(Tp(CdOrPrtry(Cd)),Ref)')
    expect(findAll(cdtrRefInf, 'Cd')[0].text).toBe('SCOR')
    expect(findAll(cdtrRefInf, 'Ref')[0].text).toBe('12345678')
    // The generator also states RfrdDocAmt (Swedbank rule 217); the schema puts it before CdtrRefInf.
    expect(childNames(strd)).toEqual(['RfrdDocAmt', 'CdtrRefInf'])
  })
})
