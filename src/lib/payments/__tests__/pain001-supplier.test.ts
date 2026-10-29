import { createHash } from 'node:crypto'
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

/** CdtrAgt member id and CdtrAcct Othr/Id of every credit transfer, in file order. */
function creditorRouting(xml: string): Array<{ memberId: string; accountId: string; scheme: string }> {
  return [...xml.matchAll(/<CdtTrfTxInf>[\s\S]*?<\/CdtTrfTxInf>/g)].map(([tx]) => ({
    memberId: tx.match(/<MmbId>([^<]+)<\/MmbId>/)![1],
    accountId: tx.match(/<CdtrAcct>\s*<Id>\s*<Othr>\s*<Id>([^<]+)<\/Id>/)![1],
    scheme: tx.match(/<CdtrAcct>[\s\S]*?<SchmeNm>([\s\S]*?)<\/SchmeNm>/)![1],
  }))
}

// crm#1218: Danske Bank reads a domestic payee from CdtrAcct alone (MIG v3.6,
// 2.80; Appendix C: no ClrSysMmbId for Sweden), Nordea wants the clearing in
// the BBAN (Appendix Sweden 2026-10-08, s. 2.3.5). Invented accounts.
describe('bank-account payee follows the debtor bank: clearing inside the BBAN at Danske Bank and Nordea', () => {
  const accounts = [
    { type: 'bank_account', clearing: '1344', account: '2045678' },
    { type: 'bank_account', clearing: '6000', account: '123456789' },
    { type: 'bank_account', clearing: '3300', account: '8001011234' },
    { type: 'bank_account', clearing: '83279', account: '123456789' },
  ] as const

  it.each(['DABASESX', 'NDEASESS', 'ndeasessxxx'])('%s: clearing + account in CdtrAcct, the clearing kept in CdtrAgt', (bic) => {
    const xml = generateSupplierPain001(
      { ...danske, bic },
      accounts.map((payee) => bgPayment({ payee })),
      options,
    )
    expect(creditorRouting(xml)).toEqual([
      { memberId: '1344', accountId: '13442045678', scheme: '<Cd>BBAN</Cd>' },
      { memberId: '6000', accountId: '6000123456789', scheme: '<Cd>BBAN</Cd>' },
      { memberId: '3300', accountId: '33008001011234', scheme: '<Cd>BBAN</Cd>' },
      { memberId: '8327', accountId: '832790123456789', scheme: '<Cd>BBAN</Cd>' },
    ])
  })

  it.each(['DABASESX', 'NDEASESS'])('%s: bankgiro and plusgiro payees are unchanged in the same file', (bic) => {
    const xml = generateSupplierPain001({ ...danske, bic }, mixedBatch(), options)
    expect(creditorRouting(xml)).toEqual([
      { memberId: '9900', accountId: '50501055', scheme: '<Prtry>BGNR</Prtry>' },
      { memberId: '9960', accountId: '1234567', scheme: '<Cd>BBAN</Cd>' },
      { memberId: '8327', accountId: '832790123456789', scheme: '<Cd>BBAN</Cd>' },
      { memberId: '9900', accountId: '50501055', scheme: '<Prtry>BGNR</Prtry>' },
    ])
  })

  it.each(['ESSESESS', 'HANDSESS', 'SWEDSESS', 'SVEASESS', 'DABADKKK'])('%s keeps the account without the clearing', (bic) => {
    const xml = generateSupplierPain001(
      { ...danske, bic },
      accounts.map((payee) => bgPayment({ payee })),
      options,
    )
    expect(creditorRouting(xml).map((r) => [r.memberId, r.accountId])).toEqual([
      ['1344', '2045678'],
      ['6000', '123456789'],
      ['3300', '8001011234'],
      ['8327', '9123456789'],
    ])
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

/**
 * Swedbank MIG 2.0 pain.001.001.03 (version 2.0.0, 2026-03-09) with Appendix
 * v2.1.0 and the ISO 2.0 example files: the form a Swedbank debtor with both
 * Swedbank ids gets (crm#1117). The ids are Swedbank's own example values.
 */
describe('Swedbank ISO 2.0: a Swedbank debtor with its SignerID and Corporate Pay id', () => {
  const ids = { signerId: '260637712ORI0003', corporatePayId: '260637712CPO0001' }
  const swedbank = {
    name: 'Testbolaget AB',
    orgNumber: '556677-8899',
    iban: 'SE3550000000054910000003',
    bic: 'SWEDSESS',
    bankgiro: '9912346',
    city: 'Uppsala',
    swedbank: ids,
  }

  const BANK_ID = 'Id(OrgId(Othr(Id,SchmeNm(Cd))))'

  function block(xml: string, name: string): string {
    return xml.match(new RegExp(`<${name}>[\\s\\S]*?</${name}>`))![0]
  }

  it('states the SignerID as the initiating party and the Corporate Pay id as the debtor, both SchmeNm BANK', () => {
    const xml = generateSupplierPain001(swedbank, [bgPayment()], options)
    const initgPty = block(xml, 'InitgPty')
    expect(initgPty).toContain('<Id>260637712ORI0003</Id>')
    expect(initgPty).toContain('<SchmeNm><Cd>BANK</Cd></SchmeNm>')
    const dbtr = block(xml, 'Dbtr')
    expect(dbtr).toContain('<Id>260637712CPO0001</Id>')
    expect(dbtr).toContain('<SchmeNm><Cd>BANK</Cd></SchmeNm>')
    // The org number Swedbank refused appears nowhere.
    expect(xml).not.toContain('5566778899</Id>')
    expect(xml).not.toContain('<Othr><Id>5566778899</Id></Othr>')
  })

  it('marks every PmtInf as a supplier payment, SvcLvl NURG and CtgyPurp SUPP between CtrlSum and ReqdExctnDt', () => {
    const doc = parseXml(generateSupplierPain001(swedbank, mixedBatch(), options))
    const groups = findAll(doc, 'PmtInf')
    expect(groups).toHaveLength(2)
    for (const group of groups) {
      const names = childNames(group)
      expect(names.slice(0, 10)).toEqual([
        'PmtInfId', 'PmtMtd', 'BtchBookg', 'NbOfTxs', 'CtrlSum', 'PmtTpInf', 'ReqdExctnDt',
        'Dbtr', 'DbtrAcct', 'DbtrAgt',
      ])
      expect(new Set(names.slice(10))).toEqual(new Set(['CdtTrfTxInf']))
      const pmtTpInf = group.children.find((c) => c.name === 'PmtTpInf')!
      expect(shape(pmtTpInf)).toBe('PmtTpInf(SvcLvl(Cd),CtgyPurp(Cd))')
      expect(findAll(pmtTpInf, 'Cd').map((n) => n.text)).toEqual(['NURG', 'SUPP'])
    }
  })

  it('debits the IBAN for every payee, the company bankgiro included in no debtor account', () => {
    const xml = generateSupplierPain001(swedbank, mixedBatch(), options)
    const doc = parseXml(xml)
    const groups = findAll(doc, 'PmtInf')
    // One PmtInf per date only: MIG 2.0 has no BGNR debtor account form.
    expect(groups.map((g) => findAll(g, 'ReqdExctnDt')[0].text)).toEqual(['2026-08-15', '2026-08-20'])
    expect(groups.map((g) => shape(findAll(g, 'DbtrAcct')[0]))).toEqual([IBAN_DEBIT, IBAN_DEBIT])
    for (const account of debtorAccounts(xml)) expect(account).not.toContain('BGNR')
    expect(xml).not.toContain(swedbank.bankgiro)
    // Bankgiro payees are still addressed as bankgiro numbers; the 83279
    // account payee keeps its five clearing digits in the Swedbank form.
    expect(groups.map((g) => findAll(g, 'MmbId').map((n) => n.text))).toEqual([
      ['9900', '9960', '83279'],
      ['9900'],
    ])
  })

  it('always states the debtor address with country SE, and the town when known', () => {
    const withTown = parseXml(generateSupplierPain001(swedbank, [bgPayment()], options))
    const dbtr = findAll(withTown, 'Dbtr')[0]
    expect(shape(dbtr)).toBe(`Dbtr(Nm,PstlAdr(TwnNm,Ctry),${BANK_ID})`)
    expect(findAll(dbtr, 'TwnNm')[0].text).toBe('Uppsala')

    const withoutTown = parseXml(generateSupplierPain001({ ...swedbank, city: null }, [bgPayment()], options))
    const dbtrNoTown = findAll(withoutTown, 'Dbtr')[0]
    expect(shape(dbtrNoTown)).toBe(`Dbtr(Nm,PstlAdr(Ctry),${BANK_ID})`)
    expect(findAll(dbtrNoTown, 'Ctry')[0].text).toBe('SE')
  })

  it.each(['SWEDSESS', 'swedsessxxx', ' SWEDSESSXXX '])(
    'names the debtor agent SWEDSESS with country SE, the stored BIC written as %j',
    (bic) => {
      const doc = parseXml(generateSupplierPain001({ ...swedbank, bic }, [bgPayment()], options))
      const dbtrAgt = findAll(doc, 'DbtrAgt')[0]
      expect(shape(dbtrAgt)).toBe('DbtrAgt(FinInstnId(BIC,PstlAdr(Ctry)))')
      expect(findAll(dbtrAgt, 'BIC')[0].text).toBe('SWEDSESS')
      expect(findAll(dbtrAgt, 'Ctry')[0].text).toBe('SE')
    },
  )

  it('addresses a plusgiro payee with the PGNR proprietary code', () => {
    const xml = generateSupplierPain001(swedbank, [bgPayment({ payee: plusgiroPayee })], options)
    const cdtrAcct = block(xml, 'CdtrAcct')
    expect(cdtrAcct).toContain('<Id>1234567</Id>')
    expect(cdtrAcct).toContain('<SchmeNm><Prtry>PGNR</Prtry></SchmeNm>')
    expect(cdtrAcct).not.toContain('BBAN')
    expect(xml).toContain('<MmbId>9960</MmbId>')
  })

  it('keeps a 4-digit clearing in the separate form: MmbId CCCC, account without clearing', () => {
    const xml = generateSupplierPain001(
      swedbank,
      [bgPayment({ payee: { type: 'bank_account', clearing: '6000', account: '123456789' }, reference: { type: 'invoice_number', value: 'F1' } })],
      options,
    )
    expect(xml).toContain('<MmbId>6000</MmbId>')
    const cdtrAcct = block(xml, 'CdtrAcct')
    expect(cdtrAcct).toContain('<Id>123456789</Id>')
    expect(cdtrAcct).toContain('<SchmeNm><Cd>BBAN</Cd></SchmeNm>')
  })

  it.each([
    // Validex's own account example, 8901-1 914 616 842-3.
    ['a 5-digit clearing', '8901-1', '914 616 842-3', '89011', '890119146168423'],
    // Stored without its fifth digit: the mod 10 check digit of 8901 is 1.
    ['a 4-digit clearing (check digit derived)', '8901', '914 616 842-3', '89011', '890119146168423'],
    // Swedbank's ISO 2.0 salary example: zero fill up to 15 digits.
    ['a short account (zero filled)', '8911-2', '4245210', '89112', '891120004245210'],
  ])('states an 8xxxx clearing as MmbId 8CCCC and a 15-digit BBAN: %s', (_case, clearing, account, memberId, bban) => {
    const xml = generateSupplierPain001(
      swedbank,
      [bgPayment({ payee: { type: 'bank_account', clearing, account }, reference: { type: 'invoice_number', value: 'F1' } })],
      options,
    )
    expect(xml).toContain(`<MmbId>${memberId}</MmbId>`)
    expect(block(xml, 'CdtrAcct')).toContain(`<Id>${bban}</Id>`)
    expect(bban).toHaveLength(15)
  })

  it('sends an OCR to a bank account as the message, never as a structured reference', () => {
    const xml = generateSupplierPain001(swedbank, [bgPayment({ payee: bankAccountPayee })], options)
    const rmtInf = block(xml, 'RmtInf')
    expect(rmtInf).toContain('<Ustrd>12345678</Ustrd>')
    expect(rmtInf).not.toContain('<Strd>')
  })

  it.each([
    ['bankgiro', undefined],
    ['plusgiro', plusgiroPayee],
  ] as const)('states an OCR to a %s payee as SCOR, without RfrdDocAmt', (_type, payee) => {
    const doc = parseXml(
      generateSupplierPain001(swedbank, [bgPayment(payee ? { payee } : {})], options),
    )
    const strd = findAll(doc, 'Strd')[0]
    expect(childNames(strd)).toEqual(['CdtrRefInf'])
    expect(shape(strd)).toBe('Strd(CdtrRefInf(Tp(CdOrPrtry(Cd)),Ref))')
    expect(findAll(strd, 'Ref')[0].text).toBe('12345678')
    expect(findAll(doc, 'RfrdDocAmt')).toHaveLength(0)
  })

  it('drops the apostrophe, which MIG 2.0 lacks, and only in the Swedbank form', () => {
    const payment = bgPayment({ payeeName: "Kalle's Bygg & Co", reference: { type: 'invoice_number', value: "Faktura 1'2" } })
    const xml = generateSupplierPain001(swedbank, [payment], options)
    expect(xml).toContain('<Nm>Kalles Bygg + Co</Nm>')
    expect(xml).toContain('<Ustrd>Faktura 12</Ustrd>')
    expect(xml).not.toContain('&apos;')
    // Every other form keeps it (MIG 1.0 allows the apostrophe).
    expect(generateSupplierPain001(debtor, [payment], options)).toContain('<Nm>Kalle&apos;s Bygg + Co</Nm>')
  })

  it('writes the whole file in pain.001.001.03 schema order', () => {
    const doc = parseXml(
      generateSupplierPain001(swedbank, [bgPayment({ payeeCity: 'Veddige' })], options),
    )
    const grpHdr = findAll(doc, 'GrpHdr')[0]
    expect(shape(grpHdr)).toBe(`GrpHdr(MsgId,CreDtTm,NbOfTxs,CtrlSum,InitgPty(Nm,${BANK_ID}))`)
    const pmtInf = findAll(doc, 'PmtInf')[0]
    expect(childNames(pmtInf)).toEqual([
      'PmtInfId', 'PmtMtd', 'BtchBookg', 'NbOfTxs', 'CtrlSum', 'PmtTpInf', 'ReqdExctnDt',
      'Dbtr', 'DbtrAcct', 'DbtrAgt', 'CdtTrfTxInf',
    ])
    const tx = findAll(doc, 'CdtTrfTxInf')[0]
    expect(shape(tx)).toBe(
      'CdtTrfTxInf(PmtId(InstrId,EndToEndId),Amt(InstdAmt),' +
        'CdtrAgt(FinInstnId(ClrSysMmbId(ClrSysId(Cd),MmbId))),' +
        'Cdtr(Nm,PstlAdr(TwnNm,Ctry)),' +
        'CdtrAcct(Id(Othr(Id,SchmeNm(Prtry)))),' +
        'RmtInf(Strd(CdtrRefInf(Tp(CdOrPrtry(Cd)),Ref))))',
    )
  })

  it('renders a batch created before 2026-10-11 (Swedbank debtor, no ids) byte for byte as before', () => {
    const { swedbank: _ids, ...preFix } = swedbank
    const payments = [
      bgPayment({ payeeName: "Derome Bygg & Industri's AB", payeeCity: 'Veddige' }),
      bgPayment({
        payee: plusgiroPayee,
        payeeName: 'Plus AB',
        amount: 200,
        reference: { type: 'invoice_number', value: 'F-1001' },
      }),
    ]
    const xml = generateSupplierPain001(preFix, payments, options)
    // SHA-256 of the file main generated before the Swedbank ISO 2.0 form
    // existed (org number ids, BGNR debit, RfrdDocAmt, apostrophe kept).
    expect(createHash('sha256').update(xml).digest('hex')).toBe(
      'c2907cf39de5da51aea63d5e3c8b7c92826be8d99aebafda62f8de21b38ed533',
    )
    expect(generateSupplierPain001({ ...preFix, swedbank: null }, payments, options)).toBe(xml)
  })
})

/**
 * Nordea "Corporate Access Payables, MIG pain.001.001.09" v1.4 and "Corporate
 * eGateway, MIG pain.001.001.03" v3.3 (both 2026-09-16): InitgPty/Id/OrgId/
 * Othr/Id is the Signer ID agreed with Nordea, SchmeNm/Cd CUST. Nordea's
 * upload refused a file naming the org number there ("fel Signer ID",
 * crm#1530).
 */
describe('Nordea: the Signer ID as the initiating party', () => {
  const nordea = {
    name: 'Testbolaget AB',
    orgNumber: '556677-8899',
    iban: 'SE4530000000031234567890',
    bic: 'NDEASESS',
    bankgiro: '9912346',
    city: 'Uppsala',
  }
  const signerId = 'NB10000123456'

  function block(xml: string, name: string): string {
    return xml.match(new RegExp(`<${name}>[\\s\\S]*?</${name}>`))![0]
  }

  it('states the Signer ID with SchmeNm CUST in InitgPty, never the org number (the refused file)', () => {
    // The refused file: one supplier payment of 146.00 from a Nordea account.
    const xml = generateSupplierPain001(
      { ...nordea, nordeaSignerId: signerId },
      [bgPayment({ amount: 146 })],
      options,
    )
    const initgPty = block(xml, 'InitgPty')
    expect(initgPty).toContain('<Id>NB10000123456</Id>')
    expect(initgPty).toContain('<SchmeNm><Cd>CUST</Cd></SchmeNm>')
    expect(initgPty).not.toContain('5566778899')
    expect(shape(findAll(parseXml(xml), 'InitgPty')[0])).toBe('InitgPty(Nm,Id(OrgId(Othr(Id,SchmeNm(Cd)))))')
  })

  it('changes nothing but InitgPty: the debtor keeps the org number and the Nordea form', () => {
    const payments = mixedBatch()
    const withId = generateSupplierPain001({ ...nordea, nordeaSignerId: signerId }, payments, options)
    const without = generateSupplierPain001(nordea, payments, options)
    const strip = (xml: string) => xml.replace(/<InitgPty>[\s\S]*?<\/InitgPty>/, '')
    expect(strip(withId)).toBe(strip(without))
    expect(block(withId, 'Dbtr')).toContain('<Othr><Id>5566778899</Id></Othr>')
    expect(withId).not.toContain('<SvcLvl>')
  })

  it('renders a Nordea batch created before the Signer ID (no id) with the org number, as it was first downloaded', () => {
    for (const debtor of [nordea, { ...nordea, nordeaSignerId: null }]) {
      const initgPty = block(generateSupplierPain001(debtor, [bgPayment()], options), 'InitgPty')
      expect(initgPty).toContain('<Othr><Id>5566778899</Id></Othr>')
      expect(initgPty).not.toContain('SchmeNm')
    }
  })

  it('leaves a Swedbank debtor on its own SignerID even with a stray Nordea id', () => {
    const swedbank = { ...nordea, bic: 'SWEDSESS', swedbank: { signerId: '260637712ORI0003', corporatePayId: '260637712CPO0001' } }
    const initgPty = block(generateSupplierPain001({ ...swedbank, nordeaSignerId: signerId }, [bgPayment()], options), 'InitgPty')
    expect(initgPty).toContain('<Id>260637712ORI0003</Id>')
    expect(initgPty).toContain('<SchmeNm><Cd>BANK</Cd></SchmeNm>')
  })
})
