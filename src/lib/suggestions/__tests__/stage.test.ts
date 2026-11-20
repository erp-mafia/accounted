import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import { createDetectorContext } from '../run'
import { isNotInDatabase, stageSuggestion } from '../stage'
import { enablePackageProposal } from '../package-proposals'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const USER = 'u0000000-0000-4000-8000-000000000001'

function fakeLog(): Logger & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  return log as never
}

const proposal = enablePackageProposal('payroll', { reason: 'Du har registrerat en anställd.', rank: 30 })

function setup(rpcResult: { data?: unknown; error?: unknown }) {
  const mock = createTableMockSupabase({ 'rpc:stage_company_suggestion': rpcResult })
  const log = fakeLog()
  const ctx = createDetectorContext({ supabase: mock.supabase as never, companyId: COMPANY, userId: USER, log })
  return { mock, log, ctx }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('stageSuggestion', () => {
  it('stages through stage_company_suggestion with the low risk tier, the reason in the preview', async () => {
    const { mock, ctx } = setup({ data: { staged: true, suggestion_id: 's1', pending_operation_id: 'p1' } })
    expect(await stageSuggestion(ctx, 'first-employee', proposal)).toEqual({ staged: true, suggestionId: 's1', pendingOperationId: 'p1' })
    expect(mock.findCall('rpc:stage_company_suggestion', 'rpc')).toEqual([
      {
        p_company_id: COMPANY,
        p_user_id: USER,
        p_suggestion_key: 'enable_package:payroll',
        p_detector: 'first-employee',
        p_rank: 30,
        p_operation_type: 'enable_package',
        p_title: 'Slå på Lön?',
        p_params: { package_id: 'payroll', source: 'suggestion' },
        p_preview_data: { package: 'Lön', change: 'Slå på', reason: 'Du har registrerat en anställd.' },
        p_risk_level: 'low',
      },
    ])
  })

  it.each(['open', 'snoozed', 'declined'] as const)('reports a skipped key (%s) without staging', async (reason) => {
    const { ctx } = setup({ data: { staged: false, reason } })
    expect(await stageSuggestion(ctx, 'first-employee', proposal)).toEqual({ staged: false, reason })
  })

  it.each([
    ['23514', 'the CHECK refuses the operation or actor type'],
    ['42883', 'the function does not exist'],
    ['PGRST202', 'PostgREST does not know the function'],
    ['42P01', 'the table does not exist'],
  ])('logs and skips when the database does not have it yet (%s: %s)', async (code) => {
    const { ctx, log } = setup({ error: { code, message: 'not here yet' } })
    expect(await stageSuggestion(ctx, 'first-employee', proposal)).toEqual({ staged: false, reason: 'not_in_database' })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('deploy order'), expect.objectContaining({ code }))
    expect(log.error).not.toHaveBeenCalled()
  })

  it('logs any other failure as an error and never throws', async () => {
    const { ctx, log } = setup({ error: { code: '57014', message: 'statement timeout' } })
    expect(await stageSuggestion(ctx, 'first-employee', proposal)).toEqual({ staged: false, reason: 'failed' })
    expect(log.error).toHaveBeenCalled()

    const throwing = createDetectorContext({
      supabase: { rpc: () => { throw new Error('network down') } } as never,
      companyId: COMPANY,
      userId: USER,
      log,
    })
    await expect(stageSuggestion(throwing, 'first-employee', proposal)).resolves.toEqual({ staged: false, reason: 'failed' })
  })

  it('refuses a proposal carrying a plaintext personnummer before any write', async () => {
    const { ctx, mock } = setup({ data: { staged: true, suggestion_id: 's1', pending_operation_id: 'p1' } })
    const leaky = { ...proposal, params: { ...proposal.params, personnummer: '191212121212' } }
    expect(await stageSuggestion(ctx, 'first-employee', leaky)).toEqual({ staged: false, reason: 'failed' })
    expect(mock.findCall('rpc:stage_company_suggestion', 'rpc')).toBeUndefined()
  })
})

describe('isNotInDatabase', () => {
  it('knows the deploy-order codes only', () => {
    expect(isNotInDatabase({ code: '23514' })).toBe(true)
    expect(isNotInDatabase({ code: '23505' })).toBe(false)
    expect(isNotInDatabase(null)).toBe(false)
  })
})
