/**
 * pain.001 (ISO 20022) payment file generator for supplier payments
 * (leverantorsbetalningar).
 *
 * Dialect: Swedish DOMESTIC giro credit transfers per the Swedish Common
 * Interpretation of ISO 20022 payment messages (Svenska Bankforeningen,
 * "Common Payment Types in Sweden", Appendix 1: bankgiro, plusgiro and
 * account payees), cross-checked against Nordea Corporate Access Payables
 * pain.001 examples v2.6 (2026-06-22). Target banks: Swedbank, SEB,
 * Handelsbanken, Nordea (pain.001.001.03 uploaded in the corporate portal).
 *
 * Wire-format constraints this file encodes (do not "improve" without a bank
 * implementation guide in hand):
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
 *  - A Luhn-valid OCR reference rides RmtInf/Strd/CdtrRefInf with type code
 *    SCOR, exactly one per transaction. Anything else is an unstructured
 *    RmtInf/Ustrd message (the giro "meddelande" field).
 *  - MsgId, PmtInfId, InstrId and EndToEndId are Max35Text.
 *  - ReqdExctnDt sits on PmtInf, so payments are grouped into one PmtInf per
 *    distinct payment date.
 *  - Determinism: CreDtTm comes from the caller (the batch row's created_at),
 *    never from the clock, so re-generating a stored batch is byte-identical
 *    and bank-side duplicate detection (keyed on MsgId) stays meaningful.
 *
 * Per BFL: the generated file is rakenskapsinformation (underlag) for the
 * payments it initiates. Subject to 7-year retention.
 */

import { roundOre } from '@/lib/money'
import { splitDomesticBankAccount } from '@/lib/salary/payment/bank-account'
import type { PaymentReference, SupplierPayee } from './supplier-payee'

export interface SupplierPain001Debtor {
  name: string
  orgNumber: string
  iban: string
  bic: string
}

export interface SupplierPain001Payment {
  payee: SupplierPayee
  payeeName: string
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
  // Sum the per-transaction amounts exactly as they are rendered (rounded to
  // ore): CtrlSum must equal the sum of the InstdAmt values or banks reject
  // the file, and summing raw floats then rounding once can differ by an ore.
  const totalAmount = sumRendered(payments)

  // One PmtInf per distinct execution date, dates ascending; original order
  // preserved within a date so the file reads like the batch it came from.
  const byDate = new Map<string, SupplierPain001Payment[]>()
  for (const payment of payments) {
    const group = byDate.get(payment.paymentDate)
    if (group) group.push(payment)
    else byDate.set(payment.paymentDate, [payment])
  }
  const dates = [...byDate.keys()].sort()

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
  lines.push(`        <Nm>${escapeXml(debtor.name)}</Nm>`)
  if (orgDigits) {
    lines.push('        <Id>')
    lines.push('          <OrgId>')
    lines.push(`            <Othr><Id>${escapeXml(orgDigits)}</Id></Othr>`)
    lines.push('          </OrgId>')
    lines.push('        </Id>')
  }
  lines.push('      </InitgPty>')
  lines.push('    </GrpHdr>')

  let txCounter = 0
  for (let g = 0; g < dates.length; g++) {
    const date = dates[g]
    const group = byDate.get(date) as SupplierPain001Payment[]
    const groupTotal = sumRendered(group)

    lines.push('    <PmtInf>')
    lines.push(`      <PmtInfId>${escapeXml(suffixId(msgId, `-P${g + 1}`))}</PmtInfId>`)
    lines.push('      <PmtMtd>TRF</PmtMtd>')
    lines.push('      <BtchBookg>true</BtchBookg>')
    lines.push(`      <NbOfTxs>${group.length}</NbOfTxs>`)
    lines.push(`      <CtrlSum>${formatDecimal(groupTotal)}</CtrlSum>`)
    lines.push(`      <ReqdExctnDt>${date}</ReqdExctnDt>`)
    lines.push('      <Dbtr>')
    lines.push(`        <Nm>${escapeXml(debtor.name)}</Nm>`)
    if (orgDigits) {
      lines.push('        <Id>')
      lines.push('          <OrgId>')
      lines.push(`            <Othr><Id>${escapeXml(orgDigits)}</Id></Othr>`)
      lines.push('          </OrgId>')
      lines.push('        </Id>')
    }
    lines.push('      </Dbtr>')
    lines.push('      <DbtrAcct>')
    lines.push('        <Id>')
    lines.push(`          <IBAN>${escapeXml(debtor.iban)}</IBAN>`)
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
      pushRemittance(lines, payment.reference)
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
  lines.push(`          <Nm>${escapeXml(payment.payeeName)}</Nm>`)
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

function pushRemittance(lines: string[], reference: PaymentReference): void {
  lines.push('        <RmtInf>')
  if (reference.type === 'ocr') {
    lines.push('          <Strd>')
    lines.push('            <CdtrRefInf>')
    lines.push('              <Tp>')
    lines.push('                <CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry>')
    lines.push('              </Tp>')
    lines.push(`              <Ref>${escapeXml(reference.value)}</Ref>`)
    lines.push('            </CdtrRefInf>')
    lines.push('          </Strd>')
  } else {
    lines.push(`          <Ustrd>${escapeXml(reference.value.slice(0, USTRD_MAX))}</Ustrd>`)
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

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
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
