import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from '@/lib/logger'
import { ALL_OPERATIONS } from '../registry'
import {
  TAX_LOSS_CARRYFORWARD_OPERATIONS,
  taxLossCarryforwardsList,
  taxLossCarryforwardsSave,
} from '../tax-loss-carryforwards'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as unknown as Logger

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('tax-loss-carryforwards operations', () => {
  it('are defined in the registry whatever the switch says, so a staged save still commits', () => {
    for (const op of TAX_LOSS_CARRYFORWARD_OPERATIONS) expect(ALL_OPERATIONS).toContain(op)
  })

  it('refuse at run time for a company the switch leaves out, before reading anything', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', 'another-company')
    const supabase = { from: vi.fn() }
    const ctx = { supabase: supabase as never, companyId: 'company-1', userId: 'user-1', log }
    expect(await taxLossCarryforwardsList.run(ctx, {}, { dryRun: false })).toEqual({
      ok: false,
      code: 'LOSS_CARRYFORWARD_UNAVAILABLE',
    })
    expect(
      await taxLossCarryforwardsSave.run(
        ctx,
        { fiscal_period_id: '00000000-0000-4000-8000-000000000001', brought_forward: 1, source: 'manual' },
        { dryRun: true },
      ),
    ).toEqual({ ok: false, code: 'LOSS_CARRYFORWARD_UNAVAILABLE' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('stages a save the approver can read: the year, the figures and the warnings in Swedish', () => {
    const stage = taxLossCarryforwardsSave.mcp!.stage!
    const preview = {
      fiscal_year: 2026,
      fiscal_period: { name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' },
      brought_forward: 1_000_000,
      amount_block_reduction: 400_000,
      group_block_reduction: 0,
      deductible: 600_000,
      carried_forward: null,
      warnings: [{ code: 'amount_block_manual_differs', message_sv: 'Angiven reduktion', message_en: 'Stated reduction' }],
    }
    expect(stage.pendingType).toBe('save_tax_loss_carryforward')
    expect(stage.title({ brought_forward: 1_000_000 }, preview)).toBe(
      'Underskottsregistret 2026: 1 000 000 kr från föregående år',
    )
    expect(stage.preview!({}, preview)).toEqual({
      fiscal_year: 2026,
      deficit_brought_forward_amount: 1_000_000,
      deficit_amount_block_amount: 400_000,
      deficit_group_block_amount: 0,
      deficit_deductible_amount: 600_000,
      deficit_carried_forward_amount: null,
      warnings: ['Angiven reduktion'],
    })
  })

  it('takes no unknown fields and no reductions below zero', () => {
    const base = { fiscal_period_id: '00000000-0000-4000-8000-000000000001', brought_forward: 1, source: 'manual' }
    expect(taxLossCarryforwardsSave.input.safeParse(base).success).toBe(true)
    expect(taxLossCarryforwardsSave.input.safeParse({ ...base, personnummer: 'x' }).success).toBe(false)
    expect(taxLossCarryforwardsSave.input.safeParse({ ...base, amount_block_reduction: -1 }).success).toBe(false)
    expect(
      taxLossCarryforwardsSave.input.safeParse({
        ...base,
        ownership_change: { date: '2026-06-01', amount_block: false, group_block: false },
      }).success,
    ).toBe(false)
  })
})
