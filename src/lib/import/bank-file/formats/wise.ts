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
 * - Only COMPLETED rows are imported; other statuses are skipped with a visible
 *   parse issue so refunds and chargebacks are never silently lost.
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

/**
 * Parse a Wise amount ("2500.0", "520.00", "-2.20"). Wise amounts are plain
 * decimals: optional sign, digits, optional `.` fraction, no thousands
 * separator. Reject anything else: bare parseFloat would silently turn "12abc"
 * into 12 and "1,234" into 1, corrupting the imported amount. NaN = reject.
 */
function parseWiseAmount(value: string | undefined): number {
  if (!value) return NaN
  const cleaned = value.trim()
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return NaN
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

      // Only settled movements affect the balance. A blank/missing status is
      // NOT completed, so it must not slip through: require an exact match.
      if (status !== 'COMPLETED') {
        const isKnownNonSettledStatus = status === 'CANCELLED' || status === 'PENDING'
        issues.push({
          row: i + 1,
          message: `Wise row ${wiseId || i + 1} has unsupported status "${status || 'blank'}"; skipped`,
          // Cancelled and pending rows have not settled. A refund, chargeback,
          // blank status, or new Wise status can represent a real movement, so
          // it must block the file until a real export pins its sign semantics.
          severity: isKnownNonSettledStatus ? 'warning' : 'error',
        })
        skippedRows++
        continue
      }

      // Direction drives the sign. An unrecognized value (blank, or NEUTRAL for
      // a balance conversion/cashback, or anything Wise adds later) must NOT be
      // guessed: silently treating it as income mis-signs real money. Skip only
      // this row and surface the reason so other valid rows remain importable.
      const direction = at(idx.direction).toUpperCase()
      if (direction !== 'IN' && direction !== 'OUT') {
        issues.push({
          row: i + 1,
          message: `Wise row ${wiseId || i + 1} has unsupported Direction "${at(idx.direction) || 'blank'}"; skipped`,
          severity: 'error',
        })
        skippedRows++
        continue
      }
      const isOut = direction === 'OUT'

      const sourceCurrency = at(idx.sourceCurrency).trim().toUpperCase()
      const targetCurrency = at(idx.targetCurrency).trim().toUpperCase()
      if (
        /^[A-Z]{3}$/.test(sourceCurrency) &&
        /^[A-Z]{3}$/.test(targetCurrency) &&
        sourceCurrency !== targetCurrency
      ) {
        issues.push({
          row: i + 1,
          message: `Cross-currency Wise row ${wiseId || i + 1} (${sourceCurrency} to ${targetCurrency}) requires per-currency balance statements; skipped`,
          severity: 'error',
        })
        skippedRows++
        continue
      }

      // Book the side that moved on the balance: target for IN, source for OUT.
      // Never invent a currency: a missing/malformed one is a bad row, skip it.
      const currency = isOut ? sourceCurrency : targetCurrency
      if (!/^[A-Z]{3}$/.test(currency)) {
        issues.push({ row: i + 1, message: `Missing/invalid currency on ${wiseId || 'row'}`, severity: 'warning' })
        skippedRows++
        continue
      }
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
        const feeRaw = at(spec.amountCol).trim()
        if (!feeRaw) continue // No fee column value: normal, most rows.
        const fee = parseWiseAmount(feeRaw)
        if (fee === 0) continue // Explicit 0.00 fee: nothing to book, no warning.
        if (!Number.isFinite(fee) || fee < 0) {
          issues.push({ row: i + 1, message: `Invalid fee amount "${feeRaw}" on ${wiseId || 'row'}`, severity: 'warning' })
          continue
        }
        // Never inherit the movement currency for the fee: a fee amount without
        // its own currency is a bad row, so flag and skip it rather than guess.
        const feeCurrency = at(spec.currencyCol).trim().toUpperCase()
        if (!/^[A-Z]{3}$/.test(feeCurrency)) {
          issues.push({ row: i + 1, message: `Fee on ${wiseId || 'row'} has no currency; skipped`, severity: 'warning' })
          continue
        }
        transactions.push({
          date,
          description: `Wise avgift${counterparty ? ` (${counterparty})` : ''}`,
          amount: round2(-Math.abs(fee)),
          currency: feeCurrency,
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
