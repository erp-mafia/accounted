import { describe, expect, it } from 'vitest'
import { roundOre } from '@/lib/money'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import {
  buildSandboxLedgerHistory,
  SANDBOX_LEDGER_ACCOUNT_NUMBERS,
  type SandboxLedgerLineRow,
} from '../ledger-history'

/**
 * The journal_entries.source_type allowlist as of
 * 20260712100500_journal_source_type_stripe_payout.sql. A value outside this
 * set is rejected by Postgres with 23514, so the seed would fail at runtime.
 */
const ALLOWED_SOURCE_TYPES = [
  'manual',
  'bank_transaction',
  'invoice_created',
  'invoice_paid',
  'invoice_cash_payment',
  'credit_note',
  'salary_payment',
  'opening_balance',
  'year_end',
  'storno',
  'correction',
  'import',
  'system',
  'inbox_item',
  'supplier_invoice_registered',
  'supplier_invoice_paid',
  'supplier_invoice_cash_payment',
  'supplier_credit_note',
  'currency_revaluation',
  'supplier_invoice_privately_paid',
  'reminder_fee',
  'accrual',
  'result_appropriation',
  'rot_rut_payout',
  'vat_settlement',
  'stripe_payout',
]

const BAS_ACCOUNT_NUMBERS = new Set(BAS_REFERENCE.map((a) => a.account_number))

const accountMap = Object.fromEntries(
  SANDBOX_LEDGER_ACCOUNT_NUMBERS.map((n) => [n, `account-${n}`]),
)

/** August 6th: the history then covers January through July. */
const input = {
  userId: 'user-1',
  companyId: 'company-1',
  fiscalPeriodId: 'fp-1',
  today: new Date(2026, 7, 6),
  accountMap,
}

function sums(lines: SandboxLedgerLineRow[]) {
  return {
    debit: roundOre(lines.reduce((n, l) => n + l.debit_amount, 0)),
    credit: roundOre(lines.reduce((n, l) => n + l.credit_amount, 0)),
  }
}

function allLines(history: ReturnType<typeof buildSandboxLedgerHistory>) {
  return history.linesByEntryIndex.flat()
}

describe('sandbox ledger history', () => {
  it('emits one line bucket per entry', () => {
    const history = buildSandboxLedgerHistory(input)

    expect(history.entries.length).toBe(history.linesByEntryIndex.length)
    expect(history.entries.length).toBeGreaterThan(0)
  })

  it('covers January through the month before today, 4 to 7 entries per month', () => {
    const history = buildSandboxLedgerHistory(input)

    const byMonth = new Map<string, number>()
    for (const entry of history.entries) {
      const month = entry.entry_date.slice(0, 7)
      byMonth.set(month, (byMonth.get(month) ?? 0) + 1)
    }

    expect([...byMonth.keys()]).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
    ])
    // January has no customer payment and no eget uttag yet (no cash in), and
    // no periodic cost: 4. Every other month is 5 or 6, plus one for the
    // quarter-close momsredovisning (March, June) and one for the Q1 payment
    // (May). July has no periodic cost, so it stays at 5.
    expect(byMonth.get('2026-01')).toBe(4)
    expect(byMonth.get('2026-03')).toBe(7)
    expect(byMonth.get('2026-05')).toBe(7)
    expect(byMonth.get('2026-06')).toBe(7)
    for (const [, count] of byMonth) {
      expect(count).toBeGreaterThanOrEqual(4)
      expect(count).toBeLessThanOrEqual(7)
    }
    expect(history.entries).toHaveLength(42)
  })

  it('produces no entries before the first full month has passed', () => {
    const january = buildSandboxLedgerHistory({ ...input, today: new Date(2026, 0, 20) })

    expect(january.entries).toEqual([])
    expect(january.linesByEntryIndex).toEqual([])
  })

  it('balances every entry exactly, both sides above zero', () => {
    const history = buildSandboxLedgerHistory(input)

    history.linesByEntryIndex.forEach((lines, index) => {
      const { debit, credit } = sums(lines)
      expect(debit, `entry ${index} (${history.entries[index].description})`).toBe(credit)
      expect(debit).toBeGreaterThan(0)
      expect(credit).toBeGreaterThan(0)
      // A line is either a debit or a credit, never both.
      for (const line of lines) {
        expect(line.debit_amount === 0 || line.credit_amount === 0).toBe(true)
        expect(line.debit_amount).toBeGreaterThanOrEqual(0)
        expect(line.credit_amount).toBeGreaterThanOrEqual(0)
      }
    })
  })

  it('keeps every amount rounded to whole öre', () => {
    for (const line of allLines(buildSandboxLedgerHistory(input))) {
      expect(line.debit_amount).toBe(roundOre(line.debit_amount))
      expect(line.credit_amount).toBe(roundOre(line.credit_amount))
    }
  })

  it('uses string BAS account numbers that exist in class 1 to 8', () => {
    for (const line of allLines(buildSandboxLedgerHistory(input))) {
      expect(typeof line.account_number).toBe('string')
      expect(line.account_number).toMatch(/^[1-8]\d{3}$/)
      expect(BAS_ACCOUNT_NUMBERS.has(line.account_number)).toBe(true)
      expect(SANDBOX_LEDGER_ACCOUNT_NUMBERS).toContain(line.account_number)
    }
  })

  it('resolves account_id through the caller-supplied map', () => {
    const history = buildSandboxLedgerHistory(input)
    for (const line of allLines(history)) {
      expect(line.account_id).toBe(`account-${line.account_number}`)
    }

    // A chart lookup that came back short must degrade to null, not undefined:
    // undefined would be dropped from the insert payload.
    const partial = buildSandboxLedgerHistory({ ...input, accountMap: {} })
    for (const line of allLines(partial)) {
      expect(line.account_id).toBeNull()
    }
  })

  it('sets an explicit dimensions bag on every single line', () => {
    for (const line of allLines(buildSandboxLedgerHistory(input))) {
      // NOT NULL on journal_entry_lines.dimensions, and PostgREST sends NULL
      // for a key one row omits while another sets it.
      expect(Object.prototype.hasOwnProperty.call(line, 'dimensions')).toBe(true)
      expect(line.dimensions).toBeTypeOf('object')
      expect(line.dimensions).not.toBeNull()
    }
  })

  it('tags revenue lines with the seeded demo dimensions on some months only', () => {
    const history = buildSandboxLedgerHistory(input)

    const revenueLines = allLines(history).filter((l) => l.account_number === '3001')
    const tagged = revenueLines.filter((l) => Object.keys(l.dimensions).length > 0)

    expect(tagged.length).toBeGreaterThan(0)
    expect(tagged.length).toBeLessThan(revenueLines.length)
    // Only the four dimension_values the seed creates, on SIE dims 1 and 6.
    for (const line of tagged) {
      expect(Object.keys(line.dimensions).sort()).toEqual(['1', '6'])
      expect(['BUTIK', 'WEBB']).toContain(line.dimensions['1'])
      expect(['P001', 'P002']).toContain(line.dimensions['6'])
    }
    expect(tagged.some((l) => l.dimensions['1'] === 'BUTIK' && l.dimensions['6'] === 'P001')).toBe(true)

    // Nothing but revenue carries dimensions.
    const otherTagged = allLines(history).filter(
      (l) => l.account_number !== '3001' && Object.keys(l.dimensions).length > 0,
    )
    expect(otherTagged).toEqual([])
  })

  it('keeps dates inside the fiscal year and leaves posting metadata to the engine', () => {
    const history = buildSandboxLedgerHistory(input)

    for (const entry of history.entries) {
      expect(entry.entry_date >= '2026-01-01').toBe(true)
      expect(entry.entry_date <= '2026-12-31').toBe(true)
      expect(entry.entry_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(ALLOWED_SOURCE_TYPES).toContain(entry.source_type)
      expect(entry).not.toHaveProperty('status')
      expect(entry).not.toHaveProperty('committed_at')
      expect(entry).not.toHaveProperty('commit_method')
      expect(entry.voucher_series).toBe('A')
      expect(entry.fiscal_period_id).toBe('fp-1')
      expect(entry.user_id).toBe('user-1')
      expect(entry.company_id).toBe('company-1')
      expect(entry.description.length).toBeGreaterThan(0)
    }
  })

  it('carries no voucher_number: the caller assigns those via the RPC', () => {
    const history = buildSandboxLedgerHistory(input)

    for (const entry of history.entries) {
      expect(entry).not.toHaveProperty('voucher_number')
      expect(entry).not.toHaveProperty('id')
    }
    for (const line of allLines(history)) {
      expect(line).not.toHaveProperty('journal_entry_id')
    }
  })

  it('emits the entries in date order so the voucher sequence stays chronological', () => {
    const dates = buildSandboxLedgerHistory(input).entries.map((e) => e.entry_date)

    expect([...dates].sort()).toEqual(dates)
  })

  it('leaves a plausibly profitable year to date', () => {
    const lines = allLines(buildSandboxLedgerHistory(input))

    const revenue = roundOre(
      lines
        .filter((l) => l.account_number.startsWith('3'))
        .reduce((n, l) => n + l.credit_amount - l.debit_amount, 0),
    )
    const costs = roundOre(
      lines
        .filter((l) => /^[4-7]/.test(l.account_number))
        .reduce((n, l) => n + l.debit_amount - l.credit_amount, 0),
    )

    expect(revenue).toBeGreaterThan(0)
    expect(costs).toBeGreaterThan(0)
    expect(revenue).toBeGreaterThan(costs * 2)
  })

  it('keeps the bank account positive throughout the year to date', () => {
    const history = buildSandboxLedgerHistory(input)

    // A demo Balansrapport with a negative företagskonto reads as a bug. The
    // January owner contribution is what prevents it: the fiscal year is the
    // company's first period, so 1930 starts at zero.
    let balance = 0
    history.linesByEntryIndex.forEach((lines) => {
      for (const line of lines) {
        if (line.account_number !== '1930') continue
        balance = roundOre(balance + line.debit_amount - line.credit_amount)
      }
      expect(balance).toBeGreaterThan(0)
    })
  })

  it('books output VAT on 2611 and input VAT on 2641', () => {
    const lines = allLines(buildSandboxLedgerHistory(input))

    const outputVat = lines.filter((l) => l.account_number === '2611')
    const inputVat = lines.filter((l) => l.account_number === '2641')

    expect(outputVat.length).toBeGreaterThan(0)
    expect(inputVat.length).toBeGreaterThan(0)

    // Trading entries only: sales credit 2611, purchases debit 2641. The one
    // exception each quarter is the momsredovisning, which clears both the
    // other way. Identify it by the 2650 line rather than by sign, so this
    // stays a real assertion about direction.
    const settlementIndexes = new Set(
      buildSandboxLedgerHistory(input)
        .linesByEntryIndex.map((entryLines, index) =>
          entryLines.some((l) => l.account_number === '2650') ? index : -1,
        )
        .filter((index) => index >= 0),
    )
    const tradingLines = buildSandboxLedgerHistory(input).linesByEntryIndex.flatMap(
      (entryLines, index) => (settlementIndexes.has(index) ? [] : entryLines),
    )

    expect(
      tradingLines
        .filter((l) => l.account_number === '2611')
        .every((l) => l.credit_amount > 0 && l.debit_amount === 0),
    ).toBe(true)
    expect(
      tradingLines
        .filter((l) => l.account_number === '2641')
        .every((l) => l.debit_amount > 0 && l.credit_amount === 0),
    ).toBe(true)
  })

  it('settles each closed VAT quarter to 2650 and pays it from the bank', () => {
    const history = buildSandboxLedgerHistory(input)

    // Each closed quarter clears its 26xx accounts to 2650 on the last day of
    // the quarter: the ordinary period-close entry, not the filing itself.
    // Today is 6 August 2026, so Q1 is cleared (31 March) and paid (12 May),
    // and Q2 is cleared (30 June) but unpaid: its deadline is 17 August.
    const declaration = history.entries.findIndex(e => e.description === 'Momsredovisning 2026 Q1')
    const payment = history.entries.findIndex(e => e.description === 'Betald moms 2026 Q1')
    expect(declaration).toBeGreaterThanOrEqual(0)
    expect(payment).toBeGreaterThan(declaration)
    expect(history.entries[declaration].entry_date).toBe('2026-03-31')
    expect(history.entries[payment].entry_date).toBe('2026-05-12')

    const q2Declaration = history.entries.find(e => e.description === 'Momsredovisning 2026 Q2')
    expect(q2Declaration?.entry_date).toBe('2026-06-30')
    expect(history.entries.some(e => e.description === 'Betald moms 2026 Q2')).toBe(false)

    // The declaration carries the settlement SHAPE get_vat_declaration_totals
    // looks for: a VAT-account line plus a 2650 line. Without it the quarter
    // would be counted again in the next declaration.
    const declarationLines = history.linesByEntryIndex[declaration]
    expect(declarationLines.find(l => l.account_number === '2611')!.debit_amount).toBeGreaterThan(0)
    expect(declarationLines.find(l => l.account_number === '2641')!.credit_amount).toBeGreaterThan(0)
    const netPayable = declarationLines.find(l => l.account_number === '2650')!.credit_amount
    expect(netPayable).toBeGreaterThan(0)

    // The payment moves exactly that amount off the bank, and touches no VAT
    // account, so it is not itself settlement-shaped.
    const paymentLines = history.linesByEntryIndex[payment]
    expect(paymentLines.find(l => l.account_number === '2650')!.debit_amount).toBe(netPayable)
    expect(paymentLines.find(l => l.account_number === '1930')!.credit_amount).toBe(netPayable)
    expect(paymentLines.some(l => ['2611', '2641'].includes(l.account_number))).toBe(false)
  })

  it('is deterministic', () => {
    const first = buildSandboxLedgerHistory(input)
    const second = buildSandboxLedgerHistory(input)

    expect(first).toEqual(second)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('does not depend on the day of the month or the local clock', () => {
    const early = buildSandboxLedgerHistory({ ...input, today: new Date(2026, 7, 1) })
    const late = buildSandboxLedgerHistory({ ...input, today: new Date(2026, 7, 31) })

    expect(early).toEqual(late)
  })
})
