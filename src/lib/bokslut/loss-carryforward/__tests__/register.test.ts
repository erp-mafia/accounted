import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import {
  getLossCarryforward,
  listLossCarryforwards,
  loadRegisterDeficit,
  saveLossCarryforward,
  type LossCarryforwardRow,
} from '../register'

const COMPANY = 'company-1'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as unknown as Logger

const P2025 = { id: 'fp-2025', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' }
const P2026 = { id: 'fp-2026', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' }

function row(overrides: Partial<LossCarryforwardRow> = {}): LossCarryforwardRow {
  return {
    id: 'tlc-2025',
    company_id: COMPANY,
    fiscal_period_id: P2025.id,
    brought_forward: '0.00',
    result_before_deficit: '-300000.00',
    group_contributions_received: '0.00',
    amount_block_reduction: '0.00',
    amount_block_manual: false,
    group_block_reduction: '0.00',
    group_block_manual: false,
    carried_forward: '300000.00',
    ownership_change_date: null,
    ownership_change_source: null,
    amount_block_applies: false,
    acquisition_cost: null,
    capital_contributions: '0.00',
    group_block_applies: false,
    group_block_last_year: null,
    source: 'manual',
    note: null,
    document_id: null,
    tax_assessment_notice_id: null,
    updated_at: '2026-10-29T00:00:00Z',
    ...overrides,
  }
}

let mock: ReturnType<typeof createQueuedMockSupabase>

function ctx() {
  return { supabase: mock.supabase as never, companyId: COMPANY, userId: 'user-1', log }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('BOLAGET_COMPANY_IDS', COMPANY)
  mock = createQueuedMockSupabase()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the register gate', () => {
  it('refuses a company the switch leaves out', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', 'another-company')
    expect(await listLossCarryforwards(ctx())).toEqual({ ok: false, code: 'LOSS_CARRYFORWARD_UNAVAILABLE' })
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('refuses a form that does not file INK2', async () => {
    mock.enqueue({ data: { entity_type: 'enskild_firma' } })
    expect(await listLossCarryforwards(ctx())).toEqual({ ok: false, code: 'LOSS_CARRYFORWARD_FORM_UNSUPPORTED' })
  })
})

describe('listLossCarryforwards', () => {
  it('reads the years oldest first and checks each against the one before it', async () => {
    mock.enqueue({ data: { entity_type: 'aktiebolag' } })
    mock.enqueue({
      data: [
        row({ id: 'tlc-2026', fiscal_period_id: P2026.id, brought_forward: '250000.00', result_before_deficit: '100000.00', carried_forward: '150000.00' }),
        row(),
      ],
    })
    mock.enqueue({ data: [P2026, P2025] })
    const outcome = await listLossCarryforwards(ctx())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || outcome.dryRun) return
    const [first, second] = outcome.data.tax_loss_carryforwards
    expect(first).toMatchObject({ fiscal_year: 2025, brought_forward: 0, carried_forward: 300_000, warnings: [] })
    expect(second).toMatchObject({
      tax_loss_carryforward_id: 'tlc-2026',
      fiscal_year: 2026,
      brought_forward: 250_000,
      deductible: 250_000,
      taxable_result: -150_000,
      carried_forward: 150_000,
    })
    // 2025 carried 300 000 forward, 2026 brings 250 000: said, never changed.
    expect(second.warnings.map((w) => [w.code, w.amount])).toEqual([['brought_forward_differs', 300_000]])
  })
})

describe('getLossCarryforward', () => {
  it('answers NOT_FOUND for an id the company does not have', async () => {
    mock.enqueue({ data: { entity_type: 'aktiebolag' } })
    mock.enqueue({ data: [] })
    expect(await getLossCarryforward(ctx(), 'nope')).toEqual({ ok: false, code: 'LOSS_CARRYFORWARD_NOT_FOUND' })
  })
})

describe('saveLossCarryforward', () => {
  const input = {
    fiscal_period_id: P2026.id,
    brought_forward: 1_000_000,
    source: 'tax_assessment' as const,
    result_before_deficit: 100_000,
  }

  it('answers FISCAL_PERIOD_NOT_FOUND for another company\'s period', async () => {
    mock.enqueue({ data: { entity_type: 'aktiebolag' } })
    mock.enqueue({ data: [] })
    const outcome = await saveLossCarryforward(ctx(), input, { dryRun: false })
    expect(outcome).toMatchObject({ ok: false, code: 'FISCAL_PERIOD_NOT_FOUND' })
  })

  it('refuses an ownership change outside the year and reductions above 4.14 a', async () => {
    mock.enqueue({ data: { entity_type: 'aktiebolag' } })
    mock.enqueue({ data: [P2026] })
    const outside = await saveLossCarryforward(
      ctx(),
      { ...input, ownership_change: { date: '2025-12-31', amount_block: true, group_block: false } },
      { dryRun: false },
    )
    expect(outside).toMatchObject({ ok: false, code: 'LOSS_CARRYFORWARD_CHANGE_OUTSIDE_YEAR' })

    mock.enqueue({ data: { entity_type: 'aktiebolag' } })
    mock.enqueue({ data: [P2026] })
    const exceeds = await saveLossCarryforward(
      ctx(),
      { ...input, amount_block_reduction: 900_000, group_block_reduction: 200_000 },
      { dryRun: false },
    )
    expect(exceeds).toMatchObject({ ok: false, code: 'LOSS_CARRYFORWARD_REDUCTIONS_EXCEED' })
  })

  it('refuses a document of another company', async () => {
    mock.enqueue({ data: { entity_type: 'aktiebolag' } })
    mock.enqueue({ data: [P2026] })
    mock.enqueue({ data: null })
    const outcome = await saveLossCarryforward(ctx(), { ...input, document_id: '00000000-0000-4000-8000-000000000001' }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: false, code: 'LOSS_CARRYFORWARD_LINK_NOT_FOUND', details: { field: 'document_id' } })
  })

  it('computes the beloppsspärr on a dry run and writes nothing', async () => {
    mock.enqueue({ data: { entity_type: 'aktiebolag' } })
    mock.enqueue({ data: [P2026] })
    mock.enqueue({ data: [] })
    const outcome = await saveLossCarryforward(
      ctx(),
      {
        ...input,
        ownership_change: { date: '2026-06-01', amount_block: true, acquisition_cost: 250_000, capital_contributions: 50_000, group_block: true },
      },
      { dryRun: true },
    )
    expect(outcome.ok && outcome.dryRun).toBe(true)
    if (!outcome.ok || !outcome.dryRun) return
    expect(outcome.preview).toMatchObject({
      tax_loss_carryforward_id: null,
      amount_block_reduction: 400_000,
      // Year of change with a koncernbidragsspärr and no koncernbidrag received: the cap is the whole result.
      group_block_reduction: 500_000,
      deductible: 100_000,
      carried_forward: 500_000,
      ownership_change: { amount_block_limit: 600_000, group_block_last_year: 2031, source: 'manual' },
    })
    expect(mock.findCalls('tax_loss_carryforwards', 'upsert')).toEqual([])
  })

  it('stores the computed year in its own name and answers the saved row', async () => {
    mock.enqueue({ data: { entity_type: 'aktiebolag' } })
    mock.enqueue({ data: [P2026] })
    mock.enqueue({ data: [] })
    mock.enqueue({
      data: row({
        id: 'tlc-2026',
        fiscal_period_id: P2026.id,
        brought_forward: '1000000.00',
        result_before_deficit: '100000.00',
        carried_forward: '900000.00',
        source: 'tax_assessment',
      }),
    })
    const outcome = await saveLossCarryforward(ctx(), input, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, created: true, data: { tax_loss_carryforward_id: 'tlc-2026', carried_forward: 900_000, warnings: [] } })
    const [payload, options] = mock.findCall('tax_loss_carryforwards', 'upsert') as [Record<string, unknown>, unknown]
    expect(options).toEqual({ onConflict: 'company_id,fiscal_period_id' })
    expect(payload).toMatchObject({
      company_id: COMPANY,
      fiscal_period_id: P2026.id,
      brought_forward: 1_000_000,
      amount_block_reduction: 0,
      amount_block_manual: false,
      carried_forward: 900_000,
      ownership_change_date: null,
      ownership_change_source: null,
      updated_by: 'user-1',
    })
    expect(payload).not.toHaveProperty('id')
  })

  it('continues an earlier koncernbidragsspärr with the pool the previous year kept back', async () => {
    const changeYear = row({
      brought_forward: '500000.00',
      result_before_deficit: '400000.00',
      group_contributions_received: '300000.00',
      group_block_reduction: '400000.00',
      carried_forward: '400000.00',
      ownership_change_date: '2025-03-01',
      ownership_change_source: 'manual',
      group_block_applies: true,
      group_block_last_year: 2030,
    })
    mock.enqueue({ data: { entity_type: 'aktiebolag' } })
    mock.enqueue({ data: [P2026] })
    mock.enqueue({ data: [changeYear] })
    mock.enqueue({ data: [P2025] })
    const outcome = await saveLossCarryforward(
      ctx(),
      { fiscal_period_id: P2026.id, brought_forward: 400_000, source: 'computed', result_before_deficit: 150_000, group_contributions_received: 100_000 },
      { dryRun: true },
    )
    if (!outcome.ok || !outcome.dryRun) throw new Error('expected a dry run')
    // Ceiling 150 000 - 100 000 = 50 000 of the 400 000 pool: 350 000 waits.
    expect(outcome.preview).toMatchObject({
      group_block_active: true,
      group_block_reduction: 350_000,
      deductible: 50_000,
      taxable_result: 100_000,
      carried_forward: 350_000,
      warnings: [],
    })
  })
})

describe('loadRegisterDeficit', () => {
  it('fails open while the table does not exist yet', async () => {
    mock.enqueue({ error: { code: 'PGRST205', message: 'Could not find the table' } })
    expect(await loadRegisterDeficit(mock.supabase as never, COMPANY, P2026.id)).toBeNull()
  })

  it('throws on any other failure instead of falling back silently', async () => {
    mock.enqueue({ error: { code: '57014', message: 'statement timeout' } })
    await expect(loadRegisterDeficit(mock.supabase as never, COMPANY, P2026.id)).rejects.toThrow(/statement timeout/)
  })

  it('answers the deduction net of the spärrar', async () => {
    mock.enqueue({
      data: { id: 'tlc-2026', brought_forward: '100000.00', amount_block_reduction: '20000.00', group_block_reduction: '5000.50', source: 'computed' },
    })
    expect(await loadRegisterDeficit(mock.supabase as never, COMPANY, P2026.id)).toEqual({
      taxLossCarryforwardId: 'tlc-2026',
      broughtForward: 100_000,
      amountBlockReduction: 20_000,
      groupBlockReduction: 5000.5,
      deductible: 74_999.5,
      source: 'computed',
    })
  })
})
