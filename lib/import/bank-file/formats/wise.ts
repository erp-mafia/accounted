/**
 * Wise (TransferWise) transaction-history CSV parser.
 *
 * Wise exports a single multi-currency statement (one row per balance movement)
 * with a header like:
 *   ID,Status,Direction,"Created on","Finished on","Source fee amount",
 *   "Source fee currency","Target fee amount","Target fee currency",
 *   "Source name","Source amount (after fees)","Source currency",
 *   "Target name","Target amount (after fees)","Target currency",
 *   "Exchange rate",Reference,Batch,"Created by",Category,Note
 *
 * Design notes:
 * - Comma-delimited, `.` decimal, fields quoted (dates contain a space, so a
 *   quote-aware splitter is required: parseCSVLine).
 * - Direction IN/OUT drives the sign. We book the row in the currency that
 *   actually moved on the balance: the target side for IN, the source side for
 *   OUT. Amounts stay in their native currency; SEK conversion happens
 *   downstream at booking time via the existing FX pipeline (Riksbanken), so
 *   this parser never converts.
 * - Wise fees are a real cost, so a non-zero source/target fee becomes its OWN
 *   negative transaction ("Wise avgift") rather than being folded or dropped.
 * - Only COMPLETED rows are imported; pending/cancelled/refunded rows are skipped.
 * - The stable Wise ID (TRANSFER-…, PLAN_ORDER-…) is carried in `raw_line` so
 *   generateExternalId can key dedup on it instead of a row hash (fee rows get
 *   an `<id>-fee` / `<id>-tgtfee` suffix).
 */

import type { BankFileFormat, BankFileParseResult, ParsedBankTransaction, BankFileParseIssue } from '../types'
import { prepareContent } from '../../shared/encoding'
import { normalizeDate } from '../date-utils'
import { parseCSVLine } from './nordea'

/** Money rule: round to two decimals without toFixed. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Parse a Wise amount ("2500.0", "520.00"). `.` decimal, no thousands sep. */
function parseWiseAmount(value: string | undefined): number {
  if (!value) return NaN
  const cleaned = value.replace(/\s/g, '')
  return parseFloat(cleaned)
}

/** Wise datetimes are "YYYY-MM-DD HH:MM:SS"; keep the date part only. */
function wiseDate(value: string | undefined): string | null {
  if (!value) return null
  return normalizeDate(value.trim().split(/[ T]/)[0])
}

const HEADER_TOKENS = ['direction', 'source amount (after fees)', 'target amount (after fees)']

export const wiseFormat: BankFileFormat = {
  id: 'wise',
  name: 'Wise',
  description: 'Wise (TransferWise) transaction history CSV, multi-currency',
  fileExtensions: ['.csv'],

  detect(content: string, _filename: string): boolean {
    const firstLine = prepareContent(content).split('\n')[0]?.toLowerCase() || ''
    // Wise's header is distinctive: the "(after fees)" amount columns plus a
    // Direction column don't appear in any Swedish-bank export.
    return firstLine.includes(',') && HEADER_TOKENS.every((t) => firstLine.includes(t))
  },

  parse(content: string): BankFileParseResult {
    const prepared = prepareContent(content)
    const lines = prepared.split('\n').filter((line) => line.trim() !== '')

    const transactions: ParsedBankTransaction[] = []
    const issues: BankFileParseIssue[] = []
    let skippedRows = 0

    const headers = parseCSVLine(lines[0] || '', ',').map((h) =>
      h.trim().toLowerCase().replace(/^"|"$/g, ''),
    )
    const col = (name: string) => headers.findIndex((h) => h === name)

    const idx = {
      id: col('id'),
      status: col('status'),
      direction: col('direction'),
      createdOn: col('created on'),
      finishedOn: col('finished on'),
      sourceFeeAmount: col('source fee amount'),
      sourceFeeCurrency: col('source fee currency'),
      targetFeeAmount: col('target fee amount'),
      targetFeeCurrency: col('target fee currency'),
      sourceName: col('source name'),
      sourceAmount: col('source amount (after fees)'),
      sourceCurrency: col('source currency'),
      targetName: col('target name'),
      targetAmount: col('target amount (after fees)'),
      targetCurrency: col('target currency'),
      reference: col('reference'),
      category: col('category'),
      note: col('note'),
    }

    if (idx.direction === -1 || idx.sourceAmount === -1 || idx.targetAmount === -1) {
      issues.push({ row: 1, message: 'Could not identify required Wise columns', severity: 'error' })
      return {
        format: 'wise',
        format_name: 'Wise',
        transactions: [],
        date_from: null,
        date_to: null,
        issues,
        stats: { total_rows: 0, parsed_rows: 0, skipped_rows: 0, total_income: 0, total_expenses: 0 },
      }
    }

    for (let i = 1; i < lines.length; i++) {
      const fields = parseCSVLine(lines[i], ',').map((f) => f.trim().replace(/^"|"$/g, ''))
      const at = (j: number) => (j >= 0 ? fields[j] ?? '' : '')

      const wiseId = at(idx.id)
      const status = at(idx.status).toUpperCase()

      // Only settled movements affect the balance.
      if (status && status !== 'COMPLETED') {
        skippedRows++
        continue
      }

      const direction = at(idx.direction).toUpperCase()
      const isOut = direction === 'OUT'

      // Book the side that moved on the balance: target for IN, source for OUT.
      const currency = (isOut ? at(idx.sourceCurrency) : at(idx.targetCurrency)).toUpperCase() || 'SEK'
      const rawAmount = parseWiseAmount(isOut ? at(idx.sourceAmount) : at(idx.targetAmount))

      const date = wiseDate(at(idx.finishedOn)) || wiseDate(at(idx.createdOn))
      if (!date) {
        issues.push({ row: i + 1, message: `Invalid date on ${wiseId || 'row'}`, severity: 'warning' })
        skippedRows++
        continue
      }
      if (!Number.isFinite(rawAmount)) {
        issues.push({ row: i + 1, message: `Invalid amount on ${wiseId || 'row'}`, severity: 'warning' })
        skippedRows++
        continue
      }

      const counterparty = (isOut ? at(idx.targetName) : at(idx.sourceName)).trim()
      const note = at(idx.note).trim()
      const reference = at(idx.reference).trim()
      const category = at(idx.category).trim()
      const description =
        [counterparty, note].filter(Boolean).join(' - ') || reference || category || 'Wise-transaktion'

      // Signed movement: OUT leaves the balance (negative), IN enters it.
      const amount = round2(isOut ? -Math.abs(rawAmount) : Math.abs(rawAmount))

      transactions.push({
        date,
        description,
        amount,
        currency,
        balance: null,
        reference: reference || null,
        counterparty: counterparty || null,
        // Stable Wise ID drives dedup (see generateExternalId).
        raw_line: wiseId || undefined,
      })

      // Fees are a real cost: emit each non-zero fee as its own negative row so
      // it lands in the inbox to categorize (e.g. 6570) and the balance ties out.
      const feeSpecs: Array<{ amountCol: number; currencyCol: number; suffix: string }> = [
        { amountCol: idx.sourceFeeAmount, currencyCol: idx.sourceFeeCurrency, suffix: 'fee' },
        { amountCol: idx.targetFeeAmount, currencyCol: idx.targetFeeCurrency, suffix: 'tgtfee' },
      ]
      for (const spec of feeSpecs) {
        const fee = parseWiseAmount(at(spec.amountCol))
        if (!Number.isFinite(fee) || fee <= 0) continue
        transactions.push({
          date,
          description: `Wise avgift${counterparty ? ` (${counterparty})` : ''}`,
          amount: round2(-Math.abs(fee)),
          currency: (at(spec.currencyCol) || currency).toUpperCase(),
          balance: null,
          reference: reference || null,
          counterparty: 'Wise',
          raw_line: wiseId ? `${wiseId}-${spec.suffix}` : undefined,
        })
      }
    }

    const dates = transactions.map((t) => t.date).sort()

    return {
      format: 'wise',
      format_name: 'Wise',
      transactions,
      date_from: dates[0] || null,
      date_to: dates[dates.length - 1] || null,
      issues,
      stats: {
        total_rows: lines.length - 1,
        parsed_rows: transactions.length,
        skipped_rows: skippedRows,
        total_income: round2(transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0)),
        total_expenses: round2(transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0)),
      },
    }
  },
}
