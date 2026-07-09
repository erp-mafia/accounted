/**
 * pain.001 (ISO 20022) payment file generator for salary batch payments.
 *
 * Swedish banks (SEB, Handelsbanken, Swedbank, Nordea) accept
 * pain.001.001.03 for credit transfer initiation.
 *
 * The generated file is uploaded to the bank's corporate portal.
 */

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
  messageId: string       // Unique message ID
  paymentDate: string     // YYYY-MM-DD requested execution date
  periodLabel: string     // e.g. "2026-04" for remittance info
}

/**
 * Generate pain.001.001.03 XML for salary batch payment.
 *
 * Structure:
 *   Document > CstmrCdtTrfInitn > GrpHdr + PmtInf (one per batch)
 *   PmtInf contains CdtTrfTxInf per employee
 *
 * Per BFL: The generated file is räkenskapsinformation (underlag)
 * linked to the salary journal entry. Subject to 7-year retention.
 */
export function generatePain001(
  company: Pain001CompanyData,
  employees: Pain001Employee[],
  options: Pain001Options
): string {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const totalAmount = employees.reduce((sum, e) => sum + e.netSalary, 0)
  const formattedTotal = formatDecimal(totalAmount)

  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"')
  lines.push('  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">')
  lines.push('  <CstmrCdtTrfInitn>')

  // ─── Group Header ───
  lines.push('    <GrpHdr>')
  lines.push(`      <MsgId>${escapeXml(options.messageId)}</MsgId>`)
  lines.push(`      <CreDtTm>${now}</CreDtTm>`)
  lines.push(`      <NbOfTxs>${employees.length}</NbOfTxs>`)
  lines.push(`      <CtrlSum>${formattedTotal}</CtrlSum>`)
  lines.push('      <InitgPty>')
  lines.push(`        <Nm>${escapeXml(company.name)}</Nm>`)
  lines.push('        <Id>')
  lines.push('          <OrgId>')
  lines.push(`            <Othr><Id>${escapeXml(company.orgNumber.replace('-', ''))}</Id></Othr>`)
  lines.push('          </OrgId>')
  lines.push('        </Id>')
  lines.push('      </InitgPty>')
  lines.push('    </GrpHdr>')

  // ─── Payment Information ───
  lines.push('    <PmtInf>')
  lines.push(`      <PmtInfId>${escapeXml(options.messageId)}-PMT</PmtInfId>`)
  lines.push('      <PmtMtd>TRF</PmtMtd>')  // Transfer
  lines.push('      <BtchBookg>true</BtchBookg>')  // Batch booking
  lines.push(`      <NbOfTxs>${employees.length}</NbOfTxs>`)
  lines.push(`      <CtrlSum>${formattedTotal}</CtrlSum>`)
  lines.push('      <PmtTpInf>')
  lines.push('        <SvcLvl><Cd>SEPA</Cd></SvcLvl>')
  lines.push('        <CtgyPurp><Cd>SALA</Cd></CtgyPurp>')  // Salary payment
  lines.push('      </PmtTpInf>')
  lines.push(`      <ReqdExctnDt>${options.paymentDate}</ReqdExctnDt>`)

  // Debtor (company)
  lines.push('      <Dbtr>')
  lines.push(`        <Nm>${escapeXml(company.name)}</Nm>`)
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
    const txId = `${options.messageId}-TX${String(i + 1).padStart(4, '0')}`

    lines.push('      <CdtTrfTxInf>')
    lines.push('        <PmtId>')
    lines.push(`          <InstrId>${escapeXml(txId)}</InstrId>`)
    lines.push(`          <EndToEndId>${escapeXml(txId)}</EndToEndId>`)
    lines.push('        </PmtId>')
    lines.push('        <Amt>')
    lines.push(`          <InstdAmt Ccy="SEK">${formatDecimal(emp.netSalary)}</InstdAmt>`)
    lines.push('        </Amt>')
    lines.push('        <Cdtr>')
    lines.push(`          <Nm>${escapeXml(emp.name)}</Nm>`)
    lines.push('        </Cdtr>')
    lines.push('        <CdtrAcct>')
    lines.push('          <Id>')
    // Swedish domestic: clearing + account number (not IBAN for domestic)
    lines.push(`            <Othr><Id>${escapeXml(emp.clearingNumber)}${escapeXml(emp.bankAccountNumber)}</Id></Othr>`)
    lines.push('          </Id>')
    lines.push('        </CdtrAcct>')
    lines.push('        <RmtInf>')
    lines.push(`          <Ustrd>Lon ${escapeXml(options.periodLabel)}</Ustrd>`)
    lines.push('        </RmtInf>')
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
