/**
 * pain.001 (ISO 20022) payment file generator for salary batch payments.
 *
 * Dialect: Swedish DOMESTIC salary credit transfers per the Swedish Common
 * Interpretation of ISO 20022 payment messages (Svenska Bankföreningen,
 * "Common Payment Types in Sweden", Appendix 1, Example 4: Salaries),
 * cross-checked against Nordea Corporate Access Payables pain.001 examples
 * v2.6 (2026-06-22). Target banks: Swedbank, SEB, Handelsbanken, Nordea
 * (pain.001.001.03 uploaded in the bank's corporate portal).
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
 *    LB generator (splitDomesticBankAccount) so both formats present
 *    identical routing for Swedbank 5-digit clearings and Nordea personkonto.
 *  - MsgId, PmtInfId, InstrId and EndToEndId are Max35Text: bases are
 *    truncated so suffixes always fit.
 *
 * Per BFL: the generated file is räkenskapsinformation (underlag) linked to
 * the salary journal entry. Subject to 7-year retention.
 */

import { splitDomesticBankAccount } from './bank-account'

export interface Pain001CompanyData {
  name: string
  orgNumber: string       // NNNNNN-NNNN
  iban: string            // SE + 22 digits (the company's own account)
  bic: string             // debtor bank SWIFT/BIC
}

export interface Pain001Employee {
  name: string
  clearingNumber: string
  bankAccountNumber: string
  netSalary: number       // Amount to pay
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
  lines.push(`        <Nm>${escapeXml(company.name)}</Nm>`)
  if (orgDigits) {
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
  lines.push('        <CtgyPurp><Cd>SALA</Cd></CtgyPurp>')  // Salary payment
  lines.push('      </PmtTpInf>')
  lines.push(`      <ReqdExctnDt>${options.paymentDate}</ReqdExctnDt>`)

  // Debtor (company)
  lines.push('      <Dbtr>')
  lines.push(`        <Nm>${escapeXml(company.name)}</Nm>`)
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
  // The company (debtor) is identified by its own IBAN: the canonical form every
  // Swedish bank accepts for the payer. Employees (creditors) stay on domestic
  // clearing+account below, which is what Swedish payroll actually collects.
  lines.push(`          <IBAN>${escapeXml(company.iban)}</IBAN>`)
  lines.push('        </Id>')
  lines.push('        <Ccy>SEK</Ccy>')
  lines.push('      </DbtrAcct>')
  lines.push('      <DbtrAgt>')
  lines.push('        <FinInstnId>')
  lines.push(`          <BIC>${escapeXml(company.bic)}</BIC>`)
  lines.push('        </FinInstnId>')
  lines.push('      </DbtrAgt>')

  // ─── Per-employee credit transfers ───
  for (let i = 0; i < employees.length; i++) {
    const emp = employees[i]
    const txSuffix = `-TX${String(i + 1).padStart(4, '0')}`
    const txId = suffixId(msgId, txSuffix)
    const { clearing4, accountDigits } = splitDomesticBankAccount(
      emp.clearingNumber,
      emp.bankAccountNumber
    )

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
    lines.push(`              <MmbId>${clearing4}</MmbId>`)
    lines.push('            </ClrSysMmbId>')
    lines.push('          </FinInstnId>')
    lines.push('        </CdtrAgt>')
    lines.push('        <Cdtr>')
    lines.push(`          <Nm>${escapeXml(emp.name)}</Nm>`)
    lines.push('        </Cdtr>')
    lines.push('        <CdtrAcct>')
    lines.push('          <Id>')
    lines.push('            <Othr>')
    lines.push(`              <Id>${accountDigits}</Id>`)
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

// ============================================================
// Helpers
// ============================================================

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
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
