/**
 * Reading a budget file (accounted#134): a SIE file's #PBUDGET rows, or a
 * spreadsheet (Excel or CSV) in one of two layouts. Pure: bytes in, rows as
 * the file has them out. What the rows mean for one budget (accounts mapped
 * to the kontoplan, object codes in the registry, months of the year, the
 * sign) is decided in import-budget.ts.
 *
 * Spreadsheet layouts, found from the header row:
 *   - long: one row per amount, columns konto, månad, belopp, and optionally
 *     dim and kod (or a projekt / kostnadsställe column, dimension 6 / 1);
 *   - wide: konto and one column per month ("2027-01", "202701", "jan",
 *     "januari 2027"), optionally dim and kod too.
 */
import { parseSwedishAmount } from '@/lib/money'
import { matchTier, type MatchTier } from '@/lib/import/shared/column-utils'
import { parseSIEFile } from '@/lib/import/sie-parser'

export type BudgetFileFormat = 'sie' | 'long' | 'wide'

export interface BudgetFileRow {
  /** The account as the file writes it (4 digits). */
  account: string
  /** 'YYYY-MM' when the file names the year. */
  month: string | null
  /** '01'..'12': always set; the only month a wide sheet headed "jan" gives. */
  calendarMonth: string
  /** SIE dimension number to object code; {} untagged. */
  dimensions: Record<string, string>
  /** As the file has it: the sign is decided by the import. */
  amount: number
  /** Line in the file (1-based), for messages. */
  line: number
}

export interface BudgetFileIssue {
  line: number
  /** What could not be read: the SIE record, the amount, the month, the dimension. */
  reason: 'record' | 'amount' | 'month' | 'dimension'
}

export interface BudgetFileRead {
  format: BudgetFileFormat
  rows: BudgetFileRow[]
  /** Rows the file has but that could not be read (an amount, a month). */
  unreadable: BudgetFileIssue[]
  /** The file's account names (#KONTO, or a name column), for the account mapper. */
  accountNames: Map<string, string>
  /** SIE only: the file's years, #RAR. */
  years: { yearIndex: number; start: string; end: string }[]
}

export class BudgetFileError extends Error {
  constructor(
    readonly code: 'BUDGET_IMPORT_NO_BUDGET_IN_FILE' | 'BUDGET_IMPORT_LAYOUT_UNKNOWN',
    message: string,
  ) {
    super(message)
    this.name = 'BudgetFileError'
  }
}

const ACCOUNT_RE = /^\s*(\d{4})(?!\d)/

// ── SIE ─────────────────────────────────────────────────────────────────

/** The #PBUDGET rows of a SIE file (decoded text). */
export function readSieBudget(content: string): BudgetFileRead {
  const parsed = parseSIEFile(content)
  const budgets = parsed.periodBudgets ?? []
  if (budgets.length === 0) {
    throw new BudgetFileError('BUDGET_IMPORT_NO_BUDGET_IN_FILE', 'The SIE file holds no #PBUDGET rows.')
  }
  const unreadable = parsed.issues
    .filter((i) => i.tag === 'PBUDGET' && i.severity !== 'info')
    .map((i) => ({ line: i.line, reason: 'record' as const }))
  return {
    format: 'sie',
    rows: budgets.map((b) => ({
      account: b.account,
      month: b.month,
      calendarMonth: b.month.slice(5, 7),
      dimensions: b.dimensions ?? {},
      amount: b.amount,
      line: b.line,
    })),
    unreadable,
    accountNames: new Map(parsed.accounts.filter((a) => a.name).map((a) => [a.number, a.name])),
    years: parsed.header.fiscalYears.map((y) => ({ yearIndex: y.yearIndex, start: y.start, end: y.end })),
  }
}

// ── Months ──────────────────────────────────────────────────────────────

const MONTH_NAMES: Record<string, string> = {
  jan: '01', januari: '01', january: '01',
  feb: '02', februari: '02', february: '02',
  mar: '03', mars: '03', march: '03',
  apr: '04', april: '04',
  maj: '05', may: '05',
  jun: '06', juni: '06', june: '06',
  jul: '07', juli: '07', july: '07',
  aug: '08', augusti: '08', august: '08',
  sep: '09', sept: '09', september: '09',
  okt: '10', oct: '10', oktober: '10', october: '10',
  nov: '11', november: '11',
  dec: '12', december: '12',
}

/**
 * A month from a header or a cell: '2027-01', '202701', '2027/1',
 * '2027-01-01', 'jan', 'januari 2027', 'Jan 2027'. A name without a year
 * gives only the calendar month. Null when the text is not a month.
 */
export function parseMonthText(text: string): { month: string | null; calendarMonth: string } | null {
  const t = text.trim().toLowerCase()
  if (!t) return null
  const iso = /^(\d{4})[-/ ]?(0?[1-9]|1[0-2])(?:[-/ ](\d{1,2}))?$/.exec(t)
  if (iso && (iso[2]!.length === 2 || /[-/ ]/.test(t))) {
    const mm = iso[2]!.padStart(2, '0')
    return { month: `${iso[1]}-${mm}`, calendarMonth: mm }
  }
  const named = /^([a-zåäö]+)\.?(?:[\s-]+(\d{4}))?$/.exec(t)
  if (named) {
    const mm = MONTH_NAMES[named[1]!]
    if (!mm) return null
    return { month: named[2] ? `${named[2]}-${mm}` : null, calendarMonth: mm }
  }
  return null
}

/**
 * A month from a spreadsheet cell: text as parseMonthText reads it, or a date
 * cell's serial (days since 1899-12-30, Excel's and the SheetJS epoch). A
 * number outside the serial range of 1955-2119 is read as text ("202701").
 */
export function parseMonthCell(cell: string | number): { month: string | null; calendarMonth: string } | null {
  if (typeof cell === 'number' && cell >= 20000 && cell < 80000) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(cell) * 86_400_000)
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
    return { month: `${date.getUTCFullYear()}-${mm}`, calendarMonth: mm }
  }
  return parseMonthText(String(cell))
}

/** An amount from a spreadsheet cell: a number as it is, text in the Swedish forms. */
function parseAmountCell(cell: string | number): number | null {
  return parseSwedishAmount(typeof cell === 'number' ? cell : cell.trim())
}

// ── Spreadsheets ────────────────────────────────────────────────────────

const ACCOUNT_KEYWORDS = ['konto', 'kontonummer', 'kontonr', 'account', 'account number', 'account no']
const ACCOUNT_NAME_KEYWORDS = ['kontonamn', 'benämning', 'namn', 'account name', 'name', 'description', 'beskrivning']
const MONTH_KEYWORDS = ['månad', 'manad', 'period', 'month']
const AMOUNT_KEYWORDS = ['belopp', 'budget', 'amount', 'summa', 'value', 'värde']
const DIM_KEYWORDS = ['dim', 'dimension', 'dimensionsnummer', 'dimension no', 'dim no']
const CODE_KEYWORDS = ['kod', 'objekt', 'objektkod', 'code', 'object']
const PROJECT_KEYWORDS = ['projekt', 'project']
const COST_CENTRE_KEYWORDS = ['kostnadsställe', 'kostnadsstalle', 'kst', 'resultatenhet', 'cost centre', 'cost center']

const RANK: Record<MatchTier, number> = { exact: 3, word: 2, substring: 1 }

/** The column whose header matches best (exact over word over substring), or -1. */
function bestColumn(headers: string[], keywords: string[], taken: Set<number>, reject: string[] = []): number {
  let best = -1
  let bestRank = 0
  headers.forEach((h, i) => {
    if (taken.has(i)) return
    if (reject.length > 0 && matchTier(h, reject) === 'exact') return
    const tier = matchTier(h, keywords)
    if (tier && RANK[tier] > bestRank) {
      best = i
      bestRank = RANK[tier]
    }
  })
  return best
}

/** The first row (of the first 20) with a cell naming the account column. */
function findHeaderRow(rows: (string | number)[][]): number {
  const limit = Math.min(rows.length, 20)
  for (let r = 0; r < limit; r++) {
    const cells = rows[r]!.map((c) => String(c ?? ''))
    if (cells.some((c) => {
      const tier = matchTier(c, ACCOUNT_KEYWORDS)
      return tier === 'exact' || tier === 'word'
    })) return r
  }
  return -1
}

/**
 * The rows of a spreadsheet: readBestSheetValues's rows, the header row
 * included, each cell its value (a number stays a number, a date cell its
 * serial), never its formatted text: an Excel cell formatted `#,##0` reads
 * "12,000", which a Swedish reader takes for twelve kronor.
 */
export function readSpreadsheetBudget(rawData: (string | number)[][]): BudgetFileRead {
  const headerRow = findHeaderRow(rawData)
  if (headerRow === -1) {
    throw new BudgetFileError('BUDGET_IMPORT_LAYOUT_UNKNOWN', 'No header row with a konto column.')
  }
  const headerCells = rawData[headerRow]!
  const headers = headerCells.map((c) => String(c ?? '').trim())
  const taken = new Set<number>()

  const accountCol = bestColumn(headers, ACCOUNT_KEYWORDS, taken, ACCOUNT_NAME_KEYWORDS)
  taken.add(accountCol)

  // Month columns make the sheet wide: two or more headers that are months
  // (as text, or date cells).
  const monthCols = headerCells
    .map((h, i) => ({ i, parsed: taken.has(i) ? null : parseMonthCell(h ?? '') }))
    .filter((c): c is { i: number; parsed: NonNullable<ReturnType<typeof parseMonthText>> } => c.parsed !== null)
  const wide = monthCols.length >= 2
  for (const c of monthCols) taken.add(c.i)

  const nameCol = bestColumn(headers, ACCOUNT_NAME_KEYWORDS, taken)
  if (nameCol !== -1) taken.add(nameCol)

  let monthCol = -1
  let amountCol = -1
  if (!wide) {
    monthCol = bestColumn(headers, MONTH_KEYWORDS, taken)
    if (monthCol !== -1) taken.add(monthCol)
    amountCol = bestColumn(headers, AMOUNT_KEYWORDS, taken)
    if (amountCol !== -1) taken.add(amountCol)
    if (monthCol === -1 || amountCol === -1) {
      throw new BudgetFileError('BUDGET_IMPORT_LAYOUT_UNKNOWN', 'Neither month columns nor a månad and a belopp column.')
    }
  }

  // The tag: dim + kod, or a column named for a dimension (projekt: 6,
  // kostnadsställe: 1, the SIE numbers).
  const dimCol = bestColumn(headers, DIM_KEYWORDS, taken)
  if (dimCol !== -1) taken.add(dimCol)
  const codeCol = bestColumn(headers, CODE_KEYWORDS, taken)
  if (codeCol !== -1) taken.add(codeCol)
  const projectCol = codeCol === -1 ? bestColumn(headers, PROJECT_KEYWORDS, taken) : -1
  if (projectCol !== -1) taken.add(projectCol)
  const costCentreCol = codeCol === -1 ? bestColumn(headers, COST_CENTRE_KEYWORDS, taken) : -1
  if (costCentreCol !== -1) taken.add(costCentreCol)

  const rows: BudgetFileRow[] = []
  const unreadable: BudgetFileIssue[] = []
  const accountNames = new Map<string, string>()

  for (let r = headerRow + 1; r < rawData.length; r++) {
    const values = rawData[r]!
    const cells = values.map((c) => String(c ?? '').trim())
    const line = r + 1
    const accountMatch = ACCOUNT_RE.exec(cells[accountCol] ?? '')
    // A blank row, a heading or a "Summa" row: not an account, not an error.
    if (!accountMatch) continue
    const account = accountMatch[1]!
    const name = nameCol !== -1 ? cells[nameCol] : (cells[accountCol] ?? '').slice(accountMatch[0].length).trim()
    if (name && !accountNames.has(account)) accountNames.set(account, name)

    const dimensions: Record<string, string> = {}
    if (codeCol !== -1 && cells[codeCol]) {
      const dimNo = dimCol !== -1 ? cells[dimCol]!.replace(/^dim(ension)?\s*/i, '') : ''
      if (!/^[1-9]\d{0,3}$/.test(dimNo)) {
        unreadable.push({ line, reason: 'dimension' })
        continue
      }
      dimensions[dimNo] = cells[codeCol]!
    } else {
      // Both named columns tag the row: a home and its cost centre.
      if (projectCol !== -1 && cells[projectCol]) dimensions['6'] = cells[projectCol]!
      if (costCentreCol !== -1 && cells[costCentreCol]) dimensions['1'] = cells[costCentreCol]!
    }

    if (wide) {
      for (const col of monthCols) {
        if (!cells[col.i]) continue
        const amount = parseAmountCell(values[col.i]!)
        if (amount === null) {
          unreadable.push({ line, reason: 'amount' })
          continue
        }
        if (amount === 0) continue
        rows.push({ account, month: col.parsed.month, calendarMonth: col.parsed.calendarMonth, dimensions, amount, line })
      }
      continue
    }

    const month = parseMonthCell(values[monthCol] ?? '')
    if (!month || !month.month) {
      unreadable.push({ line, reason: 'month' })
      continue
    }
    if (!cells[amountCol]) continue
    const amount = parseAmountCell(values[amountCol]!)
    if (amount === null) {
      unreadable.push({ line, reason: 'amount' })
      continue
    }
    if (amount === 0) continue
    rows.push({ account, month: month.month, calendarMonth: month.calendarMonth, dimensions, amount, line })
  }

  return { format: wide ? 'wide' : 'long', rows, unreadable, accountNames, years: [] }
}
