/**
 * ISO 20022 camt.053 (BankToCustomerStatement) XML parser
 *
 * This is the EU standard for bank statements, increasingly used by Swedish banks.
 * Namespace: urn:iso:std:iso:20022:tech:xsd:camt.053.001.XX (various versions)
 *
 * Key elements:
 * - <BkToCstmrStmt>: root container
 * - <Stmt>: one statement per account (a file may carry several)
 * - <Ntry>: individual transaction entries
 * - <NtryRef> / <AcctSvcrRef>: entry references; with the booking date they
 *   form the entry's external_id (see entryKey)
 * - <CdtDbtInd>: CRDT/DBIT indicator
 * - <Sts>: BOOK (booked), PDNG (pending) or INFO; .001.02 writes the code as
 *   text, .001.08 and later wrap it in <Cd>
 * - <BookgDt>/<ValDt>: <Dt> (ISODate) or <DtTm> (ISODateTime)
 * - <RmtInf><Strd><CdtrRefInf>: structured remittance (OCR/Bankgiro reference)
 *
 * One parsed row per <Ntry>: the amount that hit the account, which is what
 * the statement balance and the bank feed carry. An entry with several
 * <TxDtls> (a Bankgiro deposit batch) stays one row, and no single payment's
 * payer or OCR is attributed to the whole batch.
 */

import type { BankFileAccountIdentity, BankFileFormat, BankFileParseResult, ParsedBankTransaction, BankFileParseIssue } from '../types'
import { prepareContent } from '../../shared/encoding'
import { ISO_DATE_RE } from '@/lib/invariants'
import { parseSwedishAmount } from '@/lib/money'
import { accountIdentity, sharedAccountIdentity } from '../account-identity'
import {
  extractElements,
  extractEntryDate,
  extractNestedText,
  extractTextContent,
  stripNamespacePrefixes,
} from '../../shared/iso20022-xml'

/** Markers of a camt.053 statement: its namespace, root element or long name. */
const CAMT053_MARKERS = ['camt.053', 'bktocstmrstmt', 'banktocustomerstatement']

export const camt053Format: BankFileFormat = {
  id: 'camt053',
  name: 'ISO 20022 camt.053',
  description: 'ISO 20022 BankToCustomerStatement (XML)',
  fileExtensions: ['.xml'],

  detect(content: string, filename: string): boolean {
    // By content, whatever the extension (crm#1160): statements saved from a
    // bank's file service or another accounting system's archive arrive as
    // .txt, .053 or with no extension at all. The XML check keeps a CSV that
    // happens to mention "camt.053" in a description from being claimed.
    const lower = prepareContent(content).trimStart().toLowerCase()
    const looksLikeXml = lower.startsWith('<') || filename.toLowerCase().endsWith('.xml')
    return looksLikeXml && CAMT053_MARKERS.some((marker) => lower.includes(marker))
  },

  parse(content: string): BankFileParseResult {
    // Prefixed namespaces (<ns2:Ntry>, written by many XML serializers) read
    // as the bare element names below.
    const prepared = stripNamespacePrefixes(prepareContent(content))

    const transactions: ParsedBankTransaction[] = []
    const issues: BankFileParseIssue[] = []

    // Simple XML parsing without external dependencies
    // Extract <Ntry> elements
    const entries = extractElements(prepared, 'Ntry')

    if (entries.length === 0) {
      issues.push({
        row: 0,
        message: 'Inga transaktioner (<Ntry>) hittades i camt.053-filen.',
        severity: 'error',
      })
    }

    // Try to extract currency from statement level
    const stmtCcy = extractTextContent(prepared, 'Ccy') || 'SEK'

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]

      try {
        // A pending or informational entry is not a booking: the booked
        // version arrives in a later statement, so importing it would double.
        const status = (extractNestedText(entry, 'Sts', 'Cd') || extractTextContent(entry, 'Sts'))?.toUpperCase()
        if (status === 'PDNG' || status === 'INFO') {
          issues.push({ row: i + 1, message: `Post ${i + 1} är inte bokförd (${status}) och hoppas över.`, severity: 'info' })
          continue
        }

        // Date: <BookgDt> or <ValDt>, each as <Dt> or <DtTm>
        const bookingDate = extractEntryDate(entry, 'BookgDt')
        const valueDate = extractEntryDate(entry, 'ValDt')
        const date = bookingDate || valueDate

        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          issues.push({ row: i + 1, message: `Ogiltigt eller saknat datum i post ${i + 1}`, severity: 'warning' })
          continue
        }

        // Amount: <Amt Ccy="SEK">1234.56</Amt>. The entry's own <Amt> comes
        // before <AmtDtls> and the per-payment amounts in <NtryDtls>.
        const amountMatch = entry.match(/<Amt(?:\s[^>]*)?>([^<]+)<\/Amt>/i)
        const amountStr = amountMatch?.[1]
        const currencyMatch = entry.match(/<Amt\s[^>]*Ccy=["']([^"']+)["'][^>]*>/i)
        const currency = currencyMatch?.[1] || stmtCcy

        if (!amountStr) {
          issues.push({ row: i + 1, message: `Belopp saknas i post ${i + 1}`, severity: 'warning' })
          continue
        }

        // ISO 20022 amounts are xs:decimal: a dot, whatever the country.
        let amount = parseSwedishAmount(amountStr, '.')
        if (amount === null) {
          issues.push({ row: i + 1, message: `Ogiltigt belopp: ${amountStr}`, severity: 'warning' })
          continue
        }

        // Credit/Debit indicator: <CdtDbtInd>CRDT</CdtDbtInd> or DBIT
        const cdtDbtInd = extractTextContent(entry, 'CdtDbtInd')
        if (cdtDbtInd === 'DBIT') {
          amount = -Math.abs(amount)
        } else {
          amount = Math.abs(amount)
        }

        // Per-payment details live in <TxDtls>. With several of them the entry
        // is a batch: its payers, OCRs and end-to-end ids belong to the parts,
        // not to the booked total, so none of them is read for the row.
        const details = extractElements(entry, 'TxDtls')
        const payment = details.length <= 1 ? entry : null

        // Description: <AddtlNtryInf> or <RmtInf><Ustrd>
        const additionalInfo = extractTextContent(entry, 'AddtlNtryInf')
        const unstructuredRemittance = payment ? extractTextContent(payment, 'Ustrd') : null
        const batchLabel = payment ? null : `Samlingspost, ${details.length} betalningar`
        const description = additionalInfo || unstructuredRemittance || batchLabel || 'Unknown'

        // OCR / structured creditor reference: only <Ref> inside <CdtrRefInf>.
        // A bare <Ref> search also hits <Refs>, which comes first in the entry.
        const reference = payment ? extractNestedText(payment, 'CdtrRefInf', 'Ref') : null
        const entryRef = extractTextContent(entry, 'NtryRef')
        const acctSvcrRef = extractTextContent(entry, 'AcctSvcrRef')
        // NOTPROVIDED is the ISO 20022 placeholder for "no id", not an id.
        const endToEndId = payment ? extractTextContent(payment, 'EndToEndId') : null

        // Counterparty
        const creditorName = payment
          ? extractTextContent(payment, 'CdtrNm') || extractNestedText(payment, 'Cdtr', 'Nm')
          : null
        const debtorName = payment
          ? extractTextContent(payment, 'DbtrNm') || extractNestedText(payment, 'Dbtr', 'Nm')
          : null
        const counterparty = cdtDbtInd === 'DBIT' ? creditorName : debtorName
        const counterpartyIban = !payment
          ? null
          : cdtDbtInd === 'DBIT'
            ? extractNestedText(payment, 'CdtrAcct', 'IBAN')
            : extractNestedText(payment, 'DbtrAcct', 'IBAN')

        // Bank transaction code, in the PSD2 form ingest classifies (PMNT-RCDT-ESCT)
        const bankTransactionCode = [
          extractNestedText(entry, 'Domn', 'Cd'),
          extractNestedText(entry, 'Fmly', 'Cd'),
          extractTextContent(entry, 'SubFmlyCd'),
        ].filter(Boolean).join('-') || null

        // Balance after entry
        const balanceStr = extractTextContent(entry, 'ClsgAvlblAmt') ||
          extractTextContent(entry, 'ClsgBookdAmt')
        const balance = balanceStr ? parseSwedishAmount(balanceStr, '.') : null

        transactions.push({
          date,
          description: description.trim(),
          amount,
          currency,
          balance: balance !== null && !isNaN(balance) ? balance : null,
          reference,
          counterparty: counterparty?.trim() || null,
          raw_line: entryKey(date, acctSvcrRef, entryRef) ?? `camt053_entry_${i}`,
          value_date: valueDate && ISO_DATE_RE.test(valueDate) ? valueDate : null,
          end_to_end_id: endToEndId && endToEndId.toUpperCase() !== 'NOTPROVIDED' ? endToEndId : null,
          provider_transaction_id: acctSvcrRef || entryRef || null,
          counterparty_iban: counterpartyIban ? counterpartyIban.replace(/\s+/g, '').toUpperCase() : null,
          bank_transaction_code: bankTransactionCode,
        })
      } catch (err) {
        issues.push({
          row: i + 1,
          message: `Kunde inte tolka post ${i + 1}: ${err instanceof Error ? err.message : 'okänt fel'}`,
          severity: 'warning',
        })
      }
    }

    const dates = transactions.map((t) => t.date).sort()

    return {
      format: 'camt053',
      format_name: 'ISO 20022 camt.053',
      transactions,
      account: statementAccount(prepared),
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
 * The entry's identity across files, the input of its external_id. Neither
 * reference is safe alone: banks may number <NtryRef> per statement (1, 2, 3
 * in every monthly file) and may repeat an <AcctSvcrRef>, and a reused key
 * makes ingest skip a later month's entry as an already-imported one. The
 * booking date plus both references stays the same when the same statement
 * is imported again, so a re-import still deduplicates exactly.
 */
function entryKey(date: string, acctSvcrRef: string | null, entryRef: string | null): string | null {
  if (!acctSvcrRef && !entryRef) return null
  return [date, acctSvcrRef, entryRef].filter(Boolean).join('_')
}

/**
 * The account the statements are for (crm#1204): <Stmt><Acct><Id>, an <IBAN>
 * or a domestic number in <Othr><Id>. Read from each statement's header, the
 * part before its first <Ntry>, so a counterparty's <DbtrAcct>/<CdtrAcct> is
 * never taken for it. Null when a statement names none, or the statements
 * name different accounts (a SEK and a EUR account in one file).
 */
function statementAccount(xml: string): BankFileAccountIdentity | null {
  const statements = extractElements(xml, 'Stmt')
  const identities = statements.map((statement) => {
    const ntryIdx = statement.search(/<Ntry(?=[\s>/])/i)
    const header = ntryIdx === -1 ? statement : statement.slice(0, ntryIdx)
    const account = extractElements(header, 'Acct')[0]
    if (!account) return null
    return accountIdentity({
      iban: extractTextContent(account, 'IBAN'),
      account_number: extractNestedText(account, 'Othr', 'Id'),
    })
  })
  return identities.length > 0 ? sharedAccountIdentity(identities) : null
}
