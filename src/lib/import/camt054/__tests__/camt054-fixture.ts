/**
 * Synthetic camt.054 notifications, built element by element from the
 * banks' published mappings of BG Max to camt.054 (see ../parser.ts). Every
 * number here is made up: bankgiro numbers carry a valid Luhn check digit
 * and nothing else, and the IBAN is the format's textbook example.
 */
import { OWN_BG_DIGITS, PAYER_BG_DIGITS } from '@/lib/import/bgmax/__tests__/bgmax-fixture'

export const OWN_IBAN = 'SE4550000000058398257466'
/** The same account as a clearing number and account number, the way a BBAN prints it. */
export const OWN_BBAN = '50000000058398257466'

export interface StructuredFields {
  /** <CdtrRefInf><Ref> under SCOR. */
  ocr?: string
  /** <RfrdDocInf><Nb>. */
  number?: string
  /** The <RfrdDocInf> type code (CINV, CREN, PUOR, ...); left out, the number carries none. */
  code?: string
  /** <RfrdDocAmt><RmtdAmt>. */
  remitted?: string
  /** <RfrdDocAmt><CdtNoteAmt>. */
  creditNote?: string
}

export interface PaymentFields {
  /** <AmtDtls><TxAmt><Amt>; null leaves <AmtDtls> out. */
  amount: string | null
  /** <Amt> directly under <TxDtls> (camt.054.001.08). */
  ownAmount?: string
  /** <CdtDbtInd> directly under <TxDtls>. */
  indicator?: 'CRDT' | 'DBIT'
  currency?: string
  /** <Refs><ClrSysRef>. */
  clearingRef?: string
  /** <Refs><AcctSvcrRef>. */
  servicerRef?: string
  /** <Refs><PmtInfId>. */
  paymentInfoId?: string
  payerName?: string
  /** True: the payer sits in <Dbtr><Pty> (camt.054.001.08). */
  party?: boolean
  payerOrg?: string
  payerBankgiro?: string
  payerIban?: string
  /** The receiving bankgiro in <CdtrAcct> under BGNR; null leaves it out. */
  receiverBankgiro?: string | null
  structured?: StructuredFields[]
  unstructured?: string[]
  additional?: string[]
}

const el = (name: string, body: string | undefined | null): string => (body ? `<${name}>${body}</${name}>` : '')

const giroAccount = (name: string, digits: string | null | undefined): string =>
  digits ? el(name, el('Id', el('Othr', `${el('Id', digits)}${el('SchmeNm', el('Prtry', 'BGNR'))}`))) : ''

function structured(fields: StructuredFields, currency: string): string {
  const document = fields.number ? el('RfrdDocInf', `${fields.code ? el('Tp', el('CdOrPrtry', el('Cd', fields.code))) : ''}${el('Nb', fields.number)}`) : ''
  const amounts = el(
    'RfrdDocAmt',
    `${fields.remitted ? `<RmtdAmt Ccy="${currency}">${fields.remitted}</RmtdAmt>` : ''}${fields.creditNote ? `<CdtNoteAmt Ccy="${currency}">${fields.creditNote}</CdtNoteAmt>` : ''}`,
  )
  const creditor = fields.ocr ? el('CdtrRefInf', `${el('Tp', el('CdOrPrtry', el('Cd', 'SCOR')))}${el('Ref', fields.ocr)}`) : ''
  return el('Strd', `${document}${amounts}${creditor}`)
}

export function payment(fields: PaymentFields): string {
  const currency = fields.currency ?? 'SEK'
  const refs = el('Refs', `${el('AcctSvcrRef', fields.servicerRef)}${el('PmtInfId', fields.paymentInfoId)}${el('ClrSysRef', fields.clearingRef)}`)
  const own = `${fields.ownAmount ? `<Amt Ccy="${currency}">${fields.ownAmount}</Amt>` : ''}${el('CdtDbtInd', fields.indicator)}`
  const amounts = fields.amount
    ? el('AmtDtls', `${el('InstdAmt', `<Amt Ccy="${currency}">${fields.amount}</Amt>`)}${el('TxAmt', `<Amt Ccy="${currency}">${fields.amount}</Amt>`)}`)
    : ''
  const organisation = fields.payerOrg ? el('Id', el('OrgId', el('Othr', el('Id', fields.payerOrg)))) : ''
  const person = `${el('Nm', fields.payerName)}${el('PstlAdr', `${el('StrtNm', 'Provgatan 1')}${el('PstCd', '11122')}${el('TwnNm', 'PROVSTAD')}`)}${organisation}`
  const debtor = fields.payerName || fields.payerOrg ? el('Dbtr', fields.party ? el('Pty', person) : person) : ''
  const debtorAccount = fields.payerIban ? el('DbtrAcct', el('Id', el('IBAN', fields.payerIban))) : giroAccount('DbtrAcct', fields.payerBankgiro)
  const receiver = fields.receiverBankgiro === undefined ? OWN_BG_DIGITS : fields.receiverBankgiro
  const parties = el('RltdPties', `${debtor}${debtorAccount}${giroAccount('CdtrAcct', receiver)}`)
  const remittance = el(
    'RmtInf',
    `${(fields.unstructured ?? []).map((u) => el('Ustrd', u)).join('')}${(fields.structured ?? []).map((s) => structured(s, currency)).join('')}${(fields.additional ?? []).map((a) => el('AddtlRmtInf', a)).join('')}`,
  )
  return el('TxDtls', `${refs}${own}${amounts}${parties}${remittance}`)
}

export interface EntryFields {
  amount: string
  currency?: string
  /** YYYY-MM-DD, written as <Dt>; with a 'T' it is written as <DtTm>. */
  date: string
  valueDate?: string
  indicator?: 'CRDT' | 'DBIT'
  /** 'BOOK' by default; `wrapped` writes it as <Sts><Cd> (camt.054.001.08). */
  status?: string
  wrapped?: boolean
  /** <RvslInd>: true writes "true"; a string is written as it is ("1"). */
  reversal?: boolean | string
  /** <Btch><MsgId> and <NbOfTxs>. */
  batch?: { id?: string; count?: number }
  payments: string[]
}

const dated = (name: string, value: string | undefined): string =>
  value ? el(name, value.includes('T') ? el('DtTm', value) : el('Dt', value)) : ''

export function entry(fields: EntryFields): string {
  const status = fields.status ?? 'BOOK'
  const batch = fields.batch ? el('Btch', `${el('MsgId', fields.batch.id)}${el('NbOfTxs', fields.batch.count === undefined ? undefined : String(fields.batch.count))}`) : ''
  return el(
    'Ntry',
    [
      el('NtryRef', '1'),
      `<Amt Ccy="${fields.currency ?? 'SEK'}">${fields.amount}</Amt>`,
      el('CdtDbtInd', fields.indicator ?? 'CRDT'),
      fields.reversal ? el('RvslInd', fields.reversal === true ? 'true' : fields.reversal) : '',
      el('Sts', fields.wrapped ? el('Cd', status) : status),
      dated('BookgDt', fields.date),
      dated('ValDt', fields.valueDate),
      el('AcctSvcrRef', '00108'),
      el('BkTxCd', el('Domn', `${el('Cd', 'PMNT')}${el('Fmly', `${el('Cd', 'RCDT')}${el('SubFmlyCd', 'DMCT')}`)}`)),
      fields.payments.length > 0 || batch ? el('NtryDtls', `${batch}${fields.payments.join('')}`) : '',
    ].join(''),
  )
}

export interface NotificationFields {
  /** The account: an IBAN by default; `bban` writes a domestic number, `giroTyped` types the account BGNR with the bankgiro as its name ('' for no name). */
  iban?: string | null
  bban?: string
  giroTyped?: string
  /** <Ownr>: the account owner's name and organisation number. */
  owner?: { name: string; orgNumber: string }
  entries: string[]
}

export function notification(fields: NotificationFields): string {
  const id = fields.bban
    ? el('Id', el('Othr', `${el('Id', fields.bban)}${el('SchmeNm', el('Cd', 'BBAN'))}`))
    : fields.iban === null
      ? ''
      : el('Id', el('IBAN', fields.iban ?? OWN_IBAN))
  const typed = fields.giroTyped === undefined ? '' : `${el('Tp', el('Prtry', 'BGNR'))}${el('Nm', fields.giroTyped)}`
  const owner = fields.owner ? el('Ownr', `${el('Nm', fields.owner.name)}${el('Id', el('OrgId', el('Othr', el('Id', fields.owner.orgNumber))))}`) : ''
  const account = id || typed ? el('Acct', `${id}${typed}${el('Ccy', 'SEK')}${owner}`) : ''
  return el('Ntfctn', `${el('Id', 'NTF-1')}${el('CreDtTm', '2026-12-01T06:00:00')}${account}${fields.entries.join('')}`)
}

export function document(notifications: string[], version = '02'): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.${version}">`,
    el('BkToCstmrDbtCdtNtfctn', `${el('GrpHdr', `${el('MsgId', 'MSG-1')}${el('CreDtTm', '2026-12-01T06:00:00')}`)}${notifications.join('')}`),
    '</Document>',
  ].join('\n')
}

/**
 * A day's notification as Handelsbanken's mapping writes it: one entry, three
 * payments (an OCR, an invoice number with a message, a payer with an
 * organisation number and no reference), the receiving bankgiro on each.
 */
export function decemberFile(): string {
  return document([
    notification({
      entries: [
        entry({
          amount: '1500.00',
          date: '2026-12-01',
          valueDate: '2026-12-01',
          payments: [
            payment({ amount: '500.00', clearingRef: '492950108394', payerName: 'Kund AB', payerBankgiro: PAYER_BG_DIGITS, structured: [{ ocr: '10017' }] }),
            payment({
              amount: '750.00',
              clearingRef: '492950108395',
              payerName: 'Fjärde Kunden AB',
              structured: [{ number: '1004', code: 'CINV', remitted: '750.00' }],
              unstructured: ['Faktura 1004'],
            }),
            payment({ amount: '250.00', clearingRef: '492950108396', payerName: 'Bolaget i Norr AB', payerOrg: '559123-4567' }),
          ],
        }),
      ],
    }),
  ])
}
