import type { DetectedColumns, BalanceColumnLayout } from './types'

/** Swedish/English keywords for account number columns */
const ACCOUNT_NUMBER_KEYWORDS = [
  'konto', 'kontonr', 'kontonummer', 'kto', 'account', 'account_number',
  'account number', 'acct', 'nr',
]

/** Keywords for account name columns */
const ACCOUNT_NAME_KEYWORDS = [
  'kontonamn', 'benämning', 'namn', 'name', 'account name', 'description',
  'benamning', 'text', 'beteckning',
]

/** Keywords for debit columns */
const DEBIT_KEYWORDS = ['debet', 'debit', 'deb']

/** Keywords for credit columns */
const CREDIT_KEYWORDS = ['kredit', 'credit', 'kred', 'cred']

/** Keywords for net balance columns */
const BALANCE_KEYWORDS = [
  'saldo', 'balans', 'balance', 'ib', 'ingående', 'ingaende',
  'ingående balans', 'opening', 'opening balance', 'belopp', 'amount',
]

function normalize(header: string): string {
  return header.toLowerCase().trim().replace(/[_\-./]/g, ' ')
}

function matchesKeywords(header: string, keywords: string[]): boolean {
  const normalized = normalize(header)
  return keywords.some((kw) => normalized === kw || normalized.includes(kw))
}

/**
 * Check if a column of string values looks like 4-digit account numbers.
 * Returns the fraction of non-empty values that match /^\d{4}$/.
 */
function accountNumberScore(values: string[]): number {
  const nonEmpty = values.filter((v) => v.trim().length > 0)
  if (nonEmpty.length === 0) return 0
  const matching = nonEmpty.filter((v) => /^\d{4}$/.test(v.trim()))
  return matching.length / nonEmpty.length
}

/**
 * Check if a column of string values looks like numeric amounts.
 * Handles Swedish decimal commas and thousand separators.
 */
function numericScore(values: string[]): number {
  const nonEmpty = values.filter((v) => v.trim().length > 0)
  if (nonEmpty.length === 0) return 0
  const matching = nonEmpty.filter((v) => {
    const cleaned = v.trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.')
    return !isNaN(parseFloat(cleaned)) && isFinite(Number(cleaned))
  })
  return matching.length / nonEmpty.length
}

/**
 * Detect column layout from headers and sample data rows.
 *
 * @param headers - Array of header strings from the first row
 * @param dataRows - 2D array of string values (rows × columns)
 * @returns DetectedColumns with confidence score
 */
export function detectColumns(
  headers: string[],
  dataRows: string[][],
): DetectedColumns {
  let accountNumberCol = -1
  let accountNameCol: number | null = null
  let debitCol: number | null = null
  let creditCol: number | null = null
  let balanceCol: number | null = null
  let confidence = 0

  // Phase 1: Header keyword matching
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]
    if (accountNumberCol === -1 && matchesKeywords(h, ACCOUNT_NUMBER_KEYWORDS)) {
      accountNumberCol = i
    } else if (accountNameCol === null && matchesKeywords(h, ACCOUNT_NAME_KEYWORDS)) {
      accountNameCol = i
    } else if (debitCol === null && matchesKeywords(h, DEBIT_KEYWORDS)) {
      debitCol = i
    } else if (creditCol === null && matchesKeywords(h, CREDIT_KEYWORDS)) {
      creditCol = i
    } else if (balanceCol === null && matchesKeywords(h, BALANCE_KEYWORDS)) {
      balanceCol = i
    }
  }

  // Phase 2: Data-driven fallback for account number column
  if (accountNumberCol === -1 && dataRows.length > 0) {
    let bestScore = 0
    for (let i = 0; i < headers.length; i++) {
      const colValues = dataRows.map((row) => row[i] || '')
      const score = accountNumberScore(colValues)
      if (score > bestScore && score >= 0.5) {
        bestScore = score
        accountNumberCol = i
      }
    }
  }

  // If we still haven't found the account number column, give up
  if (accountNumberCol === -1) {
    return {
      account_number_col: 0,
      account_name_col: null,
      layout: 'net',
      balance_col: null,
      debit_col: null,
      credit_col: null,
      confidence: 0,
    }
  }

  // Phase 3: Detect numeric columns if debit/credit/balance not found via headers
  if (debitCol === null && creditCol === null && balanceCol === null && dataRows.length > 0) {
    const numericCols: number[] = []
    for (let i = 0; i < headers.length; i++) {
      if (i === accountNumberCol || i === accountNameCol) continue
      const colValues = dataRows.map((row) => row[i] || '')
      if (numericScore(colValues) >= 0.5) {
        numericCols.push(i)
      }
    }

    if (numericCols.length === 1) {
      balanceCol = numericCols[0]
    } else if (numericCols.length >= 2) {
      // Assume first two numeric columns are debit and credit
      debitCol = numericCols[0]
      creditCol = numericCols[1]
    }
  }

  // Determine layout
  let layout: BalanceColumnLayout = 'net'
  if (debitCol !== null && creditCol !== null) {
    layout = 'debit_credit'
  } else if (balanceCol !== null) {
    layout = 'net'
  } else if (debitCol !== null || creditCol !== null) {
    // Only one of debit/credit found: treat as net balance
    balanceCol = debitCol ?? creditCol
    debitCol = null
    creditCol = null
    layout = 'net'
  }

  // Calculate confidence
  const hasAccountCol = accountNumberCol >= 0
  const hasAmountCol = layout === 'debit_credit'
    ? (debitCol !== null && creditCol !== null)
    : balanceCol !== null
  const hasNameCol = accountNameCol !== null

  if (hasAccountCol && hasAmountCol) {
    // Boost confidence if data also validates
    const colValues = dataRows.map((row) => row[accountNumberCol] || '')
    const dataScore = accountNumberScore(colValues)
    confidence = hasNameCol ? 0.9 + dataScore * 0.1 : 0.8 + dataScore * 0.1
  } else if (hasAccountCol) {
    confidence = 0.4
  }

  confidence = Math.min(confidence, 1)

  return {
    account_number_col: accountNumberCol,
    account_name_col: accountNameCol,
    layout,
    balance_col: balanceCol,
    debit_col: debitCol,
    credit_col: creditCol,
    confidence: Math.round(confidence * 100) / 100,
  }
}
