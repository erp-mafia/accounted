import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import {
  MAX_NEW_LINES_PER_RATTELSE,
  planOpeningBalanceSplit,
  planRattelseCalls,
  previewOpeningBalanceSplit,
  splitOpeningBalancesPerProject,
  type CurrentIbLine,
  type OpeningBalanceSplitPreview,
  type SplitAccountPlan,
  type SplitLineView,
} from '../split-per-project'
import type { ObjectBalanceSplit } from '@/lib/bookkeeping/dimension-carry'
import type { Logger } from '@/lib/logger'

// Issue #3313: "Dela upp IB per projekt". The plan is pure and tested first;
// the doors (preview, apply) run against a per-table Supabase mock.

let lineSeq = 0
function line(account: string, amount: number, extra: Partial<CurrentIbLine> = {}): CurrentIbLine {
  lineSeq += 1
  return {
    id: `00000000-0000-4000-8000-${String(lineSeq).padStart(12, '0')}`,
    account_number: account,
    debit_amount: amount > 0 ? amount : 0,
    credit_amount: amount < 0 ? -amount : 0,
    line_description: `IB ${account}`,
    dimensions: {},
    currency: 'SEK',
    ...extra,
  }
}

const P = (code: string, amount: number): ObjectBalanceSplit => ({ dimensions: { '6': code }, amount })

function nets(lines: ReadonlyArray<{ amount: number; dimensions: Record<string, string> }>) {
  const out: Record<string, number> = {}
  for (const l of lines) {
    const key = l.dimensions['6'] ?? (Object.keys(l.dimensions).length ? JSON.stringify(l.dimensions) : '')
    out[key] = Math.round(((out[key] ?? 0) + l.amount) * 100) / 100
  }
  return out
}

const sum = (lines: ReadonlyArray<{ amount: number }>) =>
  Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100

describe('planOpeningBalanceSplit', () => {
  beforeEach(() => {
    lineSeq = 0
  })

  it('splits an untagged account into one line per project plus the remainder, keeping the total', () => {
    const plans = planOpeningBalanceSplit({
      currentLines: [line('1470', 2100), line('2081', -2100)],
      objectBalances: new Map([['1470', [P('P1', 1300), P('P2', 500)]]]),
      accountNames: new Map([['1470', 'Pågående arbeten']]),
    })
    expect(plans).toHaveLength(1)
    const [plan] = plans
    expect(plan.status).toBe('change')
    expect(plan.total).toBe(2100)
    expect(nets(plan.proposed_lines)).toEqual({ P1: 1300, P2: 500, '': 300 })
    expect(sum(plan.proposed_lines)).toBe(2100)
    expect(plan.proposed_lines[0]).toMatchObject({ debit_amount: 1300, credit_amount: 0, line_description: 'Ingående balans: Pågående arbeten' })
    // 2081 had no project balance last year: untouched, not even listed.
    expect(plans.map((p) => p.account_number)).toEqual(['1470'])
  })

  it('books a negative remainder when the projects exceed the current IB', () => {
    const [plan] = planOpeningBalanceSplit({
      currentLines: [line('1470', 1000)],
      objectBalances: new Map([['1470', [P('P1', 1300), P('P2', 500)]]]),
    })
    expect(nets(plan.proposed_lines)).toEqual({ P1: 1300, P2: 500, '': -800 })
    const remainder = plan.proposed_lines.find((l) => Object.keys(l.dimensions).length === 0)!
    expect(remainder).toMatchObject({ debit_amount: 0, credit_amount: 800, amount: -800 })
    expect(sum(plan.proposed_lines)).toBe(1000)
  })

  it('carries credit project balances and offsetting projects on an account whose IB is zero', () => {
    const [plan] = planOpeningBalanceSplit({
      currentLines: [],
      objectBalances: new Map([['1510', [P('P1', 400), P('P2', -400)]]]),
    })
    expect(plan.total).toBe(0)
    expect(nets(plan.proposed_lines)).toEqual({ P1: 400, P2: -400 })
    expect(plan.proposed_lines.find((l) => l.dimensions['6'] === 'P2')).toMatchObject({ debit_amount: 0, credit_amount: 400 })
  })

  it('rounds to öre with Math.round(x * 100) / 100 and never drifts the total', () => {
    const [plan] = planOpeningBalanceSplit({
      currentLines: [line('1470', 0.3)],
      objectBalances: new Map([['1470', [P('P1', 0.1 + 0.2 - 0.2), P('P2', 0.10000000000000003), P('P3', 1 / 3)]]]),
    })
    for (const l of plan.proposed_lines) {
      expect(Math.round(l.amount * 100) / 100).toBe(l.amount)
    }
    expect(nets(plan.proposed_lines)).toEqual({ P1: 0.1, P2: 0.1, P3: 0.33, '': -0.23 })
    expect(sum(plan.proposed_lines)).toBe(0.3)
  })

  it('is idempotent: an IB already split the same way (in any line shape) is unchanged', () => {
    const objectBalances = new Map([['1470', [P('P1', 1300), P('P2', 500)]]])
    const [already] = planOpeningBalanceSplit({
      currentLines: [
        line('1470', 1000, { dimensions: { '6': 'P1' } }),
        line('1470', 300, { dimensions: { '6': 'P1' } }),
        line('1470', 500, { dimensions: { '6': 'P2' } }),
        line('1470', 100),
        line('1470', 200),
      ],
      objectBalances,
    })
    expect(already.status).toBe('unchanged')

    // A different project allocation with the same total is not this split,
    // and it is never overwritten.
    const [moved] = planOpeningBalanceSplit({
      currentLines: [line('1470', 1800, { dimensions: { '6': 'P1' } }), line('1470', 300)],
      objectBalances,
    })
    expect(moved).toMatchObject({ status: 'skipped', skip_reason: 'existing_split' })
  })

  it('leaves accounts whose previous-year tagged balance is zero, and the VAT accounts, untouched', () => {
    const plans = planOpeningBalanceSplit({
      currentLines: [line('1470', 500), line('2611', -250), line('1510', 800)],
      objectBalances: new Map([
        ['1470', [P('P1', 0), P('P2', 0.001)]],
        ['2611', [P('P1', -250)]],
        ['1510', [P('P1', 800)]],
      ]),
    })
    expect(plans.map((p) => p.account_number)).toEqual(['1510'])
  })

  it('drops a resetting dimension tag on the current IB line when the account is re-split', () => {
    const [plan] = planOpeningBalanceSplit({
      currentLines: [line('1470', 1000, { dimensions: { '1': 'K1' } })],
      objectBalances: new Map([['1470', [P('P1', 1000)]]]),
    })
    expect(plan.status).toBe('change')
    expect(plan.proposed_lines.map((l) => l.dimensions)).toEqual([{ '6': 'P1' }])
  })

  it('never overwrites an IB already split per project from another source (SIE #OIB) with other amounts', () => {
    // The IB was imported with #OIB: P1 carries the old system's cumulative
    // 5000, while last year's tagged closing in Accounted only holds 300.
    const [plan] = planOpeningBalanceSplit({
      currentLines: [line('1470', 5000, { dimensions: { '6': 'P1' } }), line('1470', 1000)],
      objectBalances: new Map([['1470', [P('P1', 300)]]]),
      accumulatingDimensions: new Set(['6']),
    })
    expect(plan).toMatchObject({ status: 'skipped', skip_reason: 'existing_split', total: 6000 })

    // A project the proposal does not carry at all is an existing split too.
    const [other] = planOpeningBalanceSplit({
      currentLines: [line('1470', 700, { dimensions: { '6': 'P9' } }), line('1470', 300)],
      objectBalances: new Map([['1470', [P('P1', 300)]]]),
    })
    expect(other).toMatchObject({ status: 'skipped', skip_reason: 'existing_split' })
  })

  it('splits an IB whose project lines the proposal agrees with (a partial split, or tags on a resetting dimension only)', () => {
    const [partial] = planOpeningBalanceSplit({
      currentLines: [line('1470', 1300, { dimensions: { '6': 'P1' } }), line('1470', 800)],
      objectBalances: new Map([['1470', [P('P1', 1300), P('P2', 500)]]]),
      accumulatingDimensions: new Set(['6']),
    })
    expect(partial.status).toBe('change')
    expect(nets(partial.proposed_lines)).toEqual({ P1: 1300, P2: 500, '': 300 })

    // Dimension 1 resets annually: its tag is not a carried split.
    const [resetting] = planOpeningBalanceSplit({
      currentLines: [line('1470', 1000, { dimensions: { '1': 'K1' } })],
      objectBalances: new Map([['1470', [P('P1', 1000)]]]),
      accumulatingDimensions: new Set(['6']),
    })
    expect(resetting.status).toBe('change')
  })

  it('skips an account the inline rättelse cannot strike: a foreign-currency line, or a line with its own underlag', () => {
    const fx = line('1930', 1000, { currency: 'EUR' })
    const doc = line('1510', 500)
    const plans = planOpeningBalanceSplit({
      currentLines: [fx, doc],
      objectBalances: new Map([
        ['1930', [P('P1', 1000)]],
        ['1510', [P('P1', 500)]],
      ]),
      lineIdsWithDocuments: new Set([doc.id]),
    })
    expect(plans.find((p) => p.account_number === '1930')).toMatchObject({ status: 'skipped', skip_reason: 'foreign_currency' })
    expect(plans.find((p) => p.account_number === '1510')).toMatchObject({ status: 'skipped', skip_reason: 'line_document' })
  })
})

describe('planRattelseCalls', () => {
  const planFor = (account: string, parts: number, total: number): SplitAccountPlan => {
    const [plan] = planOpeningBalanceSplit({
      currentLines: [line(account, total)],
      objectBalances: new Map([[account, Array.from({ length: parts }, (_, i) => P(`P${i + 1}`, 10))]]),
    })
    return plan
  }

  it('packs accounts into calls of at most 100 new lines, one step per account', () => {
    const calls = planRattelseCalls([planFor('1470', 40, 1000), planFor('1510', 40, 1000), planFor('1610', 40, 1000)])
    expect(calls.map((call) => call.map((step) => step.account_number))).toEqual([['1470', '1510'], ['1610']])
    for (const call of calls) {
      expect(call.reduce((n, step) => n + step.add.length, 0)).toBeLessThanOrEqual(MAX_NEW_LINES_PER_RATTELSE)
    }
  })

  it('splits an account with more objects over several calls through an interim remainder', () => {
    const plan = planFor('1510', 250, 3000)
    const calls = planRattelseCalls([plan])
    expect(calls.length).toBe(3)
    expect(calls.map((call) => call[0].kind)).toEqual(['initial', 'continue', 'continue'])

    // Replay the calls the way the RPC applies them: each call keeps the
    // account at its total, and the end state is exactly the proposed split.
    let state: SplitLineView[] = []
    for (const [step] of calls) {
      expect(step.add.length).toBeLessThanOrEqual(MAX_NEW_LINES_PER_RATTELSE)
      state = step.kind === 'initial' ? [...step.add] : [...state.filter((l) => Object.keys(l.dimensions).length > 0), ...step.add]
      expect(sum(state)).toBe(3000)
    }
    expect(nets(state)).toEqual(nets(plan.proposed_lines))
  })

  it('resumes a large account an interrupted run left half split, instead of replaying its first call', () => {
    const plan = planFor('1510', 250, 3000)
    const [first] = planRattelseCalls([plan])
    expect(first[0].kind).toBe('initial')

    // Call 1 committed, call 2 failed: the account holds call 1's lines.
    let seq = 0
    const afterFirst = first[0].add.map((l) => ({ ...l, journal_entry_line_id: `after-${++seq}` }))
    const [replanned] = planOpeningBalanceSplit({
      currentLines: afterFirst.map((l) => ({
        id: l.journal_entry_line_id,
        account_number: '1510',
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
        line_description: l.line_description,
        dimensions: l.dimensions,
        currency: 'SEK',
      })),
      objectBalances: new Map([['1510', Array.from({ length: 250 }, (_, i) => P(`P${i + 1}`, 10))]]),
    })
    expect(replanned.status).toBe('change')
    const resumed = planRattelseCalls([replanned])
    // Two calls left, both continuing from the interim remainder; the lines
    // call 1 booked are never struck and re-added (the RPC refuses that).
    expect(resumed.map((call) => call[0].kind)).toEqual(['continue', 'continue'])
    const bookedBags = new Set(first[0].add.filter((l) => Object.keys(l.dimensions).length).map((l) => l.dimensions['6']))
    for (const [step] of resumed) {
      expect(step.add.some((l) => bookedBags.has(l.dimensions['6']))).toBe(false)
    }

    let state: SplitLineView[] = [...first[0].add]
    for (const [step] of resumed) {
      state = [...state.filter((l) => Object.keys(l.dimensions).length > 0), ...step.add]
      expect(sum(state)).toBe(3000)
    }
    expect(nets(state)).toEqual(nets(plan.proposed_lines))
  })

  it('plans nothing for unchanged or skipped accounts', () => {
    const unchanged = { ...planFor('1470', 2, 20), status: 'unchanged' as const }
    const skipped = { ...planFor('1510', 2, 20), status: 'skipped' as const }
    expect(planRattelseCalls([unchanged, skipped])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Doors
// ---------------------------------------------------------------------------

const COMPANY = 'company-1'
const USER = 'user-1'
const PERIOD = '7b3a0000-0000-4000-8000-000000000001'
const PREVIOUS = '7b3a0000-0000-4000-8000-000000000000'
const IB = '4d2a0000-0000-4000-8000-000000000001'
const DIM6 = 'dddd0000-0000-4000-8000-000000000006'
const DIM1 = 'dddd0000-0000-4000-8000-000000000001'

const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log }

const L1470 = 'aaaa0000-0000-4000-8000-000000001470'
const L2081 = 'aaaa0000-0000-4000-8000-000000002081'

function rows(overrides: Record<string, TableMockResult | TableMockResult[]> = {}) {
  return {
    fiscal_periods: [
      {
        data: {
          id: PERIOD,
          name: '2026',
          period_start: '2026-01-01',
          period_end: '2026-12-31',
          is_closed: false,
          locked_at: null,
          opening_balances_set: true,
          opening_balance_entry_id: IB,
          previous_period_id: PREVIOUS,
        },
      },
      { data: { id: PREVIOUS, name: '2025', is_closed: true, period_end: '2025-12-31' } },
    ],
    journal_entries: [
      { data: { id: IB, status: 'posted', entry_date: '2026-01-01', voucher_series: 'A', voucher_number: 1 } },
      { data: null, count: 0 },
    ],
    journal_entry_lines: {
      data: [
        { id: L1470, account_number: '1470', debit_amount: '2100.00', credit_amount: '0.00', line_description: 'IB 1470', dimensions: {}, currency: 'SEK' },
        { id: L2081, account_number: '2081', debit_amount: '0.00', credit_amount: '2100.00', line_description: 'IB 2081', dimensions: {}, currency: 'SEK' },
      ],
    },
    dimensions: {
      data: [
        { id: DIM1, sie_dim_no: 1, resets_annually: true },
        { id: DIM6, sie_dim_no: 6, resets_annually: false },
      ],
    },
    'rpc:compute_object_closing_balances': {
      data: [
        { account_number: '1470', dimensions: { '6': 'P1' }, net: '1300.00' },
        { account_number: '1470', dimensions: { '6': 'P2' }, net: 500 },
      ],
    },
    chart_of_accounts: { data: [{ account_number: '1470', account_name: 'Pågående arbeten' }] },
    document_attachments: { data: [] },
    dimension_values: {
      data: [
        { dimension_id: DIM6, code: 'P1', name: 'Kv. Eken', is_active: true },
        // A finished project, archived during the year: still carried.
        { dimension_id: DIM6, code: 'P2', name: 'Kv. Linden', is_active: false },
      ],
    },
    company_settings: { data: { bookkeeping_locked_through: null } },
    'rpc:correct_entry_lines_inline': { data: { log_id: 'log-1', struck_count: 1, added_count: 3 } },
    ...overrides,
  }
}

function setup(overrides: Record<string, TableMockResult | TableMockResult[]> = {}) {
  const mock = createTableMockSupabase(rows(overrides))
  const ctx = { supabase: mock.supabase as never, companyId: COMPANY, userId: USER, log }
  return { ...mock, ctx }
}

function lockedPeriod(extra: Record<string, unknown>) {
  const base = rows().fiscal_periods as TableMockResult[]
  return [{ data: { ...(base[0].data as Record<string, unknown>), ...extra } }, base[1]]
}

describe('previewOpeningBalanceSplit', () => {
  it('previews the split from the previous year, carrying only accumulating dimensions', async () => {
    const { ctx, findCall } = setup()
    const outcome = await previewOpeningBalanceSplit(ctx, { fiscal_period_id: PERIOD })
    expect(outcome.ok).toBe(true)
    const preview = (outcome as { data: OpeningBalanceSplitPreview }).data

    // Dimension 1 resets annually: never asked for, never carried.
    expect(findCall('rpc:compute_object_closing_balances', 'rpc')?.[0]).toEqual({
      p_company_id: COMPANY,
      p_fiscal_period_id: PREVIOUS,
      p_dim_nos: ['6'],
    })
    expect(preview).toMatchObject({
      journal_entry_id: IB,
      voucher: 'A1',
      source_fiscal_period_id: PREVIOUS,
      source_fiscal_period_name: '2025',
      source_period_closed: true,
      accumulating_dimensions: ['6'],
      method: 'inline_rattelse',
      accounts_to_change: 1,
      can_apply: true,
      blocked: null,
      unresolved_dimensions: [],
    })
    expect(preview.accounts[0].current_lines[0].journal_entry_line_id).toBe(L1470)
    expect(nets(preview.accounts[0].proposed_lines)).toEqual({ P1: 1300, P2: 500, '': 300 })
    expect(preview.dimension_values).toEqual([
      { sie_dim_no: '6', code: 'P1', name: 'Kv. Eken', is_active: true },
      { sie_dim_no: '6', code: 'P2', name: 'Kv. Linden', is_active: false },
    ])
    expect(preview.fingerprint).toMatch(/^[0-9a-f]{32}$/)
  })

  it('still shows the plan for a locked year, with what to open first', async () => {
    const { ctx } = setup({ fiscal_periods: lockedPeriod({ locked_at: '2026-09-01T00:00:00Z' }) })
    const outcome = await previewOpeningBalanceSplit(ctx, { fiscal_period_id: PERIOD })
    const preview = (outcome as { data: OpeningBalanceSplitPreview }).data
    expect(preview.accounts_to_change).toBe(1)
    expect(preview.can_apply).toBe(false)
    expect(preview.blocked?.code).toBe('OB_SPLIT_PERIOD_LOCKED')
    expect(preview.blocked?.message_sv).toMatch(/Lås upp året först/)
  })

  it('answers 404 for a year that is not the company\'s', async () => {
    const { ctx } = setup({ fiscal_periods: { data: null } })
    expect(await previewOpeningBalanceSplit(ctx, { fiscal_period_id: PERIOD })).toEqual({ ok: false, code: 'OB_PERIOD_NOT_FOUND' })
  })
})

describe('splitOpeningBalancesPerProject', () => {
  it('applies the split as one inline rättelse of the same IB verifikat', async () => {
    const { ctx, findCalls } = setup()
    const outcome = await splitOpeningBalancesPerProject(ctx, { fiscal_period_id: PERIOD })
    expect(outcome).toMatchObject({
      ok: true,
      data: {
        journal_entry_id: IB,
        applied: true,
        accounts_changed: ['1470'],
        lines_struck: 1,
        lines_added: 3,
        rattelse_log_ids: ['log-1'],
      },
    })
    const calls = findCalls('rpc:correct_entry_lines_inline', 'rpc')
    expect(calls).toHaveLength(1)
    const args = calls[0][0] as { p_entry_id: string; p_strike_line_ids: string[]; p_new_lines: Array<Record<string, unknown>>; p_user_id: string }
    expect(args.p_entry_id).toBe(IB)
    expect(args.p_user_id).toBe(USER)
    expect(args.p_strike_line_ids).toEqual([L1470])
    expect(args.p_new_lines).toEqual([
      { account_number: '1470', debit_amount: 1300, credit_amount: 0, line_description: 'Ingående balans: Pågående arbeten', dimensions: { '6': 'P1' } },
      { account_number: '1470', debit_amount: 500, credit_amount: 0, line_description: 'Ingående balans: Pågående arbeten', dimensions: { '6': 'P2' } },
      { account_number: '1470', debit_amount: 300, credit_amount: 0, line_description: 'Ingående balans: Pågående arbeten', dimensions: {} },
    ])
  })

  it('is a no-op the second time: an IB already split writes nothing', async () => {
    const { ctx, findCalls } = setup({
      journal_entry_lines: {
        data: [
          { id: 'l1', account_number: '1470', debit_amount: 1300, credit_amount: 0, line_description: null, dimensions: { '6': 'P1' }, currency: 'SEK' },
          { id: 'l2', account_number: '1470', debit_amount: 500, credit_amount: 0, line_description: null, dimensions: { '6': 'P2' }, currency: 'SEK' },
          { id: 'l3', account_number: '1470', debit_amount: 300, credit_amount: 0, line_description: null, dimensions: {}, currency: 'SEK' },
          { id: 'l4', account_number: '2081', debit_amount: 0, credit_amount: 2100, line_description: null, dimensions: {}, currency: 'SEK' },
        ],
      },
      // Even after the year was locked: there is nothing to refuse.
      fiscal_periods: lockedPeriod({ locked_at: '2026-09-01T00:00:00Z' }),
    })
    const outcome = await splitOpeningBalancesPerProject(ctx, { fiscal_period_id: PERIOD })
    expect(outcome).toMatchObject({ ok: true, data: { applied: false, accounts_changed: [], lines_added: 0 } })
    expect(findCalls('rpc:correct_entry_lines_inline', 'rpc')).toHaveLength(0)
  })

  it.each([
    ['locked', { locked_at: '2026-09-01T00:00:00Z' }, 'OB_SPLIT_PERIOD_LOCKED'],
    ['closed', { is_closed: true }, 'OB_SPLIT_PERIOD_CLOSED'],
  ])('refuses a %s year without writing', async (_label, extra, code) => {
    const { ctx, findCalls } = setup({ fiscal_periods: lockedPeriod(extra) })
    const outcome = await splitOpeningBalancesPerProject(ctx, { fiscal_period_id: PERIOD })
    expect(outcome).toMatchObject({ ok: false, code })
    expect(findCalls('rpc:correct_entry_lines_inline', 'rpc')).toHaveLength(0)
  })

  it('refuses behind the company lock date, and under a posted bokslut', async () => {
    const lockDate = setup({ company_settings: { data: { bookkeeping_locked_through: '2026-03-31' } } })
    expect(await splitOpeningBalancesPerProject(lockDate.ctx, { fiscal_period_id: PERIOD })).toMatchObject({
      ok: false,
      code: 'OB_COMPANY_LOCK_DATE',
      details: { lockDate: '2026-03-31', entryDate: '2026-01-01' },
    })

    const lockPreview = await previewOpeningBalanceSplit(
      setup({ company_settings: { data: { bookkeeping_locked_through: '2026-03-31' } } }).ctx,
      { fiscal_period_id: PERIOD },
    )
    expect((lockPreview as { data: OpeningBalanceSplitPreview }).data.blocked?.message_sv).toMatch(/låst t\.o\.m\. 2026-03-31/)

    const bokslut = setup({
      journal_entries: [
        { data: { id: IB, status: 'posted', entry_date: '2026-01-01', voucher_series: 'A', voucher_number: 1 } },
        { data: null, count: 1 },
      ],
    })
    expect(await splitOpeningBalancesPerProject(bokslut.ctx, { fiscal_period_id: PERIOD })).toMatchObject({
      ok: false,
      code: 'OB_CORRECT_YEAR_END_EXISTS',
    })
  })

  it('refuses a project code the registry does not hold, naming it', async () => {
    const { ctx, findCalls } = setup({
      dimension_values: { data: [{ dimension_id: DIM6, code: 'P1', name: 'Kv. Eken', is_active: true }] },
    })
    const outcome = await splitOpeningBalancesPerProject(ctx, { fiscal_period_id: PERIOD })
    expect(outcome).toMatchObject({
      ok: false,
      code: 'OB_SPLIT_DIMENSION_UNRESOLVED',
      details: { unresolved: [{ sie_dim_no: '6', code: 'P2', reason: 'unknown_value', accounts: ['1470'] }] },
    })
    expect((outcome as { messageSv?: string }).messageSv).toMatch(/P2/)
    expect(findCalls('rpc:correct_entry_lines_inline', 'rpc')).toHaveLength(0)
  })

  it('refuses when the split changed since the reviewed preview', async () => {
    const { ctx, findCalls } = setup()
    const outcome = await splitOpeningBalancesPerProject(ctx, { fiscal_period_id: PERIOD, expected_fingerprint: 'stale' })
    expect(outcome).toMatchObject({ ok: false, code: 'OB_SPLIT_PROPOSAL_CHANGED' })
    expect(findCalls('rpc:correct_entry_lines_inline', 'rpc')).toHaveLength(0)
  })

  it('applies with the fingerprint the preview answered', async () => {
    const preview = await previewOpeningBalanceSplit(setup().ctx, { fiscal_period_id: PERIOD })
    const fingerprint = (preview as { data: OpeningBalanceSplitPreview }).data.fingerprint
    const outcome = await splitOpeningBalancesPerProject(setup().ctx, { fiscal_period_id: PERIOD, expected_fingerprint: fingerprint })
    expect(outcome).toMatchObject({ ok: true, data: { applied: true, fingerprint } })
  })

  it('answers the preview on a dry run and writes nothing', async () => {
    const { ctx, findCalls } = setup()
    const outcome = await splitOpeningBalancesPerProject(ctx, { fiscal_period_id: PERIOD }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { accounts_to_change: 1, can_apply: true } })
    expect(findCalls('rpc:correct_entry_lines_inline', 'rpc')).toHaveLength(0)
  })

  it('refuses without a previous year, and without an IB', async () => {
    const base = rows().fiscal_periods as TableMockResult[]
    const noPrevious = setup({
      fiscal_periods: [{ data: { ...(base[0].data as Record<string, unknown>), previous_period_id: null } }, { data: null }],
    })
    expect(await splitOpeningBalancesPerProject(noPrevious.ctx, { fiscal_period_id: PERIOD })).toMatchObject({
      ok: false,
      code: 'OB_SPLIT_NO_PREVIOUS_YEAR',
    })
    // Without the chain link, only the year ending the day before counts:
    // never an earlier year across a gap.
    expect(noPrevious.findCalls('fiscal_periods', 'eq')).toContainEqual(['period_end', '2025-12-31'])
    expect(noPrevious.findCalls('fiscal_periods', 'lt')).toEqual([])

    const noIb = setup({ fiscal_periods: lockedPeriod({ opening_balances_set: false, opening_balance_entry_id: null }) })
    expect(await splitOpeningBalancesPerProject(noIb.ctx, { fiscal_period_id: PERIOD })).toMatchObject({
      ok: false,
      code: 'OB_CORRECT_NO_EXISTING',
    })
  })

  it('maps the RPC\'s own refusals to this action\'s codes', async () => {
    const locked = setup({
      'rpc:correct_entry_lines_inline': {
        error: { code: 'P0001', message: 'Perioden är stängd eller låst: använd rättelseverifikat (storno).' },
      },
    })
    expect(await splitOpeningBalancesPerProject(locked.ctx, { fiscal_period_id: PERIOD })).toMatchObject({
      ok: false,
      code: 'OB_SPLIT_PERIOD_LOCKED',
    })

    const other = setup({
      'rpc:correct_entry_lines_inline': { error: { code: 'P0001', message: 'Kontot 1470 finns inte i kontoplanen.' } },
    })
    expect(await splitOpeningBalancesPerProject(other.ctx, { fiscal_period_id: PERIOD })).toMatchObject({
      ok: false,
      code: 'OB_SPLIT_REFUSED',
      messageSv: 'Kontot 1470 finns inte i kontoplanen.',
    })
  })
})

describe('splitOpeningBalancesPerProject: no-ops, pricing, existing splits', () => {
  it('answers OB_SPLIT_NOTHING_TO_DO on a dry run when nothing would change, so nothing gets staged', async () => {
    const { ctx, findCalls } = setup({
      journal_entry_lines: {
        data: [
          { id: 'l1', account_number: '1470', debit_amount: 1300, credit_amount: 0, line_description: null, dimensions: { '6': 'P1' }, currency: 'SEK' },
          { id: 'l2', account_number: '1470', debit_amount: 500, credit_amount: 0, line_description: null, dimensions: { '6': 'P2' }, currency: 'SEK' },
          { id: 'l3', account_number: '1470', debit_amount: 300, credit_amount: 0, line_description: null, dimensions: {}, currency: 'SEK' },
          { id: 'l4', account_number: '2081', debit_amount: 0, credit_amount: 2100, line_description: null, dimensions: {}, currency: 'SEK' },
        ],
      },
    })
    const outcome = await splitOpeningBalancesPerProject(ctx, { fiscal_period_id: PERIOD }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'OB_SPLIT_NOTHING_TO_DO', details: { accounts_unchanged: 1 } })
    expect(findCalls('rpc:correct_entry_lines_inline', 'rpc')).toHaveLength(0)
  })

  it('prices the split for the unattended-commit ceiling: the largest side struck or added', async () => {
    const preview = await previewOpeningBalanceSplit(setup().ctx, { fiscal_period_id: PERIOD })
    // 1470: 2100 debit struck, 1300 + 500 + 300 debit added.
    expect((preview as { data: OpeningBalanceSplitPreview }).data.changed_amount_sek).toBe(2100)

    // A credit account is priced on its credit side, never at zero.
    const credit = await previewOpeningBalanceSplit(
      setup({
        journal_entry_lines: {
          data: [
            { id: L1470, account_number: '1930', debit_amount: 4000, credit_amount: 0, line_description: null, dimensions: {}, currency: 'SEK' },
            { id: L2081, account_number: '2440', debit_amount: 0, credit_amount: 4000, line_description: null, dimensions: {}, currency: 'SEK' },
          ],
        },
        'rpc:compute_object_closing_balances': { data: [{ account_number: '2440', dimensions: { '6': 'P1' }, net: -2500 }] },
      }).ctx,
      { fiscal_period_id: PERIOD },
    )
    expect((credit as { data: OpeningBalanceSplitPreview }).data.changed_amount_sek).toBe(4000)
  })

  it('leaves an IB already split per project with other amounts alone: applied=false, reported as skipped', async () => {
    const { ctx, findCalls } = setup({
      journal_entry_lines: {
        data: [
          { id: 'l1', account_number: '1470', debit_amount: 1800, credit_amount: 0, line_description: null, dimensions: { '6': 'P1' }, currency: 'SEK' },
          { id: 'l2', account_number: '1470', debit_amount: 300, credit_amount: 0, line_description: null, dimensions: {}, currency: 'SEK' },
          { id: 'l3', account_number: '2081', debit_amount: 0, credit_amount: 2100, line_description: null, dimensions: {}, currency: 'SEK' },
        ],
      },
    })
    const outcome = await splitOpeningBalancesPerProject(ctx, { fiscal_period_id: PERIOD })
    expect(outcome).toMatchObject({
      ok: true,
      data: { applied: false, accounts_changed: [], accounts_skipped: [{ account_number: '1470', reason: 'existing_split' }] },
    })
    expect(findCalls('rpc:correct_entry_lines_inline', 'rpc')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// More than 100 new lines: several inline rättelser against a stateful IB
// ---------------------------------------------------------------------------

interface SimLine {
  id: string
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description: string | null
  dimensions: Record<string, string>
  currency: string
}

interface World {
  lines: SimLine[]
  rpcCalls: number
  /** The 1-based call that fails, with this error. */
  failOn?: { call: number; error: { code: string; message: string } }
  /** 1470's total after each committed call. */
  totals: number[]
}

const PROJECTS = 150

function lineKey(l: { account_number: string; debit_amount: number; credit_amount: number; line_description: string | null; dimensions: Record<string, string> }) {
  const dims = JSON.stringify(Object.fromEntries(Object.entries(l.dimensions).sort()))
  return `${l.account_number}|${Number(l.debit_amount).toFixed(2)}|${Number(l.credit_amount).toFixed(2)}|${(l.line_description ?? '').trim()}|${dims}`
}

/** correct_entry_lines_inline as the database runs it, for the guards this path can hit. */
function simulateRattelse(world: World, args: { p_strike_line_ids: string[]; p_new_lines: Array<Omit<SimLine, 'id' | 'currency'>> }) {
  world.rpcCalls += 1
  if (world.failOn?.call === world.rpcCalls) return { data: null, error: world.failOn.error }
  if (args.p_new_lines.length > 100) return { data: null, error: { code: 'P0001', message: 'Högst 100 nya rader per rättelse.' } }
  const strike = new Set(args.p_strike_line_ids)
  if ([...strike].some((id) => !world.lines.some((l) => l.id === id))) {
    return { data: null, error: { code: 'P0001', message: 'En eller flera rader som ska strykas hör inte till verifikationen.' } }
  }
  const struckKeys = world.lines.filter((l) => strike.has(l.id)).map(lineKey).sort()
  const addedKeys = args.p_new_lines.map(lineKey).sort()
  if (JSON.stringify(struckKeys) === JSON.stringify(addedKeys)) {
    return { data: null, error: { code: 'P0001', message: 'Rättelsen ändrar ingenting.' } }
  }
  const next = [
    ...world.lines.filter((l) => !strike.has(l.id)),
    ...args.p_new_lines.map((l, i) => ({ ...l, id: `new-${world.rpcCalls}-${i}`, currency: 'SEK' })),
  ]
  const debit = Math.round(next.reduce((s, l) => s + l.debit_amount, 0) * 100) / 100
  const credit = Math.round(next.reduce((s, l) => s + l.credit_amount, 0) * 100) / 100
  if (debit !== credit) return { data: null, error: { code: 'P0001', message: 'Verifikationen balanserar inte efter rättelsen.' } }
  world.lines = next
  world.totals.push(
    Math.round(next.filter((l) => l.account_number === '1470').reduce((s, l) => s + l.debit_amount - l.credit_amount, 0) * 100) / 100,
  )
  return { data: { log_id: `log-${world.rpcCalls}` }, error: null }
}

function liveChain(resolveWith: () => unknown, record: (method: string, args: unknown[]) => void): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(resolveWith())
        return (...args: unknown[]) => {
          record(String(prop), args)
          return liveChain(resolveWith, record)
        }
      },
    },
  )
}

/** A fresh table mock per run over shared IB state: lines read live, the RPC applied to them. */
function statefulSetup(world: World) {
  const codes = Array.from({ length: PROJECTS }, (_, i) => `P${String(i + 1).padStart(3, '0')}`)
  const mock = createTableMockSupabase(
    rows({
      'rpc:compute_object_closing_balances': {
        data: codes.map((code) => ({ account_number: '1470', dimensions: { '6': code }, net: 100 })),
      },
      dimension_values: { data: codes.map((code) => ({ dimension_id: DIM6, code, name: `Projekt ${code}`, is_active: true })) },
    }),
  )
  const rpcArgs: Array<{ p_strike_line_ids: string[]; p_new_lines: Array<Record<string, unknown>> }> = []
  const tableFrom = mock.supabase.from.getMockImplementation()!
  const tableRpc = mock.supabase.rpc.getMockImplementation()!
  mock.supabase.from.mockImplementation((table: string) =>
    table === 'journal_entry_lines'
      ? (liveChain(() => ({ data: world.lines.map((l) => ({ ...l })), error: null }), () => {}) as never)
      : tableFrom(table),
  )
  mock.supabase.rpc.mockImplementation((name: string, args?: unknown) => {
    if (name !== 'correct_entry_lines_inline') return tableRpc(name, args)
    const typed = args as { p_strike_line_ids: string[]; p_new_lines: Array<Omit<SimLine, 'id' | 'currency'>> }
    rpcArgs.push(JSON.parse(JSON.stringify(typed)))
    const result = simulateRattelse(world, typed)
    return liveChain(() => result, () => {}) as never
  })
  const ctx = { supabase: mock.supabase as never, companyId: COMPANY, userId: USER, log }
  return { ctx, rpcArgs }
}

function unsplitWorld(): World {
  return {
    lines: [
      { id: L1470, account_number: '1470', debit_amount: 20000, credit_amount: 0, line_description: 'IB 1470', dimensions: {}, currency: 'SEK' },
      { id: L2081, account_number: '2081', debit_amount: 0, credit_amount: 20000, line_description: 'IB 2081', dimensions: {}, currency: 'SEK' },
    ],
    rpcCalls: 0,
    totals: [],
  }
}

function worldNets(world: World): Record<string, number> {
  return nets(world.lines.filter((l) => l.account_number === '1470').map((l) => ({ amount: l.debit_amount - l.credit_amount, dimensions: l.dimensions })))
}

const EXPECTED_SPLIT = {
  ...Object.fromEntries(Array.from({ length: PROJECTS }, (_, i) => [`P${String(i + 1).padStart(3, '0')}`, 100])),
  '': 5000,
}

describe('splitOpeningBalancesPerProject over several inline rättelser (more than 100 new lines)', () => {
  it('splits a 150-project account in two calls; the second strikes only the interim remainder', async () => {
    const world = unsplitWorld()
    const { ctx, rpcArgs } = statefulSetup(world)
    const outcome = await splitOpeningBalancesPerProject(ctx, { fiscal_period_id: PERIOD })

    expect(outcome).toMatchObject({
      ok: true,
      data: { applied: true, accounts_changed: ['1470'], lines_struck: 2, lines_added: 152, rattelse_log_ids: ['log-1', 'log-2'] },
    })
    expect(rpcArgs).toHaveLength(2)
    expect(rpcArgs[0].p_strike_line_ids).toEqual([L1470])
    expect(rpcArgs[0].p_new_lines).toHaveLength(100)
    // Call 2 re-reads the IB and strikes call 1's untagged remainder only.
    const interim = rpcArgs[0].p_new_lines.findIndex((l) => Object.keys(l.dimensions as object).length === 0)
    expect(rpcArgs[1].p_strike_line_ids).toEqual([`new-1-${interim}`])
    expect(rpcArgs[1].p_new_lines).toHaveLength(52)
    // Every call kept the account at its IB; the end state is the split.
    expect(world.totals).toEqual([20000, 20000])
    expect(worldNets(world)).toEqual(EXPECTED_SPLIT)

    // And a third run is a no-op.
    const again = await splitOpeningBalancesPerProject(statefulSetup(world).ctx, { fiscal_period_id: PERIOD })
    expect(again).toMatchObject({ ok: true, data: { applied: false } })
    expect(world.rpcCalls).toBe(2)
  })

  it('reports what call 1 applied when call 2 fails, and a rerun finishes the split', async () => {
    const world = unsplitWorld()
    world.failOn = { call: 2, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
    const first = await splitOpeningBalancesPerProject(statefulSetup(world).ctx, { fiscal_period_id: PERIOD })

    expect(first).toMatchObject({
      ok: false,
      code: 'OB_SPLIT_FAILED',
      details: { accounts_changed: ['1470'], rattelse_log_ids: ['log-1'] },
      partialPostedIds: { journal_entry_id: IB, rattelse_log_ids: 'log-1', accounts_changed: '1470' },
    })
    // Consistent in between: the account still nets to its IB.
    expect(world.totals).toEqual([20000])
    expect(world.lines.filter((l) => l.account_number === '1470')).toHaveLength(100)

    // The rerun keeps the 99 project lines in place and continues.
    world.failOn = undefined
    const preview = await previewOpeningBalanceSplit(statefulSetup(world).ctx, { fiscal_period_id: PERIOD })
    expect((preview as { data: OpeningBalanceSplitPreview }).data.accounts[0]).toMatchObject({ status: 'change', skip_reason: null })
    const { ctx, rpcArgs } = statefulSetup(world)
    const rerun = await splitOpeningBalancesPerProject(ctx, { fiscal_period_id: PERIOD })
    expect(rerun).toMatchObject({ ok: true, data: { applied: true, lines_struck: 1, lines_added: 52 } })
    expect(rpcArgs).toHaveLength(1)
    expect(rpcArgs[0].p_strike_line_ids).toHaveLength(1)
    expect(world.totals).toEqual([20000, 20000])
    expect(worldNets(world)).toEqual(EXPECTED_SPLIT)
  })

  it('reports partial progress on a refusal mid-run too (the year was locked between calls)', async () => {
    const world = unsplitWorld()
    world.failOn = { call: 2, error: { code: 'P0001', message: 'Perioden är stängd eller låst: använd rättelseverifikat (storno).' } }
    const outcome = await splitOpeningBalancesPerProject(statefulSetup(world).ctx, { fiscal_period_id: PERIOD })
    expect(outcome).toMatchObject({
      ok: false,
      code: 'OB_SPLIT_PERIOD_LOCKED',
      partialPostedIds: { journal_entry_id: IB, rattelse_log_ids: 'log-1' },
    })
  })
})
