/**
 * pain.001 (ISO 20022) payment file generator for salary batch payments.
 *
 * Dialect: Swedish DOMESTIC salary credit transfers per the Swedish Common
 * Interpretation of ISO 20022 payment messages (Svenska Bankföreningen,
 * "Common Payment Types in Sweden", Appendix 1, Example 4: Salaries),
 * cross-checked against Nordea Corporate Access Payables pain.001 examples
 * v2.6 (2026-06-22). Target banks: SEB, Handelsbanken, Nordea and every bank
 * without its own guide here (pain.001.001.03 uploaded in the bank's
 * corporate portal). Swedbank gets its own form, described further down.
 *
 * Wire-format constraints this file encodes (do not "improve" without a
 * bank implementation guide in hand):
 *
 *  - Salary batches are marked ONLY with CtgyPurp SALA. No SvcLvl element:
 *    SvcLvl SEPA means a SEPA credit transfer, which is EUR-only and wrong
 *    for SEK; the domestic default (NURG) applies when SvcLvl is omitted.
 *  - Remittance information is NOT allowed on Swedish salary payments
 *    (Nordea MIG: "No remittance info allowed"). The text on the employee's
 *    statement comes from the Dataclearing LÖN code derived from SALA.
 *  - The employee account is addressed domestically: the clearing number
 *    goes in CdtrAgt as a ClrSysMmbId under clearing system SESBA, and
 *    CdtrAcct/Id/Othr with SchmeNm BBAN holds the account in the form the
 *    company's bank reads (lib/payments/creditor-account.ts): without the
 *    clearing for most banks, with it for Danske Bank and Nordea, whose
 *    guides read the account from CdtrAcct alone. The clearing/account parts
 *    are shared with the Bankgirot LB generator (resolveDomesticBankAccount)
 *    so every format routes Swedbank 5-digit clearings and Nordea
 *    personkonto identically.
 *  - MsgId, PmtInfId, InstrId and EndToEndId are Max35Text: bases are
 *    truncated so suffixes always fit.
 *
 * Swedbank (debtor BIC SWEDSESS, the savings banks included) validates an
 * uploaded file against its own guide, "Message Implementation Guide
 * pain.001.001.03, Version 2.0.0" (MIG 2.0) with its Appendix and salary
 * example file, and refuses the form above (crm#1117). When the company has
 * entered Swedbank's ids (`company.swedbank`, lib/payments/swedbank.ts) the
 * file follows MIG 2.0 instead:
 *
 *  - InitgPty carries the SignerID and Dbtr the Corporate Pay agreement id,
 *    both with SchmeNm BANK: the org number identifies nothing there.
 *  - PmtTpInf carries SvcLvl NURG before CtgyPurp SALA ("Mandatory according
 *    to market practice guidelines").
 *  - ReqdExctnDt is Swedbank's debit day, the banking day before payday: the
 *    salary reaches the employee the banking day after the requested date
 *    (Appendix, Salary Payments). The run keeps payday as its payment date.
 *  - Dbtr and Cdtr carry PstlAdr (town when known, country SE) and DbtrAgt
 *    carries BIC SWEDSESS with country SE, as the MIG marks them required.
 *  - A clearing starting with 8 is written MmbId 8CCCC with a 15-digit BBAN
 *    (swedbankCreditorAccount); 4-digit clearings keep the separate form.
 *  - Names use the MIG 2.0 character set, which has no apostrophe.
 *
 * Nordea (`company.nordeaSignerId`, lib/payments/nordea.ts): InitgPty carries
 * the Signer ID with SchmeNm CUST, which Nordea's upload checks against the
 * file agreement (crm#1530); the rest keeps the common form. Which id
 * InitgPty carries is decided for every bank in
 * lib/payments/initiating-party.ts.
 *
 * Per BFL: the generated file is räkenskapsinformation (underlag) linked to
 * the salary journal entry. Subject to 7-year retention.
 */

import { escapeXml } from '@/lib/xml/escape'
import { formatPainAmount, max35, painControlSum, suffixId } from '@/lib/payments/pain001-format'
import { previousBankDayIso } from '@/lib/payments/bank-days'
import { sanitizeMigText } from '@/lib/payments/mig-text'
import { initiatingPartyId } from '@/lib/payments/initiating-party'
import { SWEDBANK_BIC, type SwedbankFileIds } from '@/lib/payments/swedbank'
import { creditorAccountForm, domesticCreditorAccount } from '@/lib/payments/creditor-account'

export interface Pain001CompanyData {
  name: string
  orgNumber: string       // NNNNNN-NNNN
  iban: string            // SE + 22 digits (the company's own account)
  bic: string             // debtor bank SWIFT/BIC
  /** Company town: Dbtr/PstlAdr/TwnNm in Swedbank's form. */
  city?: string | null
  /**
   * Swedbank's SignerID and Corporate Pay agreement id: set only for a
   * Swedbank debtor, and then the file takes Swedbank's MIG 2.0 form.
   */
  swedbank?: SwedbankFileIds | null
  /** Nordea's Signer ID: set only for a Nordea debtor, written as the InitgPty id. */
  nordeaSignerId?: string | null
}

export interface Pain001Employee {
  name: string
  clearingNumber: string
  bankAccountNumber: string
  netSalary: number       // Amount to pay
  /** Employee town: Cdtr/PstlAdr/TwnNm in Swedbank's form. */
  city?: string | null
}

export interface Pain001Options {
  messageId: string       // Unique message ID (truncated to Max35Text)
  paymentDate: string     // YYYY-MM-DD requested execution date
  periodLabel: string     // e.g. "2026-04" (kept out of the file body: salary
                          // payments carry no remittance info; used by callers
                          // for filenames only)
}

/**
 * Generate pain.001.001.03 XML for a Swedish domestic salary batch.
 *
 * Structure:
 *   Document > CstmrCdtTrfInitn > GrpHdr + PmtInf (one batch)
 *   PmtInf contains CdtTrfTxInf per employee
 */
export function generatePain001(
  company: Pain001CompanyData,
  employees: Pain001Employee[],
  options: Pain001Options
): string {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  // The amounts as rendered, so CtrlSum equals the sum of the InstdAmt values.
  const formattedTotal = formatPainAmount(painControlSum(employees.map((e) => e.netSalary)))
  const msgId = max35(options.messageId)
  const orgDigits = company.orgNumber.replace(/\D/g, '')
  const swedbank = company.swedbank ?? null
  // Free text: as given for the other banks, the MIG 2.0 character set for Swedbank.
  const text = (value: string) =>
    escapeXml(swedbank ? sanitizeMigText(value, { apostrophe: false }) : value)

  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"')
  lines.push('  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">')
  lines.push('  <CstmrCdtTrfInitn>')

  // ─── Group Header ───
  lines.push('    <GrpHdr>')
  lines.push(`      <MsgId>${escapeXml(msgId)}</MsgId>`)
  lines.push(`      <CreDtTm>${now}</CreDtTm>`)
  lines.push(`      <NbOfTxs>${employees.length}</NbOfTxs>`)
  lines.push(`      <CtrlSum>${formattedTotal}</CtrlSum>`)
  lines.push('      <InitgPty>')
  lines.push(`        <Nm>${text(company.name)}</Nm>`)
  // The sender as the debtor's bank knows it (initiating-party.ts): the
  // SignerID at Swedbank (BANK), the Signer ID at Nordea (CUST), the org
  // number elsewhere.
  const initiator = initiatingPartyId(company)
  if (initiator?.scheme) {
    pushSchemedId(lines, '        ', initiator.id, initiator.scheme)
  } else if (initiator) {
    lines.push('        <Id>')
    lines.push('          <OrgId>')
    lines.push(`            <Othr><Id>${escapeXml(initiator.id)}</Id></Othr>`)
    lines.push('          </OrgId>')
    lines.push('        </Id>')
  }
  lines.push('      </InitgPty>')
  lines.push('    </GrpHdr>')

  // ─── Payment Information ───
  lines.push('    <PmtInf>')
  lines.push(`      <PmtInfId>${escapeXml(suffixId(msgId, '-PMT'))}</PmtInfId>`)
  lines.push('      <PmtMtd>TRF</PmtMtd>')  // Transfer
  lines.push('      <BtchBookg>true</BtchBookg>')  // One debit for the batch
  lines.push(`      <NbOfTxs>${employees.length}</NbOfTxs>`)
  lines.push(`      <CtrlSum>${formattedTotal}</CtrlSum>`)
  lines.push('      <PmtTpInf>')
  // XSD order: SvcLvl before CtgyPurp. Swedbank requires NURG; the others default to it.
  if (swedbank) lines.push('        <SvcLvl><Cd>NURG</Cd></SvcLvl>')
  lines.push('        <CtgyPurp><Cd>SALA</Cd></CtgyPurp>')  // Salary payment
  lines.push('      </PmtTpInf>')
  // Swedbank's requested date is its debit day: the banking day before payday.
  const executionDate = swedbank ? previousBankDayIso(options.paymentDate) : options.paymentDate
  lines.push(`      <ReqdExctnDt>${executionDate}</ReqdExctnDt>`)

  // Debtor (company)
  lines.push('      <Dbtr>')
  lines.push(`        <Nm>${text(company.name)}</Nm>`)
  if (swedbank) {
    // XSD order: PstlAdr before Id. MIG 2.0: Corporate Pay agreement id, SchmeNm BANK.
    pushPostalAddress(lines, '        ', company.city, text)
    pushSchemedId(lines, '        ', swedbank.corporatePayId, 'BANK')
  } else if (orgDigits) {
    lines.push('        <Id>')
    lines.push('          <OrgId>')
    lines.push(`            <Othr><Id>${escapeXml(orgDigits)}</Id></Othr>`)
    lines.push('          </OrgId>')
    lines.push('        </Id>')
  }
  lines.push('      </Dbtr>')
  lines.push('      <DbtrAcct>')
  lines.push('        <Id>')
  // The company (debtor) is identified by its own IBAN: the canonical form every
  // Swedish bank accepts for the payer. Employees (creditors) stay on domestic
  // clearing+account below, which is what Swedish payroll actually collects.
  lines.push(`          <IBAN>${escapeXml(company.iban)}</IBAN>`)
  lines.push('        </Id>')
  lines.push('        <Ccy>SEK</Ccy>')
  lines.push('      </DbtrAcct>')
  lines.push('      <DbtrAgt>')
  lines.push('        <FinInstnId>')
  if (swedbank) {
    // MIG 2.0 allows SWEDSESS (or NOTPROVIDED) only, never a BIC11 variant.
    lines.push(`          <BIC>${SWEDBANK_BIC}</BIC>`)
    lines.push('          <PstlAdr><Ctry>SE</Ctry></PstlAdr>')
  } else {
    lines.push(`          <BIC>${escapeXml(company.bic)}</BIC>`)
  }
  lines.push('        </FinInstnId>')
  lines.push('      </DbtrAgt>')

  // ─── Per-employee credit transfers ───
  // The account form is the debtor bank's: it is the bank that reads the file.
  const accountForm = creditorAccountForm(company.bic, swedbank)
  for (let i = 0; i < employees.length; i++) {
    const emp = employees[i]
    const txId = pain001TransactionId(msgId, i)
    const { memberId, accountId } = domesticCreditorAccount(
      emp.name,
      emp.clearingNumber,
      emp.bankAccountNumber,
      accountForm,
    )

    lines.push('      <CdtTrfTxInf>')
    lines.push('        <PmtId>')
    lines.push(`          <InstrId>${escapeXml(txId)}</InstrId>`)
    lines.push(`          <EndToEndId>${escapeXml(txId)}</EndToEndId>`)
    lines.push('        </PmtId>')
    lines.push('        <Amt>')
    lines.push(`          <InstdAmt Ccy="SEK">${formatPainAmount(emp.netSalary)}</InstdAmt>`)
    lines.push('        </Amt>')
    // Creditor bank identified by clearing number in the Swedish clearing
    // system (SESBA). XSD order: CdtrAgt before Cdtr/CdtrAcct.
    lines.push('        <CdtrAgt>')
    lines.push('          <FinInstnId>')
    lines.push('            <ClrSysMmbId>')
    lines.push('              <ClrSysId><Cd>SESBA</Cd></ClrSysId>')
    lines.push(`              <MmbId>${memberId}</MmbId>`)
    lines.push('            </ClrSysMmbId>')
    lines.push('          </FinInstnId>')
    lines.push('        </CdtrAgt>')
    lines.push('        <Cdtr>')
    lines.push(`          <Nm>${text(emp.name)}</Nm>`)
    if (swedbank) pushPostalAddress(lines, '          ', emp.city, text)
    lines.push('        </Cdtr>')
    lines.push('        <CdtrAcct>')
    lines.push('          <Id>')
    lines.push('            <Othr>')
    lines.push(`              <Id>${accountId}</Id>`)
    lines.push('              <SchmeNm><Cd>BBAN</Cd></SchmeNm>')
    lines.push('            </Othr>')
    lines.push('          </Id>')
    lines.push('        </CdtrAcct>')
    // No RmtInf: not allowed for Swedish salary payments (SALA).
    lines.push('      </CdtTrfTxInf>')
  }

  lines.push('    </PmtInf>')
  lines.push('  </CstmrCdtTrfInitn>')
  lines.push('</Document>')

  return lines.join('\n')
}

/**
 * InstrId / EndToEndId of the credit transfer at `index` (0-based) in the
 * batch: the message id plus a per-transaction counter, Max35Text. Exported
 * so the bank list names each payment by the id the file carries.
 */
export function pain001TransactionId(messageId: string, index: number): string {
  return suffixId(max35(messageId), `-TX${String(index + 1).padStart(4, '0')}`)
}

// ============================================================
// Helpers
// ============================================================

/** A bank-assigned party id: Othr/Id with SchmeNm/Cd, BANK at Swedbank (MIG 2.0), CUST at Nordea. */
function pushSchemedId(lines: string[], indent: string, id: string, scheme: 'BANK' | 'CUST'): void {
  lines.push(`${indent}<Id>`)
  lines.push(`${indent}  <OrgId>`)
  lines.push(`${indent}    <Othr><Id>${escapeXml(id)}</Id><SchmeNm><Cd>${scheme}</Cd></SchmeNm></Othr>`)
  lines.push(`${indent}  </OrgId>`)
  lines.push(`${indent}</Id>`)
}

/** PstlAdr with the town when known and country SE (XSD order: TwnNm before Ctry). */
function pushPostalAddress(
  lines: string[],
  indent: string,
  town: string | null | undefined,
  text: (value: string) => string,
): void {
  lines.push(`${indent}<PstlAdr>`)
  if (town?.trim()) lines.push(`${indent}  <TwnNm>${text(town.trim())}</TwnNm>`)
  lines.push(`${indent}  <Ctry>SE</Ctry>`)
  lines.push(`${indent}</PstlAdr>`)
}


