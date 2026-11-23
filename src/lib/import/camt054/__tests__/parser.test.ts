import { describe, expect, it } from 'vitest'
import { formatBankgiroNumber } from '@/lib/bankgiro/luhn'
import { OTHER_BG, OTHER_BG_DIGITS, OWN_BG, OWN_BG_DIGITS, PAYER_BG_DIGITS, septemberFile } from '@/lib/import/bgmax/__tests__/bgmax-fixture'
import { detectCamt054, parseCamt054 } from '../parser'
import { OWN_BBAN, OWN_IBAN, decemberFile, document, entry, notification, payment } from './camt054-fixture'

const one = (entries: string[], fields: Partial<Parameters<typeof notification>[0]> = {}, version?: string) =>
  parseCamt054(document([notification({ ...fields, entries })], version))

/** The same document as a serializer with a declared namespace prefix writes it. */
const prefixed = (xml: string) => xml.replace('xmlns=', 'xmlns:ns2=').replace(/<(\/?)(?=[A-Z])/g, '<$1ns2:')

describe('detectCamt054', () => {
  it('recognises a notification by its content, whatever it is called', () => {
    expect(detectCamt054(decemberFile())).toBe(true)
    expect(detectCamt054(`\uFEFF  ${decemberFile()}`)).toBe(true)
    expect(detectCamt054(prefixed(decemberFile()))).toBe(true)
  })

  it('leaves a statement, a BG Max file and a CSV alone, even one that mentions camt.054', () => {
    expect(detectCamt054('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt/></Document>')).toBe(false)
    expect(
      detectCamt054(
        '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Ntry><AddtlNtryInf>Se camt.054, BkToCstmrDbtCdtNtfctn</AddtlNtryInf></Ntry></Stmt></BkToCstmrStmt></Document>',
      ),
    ).toBe(false)
    expect(detectCamt054(septemberFile())).toBe(false)
    expect(detectCamt054('Datum;Text;Belopp\n2026-12-01;camt.054 avisering;1500,00')).toBe(false)
  })
})

describe('parseCamt054', () => {
  it('reads a booked credit entry as a deposit with one payment per <TxDtls>', () => {
    const result = parseCamt054(decemberFile())
    expect(result).toMatchObject({ rejected_deposits: 0, skipped_entries: 0, date_from: '2026-12-01', date_to: '2026-12-01', issues: [] })
    expect(result.deposits).toHaveLength(1)
    const [deposit] = result.deposits
    expect(deposit).toMatchObject({
      bankgiro: OWN_BG,
      account: { iban: OWN_IBAN },
      date: '2026-12-01',
      value_date: '2026-12-01',
      booked: true,
      serial: null,
      amount: 1500,
      currency: 'SEK',
    })
    expect(deposit!.payments).toEqual([
      {
        kind: 'payment',
        amount: 500,
        payer_bankgiro: formatBankgiroNumber(PAYER_BG_DIGITS),
        reference: '10017',
        reference_code: '2',
        extra_references: [],
        message: null,
        payer_name: 'Kund AB',
        payer_org_number: null,
        bgc_serial: '492950108394',
      },
      {
        kind: 'payment',
        amount: 750,
        payer_bankgiro: null,
        reference: '1004',
        reference_code: '3',
        extra_references: [],
        message: 'Faktura 1004',
        payer_name: 'Fjärde Kunden AB',
        payer_org_number: null,
        bgc_serial: '492950108395',
      },
      {
        kind: 'payment',
        amount: 250,
        payer_bankgiro: null,
        reference: null,
        reference_code: '0',
        extra_references: [],
        message: null,
        payer_name: 'Bolaget i Norr AB',
        payer_org_number: '5591234567',
        bgc_serial: '492950108396',
      },
    ])
  })

  it('reads prefixed element names and ignores commented-out elements', () => {
    expect(parseCamt054(prefixed(decemberFile())).deposits[0]!.payments).toHaveLength(3)
    const commented = decemberFile().replace('<NtryDtls>', '<NtryDtls><!-- <TxDtls><AmtDtls><TxAmt><Amt Ccy="SEK">1.00</Amt></TxAmt></AmtDtls></TxDtls> -->')
    expect(parseCamt054(commented)).toMatchObject({ rejected_deposits: 0 })
    expect(parseCamt054(commented).deposits[0]!.payments).toHaveLength(3)
  })

  it('reads a message in CDATA whole, a comment opener inside it included', () => {
    // A real comment follows the payment: the opener inside the CDATA must not swallow what lies between.
    const withCdata = payment({ amount: '50.00', payerName: 'Kund AB', unstructured: ['<![CDATA[Faktura <1004> & <!-- mer]]>'], structured: [{ ocr: '10017' }] })
    const result = one([entry({ amount: '50.00', date: '2026-12-01', payments: [`${withCdata}<!-- slut -->`] })])
    expect(result.deposits[0]!.payments[0]).toMatchObject({ message: 'Faktura <1004> & <!-- mer', reference: '10017', payer_name: 'Kund AB' })
  })

  it('reads every form of an xs:decimal amount, and no negative one', () => {
    const result = one([
      entry({ amount: '+100.00', date: '2026-12-01', payments: [payment({ amount: '99.5' }), payment({ amount: '.50' })] }),
      entry({ amount: '7.', date: '2026-12-02', payments: [payment({ amount: '7' })] }),
      entry({ amount: '-5.00', date: '2026-12-03', payments: [payment({ amount: '-5.00' })] }),
    ])
    expect(result.deposits.map((d) => [d.amount, d.payments.map((p) => p.amount)])).toEqual([[100, [99.5, 0.5]], [7, [7]]])
    expect(result.rejected_deposits).toBe(1)
  })

  it('reads the newer layout: status in <Cd>, a date-time, the payer in <Pty>, the amount under <TxDtls>', () => {
    const result = one(
      [
        entry({
          amount: '99.50',
          date: '2026-12-01T23:30:00+00:00',
          wrapped: true,
          payments: [payment({ amount: null, ownAmount: '99.50', indicator: 'CRDT', servicerRef: '2026-12-01-09.10.37.990513', payerName: 'Kund AB', party: true, payerOrg: '165560160680', structured: [{ number: 'F-2031' }] })],
        }),
      ],
      {},
      '08',
    )
    expect(result.deposits).toHaveLength(1)
    // 23:30 UTC is the next day in Stockholm.
    expect(result.deposits[0]).toMatchObject({ date: '2026-12-02', amount: 99.5 })
    expect(result.deposits[0]!.payments[0]).toMatchObject({
      amount: 99.5,
      payer_name: 'Kund AB',
      payer_org_number: '5560160680',
      reference: 'F-2031',
      reference_code: '3',
      bgc_serial: '2026-12-01-09.10.37.990513',
    })
  })

  it('takes a single payment without an amount of its own as the whole entry', () => {
    const result = one([entry({ amount: '321.00', date: '2026-12-01', payments: [payment({ amount: null, payerName: 'Kund AB' })] })])
    expect(result.deposits[0]!.payments).toMatchObject([{ kind: 'payment', amount: 321 }])
  })

  it('keeps every reference of a payment: the OCR first, then invoice numbers, then what a credit note names', () => {
    const result = one([
      entry({
        amount: '800.00',
        date: '2026-12-01',
        payments: [
          payment({
            amount: '800.00',
            structured: [
              { number: '1002', code: 'CINV', remitted: '1000.00' },
              { ocr: '10017' },
              { number: 'K-7', code: 'CREN', creditNote: '200.00' },
            ],
            unstructured: ['Två fakturor', 'minus kredit'],
            additional: ['Tack'],
          }),
        ],
      }),
    ])
    expect(result.deposits[0]!.payments[0]).toMatchObject({
      kind: 'payment',
      amount: 800,
      reference: '10017',
      reference_code: '2',
      extra_references: ['1002', 'K-7'],
      message: 'Två fakturor minus kredit Tack',
    })
  })

  it('subtracts a credit note the bank reports as a payment of its own, when that is what adds up', () => {
    const result = one([
      entry({
        amount: '300.00',
        date: '2026-12-01',
        batch: { id: '00012', count: 2 },
        payments: [
          payment({ amount: '500.00', paymentInfoId: 'A1', structured: [{ ocr: '10017' }] }),
          payment({ amount: '200.00', paymentInfoId: 'A2', structured: [{ number: 'K-7', code: 'CREN', ocr: '10025' }] }),
        ],
      }),
    ])
    expect(result.issues).toEqual([])
    expect(result.deposits[0]).toMatchObject({ serial: '00012', amount: 300 })
    expect(result.deposits[0]!.payments).toMatchObject([
      { kind: 'payment', amount: 500, bgc_serial: 'A1' },
      { kind: 'deduction', amount: -200, reference: '10025', extra_references: ['K-7'], bgc_serial: 'A2' },
    ])
  })

  it('subtracts a payment marked as a debit inside the entry', () => {
    const result = one([
      entry({
        amount: '400.00',
        date: '2026-12-01',
        payments: [payment({ amount: '500.00' }), payment({ amount: '100.00', indicator: 'DBIT' })],
      }),
    ])
    expect(result.deposits[0]!.payments).toMatchObject([{ kind: 'payment', amount: 500 }, { kind: 'deduction', amount: -100 }])
  })

  it('leaves out an entry whose payments do not add up to it', () => {
    const result = one([
      entry({ amount: '1000.00', date: '2026-12-01', payments: [payment({ amount: '500.00' }), payment({ amount: '400.00' })] }),
      entry({ amount: '250.00', date: '2026-12-02', payments: [payment({ amount: '250.00' })] }),
    ])
    expect(result.rejected_deposits).toBe(1)
    expect(result.deposits).toMatchObject([{ date: '2026-12-02', amount: 250 }])
    expect(result.issues).toEqual([expect.objectContaining({ entry: 1, severity: 'error' })])
  })

  it('leaves out an entry whose payments are in another currency, or whose amount has öre it cannot hold', () => {
    const result = one([
      entry({ amount: '100.00', date: '2026-12-01', payments: [payment({ amount: '100.00', currency: 'EUR' })] }),
      entry({ amount: '100.005', date: '2026-12-01', payments: [payment({ amount: '100.005' })] }),
    ])
    expect(result).toMatchObject({ deposits: [], rejected_deposits: 2 })

    // The currency attribute written with spaces around its equals sign is the same attribute.
    const spaced = document([
      notification({ entries: [entry({ amount: '100.00', date: '2026-12-01', payments: [payment({ amount: '100.00', currency: 'USD' })] })] }),
    ]).replaceAll('Ccy="USD"', 'Ccy = "USD"')
    expect(parseCamt054(spaced)).toMatchObject({ deposits: [], rejected_deposits: 1 })
  })

  it('reads only invoices and credit notes as references, never another kind of document', () => {
    const result = one([
      entry({
        amount: '800.00',
        date: '2026-12-01',
        payments: [
          payment({ amount: '300.00', structured: [{ number: '1002', code: 'PUOR' }] }),
          payment({ amount: '500.00', structured: [{ number: '4471', code: 'PUOR' }, { number: '1003', code: 'CINV' }, { number: '1004' }] }),
        ],
      }),
    ])
    expect(result.deposits[0]!.payments).toMatchObject([
      { reference: null, reference_code: '0', extra_references: [] },
      { reference: '1003', extra_references: ['1004'] },
    ])
  })

  it('skips what is no deposit: a debit, a pending entry, a reversal, an entry without payment details', () => {
    const result = one([
      entry({ amount: '10.00', date: '2026-12-01', indicator: 'DBIT', payments: [payment({ amount: '10.00' })] }),
      entry({ amount: '20.00', date: '2026-12-01', status: 'PDNG', payments: [payment({ amount: '20.00' })] }),
      entry({ amount: '30.00', date: '2026-12-01', reversal: true, payments: [payment({ amount: '30.00' })] }),
      entry({ amount: '35.00', date: '2026-12-01', reversal: '1', payments: [payment({ amount: '35.00' })] }),
      entry({ amount: '40.00', date: '2026-12-01', payments: [] }),
      entry({ amount: '50.00', date: '2026-12-01', reversal: 'false', payments: [payment({ amount: '50.00' })] }),
    ])
    expect(result).toMatchObject({ skipped_entries: 5, rejected_deposits: 0 })
    expect(result.deposits).toMatchObject([{ amount: 50 }])
    expect(result.issues.map((i) => [i.entry, i.severity])).toEqual([[2, 'info'], [5, 'info']])
  })

  it('warns when the batch states another number of payments', () => {
    const result = one([entry({ amount: '50.00', date: '2026-12-01', batch: { count: 3 }, payments: [payment({ amount: '50.00' })] })])
    expect(result.deposits).toHaveLength(1)
    expect(result.issues).toEqual([expect.objectContaining({ entry: 1, severity: 'warning' })])
  })

  it('names the receiving bankgiro only when the entry has exactly one', () => {
    const none = one([entry({ amount: '50.00', date: '2026-12-01', payments: [payment({ amount: '50.00', receiverBankgiro: null })] })])
    expect(none.deposits[0]!.bankgiro).toBeNull()

    const typed = one([entry({ amount: '50.00', date: '2026-12-01', payments: [payment({ amount: '50.00', receiverBankgiro: null })] })], {
      bban: OWN_BBAN,
      giroTyped: OWN_BG_DIGITS,
    })
    expect(typed.deposits[0]).toMatchObject({ bankgiro: OWN_BG, account: { iban: null, account_number: OWN_BBAN }, bank_account: OWN_BBAN })

    const two = one([
      entry({
        amount: '150.00',
        date: '2026-12-01',
        payments: [payment({ amount: '50.00' }), payment({ amount: '100.00', receiverBankgiro: OTHER_BG_DIGITS })],
      }),
    ])
    expect(two.deposits[0]!.bankgiro).toBeNull()

    const other = one([entry({ amount: '50.00', date: '2026-12-01', payments: [payment({ amount: '50.00', receiverBankgiro: OTHER_BG_DIGITS })] })])
    expect(other.deposits[0]!.bankgiro).toBe(OTHER_BG)
  })

  it('gives the payer account as the bank prints it and never a private id as an organisation number', () => {
    const result = one([
      entry({
        amount: '50.00',
        date: '2026-12-01',
        payments: [payment({ amount: '50.00', payerName: 'Anna Andersson', payerIban: 'SE3550000000054910000003', payerOrg: '12345' })],
      }),
    ])
    expect(result.deposits[0]!.payments[0]).toMatchObject({ payer_bankgiro: 'SE3550000000054910000003', payer_org_number: null })
  })

  it('reads each notification under its own account', () => {
    const result = parseCamt054(
      document([
        notification({ entries: [entry({ amount: '10.00', date: '2026-12-01', payments: [payment({ amount: '10.00' })] })] }),
        notification({ iban: null, entries: [entry({ amount: '20.00', date: '2026-12-03', payments: [payment({ amount: '20.00' })] })] }),
      ]),
    )
    expect(result).toMatchObject({ date_from: '2026-12-01', date_to: '2026-12-03' })
    expect(result.deposits.map((d) => d.account)).toEqual([{ iban: OWN_IBAN, clearing: null, account_number: null }, null])
  })

  it('reads the account from its own id, never from its owner', () => {
    const entries = [entry({ amount: '10.00', date: '2026-12-01', payments: [payment({ amount: '10.00', receiverBankgiro: null })] })]
    const owner = { name: 'Bolag 123 4567 AB', orgNumber: '5560160680' }
    // An IBAN account: the owner's organisation number is not an account number.
    expect(one(entries, { owner }).deposits[0]).toMatchObject({ account: { iban: OWN_IBAN, clearing: null, account_number: null }, bankgiro: null })
    // An account typed BGNR with no name of its own: the owner's name is not a bankgiro.
    expect(one(entries, { owner, iban: null, giroTyped: '' }).deposits[0]).toMatchObject({ account: null, bankgiro: null })
  })

  it('says so when the file is cut short, and still reads the notifications it holds whole', () => {
    const whole = document([
      notification({ entries: [entry({ amount: '10.00', date: '2026-12-01', payments: [payment({ amount: '10.00' })] })] }),
      notification({ entries: [entry({ amount: '20.00', date: '2026-12-02', payments: [payment({ amount: '20.00' })] })] }),
    ])
    const cut = whole.slice(0, whole.lastIndexOf('<Ntry>') + 40)
    const result = parseCamt054(cut)
    expect(result.deposits).toMatchObject([{ amount: 10 }])
    expect(result.issues).toEqual([expect.objectContaining({ entry: 0, severity: 'warning', message: expect.stringContaining('avkortad') })])
    expect(parseCamt054(whole).issues).toEqual([])
  })

  it('reports a file with no entries', () => {
    const result = parseCamt054(document([notification({ entries: [] })]))
    expect(result.deposits).toEqual([])
    expect(result.issues).toEqual([expect.objectContaining({ entry: 0, severity: 'error' })])
  })
})
