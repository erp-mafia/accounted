/**
 * pain.001 (ISO 20022) payment file generator for supplier payments
 * (leverantorsbetalningar).
 *
 * Dialect: Swedish DOMESTIC giro credit transfers per the Swedish Common
 * Interpretation of ISO 20022 payment messages (Svenska Bankforeningen,
 * "Common Payment Types in Sweden", Appendix 1), cross-checked against
 * Nordea Corporate Access Payables pain.001 examples v2.6 (2026-06-22) and
 * validated against Swedbank Validex (eken.validex.net, Swedbank MIG 1.0,
 * run 2026-08-10). Target banks: Swedbank, SEB, Handelsbanken, Nordea
 * (pain.001.001.03 uploaded in the corporate portal).
 *
 * Wire-format constraints this file encodes (do not "improve" without a
 * bank implementation guide in hand):
 *
 *  - No SvcLvl element: SvcLvl SEPA means a SEPA credit transfer (EUR-only);
 *    the domestic default (NURG) applies when SvcLvl is omitted. No CtgyPurp:
 *    SALA/PENS mark salary rails; supplier giro payments are plain transfers.
 *  - Bankgiro payees are addressed through Bankgirot: CdtrAgt ClrSysMmbId
 *    SESBA member 9900, CdtrAcct/Id/Othr with the bare BG digits and
 *    SchmeNm/Prtry BGNR. Plusgiro payees route SESBA member 9960 with
 *    SchmeNm/Cd BBAN. Bank-account payees use the clearing number as the
 *    SESBA member and the account (without clearing) as BBAN, through the
 *    same splitDomesticBankAccount used by the salary generator so the two
 *    files can never route an account differently.
 *  - Swedbank MIG (Validex PFH_pain_001_001_03_219): a BGNR creditor demands
 *    a BGNR debtor. When the company has a bankgiro, bankgiro-payee payments
 *    are grouped into their own PmtInf debited from the company bankgiro
 *    (DbtrAcct Othr/BGNR); other payees are debited from the IBAN.
 *  - Creditor postal address ALWAYS (Validex round 3, rule PFH_237 fires on
 *    the BGNR path too, overriding what rule 020's phrasing suggested), and
 *    a present PstlAdr must carry TwnNm (rule PFH_222, enforced now): the
 *    supplier's town when known, plus Ctry SE (v1 is domestic-only). A payee
 *    without a town yields a Ctry-only address that Swedbank rejects, so the
 *    preview warns when the supplier register lacks a city. The debtor
 *    address rides along the same way from company settings.
 *  - InitgPty and Dbtr always carry OrgId (Validex PFH_002: InitgPty
 *    other/Id must be stated); the batch service refuses to create a batch
 *    for a company without an organisationsnummer.
 *  - A Luhn-valid OCR reference rides RmtInf/Strd with the amount repeated
 *    as RfrdDocAmt/RmtdAmt (Validex PFH_217) and CdtrRefInf type SCOR,
 *    exactly one per transaction. Anything else is an unstructured
 *    RmtInf/Ustrd message (the giro "meddelande" field).
 *  - Free text is restricted to the MIG character set (Validex PFH_214):
 *    Swedish letters survive, other accented letters transliterate (e for
 *    e-acute, u for u-umlaut), anything else becomes '?'. Identifiers and
 *    references are ASCII digits by construction.
 *  - MsgId, PmtInfId, InstrId and EndToEndId are Max35Text.
 *  - ReqdExctnDt sits on PmtInf, so payments are grouped into one PmtInf per
 *    distinct (payment date, debtor account form).
 *  - Determinism: CreDtTm comes from the caller (the batch row's created_at),
 *    never from the clock, so re-generating a stored batch is byte-identical
 *    for the same generator version and bank-side duplicate detection (keyed
 *    on MsgId) stays meaningful.
 *
 * Per BFL: the generated file is rakenskapsinformation (underlag) for the
 * payments it initiates. Subject to 7-year retention.
 */

import { escapeXml } from '@/lib/xml/escape'
import { roundOre } from '@/lib/money'
import { splitDomesticBankAccount } from '@/lib/salary/payment/bank-account'
import type { PaymentReference, SupplierPayee } from './supplier-payee'

export interface SupplierPain001Debtor {
  name: string
  orgNumber: string
  iban: string
  bic: string
  /** Company bankgiro (digits); enables the BGNR-to-BGNR debit Swedbank wants. */
  bankgiro?: string | null
  /** Company town; emitted as Dbtr/PstlAdr/TwnNm when present. */
  city?: string | null
}

export interface SupplierPain001Payment {
  payee: SupplierPayee
  payeeName: string
  /** Supplier town; Cdtr/PstlAdr/TwnNm on IBAN-debited payments when known. */
  payeeCity?: string | null
  amount: number
  /** YYYY-MM-DD requested execution date. */
  paymentDate: string
  reference: PaymentReference
}

export interface SupplierPain001Options {
  /** Stored batch msg_id; reused verbatim on regeneration. */
  messageId: string
  /** Batch created_at (ISO timestamp): becomes CreDtTm, NOT the clock. */
  createdAt: string
}

/** The receiver-side giro message field is 25 positions; keep Ustrd within it. */
const USTRD_MAX = 25

export function generateSupplierPain001(
  debtor: SupplierPain001Debtor,
  payments: SupplierPain001Payment[],
  options: SupplierPain001Options,
): string {
  if (payments.length === 0) {
    throw new Error('Betalfilen måste innehålla minst en betalning')
  }

  const creDtTm = new Date(options.createdAt).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const msgId = max35(options.messageId)
  const orgDigits = debtor.orgNumber.replace(/\D/g, '')
  if (!orgDigits) {
    // Validex PFH_002: InitgPty other/Id must be stated. The batch service
    // guarantees this; a missing org number here is a programming error.
    throw new Error('Organisationsnummer saknas för betalfilens avsändare')
  }
  const debtorBankgiro = (debtor.bankgiro ?? '').replace(/\D/g, '')
  const debtorName = sanitizeText(debtor.name)
  // Sum the per-transaction amounts exactly as they are rendered (rounded to
  // ore): CtrlSum must equal the sum of the InstdAmt values or banks reject
  // the file, and summing raw floats then rounding once can differ by an ore.
  const totalAmount = sumRendered(payments)

  // One PmtInf per distinct (execution date, debtor account form): a BGNR
  // creditor must debit the company bankgiro (Swedbank rule 219), everything
  // else debits the IBAN, and ReqdExctnDt is PmtInf-level. Original order is
  // preserved within a group so the file reads like the batch it came from.
  const byGroup = new Map<string, SupplierPain001Payment[]>()
  for (const payment of payments) {
    const bgnrDebit = debtorBankgiro !== '' && payment.payee.type === 'bankgiro'
    const key = `${payment.paymentDate}|${bgnrDebit ? 'bgnr' : 'acct'}`
    const group = byGroup.get(key)
    if (group) group.push(payment)
    else byGroup.set(key, [payment])
  }
  const groupKeys = [...byGroup.keys()].sort()

  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"')
  lines.push('  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">')
  lines.push('  <CstmrCdtTrfInitn>')

  lines.push('    <GrpHdr>')
  lines.push(`      <MsgId>${escapeXml(msgId)}</MsgId>`)
  lines.push(`      <CreDtTm>${creDtTm}</CreDtTm>`)
  lines.push(`      <NbOfTxs>${payments.length}</NbOfTxs>`)
  lines.push(`      <CtrlSum>${formatDecimal(totalAmount)}</CtrlSum>`)
  lines.push('      <InitgPty>')
  lines.push(`        <Nm>${escapeXml(debtorName)}</Nm>`)
  lines.push('        <Id>')
  lines.push('          <OrgId>')
  lines.push(`            <Othr><Id>${escapeXml(orgDigits)}</Id></Othr>`)
  lines.push('          </OrgId>')
  lines.push('        </Id>')
  lines.push('      </InitgPty>')
  lines.push('    </GrpHdr>')

  let txCounter = 0
  for (let g = 0; g < groupKeys.length; g++) {
    const key = groupKeys[g]
    const [date, form] = key.split('|')
    const group = byGroup.get(key) as SupplierPain001Payment[]
    const groupTotal = sumRendered(group)
    const bgnrDebit = form === 'bgnr'

    lines.push('    <PmtInf>')
    lines.push(`      <PmtInfId>${escapeXml(suffixId(msgId, `-P${g + 1}`))}</PmtInfId>`)
    lines.push('      <PmtMtd>TRF</PmtMtd>')
    lines.push('      <BtchBookg>true</BtchBookg>')
    lines.push(`      <NbOfTxs>${group.length}</NbOfTxs>`)
    lines.push(`      <CtrlSum>${formatDecimal(groupTotal)}</CtrlSum>`)
    lines.push(`      <ReqdExctnDt>${date}</ReqdExctnDt>`)
    lines.push('      <Dbtr>')
    lines.push(`        <Nm>${escapeXml(debtorName)}</Nm>`)
    // XSD order in PostalAddress6: TwnNm before Ctry; PstlAdr before Id.
    if (debtor.city?.trim()) {
      lines.push('        <PstlAdr>')
      lines.push(`          <TwnNm>${escapeXml(sanitizeText(debtor.city.trim()))}</TwnNm>`)
      lines.push('          <Ctry>SE</Ctry>')
      lines.push('        </PstlAdr>')
    }
    lines.push('        <Id>')
    lines.push('          <OrgId>')
    lines.push(`            <Othr><Id>${escapeXml(orgDigits)}</Id></Othr>`)
    lines.push('          </OrgId>')
    lines.push('        </Id>')
    lines.push('      </Dbtr>')
    lines.push('      <DbtrAcct>')
    lines.push('        <Id>')
    if (bgnrDebit) {
      lines.push('          <Othr>')
      lines.push(`            <Id>${escapeXml(debtorBankgiro)}</Id>`)
      lines.push('            <SchmeNm><Prtry>BGNR</Prtry></SchmeNm>')
      lines.push('          </Othr>')
    } else {
      lines.push(`          <IBAN>${escapeXml(debtor.iban)}</IBAN>`)
    }
    lines.push('        </Id>')
    lines.push('        <Ccy>SEK</Ccy>')
    lines.push('      </DbtrAcct>')
    lines.push('      <DbtrAgt>')
    lines.push('        <FinInstnId>')
    lines.push(`          <BIC>${escapeXml(debtor.bic)}</BIC>`)
    lines.push('        </FinInstnId>')
    lines.push('      </DbtrAgt>')

    for (const payment of group) {
      txCounter += 1
      const txId = suffixId(msgId, `-TX${String(txCounter).padStart(4, '0')}`)

      lines.push('      <CdtTrfTxInf>')
      lines.push('        <PmtId>')
      lines.push(`          <InstrId>${escapeXml(txId)}</InstrId>`)
      lines.push(`          <EndToEndId>${escapeXml(txId)}</EndToEndId>`)
      lines.push('        </PmtId>')
      lines.push('        <Amt>')
      lines.push(`          <InstdAmt Ccy="SEK">${formatDecimal(payment.amount)}</InstdAmt>`)
      lines.push('        </Amt>')
      pushCreditor(lines, payment)
      pushRemittance(lines, payment.reference, payment.amount)
      lines.push('      </CdtTrfTxInf>')
    }

    lines.push('    </PmtInf>')
  }

  lines.push('  </CstmrCdtTrfInitn>')
  lines.push('</Document>')

  return lines.join('\n')
}

/** XSD order within CdtTrfTxInf: CdtrAgt before Cdtr before CdtrAcct. */
function pushCreditor(lines: string[], payment: SupplierPain001Payment): void {
  const { payee } = payment

  let memberId: string
  let accountId: string
  let scheme: string
  switch (payee.type) {
    case 'bankgiro':
      memberId = '9900'
      accountId = payee.bankgiro
      scheme = '<SchmeNm><Prtry>BGNR</Prtry></SchmeNm>'
      break
    case 'plusgiro':
      memberId = '9960'
      accountId = payee.plusgiro
      scheme = '<SchmeNm><Cd>BBAN</Cd></SchmeNm>'
      break
    case 'bank_account': {
      const { clearing4, accountDigits } = splitDomesticBankAccount(payee.clearing, payee.account)
      memberId = clearing4
      accountId = accountDigits
      scheme = '<SchmeNm><Cd>BBAN</Cd></SchmeNm>'
      break
    }
  }

  lines.push('        <CdtrAgt>')
  lines.push('          <FinInstnId>')
  lines.push('            <ClrSysMmbId>')
  lines.push('              <ClrSysId><Cd>SESBA</Cd></ClrSysId>')
  lines.push(`              <MmbId>${memberId}</MmbId>`)
  lines.push('            </ClrSysMmbId>')
  lines.push('          </FinInstnId>')
  lines.push('        </CdtrAgt>')
  lines.push('        <Cdtr>')
  lines.push(`          <Nm>${escapeXml(sanitizeText(payment.payeeName))}</Nm>`)
  // Always (Validex round 3, rule 237 fires on every path): the supplier's
  // town when known and country SE (v1 scope). XSD order: TwnNm before Ctry.
  lines.push('          <PstlAdr>')
  if (payment.payeeCity?.trim()) {
    lines.push(`            <TwnNm>${escapeXml(sanitizeText(payment.payeeCity.trim()))}</TwnNm>`)
  }
  lines.push('            <Ctry>SE</Ctry>')
  lines.push('          </PstlAdr>')
  lines.push('        </Cdtr>')
  lines.push('        <CdtrAcct>')
  lines.push('          <Id>')
  lines.push('            <Othr>')
  lines.push(`              <Id>${escapeXml(accountId)}</Id>`)
  lines.push(`              ${scheme}`)
  lines.push('            </Othr>')
  lines.push('          </Id>')
  lines.push('        </CdtrAcct>')
}

function pushRemittance(lines: string[], reference: PaymentReference, amount: number): void {
  lines.push('        <RmtInf>')
  if (reference.type === 'ocr') {
    lines.push('          <Strd>')
    // Validex PFH_217: RfrdDocAmt must be stated when Strd is provided. The
    // remitted amount equals the instructed amount for a full-line payment.
    lines.push('            <RfrdDocAmt>')
    lines.push(`              <RmtdAmt Ccy="SEK">${formatDecimal(amount)}</RmtdAmt>`)
    lines.push('            </RfrdDocAmt>')
    lines.push('            <CdtrRefInf>')
    lines.push('              <Tp>')
    lines.push('                <CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry>')
    lines.push('              </Tp>')
    lines.push(`              <Ref>${escapeXml(reference.value)}</Ref>`)
    lines.push('            </CdtrRefInf>')
    lines.push('          </Strd>')
  } else {
    lines.push(`          <Ustrd>${escapeXml(sanitizeText(reference.value).slice(0, USTRD_MAX))}</Ustrd>`)
  }
  lines.push('        </RmtInf>')
}

// ============================================================
// Helpers (deliberately duplicated from the salary generator: that dialect is
// production-hardened and stays untouched; see DECISIONS.md 2026-08-10)
// ============================================================

/** Control sums add the amounts AS RENDERED: each rounded to öre first. */
function sumRendered(payments: readonly SupplierPain001Payment[]): number {
  return payments.reduce((sum, p) => sum + roundOre(p.amount), 0)
}

/**
 * MIG character-set restriction (Validex PFH_pain_001_001_03_214): Swedish
 * letters pass through, other accented Latin letters transliterate to their
 * base letter, and anything still outside the allowed set becomes '?', the
 * same substitution the Bankgirot LB generator uses. Sanitize BEFORE
 * escapeXml so entity-encoded characters are never mangled.
 */
const TRANSLITERATIONS: Record<string, string> = {
  'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e', 'É': 'E', 'È': 'E', 'Ê': 'E', 'Ë': 'E',
  'á': 'a', 'à': 'a', 'â': 'a', 'ã': 'a', 'Á': 'A', 'À': 'A', 'Â': 'A', 'Ã': 'A',
  'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i', 'Í': 'I', 'Ì': 'I', 'Î': 'I', 'Ï': 'I',
  'ó': 'o', 'ò': 'o', 'ô': 'o', 'õ': 'o', 'Ó': 'O', 'Ò': 'O', 'Ô': 'O', 'Õ': 'O',
  'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u', 'Ú': 'U', 'Ù': 'U', 'Û': 'U', 'Ü': 'U',
  'ý': 'y', 'ÿ': 'y', 'Ý': 'Y', 'ñ': 'n', 'Ñ': 'N', 'ç': 'c', 'Ç': 'C',
  'ø': 'o', 'Ø': 'O', 'æ': 'a', 'Æ': 'A', 'ß': 'ss',
  'š': 's', 'Š': 'S', 'ž': 'z', 'Ž': 'Z', 'đ': 'd', 'Đ': 'D',
  // '+' is in the allowed set and reads naturally where Swedish names use '&'.
  '&': '+',
}

const DISALLOWED_TEXT = /[^0-9A-Za-zåäöÅÄÖ/\-?:().,'+ ]/g

function sanitizeText(value: string): string {
  // NFC first: decomposed input (base letter + combining mark, common in text
  // pasted from PDFs) must fold to the precomposed forms the map knows.
  let transliterated = ''
  for (const ch of value.normalize('NFC')) transliterated += TRANSLITERATIONS[ch] ?? ch
  return transliterated.replace(DISALLOWED_TEXT, '?')
}

function formatDecimal(amount: number): string {
  return roundOre(amount).toFixed(2)
}

function max35(value: string): string {
  return value.slice(0, 35)
}

function suffixId(base: string, suffix: string): string {
  return base.slice(0, Math.max(1, 35 - suffix.length)) + suffix
}
