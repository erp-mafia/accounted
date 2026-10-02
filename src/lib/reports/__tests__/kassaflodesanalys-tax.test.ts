import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKassaflodesanalys } from '../kassaflodesanalys'
import { generateTrialBalance } from '../trial-balance'
import { CashFlowTaxAllocationError } from '../cash-flow-tax'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

// Exercise the real report, trial-balance, income-statement,
// and opening-balance modules. The in-memory client replaces database reads.
// These tests do not verify the deployed SQL, RLS, or customer incidence.
type Line = { account_number: string; debit: number; credit: number }
type Entry = {
  source: 'manual' | 'import' | 'year_end' | 'storno' | 'correction'
  lines: Line[]
  status?: 'posted' | 'reversed' | 'draft'
  reverses_id?: string
  correction_of_id?: string
  fiscal_period_id?: string
}
type Fixture = {
  name: string
  entries: Entry[]
  opening?: Line[]
  expectedTax?: number
  expectedCash: number
  openingEntryId?: string
  journalReadError?: boolean
}

const round = (value: number) => Math.round(value * 100) / 100 || 0
const pair = (debit: string, credit: string, amount: number): Line[] => [
  { account_number: debit, debit: amount, credit: 0 },
  { account_number: credit, debit: 0, credit: amount },
]
const entry = (debit: string, credit: string, amount = 1000, source: Entry['source'] = 'manual'): Entry => ({
  source, lines: pair(debit, credit, amount),
})

const fixtures: Fixture[] = [
  { name: 'unpaid income tax on 2510', entries: [entry('8910', '2510')], expectedTax: 0, expectedCash: 0 },
  { name: 'unpaid income tax on 2512', entries: [entry('8910', '2512')], expectedTax: 0, expectedCash: 0 },
  { name: 'unpaid foreign income tax on 6997 and 2517', entries: [entry('6997', '2517')], expectedTax: 0, expectedCash: 0 },
  { name: 'foreign income tax paid directly on 6996', entries: [entry('6996', '1930')], expectedTax: -1000, expectedCash: -1000 },
  { name: 'foreign tax accrual and partial settlement', entries: [entry('6997', '2517'), entry('2517', '1930', 400)], expectedTax: -400, expectedCash: -400 },
  { name: 'foreign tax expense reclassified when paid', entries: [entry('6997', '2517'), entry('2517', '1930'), entry('6996', '6997')], expectedTax: -1000, expectedCash: -1000 },
  { name: 'foreign income tax refund on operating expense account', entries: [entry('1930', '6996')], expectedTax: 1000, expectedCash: 1000 },
  { name: 'imported unpaid income tax on 2510', entries: [entry('8910', '2510', 1000, 'import')], expectedTax: 0, expectedCash: 0 },
  { name: 'native year-end provision remains excluded', entries: [entry('8910', '2512', 1000, 'year_end')], expectedTax: 0, expectedCash: 0 },
  { name: '2510 accrual and full payment', entries: [entry('8910', '2510'), entry('2510', '1930')], expectedTax: -1000, expectedCash: -1000 },
  { name: '2512 accrual and full payment', entries: [entry('8910', '2512'), entry('2512', '1930')], expectedTax: -1000, expectedCash: -1000 },
  { name: '2510 accrual and partial payment', entries: [entry('8910', '2510'), entry('2510', '1930', 400)], expectedTax: -400, expectedCash: -400 },
  { name: 'payment of opening 2510 liability', opening: pair('1930', '2510', 1000), entries: [entry('2510', '1930')], expectedTax: -1000, expectedCash: -1000 },
  { name: 'payment of opening 2512 liability', opening: pair('1930', '2512', 1000), entries: [entry('2512', '1930')], expectedTax: -1000, expectedCash: -1000 },
  { name: 'prepaid income tax on 2518', entries: [entry('2518', '1930', 400)], expectedTax: -400, expectedCash: -400 },
  { name: 'income tax refund from 1640', opening: pair('1640', '2091', 400), entries: [entry('1930', '1640', 400)], expectedTax: 400, expectedCash: 400 },
  { name: 'unpaid tax reversal', opening: pair('1930', '2510', 1000), entries: [entry('2510', '8910')], expectedTax: 0, expectedCash: 0 },
  { name: 'tax liability reclassification 2512 to 2510', opening: pair('1930', '2512', 1000), entries: [entry('2512', '2510')], expectedTax: 0, expectedCash: 0 },
  { name: 'deferred tax without payment', entries: [entry('8940', '2240')], expectedTax: 0, expectedCash: 0 },
  { name: 'empty activity', entries: [], expectedTax: 0, expectedCash: 0 },
  { name: 'interest income plus unpaid tax', entries: [entry('1930', '8310', 100), entry('8910', '2510')], expectedTax: 0, expectedCash: 100 },
  { name: 'partial payment with ore amounts', entries: [entry('8910', '2510', 1000.01), entry('2510', '1930', 400.02)], expectedTax: -400.02, expectedCash: -400.02 },
  // A deposit alone does not identify the tax or fee it will settle.
  { name: 'bank deposit to skattekonto only', entries: [entry('1630', '1930')], expectedCash: -1000 },
  { name: 'income tax charged against existing skattekonto balance', opening: pair('1630', '2510', 1000), entries: [entry('2510', '1630')], expectedCash: 0 },
  { name: 'fund and settle income tax through skattekonto', entries: [entry('8910', '2512'), entry('1630', '1930'), entry('2512', '1630')], expectedTax: -1000, expectedCash: -1000 },
  { name: 'prepaid F-tax through skattekonto', entries: [entry('1630', '1930'), entry('2518', '1630')], expectedTax: -1000, expectedCash: -1000 },
  { name: 'native provision and skattekonto payment', entries: [entry('8910', '2512', 1000, 'year_end'), entry('1630', '1930'), entry('2512', '1630')], expectedTax: -1000, expectedCash: -1000 },
  { name: 'pension payroll tax accrued on 2514', entries: [entry('7533', '2514')], expectedTax: 0, expectedCash: 0 },
  { name: 'pension payroll tax paid through 2514', entries: [entry('7533', '2514'), entry('2514', '1930')], expectedTax: 0, expectedCash: -1000 },
  { name: 'pension payroll tax reclassified to generic 2510', opening: pair('1930', '2514', 1000), entries: [entry('2514', '2510')], expectedTax: 0, expectedCash: 0 },
  { name: 'VAT settlement against existing skattekonto balance', opening: pair('1630', '2650', 1000), entries: [entry('2650', '1630')], expectedTax: 0, expectedCash: 0 },
]

function aggregate(lines: Line[]): Line[] {
  const sums = new Map<string, Line>()
  for (const line of lines) {
    const sum = sums.get(line.account_number) ?? { account_number: line.account_number, debit: 0, credit: 0 }
    sum.debit = round(sum.debit + line.debit)
    sum.credit = round(sum.credit + line.credit)
    sums.set(line.account_number, sum)
  }
  return [...sums.values()]
}

function makeClient(fixture: Fixture) {
  const period = {
    period_start: '2026-01-01', period_end: '2026-12-31',
    opening_balance_entry_id: fixture.openingEntryId ?? null, closing_entry_id: null, is_closed: false,
  }
  const entries = fixture.entries.map((e, index) => ({
    id: `entry-${index}`, company_id: 'company-1', fiscal_period_id: e.fiscal_period_id ?? 'period-1',
    source_type: e.source, status: e.status ?? 'posted',
    reverses_id: e.reverses_id ?? null, correction_of_id: e.correction_of_id ?? null,
  }))
  const lines = fixture.entries.flatMap((e, index) => e.lines.map((line, i) => ({
    id: `line-${index}-${i}`, journal_entry_id: `entry-${index}`, account_number: line.account_number,
    debit_amount: line.debit, credit_amount: line.credit,
  })))
  const from = vi.fn((table: string) => {
    if (!['fiscal_periods', 'chart_of_accounts', 'journal_entries', 'journal_entry_lines'].includes(table)) {
      throw new Error(`Unexpected table: ${table}`)
    }
    const filters = new Map<string, unknown>()
    const predicates: ((row: Record<string, unknown>) => boolean)[] = []
    let bounds = [0, 999]
    const result = () => {
      if (table !== 'journal_entry_lines') expect(filters.get('company_id')).toBe('company-1')
      if (table === 'fiscal_periods') {
        expect(filters.get('id')).toBe('period-1')
        return { data: period, error: null }
      }
      if (table === 'journal_entries' && fixture.journalReadError) return { data: null, error: { message: 'read failed' } }
      if (table === 'journal_entry_lines') expect(filters.has('journal_entry_id')).toBe(true)
      const records = table === 'journal_entries' ? entries : table === 'journal_entry_lines' ? lines : []
      return { data: records.filter(row => predicates.every(predicate => predicate(row))).slice(bounds[0], bounds[1] + 1), error: null }
    }
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn((key: string, value: unknown) => {
        filters.set(key, value); predicates.push(row => row[key] === value); return builder
      }),
      neq: vi.fn((key: string, value: unknown) => {
        predicates.push(row => row[key] !== value); return builder
      }),
      in: vi.fn((key: string, values: unknown[]) => {
        filters.set(key, values); predicates.push(row => values.includes(row[key])); return builder
      }),
      order: vi.fn(() => builder),
      range: vi.fn((from: number, to: number) => { bounds = [from, to]; return builder }),
      single: vi.fn(async () => result()),
      then: (resolve: (value: ReturnType<typeof result>) => void) => resolve(result()),
    }
    return builder
  })
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    expect(args.p_company_id).toBe('company-1')
    if (name === 'compute_prior_opening_balances') {
      expect(args.p_period_start).toBe(period.period_start)
      return { data: aggregate(fixture.opening ?? []), error: null }
    }
    if (name !== 'get_trial_balance_aggregates') throw new Error(`Unexpected RPC: ${name}`)
    expect(args).toEqual({
      p_company_id: 'company-1', p_fiscal_period_id: 'period-1',
      p_closing_mode: 'exclude-all-year-end', p_from_date: null, p_to_date: null,
      p_exclude_entry_id: period.opening_balance_entry_id, p_dimensions: null,
    })
    // This simulates the inspected SQL predicate; it is not a SQL execution.
    const excluded = new Set(entries.filter(e => e.source_type === 'year_end' && e.status === 'reversed').map(e => e.id))
    const included = fixture.entries.filter((_, i) => {
      const e = entries[i]
      return e.fiscal_period_id === 'period-1' && ['posted', 'reversed'].includes(e.status)
        && e.id !== period.opening_balance_entry_id && e.source_type !== 'year_end'
        && !excluded.has(e.reverses_id ?? '') && !excluded.has(e.correction_of_id ?? '')
    })
    return { data: aggregate(included.flatMap(e => e.lines)).map(row => ({ bucket: 'period', ...row })), error: null }
  })
  return { from, rpc } as unknown as Parameters<typeof generateKassaflodesanalys>[0]
}

beforeEach(() => { vi.stubEnv('REPORTS_TB_RPC', 'on') })
afterEach(() => { vi.unstubAllEnvs() })

describe('cash-flow tax verification against balanced journal fixtures', () => {
  it.each(fixtures)('$name', async (fixture) => {
    for (const lines of [...fixture.entries.map(e => e.lines), fixture.opening ?? []]) {
      expect(round(lines.reduce((sum, line) => sum + line.debit - line.credit, 0))).toBe(0)
    }
    const client = makeClient(fixture)
    const report = await generateKassaflodesanalys(client, 'company-1', 'period-1')
    const { isBalanced } = await generateTrialBalance(client, 'company-1', 'period-1', {
      closingEntry: 'exclude-all-year-end',
    })
    expect(isBalanced).toBe(true)
    expect.soft(report.reconciliation.delta_actual).toBe(fixture.expectedCash)
    if (fixture.expectedTax !== undefined) expect.soft(report.lopande.skatt_betald).toBe(fixture.expectedTax)
    expect.soft(report.total_cash_flow).toBe(fixture.expectedCash)
    expect.soft(report.reconciliation.is_reconciled).toBe(true)
  })
})


describe('tax allocation evidence and boundaries', () => {
  const run = (entries: Entry[], extras: Partial<Fixture> = {}) => generateKassaflodesanalys(
    makeClient({ name: 'evidence', entries, expectedCash: 0, ...extras }), 'company-1', 'period-1',
  )

  it('keeps direct pension tax accrual on generic 2510 out of paid income tax', async () => {
    const report = await run([entry('7533', '2510')])
    expect(report.lopande.skatt_betald).toBe(0)
    expect(report.lopande.delta_kortfristiga_skulder).toBe(1000)
    expect(report.total_cash_flow).toBe(0)
  })

  it.each([
    ['5191', '2513'],
    ['7533', '2514'],
    ['7550', '2515'],
  ])('keeps unpaid other tax %s / %s in working capital', async (expense, liability) => {
    const report = await run([entry(expense, liability)])
    expect(report.lopande.skatt_betald).toBe(0)
    expect(report.lopande.delta_kortfristiga_skulder).toBe(1000)
    expect(report.total_cash_flow).toBe(0)
  })

  it('reverses a transfer from generic tax into pension tax without cash', async () => {
    const report = await run([entry('2510', '2514')])
    expect(report.lopande.skatt_betald).toBe(0)
    expect(report.total_cash_flow).toBe(0)
  })

  it('accepts a combined payment when the two tax liabilities remain separate', async () => {
    const report = await run([{
      source: 'manual', lines: [
        { account_number: '2510', debit: 1000, credit: 0 },
        { account_number: '2514', debit: 500, credit: 0 },
        { account_number: '1930', debit: 0, credit: 1500 },
      ],
    }])
    expect(report.lopande.skatt_betald).toBe(-1000)
    expect(report.lopande.delta_kortfristiga_skulder).toBe(-500)
    expect(report.total_cash_flow).toBe(-1500)
  })

  it('keeps a refund positive and excludes a simultaneous deferred-tax provision', async () => {
    const report = await run([entry('1930', '8930', 123.45), entry('8940', '2240')])
    expect(report.lopande.skatt_betald).toBe(123.45)
    expect(report.total_cash_flow).toBe(123.45)
  })

  it('does not fetch journal evidence for an ordinary unpaid income-tax provision', async () => {
    const client = makeClient({ name: 'ordinary', entries: [entry('8910', '2510')], expectedCash: 0 })
    await generateKassaflodesanalys(client, 'company-1', 'period-1')
    expect(client.from).not.toHaveBeenCalledWith('journal_entries')
    expect(client.from).not.toHaveBeenCalledWith('journal_entry_lines')
  })

  it('nets a reversed non-income-tax reclassification with its storno', async () => {
    const report = await run([
      { ...entry('2514', '2510'), status: 'reversed' },
      { ...entry('2510', '2514', 1000, 'storno'), reverses_id: 'entry-0' },
    ])
    expect(report.lopande.skatt_betald).toBe(0)
    expect(report.total_cash_flow).toBe(0)
  })

  it('excludes year-end reversals and corrections across period boundaries', async () => {
    const report = await run([
      { ...entry('2514', '2510', 9000, 'year_end'), status: 'reversed', fiscal_period_id: 'previous-period' },
      { ...entry('2510', '2514', 9000, 'storno'), reverses_id: 'entry-0' },
      { ...entry('2514', '2510', 8000, 'correction'), correction_of_id: 'entry-0' },
      entry('2514', '2510'),
    ])
    expect(report.lopande.skatt_betald).toBe(0)
    expect(report.total_cash_flow).toBe(0)
  })

  it('ignores draft reclassifications', async () => {
    const report = await run([
      { ...entry('2514', '2510', 9000), status: 'draft' },
      entry('2514', '2510'),
    ])
    expect(report.lopande.skatt_betald).toBe(0)
    expect(report.total_cash_flow).toBe(0)
  })

  it('excludes the linked opening entry from tax evidence', async () => {
    const report = await run([entry('1930', '2514'), entry('2514', '2510')], { openingEntryId: 'entry-0' })
    expect(report.lopande.skatt_betald).toBe(0)
    expect(report.total_cash_flow).toBe(0)
    expect(report.reconciliation.delta_actual).toBe(0)
  })

  it('keeps evidence reads paginated beyond 1000 entries', async () => {
    const report = await run(Array.from({ length: 1001 }, () => entry('2514', '2510', 1)))
    expect(report.lopande.skatt_betald).toBe(0)
    expect(report.total_cash_flow).toBe(0)
  })

  it('fails instead of ignoring an evidence-read error', async () => {
    await expect(run([entry('2514', '2510')], { journalReadError: true })).rejects.toThrow('read failed')
  })

  it('refuses to allocate a mixed non-income transfer and settlement', async () => {
    await expect(run([entry('2514', '2510'), entry('2510', '1630', 400)]))
      .rejects.toBeInstanceOf(CashFlowTaxAllocationError)
  })

  it('refuses an ambiguous combined voucher without guessing counterpart pairing', async () => {
    await expect(run([{
      source: 'manual', lines: [
        { account_number: '2514', debit: 1000, credit: 0 },
        { account_number: '2510', debit: 0, credit: 600 },
        { account_number: '1930', debit: 0, credit: 400 },
      ],
    }])).rejects.toBeInstanceOf(CashFlowTaxAllocationError)
  })

  it('does not assume unspecified 8980 tax is income tax', async () => {
    await expect(run([entry('8980', '2510')])).rejects.toBeInstanceOf(CashFlowTaxAllocationError)
  })

  it('localizes allocation failures through the shared error mapper', () => {
    const error = new CashFlowTaxAllocationError()
    expect(getErrorMessage(error)).toBe(sv.reports.cash_flow_tax_allocation_required)
    expect(getErrorMessage(error, { locale: 'en' })).toBe(en.reports.cash_flow_tax_allocation_required)
  })
})
