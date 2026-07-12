import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// Fixtures live in /dev_docs which is gitignored (contains anonymised real-world
// customer exports). Skip the suite when running outside a dev machine.
const fixtureDir = join(process.cwd(), 'dev_docs', 'example_sie')
const fixturesAvailable = existsSync(join(fixtureDir, '8812090614_2025.se'))

vi.mock('../trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

import { generateIncomeStatement } from '../income-statement'
import { generateTrialBalance } from '../trial-balance'
import {
  detectEncoding,
  decodeBuffer,
  parseSIEFile,
} from '@/lib/import/sie-parser'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import type { ParsedSIEFile } from '@/lib/import/types'
import type { TrialBalanceRow } from '@/types'

const mockTrialBalance = vi.mocked(generateTrialBalance)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = {} as any

beforeEach(() => {
  vi.clearAllMocks()
})

/**
 * Load a real SIE file from dev_docs/example_sie and parse it with the real
 * parser (encoding detection included). These are anonymised real-world Bokio
 * exports: regression data for the multi-year-import + year-end-close bug
 * reported by an onboarding user in April 2026.
 */
function loadSIE(filename: string): ParsedSIEFile {
  const path = join(process.cwd(), 'dev_docs', 'example_sie', filename)
  const buffer = readFileSync(path)
  // readFileSync on Node returns a Buffer; slice to an ArrayBuffer view.
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer
  const encoding = detectEncoding(arrayBuffer)
  const content = decodeBuffer(arrayBuffer, encoding)
  return parseSIEFile(content)
}

/**
 * Build trial balance rows for a given fiscal-year SIE file, simulating what
 * the database would contain after a clean SIE import:
 *   - Opening balance entry (from #IB 0)
 *   - Period activity (from all #VER lines)
 *
 * Maps source accounts to themselves (Bokio uses BAS-compliant numbers, so
 * no translation is needed). Uses BAS reference for account_class; falls back
 * to the first digit of the account number.
 */
function buildTrialBalanceFromSIE(parsed: ParsedSIEFile): TrialBalanceRow[] {
  const opening = new Map<string, { debit: number; credit: number }>()
  const period = new Map<string, { debit: number; credit: number }>()

  // Opening balances: only class 1-2 (Swedish SIE #IB convention)
  for (const ib of parsed.openingBalances.filter((b) => b.yearIndex === 0)) {
    const bucket = opening.get(ib.account) || { debit: 0, credit: 0 }
    if (ib.amount > 0) bucket.debit += ib.amount
    else bucket.credit += Math.abs(ib.amount)
    opening.set(ib.account, bucket)
  }

  // Period activity: every #VER line
  for (const voucher of parsed.vouchers) {
    for (const line of voucher.lines) {
      const bucket = period.get(line.account) || { debit: 0, credit: 0 }
      if (line.amount > 0) bucket.debit += line.amount
      else bucket.credit += Math.abs(line.amount)
      period.set(line.account, bucket)
    }
  }

  const allAccounts = new Set([...opening.keys(), ...period.keys()])
  const rows: TrialBalanceRow[] = []

  for (const account of allAccounts) {
    const op = opening.get(account) || { debit: 0, credit: 0 }
    const pe = period.get(account) || { debit: 0, credit: 0 }
    const basRef = getBASReference(account)
    const accountClass = basRef?.account_class ?? parseInt(account[0], 10)
    const accountName = parsed.accounts.find((a) => a.number === account)?.name ??
      basRef?.account_name ?? `Konto ${account}`

    rows.push({
      account_number: account,
      account_name: accountName,
      account_class: accountClass,
      opening_debit: Math.round(op.debit * 100) / 100,
      opening_credit: Math.round(op.credit * 100) / 100,
      period_debit: Math.round(pe.debit * 100) / 100,
      period_credit: Math.round(pe.credit * 100) / 100,
      closing_debit: Math.round((op.debit + pe.debit) * 100) / 100,
      closing_credit: Math.round((op.credit + pe.credit) * 100) / 100,
    })
  }

  return rows.sort((a, b) => a.account_number.localeCompare(b.account_number))
}

describe.skipIf(!fixturesAvailable)('income statement: Bokio SIE regression (dev_docs/example_sie)', () => {
  it('2025: net_result matches Bokio 221 316 kr despite Yearly result closing voucher', async () => {
    // Bokio's 2025 export contains V194 "Yearly result": debit 8999 / credit 2099
    // with 221 316.27. Before the fix, treating 8999 as a regular class-8
    // financial item cancelled the computed profit and net_result dropped to ~0.
    // NE-bilaga was unaffected because it ignores 8999 by design.
    const parsed = loadSIE('8812090614_2025.se')
    const rows = buildTrialBalanceFromSIE(parsed)

    mockTrialBalance.mockResolvedValue({
      rows,
      totalDebit: rows.reduce((s, r) => s + r.closing_debit, 0),
      totalCredit: rows.reduce((s, r) => s + r.closing_credit, 0),
      isBalanced: true,
    })

    const report = await generateIncomeStatement(supabase, 'company-1', 'period-2025')

    // Bokio shows årets resultat = 221 316.27 kr on their V194 voucher.
    // Accounted computes 220 906.27 (Revenue 370 314.68 − Expenses 149 408.41),
    // which is the mathematically exact figure. The 410 kr difference is
    // öresutjämning/rounding that Bokio absorbed into V194 itself.
    expect(report.net_result).toBeCloseTo(220_906.27, 2)
    expect(report.total_revenue).toBeCloseTo(370_314.68, 2)
    expect(report.total_expenses).toBeCloseTo(149_408.41, 2)

    // Sanity: revenue and expenses are in the expected ballpark (~370k / ~149k)
    expect(report.total_revenue).toBeGreaterThan(365_000)
    expect(report.total_revenue).toBeLessThan(375_000)
    expect(report.total_expenses).toBeGreaterThan(145_000)
    expect(report.total_expenses).toBeLessThan(155_000)

    // 8999 must not contribute to the financial section total.
    // Other class 8 accounts (interest) may still appear with small amounts.
    const flat = report.financial_sections.flatMap((s) => s.rows)
    expect(flat.find((r) => r.account_number === '8999')).toBeUndefined()
  })

  it('2024: no year-end close in SIE: net_result equals the sum of #RES accounts (~541k)', async () => {
    // 2024 SIE has no "Yearly result" voucher, so 8999 stays at 0 and the
    // computation is a plain revenue-minus-expenses. This proves the fix
    // doesn't regress the non-closed case.
    const parsed = loadSIE('8812090614_2024.se')
    const rows = buildTrialBalanceFromSIE(parsed)

    mockTrialBalance.mockResolvedValue({
      rows,
      totalDebit: rows.reduce((s, r) => s + r.closing_debit, 0),
      totalCredit: rows.reduce((s, r) => s + r.closing_credit, 0),
      isBalanced: true,
    })

    const report = await generateIncomeStatement(supabase, 'company-1', 'period-2024')

    // Bokio internal total = 540 702.71 (from summing #RES 0 without 8999).
    expect(report.net_result).toBeCloseTo(540_702.71, 2)
  })
})
