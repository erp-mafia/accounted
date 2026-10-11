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
 *    goes in CdtrAgt as a ClrSysMmbId under clearing system SESBA, and the
 *    account number WITHOUT the clearing goes in CdtrAcct/Id/Othr with
 *    SchmeNm BBAN. The clearing/account split is shared with the Bankgirot
 *    LB generator (resolveDomesticBankAccount) so both formats present
 *    identical routing for Swedbank 5-digit clearings and Nordea personkonto.
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
 * Per BFL: the generated file is räkenskapsinformation (underlag) linked to
 * the salary journal entry. Subject to 7-year retention.
 */

import { escapeXml } from '@/lib/xml/escape'
import { previousBankDayIso } from '@/lib/payments/bank-days'
import { sanitizeMigText } from '@/lib/payments/mig-text'
import { SWEDBANK_BIC, swedbankCreditorAccount, type SwedbankFileIds } from '@/lib/payments/swedbank'
import { payeeAccountParts } from './bank-account'

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
  const totalAmount = employees.reduce((sum, e) => sum + e.netSalary, 0)
  const formattedTotal = formatDecimal(totalAmount)
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
  if (swedbank) {
    // MIG 2.0: "SignerID as assigned by Swedbank", SchmeNm BANK.
    pushBankAssignedId(lines, '        ', swedbank.signerId)
  } else if (orgDigits) {
    lines.push('        <Id>')
    lines.push('          <OrgId>')
    lines.push(`            <Othr><Id>${escapeXml(orgDigits)}</Id></Othr>`)
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
    pushBankAssignedId(lines, '        ', swedbank.corporatePayId)
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
  for (let i = 0; i < employees.length; i++) {
    const emp = employees[i]
    const txId = pain001TransactionId(msgId, i)
    const { memberId, accountId } = swedbank
      ? swedbankCreditorAccount(emp.name, emp.clearingNumber, emp.bankAccountNumber)
      : domesticRouting(emp)

    lines.push('      <CdtTrfTxInf>')
    lines.push('        <PmtId>')
    lines.push(`          <InstrId>${escapeXml(txId)}</InstrId>`)
    lines.push(`          <EndToEndId>${escapeXml(txId)}</EndToEndId>`)
    lines.push('        </PmtId>')
    lines.push('        <Amt>')
    lines.push(`          <InstdAmt Ccy="SEK">${formatDecimal(emp.netSalary)}</InstdAmt>`)
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

/** The routing every bank but Swedbank takes: 4-digit clearing, account without it. */
function domesticRouting(emp: Pain001Employee): { memberId: string; accountId: string } {
  const { clearing4, accountDigits } = payeeAccountParts(emp.name, emp.clearingNumber, emp.bankAccountNumber)
  return { memberId: clearing4, accountId: accountDigits }
}

/** Party Id/OrgId/Othr carrying an id the bank assigned (SchmeNm BANK). */
function pushBankAssignedId(lines: string[], indent: string, id: string): void {
  lines.push(`${indent}<Id>`)
  lines.push(`${indent}  <OrgId>`)
  lines.push(`${indent}    <Othr><Id>${escapeXml(id)}</Id><SchmeNm><Cd>BANK</Cd></SchmeNm></Othr>`)
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

/** Format number as decimal with 2 decimal places (ISO 20022 requires dot separator) */
function formatDecimal(amount: number): string {
  return (Math.round(amount * 100) / 100).toFixed(2)
}

/** Truncate to Max35Text. */
function max35(value: string): string {
  return value.slice(0, 35)
}

/** Append a suffix to a base id, truncating the BASE so the result stays
 *  Max35Text: the suffix carries the uniqueness (per-tx counter) and must
 *  survive intact. */
function suffixId(base: string, suffix: string): string {
  return base.slice(0, Math.max(1, 35 - suffix.length)) + suffix
}
