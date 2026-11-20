/**
 * The filed-momsperiod warning end to end: the confirm-before-posting guard,
 * the composition seam, the VAT block's check and the real reading of the
 * declaration, with nothing stubbed but the database. The unit tests beside
 * this one stub every seam on both sides, so this is the test that fails
 * when two of the parts stop fitting each other.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { runVoucherWarningsGuard } from '@/lib/bookkeeping/voucher-warnings-guard'
import { stagedFiledVatNote } from '@/lib/pending-operations/filed-vat-note'

type Row = Record<string, unknown>

/** Every table answers its rows whatever the filters; one table can be made unreadable. */
function fakeSupabase(tables: Record<string, Row[]>, opts: { failTable?: string } = {}): SupabaseClient {
  const from = (table: string) => {
    const rows = tables[table] ?? []
    const failing = opts.failTable === table
    const answer = () => (failing ? { data: null, error: { message: `${table} unreadable` } } : { data: rows, error: null })
    const builder: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'in', 'is', 'gte', 'lte', 'gt', 'lt', 'order', 'limit', 'range', 'neq', 'or', 'not']) {
      builder[method] = () => builder
    }
    builder.maybeSingle = async () => (failing ? answer() : { data: rows[0] ?? null, error: null })
    builder.single = async () => (failing ? answer() : { data: rows[0] ?? null, error: null })
    builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(answer()).then(resolve, reject)
    return builder
  }
  const rpc = async (name: string) =>
    name === 'skattekonto_shape_accounts' ? { data: ['1630'], error: null } : { data: null, error: null }
  return { from, rpc } as unknown as SupabaseClient
}

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger

const SETTINGS = {
  entity_type: 'aktiebolag',
  fiscal_year_start_month: 1,
  vat_taxable_base_over_40m: false,
  vat_has_eu_trade: false,
  vat_filing_method: null,
  vat_registered: true,
  moms_period: 'quarterly',
}
const Q3_FILED = {
  id: 'd-q3',
  tax_deadline_type: 'moms_quarterly',
  tax_period: '2026-Q3',
  is_completed: true,
  completed_at: '2026-11-11T12:00:00.000Z',
  status: 'submitted',
  notes: null,
  due_date: '2026-11-12',
}
/** A calendar-year company on kvartalsmoms with Q3 2026 filed on 11 November. */
const company = (over: Record<string, Row[]> = {}) => ({
  company_settings: [SETTINGS],
  fiscal_periods: [{ period_start: '2026-01-01', period_end: '2026-12-31' }],
  deadlines: [Q3_FILED],
  chart_of_accounts: [],
  ...over,
})

const purchase = (cost: string, vat: number) => [
  { account_number: cost, debit_amount: vat * 4, credit_amount: 0 },
  { account_number: '2641', debit_amount: vat, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: vat * 5 },
]

type GuardInput = Parameters<typeof runVoucherWarningsGuard>[2]
const guard = (tables: Record<string, Row[]>, input: GuardInput, opts: { failTable?: string } = {}) =>
  runVoucherWarningsGuard(fakeSupabase(tables, opts), 'c-1', input, log, { checkDuplicates: false })
const typed = (entry_date: string, lines = purchase('6540', 100)): GuardInput => ({ entry_date, description: 'x', lines })
/** The filed periods the guard's answer names, or null when it asked nothing. */
const filedPeriods = (result: Awaited<ReturnType<typeof runVoucherWarningsGuard>>) =>
  result.ok
    ? null
    : result.details.warnings.filter((w) => w.code === 'VAT_PERIOD_ALREADY_FILED').flatMap((w) => w.details.filed_periods)
const SILENT = { ok: true, acknowledged: [] }

describe('a new verifikat dated in a filed momsperiod', () => {
  it('asks when it carries input moms, with the rutor that move', async () => {
    const result = await guard(company(), typed('2026-09-27'))

    expect(filedPeriods(result)).toEqual([
      {
        tax_period: '2026-Q3',
        period_start: '2026-07-01',
        period_end: '2026-09-30',
        filed_on: '2026-11-11',
        rutor_change: { ruta48: 100, ruta49: -100 },
      },
    ])
  })

  it('is not asked about a bank fee: no ruta moves', async () => {
    const fee = [
      { account_number: '6570', debit_amount: 45, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 45 },
    ]

    expect(await guard(company(), typed('2026-09-27', fee))).toEqual(SILENT)
  })

  it('asks on the first and the last day of the period and on neither neighbour', async () => {
    const asked = async (date: string) => !(await guard(company(), typed(date))).ok

    expect(await asked('2026-07-01')).toBe(true)
    expect(await asked('2026-09-30')).toBe(true)
    expect(await asked('2026-06-30')).toBe(false)
    expect(await asked('2026-10-01')).toBe(false)
  })

  it('asks about a reverse-charge purchase although the moms to pay nets to zero', async () => {
    const reverseCharge = [
      { account_number: '4535', debit_amount: 1000, credit_amount: 0 },
      { account_number: '2614', debit_amount: 0, credit_amount: 250 },
      { account_number: '2645', debit_amount: 250, credit_amount: 0 },
      { account_number: '2440', debit_amount: 0, credit_amount: 1000 },
    ]

    expect((await guard(company(), typed('2026-09-27', reverseCharge))).ok).toBe(false)
  })

  it('is not asked about the momsredovisning itself, which the declaration leaves out', async () => {
    const momsredovisning = [
      { account_number: '2611', debit_amount: 2500, credit_amount: 0 },
      { account_number: '2641', debit_amount: 0, credit_amount: 1500 },
      { account_number: '2650', debit_amount: 0, credit_amount: 1000 },
    ]

    expect(await guard(company(), typed('2026-09-30', momsredovisning))).toEqual(SILENT)
  })

  it('is not asked in a company that is not registered for moms', async () => {
    const tables = company({ company_settings: [{ ...SETTINGS, vat_registered: false }] })

    expect(await guard(tables, typed('2026-09-27'))).toEqual(SILENT)
  })

  it('judges helårsmoms by the räkenskapsår it declares, a broken year included', async () => {
    const tables = company({
      company_settings: [{ ...SETTINGS, fiscal_year_start_month: 7, moms_period: 'yearly' }],
      fiscal_periods: [
        { period_start: '2024-07-01', period_end: '2025-06-30' },
        { period_start: '2025-07-01', period_end: '2026-06-30' },
        { period_start: '2026-07-01', period_end: '2027-06-30' },
      ],
      deadlines: [
        {
          id: 'd-y',
          tax_deadline_type: 'moms_yearly',
          tax_period: '2025/2026',
          is_completed: true,
          completed_at: '2026-08-20T12:00:00.000Z',
          status: 'submitted',
          notes: null,
          due_date: '2026-08-26',
        },
      ],
    })
    const asked = async (date: string) => !(await guard(tables, typed(date))).ok

    expect(await asked('2025-07-01')).toBe(true)
    expect(await asked('2025-09-15')).toBe(true)
    expect(await asked('2026-06-30')).toBe(true)
    expect(await asked('2025-06-30')).toBe(false)
    expect(await asked('2026-07-01')).toBe(false)
  })

  it('never stops a booking when the filing record or the chart cannot be read', async () => {
    expect(await guard(company(), typed('2026-09-27'), { failTable: 'deadlines' })).toEqual(SILENT)
    expect(await guard(company(), typed('2026-09-27'), { failTable: 'chart_of_accounts' })).toEqual(SILENT)
  })
})

describe('a rättelse of a verifikat dated in a filed momsperiod', () => {
  const original = { entry_date: '2026-09-27', lines: purchase('6540', 100) }
  const rattelse = (entry_date: string, lines: GuardInput['lines'], replaces = original): GuardInput => ({
    entry_date,
    description: '',
    lines,
    replaces,
  })

  it('is not asked when only the cost account changes', async () => {
    expect(await guard(company(), rattelse('', purchase('5410', 100)))).toEqual(SILENT)
  })

  it('is not asked when it lands on another day of the same period with the same moms', async () => {
    expect(await guard(company(), rattelse('2026-08-02', purchase('6540', 100)))).toEqual(SILENT)
  })

  it('asks with the net when the moms changes', async () => {
    const result = await guard(company(), rattelse('', purchase('6540', 125)))

    expect(filedPeriods(result)).toEqual([expect.objectContaining({ tax_period: '2026-Q3', rutor_change: { ruta48: 25, ruta49: -25 } })])
  })

  it('asks with the moms leaving the period when the rättelse is dated in an open one', async () => {
    const result = await guard(company(), rattelse('2026-11-17', purchase('6540', 100)))

    expect(filedPeriods(result)).toEqual([expect.objectContaining({ tax_period: '2026-Q3', rutor_change: { ruta48: -100, ruta49: 100 } })])
  })

  it('asks with the moms entering the period when an October verifikat is corrected into it', async () => {
    const october = { entry_date: '2026-10-05', lines: purchase('6540', 100) }

    const result = await guard(company(), rattelse('2026-09-30', purchase('6540', 100), october))

    expect(filedPeriods(result)).toEqual([expect.objectContaining({ tax_period: '2026-Q3', rutor_change: { ruta48: 100, ruta49: -100 } })])
  })

  it('asks when the rättelse turns the purchase into a verifikat the declaration leaves out', async () => {
    const asMomsredovisning = [
      { account_number: '2641', debit_amount: 100, credit_amount: 0 },
      { account_number: '2650', debit_amount: 0, credit_amount: 100 },
    ]

    const result = await guard(company(), rattelse('', asMomsredovisning))

    // The new lines are not read, so the original's moms leaves the period.
    expect(filedPeriods(result)).toEqual([expect.objectContaining({ rutor_change: { ruta48: -100, ruta49: 100 } })])
  })
})

describe('a staged proposal that would change a filed momsdeklaration', () => {
  const note = (op: Parameters<typeof stagedFiledVatNote>[2]) => stagedFiledVatNote(fakeSupabase(company()), 'c-1', op, log)
  const mirrored = (lines: ReturnType<typeof purchase>) =>
    lines.map((l) => ({ ...l, debit_amount: l.credit_amount, credit_amount: l.debit_amount }))

  it('a bank row with moms carries the note; a bank fee carries none', async () => {
    expect(
      await note({ operation_type: 'categorize_transaction', params: {}, preview_data: { date: '2026-09-27', lines: purchase('6540', 100) } }),
    ).toBe(
      'Momsdeklarationen för 2026-Q3 är redan inlämnad (2026-11-11), och bokningen ändrar underlaget för den. ' +
        'Godkänns förslaget kan deklarationen behöva rättas.',
    )
    expect(
      await note({
        operation_type: 'categorize_transaction',
        params: {},
        preview_data: {
          date: '2026-09-27',
          lines: [
            { account_number: '6570', debit_amount: 45, credit_amount: 0 },
            { account_number: '1930', debit_amount: 0, credit_amount: 45 },
          ],
        },
      }),
    ).toBeNull()
  })

  it('a makulering of a purchase carries the note', async () => {
    expect(
      await note({
        operation_type: 'reverse_entry',
        params: {},
        preview_data: { reversal: { entry_date: '2026-09-27', lines: mirrored(purchase('6540', 100)) } },
      }),
    ).toContain('och makuleringen ändrar underlaget för den')
  })

  it('a momsredovisning corrected inside itself carries no note: judged whole, it stays one', async () => {
    const kept = { account_number: '2650', debit_amount: 0, credit_amount: 1000 }
    const struck = [
      { account_number: '2611', debit_amount: 2500, credit_amount: 0 },
      { account_number: '2641', debit_amount: 0, credit_amount: 1500 },
    ]
    const added = [
      { account_number: '2611', debit_amount: 2600, credit_amount: 0 },
      { account_number: '2641', debit_amount: 0, credit_amount: 1600 },
    ]
    const client = fakeSupabase(company({ journal_entries: [{ source_type: 'manual', lines: [kept, ...struck] }] }))

    expect(
      await stagedFiledVatNote(
        client,
        'c-1',
        {
          operation_type: 'correct_entry_lines_inline',
          params: {},
          preview_data: {
            journal_entry_id: 'e-1',
            entry_date: '2026-09-30',
            struck_lines: struck,
            added_lines: added,
            resulting_lines: [kept, ...added],
          },
        },
        log,
      ),
    ).toBeNull()
  })

  it('a purchase corrected inside itself carries the note when its moms changes', async () => {
    const struck = [{ account_number: '2641', debit_amount: 100, credit_amount: 0 }]
    const added = [{ account_number: '2641', debit_amount: 125, credit_amount: 0 }]
    const resulting = [
      { account_number: '6540', debit_amount: 375, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 500 },
      ...added,
    ]
    const client = fakeSupabase(company({ journal_entries: [{ source_type: 'manual', lines: purchase('6540', 100) }] }))

    expect(
      await stagedFiledVatNote(
        client,
        'c-1',
        {
          operation_type: 'correct_entry_lines_inline',
          params: {},
          preview_data: { journal_entry_id: 'e-1', entry_date: '2026-09-27', struck_lines: struck, added_lines: added, resulting_lines: resulting },
        },
        log,
      ),
    ).toContain('och rättelsen ändrar underlaget för den')
  })

  it('the makulering of an ingående balans carries no note: the declaration leaves the chain out', async () => {
    const balances = [
      { account_number: '2641', debit_amount: 300, credit_amount: 0 },
      { account_number: '2099', debit_amount: 0, credit_amount: 300 },
    ]
    const tables = company({
      deadlines: [{ ...Q3_FILED }],
      journal_entries: [{ source_type: 'opening_balance', lines: balances }],
    })

    expect(
      await stagedFiledVatNote(
        fakeSupabase(tables),
        'c-1',
        {
          operation_type: 'reverse_entry',
          params: { entry_id: 'e-ib' },
          preview_data: { reversal: { entry_date: '2026-07-01', lines: mirrored(balances as ReturnType<typeof purchase>) } },
        },
        log,
      ),
    ).toBeNull()
  })

  it('a rättelse carries the note only when the moms changes', async () => {
    const original = { entry_date: '2026-09-27', lines: purchase('6540', 100) }

    expect(
      await note({ operation_type: 'correct_entry', params: { lines: purchase('5410', 100) }, preview_data: { original } }),
    ).toBeNull()
    expect(
      await note({ operation_type: 'correct_entry', params: { lines: purchase('6540', 125) }, preview_data: { original } }),
    ).toContain('och rättelsen ändrar underlaget för den')
  })
})
