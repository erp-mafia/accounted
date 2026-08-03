/**
 * Wise per-currency balance-statement CSV parser.
 *
 * Unlike Wise's multi-currency transaction-history export, balance statements
 * carry a signed Amount for one balance. That signed value is the authoritative
 * bank movement, so this parser never derives the sign from transfer metadata.
 *
 * "Total fees" is a breakdown of Amount, not an extra charge: the Running
 * Balance moves by exactly Amount per row, so booking the fee as its own
 * transaction (as wise.ts does for the "(after fees)" history export) would
 * double-count it here. The fee is kept in the description as underlag, and a
 * running-balance continuity check warns if a statement ever violates the
 * netted-fee assumption.
 */

import type {
  BankFileFormat,
  BankFileParseIssue,
  BankFileParseResult,
  ParsedBankTransaction,
} from '../types'
import { prepareContent } from '../../shared/encoding'
import { normalizeDate } from '../date-utils'
import { parseCSVLine } from './nordea'
import { roundOre } from '@/lib/money'

function parseWiseStatementAmount(value: string | undefined): number {
  if (!value) return NaN
  const cleaned = value.trim()
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return NaN
  return Number.parseFloat(cleaned)
}

function wiseStatementDate(value: string | undefined): string | null {
  if (!value) return null
  const datePart = value.trim().split(/[ T]/)[0]
  const normalized = normalizeDate(datePart)
  if (normalized) return normalized

  const dashDate = datePart.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/)
  if (!dashDate) return null
  return normalizeDate(`${dashDate[1]}.${dashDate[2]}.${dashDate[3]}`)
}

const REQUIRED_HEADERS = [
  'transferwise id',
  'date',
  'amount',
  'currency',
  'description',
  'running balance',
  'total fees',
]

export const wiseStatementFormat: BankFileFormat = {
  id: 'wise_statement',
  name: 'Wise balance statement',
  description: 'Wise per-currency balance statement CSV',
  fileExtensions: ['.csv'],

  detect(content: string, _filename: string): boolean {
    const firstLine = prepareContent(content).split('\n')[0] || ''
    const headers = parseCSVLine(firstLine, ',').map((header) => header.trim().toLowerCase())
    return REQUIRED_HEADERS.every((header) => headers.includes(header))
  },

  parse(content: string): BankFileParseResult {
    const lines = prepareContent(content)
      .split('\n')
      .filter((line) => line.trim() !== '')
    const transactions: ParsedBankTransaction[] = []
    const issues: BankFileParseIssue[] = []
    let skippedRows = 0

    const headers = parseCSVLine(lines[0] || '', ',').map((header) =>
      header.trim().toLowerCase(),
    )
    const col = (name: string) => headers.findIndex((header) => header === name)
    const idx = {
      id: col('transferwise id'),
      date: col('date'),
      amount: col('amount'),
      currency: col('currency'),
      description: col('description'),
      paymentReference: col('payment reference'),
      runningBalance: col('running balance'),
      exchangeFrom: col('exchange from'),
      exchangeTo: col('exchange to'),
      payerName: col('payer name'),
      payeeName: col('payee name'),
      merchant: col('merchant'),
      note: col('note'),
      totalFees: col('total fees'),
    }

    const seenWiseMovements = new Set<string>()
    // Continuity chain for the netted-fee guard: reset whenever a row is
    // skipped or lacks a balance, so gaps never produce false warnings.
    let previousMovement: { balance: number; amount: number } | null = null

    if (REQUIRED_HEADERS.some((header) => col(header) === -1)) {
      issues.push({
        row: 1,
        message: 'Could not identify required Wise balance statement columns',
        severity: 'error',
      })
      return {
        format: 'wise_statement',
        format_name: 'Wise balance statement',
        transactions: [],
        date_from: null,
        date_to: null,
        issues,
        stats: {
          total_rows: 0,
          parsed_rows: 0,
          skipped_rows: 0,
          total_income: 0,
          total_expenses: 0,
        },
      }
    }

    for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
      const fields = parseCSVLine(lines[lineIndex], ',').map((field) => field.trim())
      const at = (columnIndex: number) =>
        columnIndex >= 0 ? fields[columnIndex] ?? '' : ''
      const rowNumber = lineIndex + 1
      const wiseId = at(idx.id).trim()
      const rowLabel = wiseId || `row ${rowNumber}`
      const amount = parseWiseStatementAmount(at(idx.amount))
      const currency = at(idx.currency).trim().toUpperCase()
      const date = wiseStatementDate(at(idx.date))

      if (!date) {
        issues.push({ row: rowNumber, message: `Invalid date on ${rowLabel}`, severity: 'warning' })
        skippedRows++
        previousMovement = null
        continue
      }
      if (!Number.isFinite(amount) || amount === 0) {
        issues.push({ row: rowNumber, message: `Invalid amount on ${rowLabel}`, severity: 'warning' })
        skippedRows++
        previousMovement = null
        continue
      }
      if (!/^[A-Z]{3}$/.test(currency)) {
        issues.push({
          row: rowNumber,
          message: `Missing/invalid currency on ${rowLabel}`,
          severity: 'warning',
        })
        skippedRows++
        previousMovement = null
        continue
      }

      const rawBalance = at(idx.runningBalance).trim()
      const parsedBalance = rawBalance ? parseWiseStatementAmount(rawBalance) : NaN
      let balance: number | null = null
      if (rawBalance && !Number.isFinite(parsedBalance)) {
        issues.push({
          row: rowNumber,
          message: `Invalid running balance on ${rowLabel}`,
          severity: 'warning',
        })
      } else if (Number.isFinite(parsedBalance)) {
        balance = roundOre(parsedBalance)
      }

      const roundedAmount = roundOre(amount)
      const payerName = at(idx.payerName).trim()
      const payeeName = at(idx.payeeName).trim()
      const merchant = at(idx.merchant).trim()
      const counterparty =
        merchant ||
        (roundedAmount < 0 ? payeeName : payerName) ||
        (roundedAmount < 0 ? payerName : payeeName)
      const reference = at(idx.paymentReference).trim()
      const note = at(idx.note).trim()
      const exportedDescription = at(idx.description).trim()
      const primaryDescription =
        exportedDescription || counterparty || reference || 'Wise transaction'
      const descriptionParts = [primaryDescription]
      if (note && !primaryDescription.includes(note)) descriptionParts.push(note)

      const rawTotalFees = at(idx.totalFees).trim()
      if (rawTotalFees) {
        const totalFees = parseWiseStatementAmount(rawTotalFees)
        if (!Number.isFinite(totalFees) || totalFees < 0) {
          issues.push({
            row: rowNumber,
            message: `Invalid total fees on ${rowLabel}`,
            severity: 'warning',
          })
        } else if (
          totalFees > 0 &&
          !/wise charges|wise avgift|\bfee\b/i.test(primaryDescription)
        ) {
          descriptionParts.push(`Wise avgift: ${roundOre(totalFees)} ${currency}`)
        }
      }

      // Ordinary movements use the same canonical Wise ID as the transaction
      // history export, preventing an overlapping import from creating a
      // second transaction. Conversions can reuse one ID across currency
      // statements, so their independently signed legs stay currency-scoped.
      const hasExchangeDetails = Boolean(
        at(idx.exchangeFrom).trim() || at(idx.exchangeTo).trim(),
      )
      const stableMovementId = wiseId
        ? hasExchangeDetails
          ? `${wiseId}:${currency}`
          : wiseId
        : undefined

      if (stableMovementId && seenWiseMovements.has(stableMovementId)) {
        issues.push({
          row: rowNumber,
          message: `Duplicate Wise movement ID ${stableMovementId}; skipped`,
          severity: 'error',
        })
        skippedRows++
        previousMovement = null
        continue
      }
      if (stableMovementId) seenWiseMovements.add(stableMovementId)

      // Netted-fee guard: on adjacent parsed rows the balance must move by
      // exactly the signed Amount (statements can be oldest-first or
      // newest-first, so accept either direction). A break means Amount does
      // not equal the balance movement, e.g. fees charged on top of Amount,
      // and the file needs manual review before booking.
      if (balance !== null && previousMovement !== null) {
        const oldestFirst =
          roundOre(previousMovement.balance + roundedAmount) === balance
        const newestFirst =
          roundOre(balance + previousMovement.amount) === previousMovement.balance
        if (!oldestFirst && !newestFirst) {
          issues.push({
            row: rowNumber,
            message: `Running balance break at ${rowLabel}: the signed amount does not match the balance change (fees may not be netted into Amount); verify against the Wise balance before booking`,
            severity: 'warning',
          })
        }
      }
      previousMovement = balance !== null ? { balance, amount: roundedAmount } : null

      transactions.push({
        date,
        description: descriptionParts.join(' - '),
        amount: roundedAmount,
        currency,
        balance,
        reference: reference || null,
        counterparty: counterparty || null,
        raw_line: stableMovementId,
      })
    }

    const dates = transactions.map((transaction) => transaction.date).sort()
    return {
      format: 'wise_statement',
      format_name: 'Wise balance statement',
      transactions,
      date_from: dates[0] || null,
      date_to: dates[dates.length - 1] || null,
      issues,
      stats: {
        total_rows: lines.length > 0 ? lines.length - 1 : 0,
        parsed_rows: transactions.length,
        skipped_rows: skippedRows,
        total_income: roundOre(
          transactions
            .filter((transaction) => transaction.amount > 0)
            .reduce((sum, transaction) => sum + transaction.amount, 0),
        ),
        total_expenses: roundOre(
          transactions
            .filter((transaction) => transaction.amount < 0)
            .reduce((sum, transaction) => sum + transaction.amount, 0),
        ),
      },
    }
  },
}
