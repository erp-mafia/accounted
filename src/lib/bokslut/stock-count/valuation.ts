import { roundOre, sumOre } from '@/lib/money'

/**
 * The inventeringslista's arithmetic, pure: each row's value, the totals per
 * kind of stock, and the lagerförändring that brings the ledger to the
 * counted value on balansdagen.
 *
 * A row is valued at cost less the write-down to net realisable value
 * (lägsta värdets princip, ÅRL 4:9; the write-down is the company's own
 * assessment per row, e.g. inkurans). Every value is rounded to öre here,
 * once per row, and the totals add the rounded values, so the list, the PDF
 * and the verifikat show the same figures.
 */

export const STOCK_CATEGORIES = ['raw_materials', 'supplies', 'work_in_progress', 'finished_goods', 'goods_for_resale'] as const
export type StockCategory = (typeof STOCK_CATEGORIES)[number]

/**
 * BAS 2026 accounts per kind of stock: the balance account the counted value
 * belongs on, the accounts whose balance makes up the ledger value (the
 * stock account and its förändring sub-account in the same group), and the
 * result account of the lagerförändring.
 */
export const STOCK_CATEGORY_ACCOUNTS: Record<
  StockCategory,
  { stock: string; ledger: readonly string[]; change: string; label_sv: string }
> = {
  raw_materials: { stock: '1410', ledger: ['1410', '1419'], change: '4910', label_sv: 'Råvaror' },
  supplies: { stock: '1420', ledger: ['1420', '1429'], change: '4920', label_sv: 'Tillsatsmaterial och förnödenheter' },
  work_in_progress: { stock: '1440', ledger: ['1440', '1449'], change: '4940', label_sv: 'Produkter i arbete' },
  finished_goods: { stock: '1450', ledger: ['1450', '1459'], change: '4950', label_sv: 'Färdiga varor' },
  goods_for_resale: { stock: '1460', ledger: ['1460', '1469'], change: '4960', label_sv: 'Handelsvaror' },
}

export interface StockRowInput {
  quantity: number
  unit_cost: number
  write_down_percent: number
}

/** quantity x unit cost, less the write-down, in öre. Never negative. */
export function stockRowValue(row: StockRowInput): number {
  const cost = row.quantity * row.unit_cost
  const share = Math.min(Math.max(row.write_down_percent, 0), 100) / 100
  return Math.max(0, roundOre(cost - cost * share))
}

export interface CategoryTotal {
  category: StockCategory
  /** Before write-downs. */
  cost: number
  write_down: number
  value: number
  rows: number
}

export function categoryTotals(rows: ReadonlyArray<StockRowInput & { category: StockCategory; value?: number }>): CategoryTotal[] {
  return STOCK_CATEGORIES.flatMap((category) => {
    const inCategory = rows.filter((r) => r.category === category)
    if (inCategory.length === 0) return []
    const cost = sumOre(inCategory.map((r) => roundOre(r.quantity * r.unit_cost)))
    const value = sumOre(inCategory.map((r) => r.value ?? stockRowValue(r)))
    return [{ category, cost, write_down: roundOre(cost - value), value, rows: inCategory.length }]
  })
}

export interface StockAdjustment {
  category: StockCategory
  stock_account: string
  change_account: string
  counted: number
  ledger: number
  /** counted - ledger: positive raises the stock (Dr stock / Cr change). */
  adjustment: number
}

export interface StockAdjustmentLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description: string
}

/**
 * The adjustment per kind of stock. A kind with rows on the list, or with a
 * balance in the ledger, is compared: the list covers every item (LIV 1 §),
 * so a kind the ledger holds and the list does not is counted as nothing.
 */
export function stockAdjustments(
  totals: ReadonlyArray<CategoryTotal>,
  ledgerBalances: Readonly<Record<string, number>>,
): StockAdjustment[] {
  return STOCK_CATEGORIES.flatMap((category) => {
    const accounts = STOCK_CATEGORY_ACCOUNTS[category]
    const ledger = sumOre(accounts.ledger.map((a) => ledgerBalances[a] ?? 0))
    const counted = totals.find((t) => t.category === category)?.value ?? 0
    if (counted === 0 && ledger === 0 && !totals.some((t) => t.category === category)) return []
    return [{
      category,
      stock_account: accounts.stock,
      change_account: accounts.change,
      counted,
      ledger,
      adjustment: roundOre(counted - ledger),
    }]
  })
}

/** The verifikat's lines: one pair per kind whose value moved. Balanced by construction. */
export function stockAdjustmentLines(adjustments: ReadonlyArray<StockAdjustment>): StockAdjustmentLine[] {
  return adjustments.flatMap((a) => {
    if (a.adjustment === 0) return []
    const amount = Math.abs(a.adjustment)
    const label = STOCK_CATEGORY_ACCOUNTS[a.category].label_sv
    const text = `Lagerförändring ${label.toLocaleLowerCase('sv-SE')}`
    const stock = { account_number: a.stock_account, line_description: text }
    const change = { account_number: a.change_account, line_description: text }
    return a.adjustment > 0
      ? [
          { ...stock, debit_amount: amount, credit_amount: 0 },
          { ...change, debit_amount: 0, credit_amount: amount },
        ]
      : [
          { ...change, debit_amount: amount, credit_amount: 0 },
          { ...stock, debit_amount: 0, credit_amount: amount },
        ]
  })
}

export interface ParsedStockRow {
  description: string
  unit: string | null
  quantity: number
  unit_cost: number
  write_down_percent: number
  category: StockCategory
}

export interface ParsedStockPaste {
  rows: ParsedStockRow[]
  /** 1-based line numbers that could not be read. */
  rejected: number[]
}

function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const cleaned = raw.replace(/\s| /g, '').replace(/kr$/i, '').replace(/%$/, '')
  if (cleaned === '') return null
  // Swedish decimal comma; a dot is a decimal point only when there is no comma.
  const normalised = cleaned.includes(',') ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned
  const n = Number(normalised)
  return Number.isFinite(n) ? n : null
}

const CATEGORY_WORDS: Record<string, StockCategory> = {
  ravaror: 'raw_materials',
  råvaror: 'raw_materials',
  raw_materials: 'raw_materials',
  tillsatsmaterial: 'supplies',
  fornodenheter: 'supplies',
  förnödenheter: 'supplies',
  supplies: 'supplies',
  'produkter i arbete': 'work_in_progress',
  pia: 'work_in_progress',
  work_in_progress: 'work_in_progress',
  'färdiga varor': 'finished_goods',
  'fardiga varor': 'finished_goods',
  finished_goods: 'finished_goods',
  handelsvaror: 'goods_for_resale',
  goods_for_resale: 'goods_for_resale',
}

/**
 * A pasted list (from a spreadsheet: tab, semicolon or comma separated):
 * description; quantity; unit cost; optional write-down %; optional unit;
 * optional kind of stock. A first line whose quantity column is not a
 * number is taken as a header and skipped.
 */
export function parseStockPaste(text: string, defaultCategory: StockCategory = 'goods_for_resale'): ParsedStockPaste {
  const lines = text.split(/\r?\n/)
  const rows: ParsedStockRow[] = []
  const rejected: number[] = []
  lines.forEach((line, index) => {
    if (line.trim() === '') return
    const separator = line.includes('\t') ? '\t' : line.includes(';') ? ';' : ','
    const cells = line.split(separator).map((c) => c.trim())
    const description = cells[0] ?? ''
    const quantity = parseNumber(cells[1])
    const unitCost = parseNumber(cells[2])
    if (index === 0 && quantity === null) return
    const writeDown = cells[3] ? parseNumber(cells[3]) : 0
    if (!description || quantity === null || unitCost === null || writeDown === null
      || quantity < 0 || unitCost < 0 || writeDown < 0 || writeDown > 100) {
      rejected.push(index + 1)
      return
    }
    const categoryWord = cells[5]?.toLocaleLowerCase('sv-SE')
    rows.push({
      description: description.slice(0, 300),
      unit: cells[4] ? cells[4].slice(0, 20) : null,
      quantity,
      unit_cost: roundOre(unitCost),
      write_down_percent: writeDown,
      category: (categoryWord && CATEGORY_WORDS[categoryWord]) || defaultCategory,
    })
  })
  return { rows, rejected }
}
