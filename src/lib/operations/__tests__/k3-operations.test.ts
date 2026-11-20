import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/bokslut/assets/building-tax-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/assets/building-tax-service')>()),
  setAssetTaxPlan: vi.fn(),
}))
vi.mock('@/lib/bokslut/assets/transition-split-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/assets/transition-split-service')>()),
  splitAssetAtTransition: vi.fn(),
}))
vi.mock('@/lib/bokslut/assets/development-model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/assets/development-model')>()),
  setDevelopmentModel: vi.fn(),
}))
vi.mock('@/lib/bokslut/k3-transition/transition-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/k3-transition/transition-service')>()),
  previewK3Transition: vi.fn(),
  commitK3TransitionPosting: vi.fn(),
}))
vi.mock('@/lib/auth/require-write', () => ({
  getCompanyRole: vi.fn(),
}))

import { getCompanyRole } from '@/lib/auth/require-write'
import { setAssetTaxPlan } from '@/lib/bokslut/assets/building-tax-service'
import { setDevelopmentModel } from '@/lib/bokslut/assets/development-model'
import { splitAssetAtTransition } from '@/lib/bokslut/assets/transition-split-service'
import { commitK3TransitionPosting, previewK3Transition } from '@/lib/bokslut/k3-transition/transition-service'
import {
  assetsTaxPlanSet,
  assetsTransitionSplitSet,
  companyAccountingPoliciesUpdate,
  k3TransitionCommit,
} from '../k3'
import type { OperationContext } from '../types'

/**
 * The K3 doors are thin: each runs the dashboard's own service, a dry run
 * with the same checks and nothing written, and the admin gate where the
 * dashboard asks for an admin.
 */

const ctx = { supabase: {} as never, companyId: 'company-1', userId: 'user-1', log: {} as never } as OperationContext
const ASSET = '11111111-1111-4111-8111-111111111111'

const PREVIEW = {
  transition_date: '2026-01-01',
  equity_account: '2091',
  deferred_tax: { relief: false, rate: 0.206, items: [], held: 0, opening: 20600, change: 20600 },
  lines: [
    { account_number: '2091', debit_amount: 20600, credit_amount: 0, line_description: 'Uppskjuten skatt vid övergången till K3' },
    { account_number: '2240', debit_amount: 0, credit_amount: 20600, line_description: 'Avsättning för uppskjuten skatt' },
  ],
  warnings: [],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('K3 operations', () => {
  it('runs the tax plan through the service, dry run included', async () => {
    vi.mocked(setAssetTaxPlan).mockResolvedValue({ id: ASSET, tax_depreciation_rate: '2.000', tax_depreciation_from: null, tax_primary_allowance: false } as never)
    const input = { asset_id: ASSET, tax_depreciation_rate: 2 }
    const dry = await assetsTaxPlanSet.run(ctx, input, { dryRun: true })
    expect(dry).toEqual({
      ok: true,
      dryRun: true,
      preview: { asset_id: ASSET, tax_depreciation_rate: 2, tax_depreciation_from: null, tax_primary_allowance: false },
    })
    expect(setAssetTaxPlan).toHaveBeenCalledWith(ctx.supabase, 'company-1', ASSET, { tax_depreciation_rate: 2 }, { dryRun: true })
  })

  it('splits at the transition only after the same split was planned', async () => {
    const plan = { asset_id: ASSET, transition_date: '2026-01-01', components: [] }
    vi.mocked(splitAssetAtTransition).mockResolvedValueOnce(plan as never).mockResolvedValueOnce({ id: ASSET } as never)
    const outcome = await assetsTransitionSplitSet.run(ctx, { asset_id: ASSET, components: [] }, { dryRun: false })
    expect(outcome).toEqual({ ok: true, data: plan })
    expect(vi.mocked(splitAssetAtTransition).mock.calls[0][4]).toEqual({ dryRun: true })
    expect(vi.mocked(splitAssetAtTransition).mock.calls[1][4]).toBeUndefined()
  })

  it('refuses the 18.7 model to a member who is not an owner or admin, before any read', async () => {
    vi.mocked(getCompanyRole).mockResolvedValue({ ok: true, role: 'member' } as never)
    const outcome = await companyAccountingPoliciesUpdate.run(ctx, { development_expenditure_model: 'capitalise' }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(setDevelopmentModel).not.toHaveBeenCalled()

    vi.mocked(getCompanyRole).mockResolvedValue({ ok: true, role: 'owner' } as never)
    vi.mocked(setDevelopmentModel).mockResolvedValue('capitalise')
    expect(await companyAccountingPoliciesUpdate.run(ctx, { development_expenditure_model: 'capitalise' }, { dryRun: false })).toEqual({
      ok: true,
      data: { development_expenditure_model: 'capitalise' },
    })
    // The person behind an API key or MCP call, for the audit row the
    // database writes (a service-role session has no auth.uid()).
    expect(vi.mocked(setDevelopmentModel).mock.calls.at(-1)?.[3]).toEqual({ dryRun: false, userId: ctx.userId })
  })

  it('previews the transition voucher on a dry run and posts it otherwise', async () => {
    vi.mocked(previewK3Transition).mockResolvedValue(PREVIEW as never)
    const input = { adjustments: [], loss_carryforward: null, manual_items: [] }
    const dry = await k3TransitionCommit.run(ctx, input, { dryRun: true })
    expect(dry).toMatchObject({ ok: true, dryRun: true, preview: { opening_deferred_tax: 20600, equity_account: '2091' } })
    expect(commitK3TransitionPosting).not.toHaveBeenCalled()

    vi.mocked(commitK3TransitionPosting).mockResolvedValue({ entry: { id: 'entry-1' }, preview: PREVIEW } as never)
    const posted = await k3TransitionCommit.run(ctx, input, { dryRun: false })
    expect(posted).toMatchObject({ ok: true, data: { journal_entry_id: 'entry-1', transition_date: '2026-01-01', opening_deferred_tax: 20600 } })
    expect((posted as { data: { lines: unknown[] } }).data.lines).toEqual([
      { account_number: '2091', debit: 20600, credit: 0, description: 'Uppskjuten skatt vid övergången till K3' },
      { account_number: '2240', debit: 0, credit: 20600, description: 'Avsättning för uppskjuten skatt' },
    ])
  })
})
