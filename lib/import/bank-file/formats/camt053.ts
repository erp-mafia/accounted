/**
 * ISO 20022 camt.053 (BankToCustomerStatement) XML parser
 *
 * This is the EU standard for bank statements, increasingly used by Swedish banks.
 * Namespace: urn:iso:std:iso:20022:tech:xsd:camt.053.001.XX (various versions)
 *
 * Key elements:
 * - <BkToCstmrStmt>: root container
 * - <Stmt>: one statement per account
 * - <Ntry>: individual transaction entries
 * - <NtryRef> / <AcctSvcrRef>: unique entry reference (external_id)
 * - <CdtDbtInd>: CRDT/DBIT indicator
 * - <RmtInf><Strd><CdtrRefInf>: structured remittance (OCR/Bankgiro reference)
 */

import type { BankFileFormat, BankFileParseResult, ParsedBankTransaction, BankFileParseIssue } from '../types'
import { prepareContent } from '../../shared/encoding'

export const camt053Format: BankFileFormat = {
  id: 'camt053',
  name: 'ISO 20022 camt.053',
  description: 'ISO 20022 BankToCustomerStatement (XML)',
  fileExtensions: ['.xml'],

  detect(content: string, filename: string): boolean {
    // Check for XML with camt.053 namespace
    if (filename.toLowerCase().endsWith('.xml')) {
      const lower = content.toLowerCase()
      return (
        lower.includes('camt.053') ||
        lower.includes('bktocstmrstmt') ||
        lower.includes('banktoCustomerstatement'.toLowerCase())
      )
    }
    return false
  },

  parse(content: string): BankFileParseResult {
    const prepared = prepareContent(content)

    const transactions: ParsedBankTransaction[] = []
    const issues: BankFileParseIssue[] = []

    // Simple XML parsing without external dependencies
    // Extract <Ntry> elements
    const entries = extractElements(prepared, 'Ntry')

    if (entries.length === 0) {
      issues.push({
        row: 0,
        message: 'No <Ntry> elements found in camt.053 file',
        severity: 'error',
      })
    }

    // Try to extract currency from statement level
    const stmtCcy = extractTextContent(prepared, 'Ccy') || 'SEK'

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]

      try {
        // Date: <BookgDt><Dt> or <ValDt><Dt>
        const bookingDate = extractTextContent(entry, 'BookgDt>.*?<Dt') ||
          extractNestedText(entry, 'BookgDt', 'Dt')
        const valueDate = extractTextContent(entry, 'ValDt>.*?<Dt') ||
          extractNestedText(entry, 'ValDt', 'Dt')
        const date = bookingDate || valueDate

        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          issues.push({ row: i + 1, message: `Invalid or missing date in entry ${i}`, severity: 'warning' })
          continue
        }

        // Amount: <Amt Ccy="SEK">1234.56</Amt>
        const amountMatch = entry.match(/<Amt[^>]*>([^<]+)<\/Amt>/i)
        const amountStr = amountMatch?.[1]
        const currencyMatch = entry.match(/<Amt[^>]*Ccy="([^"]+)"[^>]*>/i)
        const currency = currencyMatch?.[1] || stmtCcy

        if (!amountStr) {
          issues.push({ row: i + 1, message: `Missing amount in entry ${i}`, severity: 'warning' })
          continue
        }

        let amount = parseFloat(amountStr)
        if (isNaN(amount)) {
          issues.push({ row: i + 1, message: `Invalid amount: ${amountStr}`, severity: 'warning' })
          continue
        }

        // Credit/Debit indicator: <CdtDbtInd>CRDT</CdtDbtInd> or DBIT
        const cdtDbtInd = extractTextContent(entry, 'CdtDbtInd')
        if (cdtDbtInd === 'DBIT') {
          amount = -Math.abs(amount)
        } else {
          amount = Math.abs(amount)
        }

        // Description: <AddtlNtryInf> or <RmtInf><Ustrd>
        const additionalInfo = extractTextContent(entry, 'AddtlNtryInf')
        const unstructuredRemittance = extractTextContent(entry, 'Ustrd')
        const description = additionalInfo || unstructuredRemittance || 'Unknown'

        // Reference: Try structured remittance info first, then entry reference
        const structuredRef = extractTextContent(entry, 'Ref') // Inside <CdtrRefInf><Ref>
        const entryRef = extractTextContent(entry, 'NtryRef')
        const acctSvcrRef = extractTextContent(entry, 'AcctSvcrRef')
        const reference = structuredRef || null

        // Counterparty
        const creditorName = extractTextContent(entry, 'CdtrNm') ||
          extractNestedText(entry, 'Cdtr', 'Nm')
        const debtorName = extractTextContent(entry, 'DbtrNm') ||
          extractNestedText(entry, 'Dbtr', 'Nm')
        const counterparty = cdtDbtInd === 'DBIT' ? creditorName : debtorName

        // Balance after entry
        const balanceStr = extractTextContent(entry, 'ClsgAvlblAmt') ||
          extractTextContent(entry, 'ClsgBookdAmt')
        const balance = balanceStr ? parseFloat(balanceStr) : null

        transactions.push({
          date,
          description: description.trim(),
          amount: Math.round(amount * 100) / 100,
          currency,
          balance: balance !== null && !isNaN(balance) ? balance : null,
          reference,
          counterparty: counterparty?.trim() || null,
          raw_line: entryRef || acctSvcrRef || `camt053_entry_${i}`,
        })
      } catch (err) {
        issues.push({
          row: i + 1,
          message: `Error parsing entry ${i}: ${err instanceof Error ? err.message : 'Unknown'}`,
          severity: 'warning',
        })
      }
    }

    const dates = transactions.map((t) => t.date).sort()

    return {
      format: 'camt053',
      format_name: 'ISO 20022 camt.053',
      transactions,
      date_from: dates[0] || null,
      date_to: dates[dates.length - 1] || null,
      issues,
      stats: {
        total_rows: entries.length,
        parsed_rows: transactions.length,
        skipped_rows: entries.length - transactions.length,
        total_income: Math.round(transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0) * 100) / 100,
        total_expenses: Math.round(transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0) * 100) / 100,
      },
    }
  },
}

/**
 * Extract all occurrences of a named XML element (simple parser, no dependencies)
 */
function extractElements(xml: string, tagName: string): string[] {
  const elements: string[] = []
  // Match exact tag name (followed by > or whitespace, not a longer tag name)
  const regex = new RegExp(`<${tagName}(?=[\\s>/])`, 'gi')
  let match

  while ((match = regex.exec(xml)) !== null) {
    const startIdx = match.index
    // Find matching closing tag
    const closeTag = `</${tagName}>`
    const closeIdx = xml.indexOf(closeTag, startIdx + match[0].length)

    if (closeIdx === -1) continue

    elements.push(xml.substring(startIdx, closeIdx + closeTag.length))

    // Advance regex past this element to avoid re-matching inside it
    regex.lastIndex = closeIdx + closeTag.length
  }

  return elements
}

/**
 * Extract text content of the first occurrence of a tag
 */
function extractTextContent(xml: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}[^>]*>([^<]+)<`, 'i')
  const match = xml.match(regex)
  return match?.[1]?.trim() || null
}

/**
 * Extract text content of a nested tag within a parent tag
 */
function extractNestedText(xml: string, parentTag: string, childTag: string): string | null {
  const parentRegex = new RegExp(`<${parentTag}[^>]*>([\\s\\S]*?)<\\/${parentTag}>`, 'i')
  const parentMatch = xml.match(parentRegex)
  if (!parentMatch) return null

  const childRegex = new RegExp(`<${childTag}[^>]*>([^<]+)<`, 'i')
  const childMatch = parentMatch[1].match(childRegex)
  return childMatch?.[1]?.trim() || null
}
