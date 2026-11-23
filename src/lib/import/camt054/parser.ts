/**
 * ISO 20022 camt.054 (BankToCustomerDebitCreditNotification): the bank's own
 * notification of the payments credited to an account, the file Swedish
 * banks deliver in place of Bankgirot's BG Max.
 *
 * A bank feed shows a deposit as one row with no payer and no OCR. The
 * notification lists the same booking as an entry (<Ntry>) with one <TxDtls>
 * per payment: who paid, with which OCR or invoice number, how much. This
 * module reads that; like the BG Max reader (lib/import/bgmax/parser.ts) it
 * never creates bank rows. lib/import/bgmax/attach.ts attaches each entry's
 * payments to the bank row that is the entry.
 *
 * Sources: the banks' own mappings from BG Max to camt.054:
 *   - Handelsbanken, "Conversion recommendations for the BgMax format" (March 2025);
 *   - Länsförsäkringar Bank, "Migration Guideline BGMAX for ISO 20022" (2022-12-20);
 *   - Nordea, "Changes to the CAMT.054C file structure" (2026-11-11).
 * They agree on the structure and differ in where a detail sits, so each
 * detail is read from every place one of them puts it:
 *   - the receiving bankgiro: <CdtrAcct><Id><Othr> under the scheme BGNR on
 *     the payment, or the notification's own <Acct> typed BGNR; a bank may
 *     leave it out altogether;
 *   - the payment's amount: <AmtDtls><TxAmt><Amt>, or <Amt> directly under
 *     <TxDtls> (camt.054.001.08);
 *   - the payer: <Dbtr><Nm> or <Dbtr><Pty><Nm>, the organisation number in
 *     <OrgId>, the payer's bankgiro in <DbtrAcct>;
 *   - references: an OCR in <CdtrRefInf><Ref>, invoice and credit note
 *     numbers in <RfrdDocInf><Nb> (CINV, CREN), free text in <Ustrd> and
 *     <AddtlRmtInf>;
 *   - the bank's id for the payment: <ClrSysRef>, <AcctSvcrRef> or <PmtInfId>.
 *
 * Only booked credit entries are read. An entry whose payments do not add up
 * to the entry is left out (counted in rejected_deposits), because its split
 * would not explain the bank row. Amounts are whole öre until the very end,
 * so the sum is checked without float drift.
 */
import { roundOre } from '@/lib/money'
import { accountIdentity } from '../bank-file/account-identity'
import type { BankFileAccountIdentity } from '../bank-file/types'
import { bankgiro, orgNumber, type BgMaxDeposit, type BgMaxPayment } from '../bgmax/parser'
import { prepareContent } from '../shared/encoding'
import {
  extractAllText,
  extractAmount,
  extractElements,
  extractEntryDate,
  extractNestedText,
  extractTextContent,
  plainXml,
  stripNamespacePrefixes,
} from '../shared/iso20022-xml'

/**
 * One payment of an entry, in the shape the deposit attachment takes
 * (BgMaxPayment). `payer_bankgiro` is the payer's account as the bank gives
 * it (a bankgiro formatted, else the IBAN or number); `bgc_serial` is the
 * bank's id for the payment; `reference_code` follows BG Max's Tabell 5:
 * '2' an OCR, '3' another reference, '0' none.
 */
export type Camt054Payment = BgMaxPayment

/** One booked credit entry with its payments, in the shape the deposit attachment takes (BgMaxDeposit). */
export interface Camt054Deposit extends Omit<BgMaxDeposit, 'bankgiro'> {
  /** The receiving bankgiro, formatted, when the notification names exactly one for the entry; null when it names none or several. */
  bankgiro: string | null
  /** <ValDt>, when the entry gives one. */
  value_date: string | null
  /** Always true: `date` is the day the bank booked the entry, not a payment date it may book later. */
  booked: true
  /** The account the notification is for (<Ntfctn><Acct>), as the bank-file import reads a statement's own account. */
  account: BankFileAccountIdentity | null
}

export interface Camt054Issue {
  /** 1-based number of the entry in the file; 0 for the file as a whole. */
  entry: number
  severity: 'info' | 'warning' | 'error'
  message: string
}

export interface Camt054ParseResult {
  /** The booked credit entries whose payments add up to the entry; only these may be attached. */
  deposits: Camt054Deposit[]
  /** Credit entries left out: their payments do not add up to the entry, or the entry cannot be read. */
  rejected_deposits: number
  /** Entries that are no deposit to attach: debits, pending or reversed entries, entries without payment details. */
  skipped_entries: number
  date_from: string | null
  date_to: string | null
  issues: Camt054Issue[]
}

/** The message's own element, prefixed or not. A statement that only mentions camt.054 in a text has none. */
const CAMT054_ELEMENT = /<(?:[A-Za-z_][\w.-]*:)?BkToCstmrDbtCdtNtfctn(?=[\s>/])/i

/** True when the content is a camt.054 notification: XML that carries the message's element, whatever the file is called. */
export function detectCamt054(content: string): boolean {
  const prepared = prepareContent(content).trimStart()
  return prepared.startsWith('<') && CAMT054_ELEMENT.test(prepared)
}

/**
 * An xs:decimal amount as whole öre ("100", "100.5", "+100.00", ".50");
 * null when it is not one, is negative, or has more than two decimals that
 * matter.
 */
function decimalToOre(value: string): number | null {
  const match = /^\+?(\d*)(?:\.(\d*))?$/.exec(value.trim())
  if (!match) return null
  const whole = match[1] ?? ''
  const fraction = match[2] ?? ''
  if (whole.length + fraction.length === 0) return null
  if (/[1-9]/.test(fraction.slice(2))) return null
  return Number(whole || '0') * 100 + Number(fraction.slice(0, 2).padEnd(2, '0'))
}

/** xs:boolean: "true" or "1". */
const isTrue = (value: string | null): boolean => value !== null && /^(true|1)$/i.test(value.trim())

/** The <RfrdDocInf> type codes that name an invoice the payment settles; with no code at all the number is read as one too. */
const INVOICE_DOCUMENTS = new Set(['CINV', 'MSIN', 'HIRI', 'SBIN', 'DEBN', 'DNFA'])
/** The type codes that name a credit note the payment deducts. */
const CREDIT_DOCUMENTS = new Set(['CREN', 'CNFA'])

function text(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').replace(/\s+/g, ' ').trim()
  return trimmed.length > 0 ? trimmed : null
}

/** The scheme of an <Othr> identification: <SchmeNm><Prtry> or <SchmeNm><Cd>, upper case. */
function schemeOf(other: string): string | null {
  return (extractNestedText(other, 'SchmeNm', 'Prtry') ?? extractNestedText(other, 'SchmeNm', 'Cd'))?.toUpperCase() ?? null
}

/** The bankgiro an account element names under the scheme BGNR, formatted; null when it names none. */
function accountBankgiro(account: string): string | null {
  for (const other of extractElements(account, 'Othr')) {
    if (schemeOf(other) === 'BGNR') return bankgiro(extractTextContent(other, 'Id') ?? '')
  }
  return null
}

/** A counterparty account as the bank gives it: a bankgiro formatted, else the IBAN, else the number. */
function accountAsGiven(account: string): string | null {
  return accountBankgiro(account) ?? text(extractTextContent(account, 'IBAN')) ?? text(extractNestedText(account, 'Othr', 'Id'))
}

/** What follows the account's own <Id>: its type, currency and name, then its owner and servicer, who carry ids of their own. */
const AFTER_ACCOUNT_ID = /<(?:Tp|Ccy|Nm|Ownr|Svcr)(?=[\s>/])/i

/**
 * The account a notification is for, read from the account's own <Id> (the
 * owner's organisation number is an <Othr> id too, and is not the account).
 * Länsförsäkringar types the account BGNR and prints the bankgiro as its
 * name; a notification may also identify the account by the bankgiro itself.
 * Neither is a bank account number.
 */
function notificationAccount(account: string | undefined): { identity: BankFileAccountIdentity | null; giro: string | null } {
  if (!account) return { identity: null, giro: null }
  const idEnd = account.search(AFTER_ACCOUNT_ID)
  const ownId = idEnd === -1 ? account : account.slice(0, idEnd)
  const ownGiro = accountBankgiro(ownId)
  const name = extractNestedText(account, 'Tp', 'Prtry')?.toUpperCase() === 'BGNR' ? (extractTextContent(account, 'Nm') ?? '') : ''
  // A bankgiro is 7 or 8 digits: a name that is anything else is a name.
  const typedGiro = /^\d{3,4}-?\d{4}$/.test(name.trim()) ? bankgiro(name) : null
  const identity = ownGiro
    ? null
    : accountIdentity({ iban: extractTextContent(ownId, 'IBAN'), account_number: extractNestedText(ownId, 'Othr', 'Id') })
  return { identity, giro: ownGiro ?? typedGiro }
}

interface PaymentDraft extends Omit<Camt054Payment, 'amount' | 'kind'> {
  /** Whole öre, unsigned; null when the payment states no amount of its own. */
  ore: number | null
  currency: string | null
  /** The payment is itself a debit inside the entry (<CdtDbtInd>DBIT). */
  debit: boolean
  /** Every structured remittance of the payment is a credit note: a deduction the bank reports on its own. */
  creditNoteOnly: boolean
  receiver_bankgiro: string | null
}

/** The elements of <TxDtls> that follow its own <Amt> and <CdtDbtInd> and may hold amounts of their own. */
const AFTER_OWN_AMOUNT = /<(?:AmtDtls|Avlbty|BkTxCd|Chrgs|Intrst|RltdPties|RltdAgts|RmtInf)(?=[\s>/])/i

function parsePayment(tx: string): PaymentDraft {
  const references = extractElements(tx, 'Refs')[0] ?? ''
  // <TxDtls>'s own <Amt> (camt.054.001.08) sits between <Refs> and the rest.
  const withoutRefs = references ? tx.replace(references, '') : tx
  const cut = withoutRefs.search(AFTER_OWN_AMOUNT)
  const own = cut === -1 ? withoutRefs : withoutRefs.slice(0, cut)
  const stated =
    extractAmount(extractElements(tx, 'TxAmt')[0] ?? '') ?? extractAmount(own) ?? extractAmount(extractElements(tx, 'InstdAmt')[0] ?? '')

  const parties = extractElements(tx, 'RltdPties')[0] ?? ''
  const debtor = extractElements(parties, 'Dbtr')[0] ?? ''
  const organisation = extractElements(debtor, 'OrgId')[0] ?? ''
  const payerOrg = orgNumber(extractNestedText(organisation, 'Othr', 'Id') ?? extractNestedText(organisation, 'Other', 'Id') ?? '')
  const debtorAccount = extractElements(parties, 'DbtrAcct')[0]
  const creditorAccount = extractElements(parties, 'CdtrAcct')[0]

  const remittance = extractElements(tx, 'RmtInf').join('')
  const structured = extractElements(remittance, 'Strd')
  const ocr: string[] = []
  const invoiceNumbers: string[] = []
  const creditReferences: string[] = []
  let credits = 0
  for (const part of structured) {
    // A document of another kind (a purchase order, a contract, a statement
    // of account) is not an invoice: its number is left out, so it never
    // suggests the invoice that happens to share it.
    const documents = extractElements(part, 'RfrdDocInf').map((doc) => ({
      code: (extractNestedText(doc, 'CdOrPrtry', 'Cd') ?? extractNestedText(doc, 'CdOrPrtry', 'Prtry'))?.toUpperCase() ?? null,
      number: text(extractTextContent(doc, 'Nb')),
    }))
    const isCredit =
      documents.some((doc) => doc.code !== null && CREDIT_DOCUMENTS.has(doc.code)) ||
      (extractAmount(part, 'CdtNoteAmt') !== null && extractAmount(part, 'RmtdAmt') === null)
    if (isCredit) credits++
    const numbers = documents
      .filter((doc) => doc.code === null || INVOICE_DOCUMENTS.has(doc.code) || CREDIT_DOCUMENTS.has(doc.code))
      .map((doc) => doc.number)
      .filter((n): n is string => n !== null)
    const creditorReferences = extractElements(part, 'CdtrRefInf')
      .map((ref) => text(extractTextContent(ref, 'Ref')))
      .filter((r): r is string => r !== null)
    if (isCredit) creditReferences.push(...creditorReferences, ...numbers)
    else {
      ocr.push(...creditorReferences)
      invoiceNumbers.push(...numbers)
    }
  }
  // The OCR first, then the invoice numbers, then what a credit note names.
  const all = [...new Set([...ocr, ...invoiceNumbers, ...creditReferences])]
  const reference = all[0] ?? null

  const messages = [...extractAllText(remittance, 'Ustrd'), ...extractAllText(remittance, 'AddtlRmtInf')]

  return {
    ore: stated ? decimalToOre(stated.value) : null,
    currency: stated?.currency ?? null,
    debit: extractTextContent(own, 'CdtDbtInd')?.toUpperCase() === 'DBIT',
    creditNoteOnly: structured.length > 0 && credits === structured.length,
    receiver_bankgiro: creditorAccount ? accountBankgiro(creditorAccount) : null,
    payer_bankgiro: debtorAccount ? accountAsGiven(debtorAccount) : null,
    reference,
    reference_code: reference === null ? '0' : ocr.includes(reference) ? '2' : '3',
    extra_references: all.slice(1),
    message: text(messages.join(' ')),
    payer_name: text(extractTextContent(debtor, 'Nm')),
    payer_org_number: payerOrg && payerOrg.length === 10 ? payerOrg : null,
    bgc_serial:
      text(extractTextContent(references, 'ClrSysRef')) ??
      text(extractTextContent(references, 'AcctSvcrRef')) ??
      text(extractTextContent(references, 'PmtInfId')) ??
      text(extractTextContent(references, 'TxId')),
  }
}

/**
 * The signed öre of each payment, when they add up to the entry: as stated
 * (a payment marked DBIT subtracts), or, when that does not add up, with each
 * payment that is only a credit note subtracted (Länsförsäkringar reports a
 * BG Max deduction as a payment of its own). Null when neither reading
 * explains the entry.
 */
function signedOre(drafts: readonly PaymentDraft[], entryOre: number): number[] | null {
  if (drafts.some((d) => d.ore === null)) return null
  const stated = drafts.map((d) => (d.debit ? -d.ore! : d.ore!))
  if (stated.reduce((sum, n) => sum + n, 0) === entryOre) return stated
  if (!drafts.some((d) => d.creditNoteOnly)) return null
  const deducted = drafts.map((d, i) => (d.creditNoteOnly && !d.debit ? -d.ore! : stated[i]!))
  return deducted.reduce((sum, n) => sum + n, 0) === entryOre ? deducted : null
}

/**
 * Parse a camt.054 notification. Never throws on content: every problem
 * becomes an issue, and an entry whose payments do not add up to it is left
 * out, because its split would not explain the bank row.
 */
export function parseCamt054(content: string): Camt054ParseResult {
  const xml = stripNamespacePrefixes(plainXml(prepareContent(content)))
  const issues: Camt054Issue[] = []
  const deposits: Camt054Deposit[] = []
  let rejected = 0
  let skipped = 0
  let entryNo = 0

  for (const notification of extractElements(xml, 'Ntfctn')) {
    const firstEntry = notification.search(/<Ntry(?=[\s>/])/i)
    const header = firstEntry === -1 ? notification : notification.slice(0, firstEntry)
    const accountElement = extractElements(header, 'Acct')[0]
    const account = notificationAccount(accountElement)
    const accountCurrency = accountElement ? extractTextContent(accountElement, 'Ccy') : null

    for (const entry of extractElements(notification, 'Ntry')) {
      entryNo++
      // The entry's own fields come before its details; read them there so a
      // payment's amount, date or indicator is never taken for the entry's.
      const detailsAt = entry.search(/<NtryDtls(?=[\s>/])/i)
      const head = detailsAt === -1 ? entry : entry.slice(0, detailsAt)

      // A pending or informational entry is not a booking yet, and a reversal
      // or a debit is no deposit.
      const status = (extractNestedText(head, 'Sts', 'Cd') || extractTextContent(head, 'Sts'))?.toUpperCase()
      if (status === 'PDNG' || status === 'INFO') {
        skipped++
        issues.push({ entry: entryNo, severity: 'info', message: `Post ${entryNo} är inte bokförd (${status}) och hoppas över.` })
        continue
      }
      if (isTrue(extractTextContent(head, 'RvslInd')) || extractTextContent(head, 'CdtDbtInd')?.toUpperCase() !== 'CRDT') {
        skipped++
        continue
      }
      const details = extractElements(entry, 'TxDtls')
      if (details.length === 0) {
        skipped++
        issues.push({ entry: entryNo, severity: 'info', message: `Post ${entryNo} saknar betalningsuppgifter och hoppas över.` })
        continue
      }

      const valueDate = extractEntryDate(head, 'ValDt')
      const date = extractEntryDate(head, 'BookgDt') ?? valueDate
      const stated = extractAmount(head)
      const entryOre = stated ? decimalToOre(stated.value) : null
      if (!date || entryOre === null) {
        rejected++
        issues.push({ entry: entryNo, severity: 'error', message: `Post ${entryNo} har inget giltigt datum eller belopp; den kopplas inte.` })
        continue
      }
      const currency = (stated?.currency ?? accountCurrency ?? 'SEK').toUpperCase()

      const drafts = details.map(parsePayment)
      // A single payment that states no amount of its own is the whole entry.
      if (drafts.length === 1 && drafts[0]!.ore === null) drafts[0]!.ore = entryOre
      const signed = drafts.some((d) => d.currency !== null && d.currency !== currency) ? null : signedOre(drafts, entryOre)
      if (!signed) {
        rejected++
        issues.push({
          entry: entryNo,
          severity: 'error',
          message: `Postens belopp stämmer inte med summan av dess betalningar (post ${entryNo}); posten kopplas inte.`,
        })
        continue
      }
      // <Btch> states the batch the bank booked as this entry: its payment
      // count and, at some banks, the deposit serial number as its id.
      const batches = extractElements(entry, 'Btch')
      const declared = batches.map((batch) => Number(extractTextContent(batch, 'NbOfTxs') ?? NaN))
      if (declared.length > 0 && declared.every(Number.isFinite) && declared.reduce((sum, n) => sum + n, 0) !== drafts.length) {
        issues.push({ entry: entryNo, severity: 'warning', message: `Antalet betalningar i post ${entryNo} stämmer inte med postens uppgift.` })
      }

      const receivers = new Set(drafts.map((d) => d.receiver_bankgiro).filter((g): g is string => g !== null))
      const batchId = batches.length === 1 ? (extractTextContent(batches[0]!, 'MsgId') ?? '') : ''
      deposits.push({
        bankgiro: receivers.size === 1 ? [...receivers][0]! : receivers.size === 0 ? account.giro : null,
        bank_account: account.identity ? (account.identity.iban ?? account.identity.account_number) : null,
        account: account.identity,
        date,
        value_date: valueDate,
        booked: true,
        serial: /^\d{1,5}$/.test(batchId) ? batchId : null,
        amount: roundOre(entryOre / 100),
        currency,
        payments: drafts.map((draft, index): Camt054Payment => ({
          kind: signed[index]! < 0 ? 'deduction' : 'payment',
          amount: roundOre(signed[index]! / 100),
          payer_bankgiro: draft.payer_bankgiro,
          reference: draft.reference,
          reference_code: draft.reference_code,
          extra_references: draft.extra_references,
          message: draft.message,
          payer_name: draft.payer_name,
          payer_org_number: draft.payer_org_number,
          bgc_serial: draft.bgc_serial,
        })),
      })
    }
  }

  // A file cut short loses what was not yet closed: say so, as the BG Max reader does for a missing end record.
  if (!/<\/BkToCstmrDbtCdtNtfctn\s*>/i.test(xml)) {
    issues.unshift({ entry: 0, severity: 'warning', message: 'Filen saknar sitt slut (</BkToCstmrDbtCdtNtfctn>); den kan vara avkortad.' })
  }
  if (entryNo === 0) {
    issues.push({ entry: 0, severity: 'error', message: 'Inga poster (<Ntry>) hittades i camt.054-filen.' })
  }

  const dates = deposits.map((d) => d.date).sort()
  return {
    deposits,
    rejected_deposits: rejected,
    skipped_entries: skipped,
    date_from: dates[0] ?? null,
    date_to: dates[dates.length - 1] ?? null,
    issues,
  }
}
