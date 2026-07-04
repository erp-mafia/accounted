import * as XLSX from 'xlsx'
import { detectColumns } from './column-detector'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { readWorkbookFromBuffer } from '../shared/workbook-reader'
import type {
  DetectedColumns,
  ParsedOpeningBalanceRow,
  OpeningBalanceParseResult,
} from './types'

/**
 * Parse a numeric value from a cell, handling Swedish decimal commas,
 * thousand separators, and various string formats.
 */
export function parseAmount(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') return Math.round(value * 100) / 100

  const str = String(value).trim()
  if (str === '' || str === '-') return 0

  // Remove thousand separators (spaces and dots before comma)
  // Then replace comma with dot for parsing
  const cleaned = str
    .replace(/\s/g, '')       // Remove spaces (thousand separator)
    .replace(/\.(?=\d{3})/g, '') // Remove dots used as thousand separators
    .replace(',', '.')        // Swedish decimal comma → dot

  const num = parseFloat(cleaned)
  if (isNaN(num)) return 0
  return Math.round(num * 100) / 100
}

/**
 * Parse an opening balance file (Excel or CSV) and return structured rows
 * with validation and BAS account matching.
 *
 * @param buffer - Raw file buffer
 * @param filename - Original filename (used for format detection)
 * @param columnOverrides - Optional manual column mapping (from column mapping step)
 */
export function parseOpeningBalanceFile(
  buffer: ArrayBuffer,
  filename: string,
  columnOverrides?: DetectedColumns,
): OpeningBalanceParseResult {
  const workbook = readWorkbookFromBuffer(buffer, filename)

  // Pick the sheet with the most rows (heuristic for multi-sheet workbooks)
  let bestSheet = workbook.SheetNames[0]
  let bestRowCount = 0
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]
    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1')
    const rowCount = range.e.r - range.s.r + 1
    if (rowCount > bestRowCount) {
      bestRowCount = rowCount
      bestSheet = name
    }
  }

  const sheet = workbook.Sheets[bestSheet]
  const rawData: string[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: false,
  })

  if (rawData.length < 2) {
    return {
      filename,
      sheet_name: bestSheet,
      total_rows: 0,
      detected_columns: columnOverrides || {
        account_number_col: 0,
        account_name_col: null,
        layout: 'net',
        balance_col: null,
        debit_col: null,
        credit_col: null,
        confidence: 0,
      },
      headers: rawData[0]?.map((h) => String(h)) || [],
      preview_rows: [],
      rows: [],
      total_debit: 0,
      total_credit: 0,
      is_balanced: true,
      warnings: ['Filen innehåller för få rader.'],
    }
  }

  const headers = rawData[0].map((h) => String(h))
  const dataRows = rawData.slice(1)

  // Detect or use overridden columns
  const columns = columnOverrides || detectColumns(headers, dataRows)

  const rows: ParsedOpeningBalanceRow[] = []
  const warnings: string[] = []
  const seenAccounts = new Map<string, number>() // account_number → first row_index

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]
    const rawAccountNumber = String(row[columns.account_number_col] || '')
      .replace(/[ ​‌‍﻿]/g, '') // strip NBSP and zero-width chars
      .trim()

    // Skip empty rows
    if (!rawAccountNumber) continue

    // Clean account number: strip every non-digit (whitespace, dots, dashes, letters)
    const accountNumber = rawAccountNumber.replace(/\D/g, '')

    // Skip non-4-digit account numbers (likely header/total rows)
    if (!/^\d{4}$/.test(accountNumber)) {
      // Could be a summary/total row: skip silently unless it looked intentional
      if (rawAccountNumber.length > 0 && !/^(summa|total|sum|samman)/i.test(rawAccountNumber)) {
        warnings.push(`Rad ${i + 2}: "${rawAccountNumber}" är inte ett giltigt kontonummer (4 siffror): hoppades över`)
      }
      continue
    }

    // Get account name from file or BAS reference
    const accountNameFromFile = columns.account_name_col !== null
      ? String(row[columns.account_name_col] || '').trim()
      : ''

    const basRef = getBASReference(accountNumber)
    const basMatch = basRef?.account_name ?? null
    const accountName = accountNameFromFile || basMatch || `Konto ${accountNumber}`

    // Parse amounts
    let debitAmount = 0
    let creditAmount = 0

    if (columns.layout === 'debit_credit') {
      debitAmount = parseAmount(columns.debit_col !== null ? row[columns.debit_col] : 0)
      creditAmount = parseAmount(columns.credit_col !== null ? row[columns.credit_col] : 0)
    } else {
      // Net balance: positive → debit, negative → credit
      const netAmount = parseAmount(columns.balance_col !== null ? row[columns.balance_col] : 0)
      if (netAmount > 0) {
        debitAmount = netAmount
      } else if (netAmount < 0) {
        creditAmount = Math.abs(netAmount)
      }
    }

    // Validate
    const validationErrors: string[] = []
    const is_valid_account = /^\d{4}$/.test(accountNumber)

    if (!is_valid_account) {
      validationErrors.push('Ogiltigt kontonummer')
    }

    if (debitAmount === 0 && creditAmount === 0) {
      // Zero-amount rows will be filtered silently
      continue
    }

    if (debitAmount > 0 && creditAmount > 0) {
      validationErrors.push('Kontot har både debet- och kreditbelopp')
    }

    // Warn on P&L accounts (class 3-8)
    const accountClass = parseInt(accountNumber.charAt(0), 10)
    if (accountClass >= 3 && accountClass <= 8) {
      validationErrors.push(`Konto ${accountNumber} är ett resultatkonto (klass ${accountClass}): ingående balanser ska normalt bara innehålla balanskonton (klass 1-2)`)
    }

    // Track duplicates
    if (seenAccounts.has(accountNumber)) {
      warnings.push(`Konto ${accountNumber} förekommer på flera rader: beloppen kommer summeras`)
    }
    seenAccounts.set(accountNumber, i + 2) // +2 for header row + 1-based

    rows.push({
      row_index: i + 2,
      account_number: accountNumber,
      account_name: accountName,
      debit_amount: debitAmount,
      credit_amount: creditAmount,
      is_valid: validationErrors.length === 0,
      validation_errors: validationErrors,
      bas_match: basMatch,
    })
  }

  // Merge duplicate accounts: keyed on the already-normalized account_number.
  // Union validation_errors across rows so a warning that fires on row 5 (e.g.
  // BAS-class mismatch) isn't silently dropped because row 2 of the same
  // account had no error. Suppressed validation issues on IB-feeding data
  // would risk a misclassification propagating into the ledger.
  const mergedMap = new Map<string, ParsedOpeningBalanceRow>()
  for (const row of rows) {
    const existing = mergedMap.get(row.account_number)
    if (existing) {
      existing.debit_amount = Math.round((existing.debit_amount + row.debit_amount) * 100) / 100
      existing.credit_amount = Math.round((existing.credit_amount + row.credit_amount) * 100) / 100
      if (!existing.account_name && row.account_name) {
        existing.account_name = row.account_name
      }
      if (row.validation_errors?.length) {
        const seen = new Set(existing.validation_errors)
        for (const err of row.validation_errors) {
          if (!seen.has(err)) existing.validation_errors.push(err)
        }
        existing.is_valid = existing.is_valid && row.is_valid
      }
    } else {
      mergedMap.set(row.account_number, { ...row, validation_errors: [...row.validation_errors] })
    }
  }
  const mergedRows = Array.from(mergedMap.values())

  // Compute totals
  let totalDebit = 0
  let totalCredit = 0
  for (const row of mergedRows) {
    totalDebit = Math.round((totalDebit + row.debit_amount) * 100) / 100
    totalCredit = Math.round((totalCredit + row.credit_amount) * 100) / 100
  }

  const diff = Math.round((totalDebit - totalCredit) * 100) / 100
  const isBalanced = Math.abs(diff) < 0.01

  if (!isBalanced) {
    warnings.push(`Debet (${totalDebit.toFixed(2)}) och kredit (${totalCredit.toFixed(2)}) balanserar inte: differens: ${diff.toFixed(2)} SEK`)
  }

  return {
    filename,
    sheet_name: bestSheet,
    total_rows: mergedRows.length,
    detected_columns: columns,
    headers,
    preview_rows: dataRows.slice(0, 5),
    rows: mergedRows,
    total_debit: totalDebit,
    total_credit: totalCredit,
    is_balanced: isBalanced,
    warnings,
  }
}
