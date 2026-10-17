import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import type { CoreEvent } from '@/lib/events/types'

const mocks = vi.hoisted(() => ({
  supabase: null as unknown,
  loadCompanyCapabilities: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => mocks.supabase),
}))
vi.mock('@/lib/modules/capabilities', () => ({
  loadCompanyCapabilities: (...args: unknown[]) => mocks.loadCompanyCapabilities(...args),
}))

import { createLogger } from '@/lib/logger'
import { createDetectorContext, runDetector } from '../run'
import { detectorsByEventType, registerSuggestionDetectorHandler, runEventDetectors } from '../handler'
import type { Detector } from '../types'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const USER = 'u0000000-0000-4000-8000-000000000001'

function capabilities(payroll: string, pos = 'on') {
  return {
    packages: [
      { id: 'payroll', switchable: true, availability: payroll },
      { id: 'pos-and-webshop', switchable: true, availability: pos },
    ],
  }
}

function stagedOnce() {
  const mock = createTableMockSupabase({
    'rpc:stage_company_suggestion': { data: { staged: true, suggestion_id: 's1', pending_operation_id: 'p1' } },
  })
  mocks.supabase = mock.supabase
  return mock
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('runDetector', () => {
  const detector: Detector<{ n: number }> = {
    id: 'test-detector',
    trigger: { kind: 'schedule', cadence: 'daily' },
    subjects: () => [{ n: 1 }, { n: 2 }, { n: 3 }],
    condition: async (_ctx, s) => s.n !== 2,
    propose: (s) => ({
      key: `enable_package:p${s.n}`,
      operationType: 'enable_package',
      params: { package_id: 'payroll' },
      title: 't',
      reason: 'r',
      rank: 1,
    }),
  }

  it('stages every subject whose condition holds', async () => {
    const mock = stagedOnce()
    const ctx = createDetectorContext({ supabase: mock.supabase as never, companyId: COMPANY, userId: USER, log: createLogger('test') })
    const results = await runDetector(detector, ctx, null)
    expect(results.map((r) => r.key)).toEqual(['enable_package:p1', 'enable_package:p3'])
    expect(mock.findCalls('rpc:stage_company_suggestion', 'rpc')).toHaveLength(2)
  })

  it('stops after maxStaged new stagings', async () => {
    const mock = stagedOnce()
    const ctx = createDetectorContext({ supabase: mock.supabase as never, companyId: COMPANY, userId: USER, log: createLogger('test') })
    expect(await runDetector(detector, ctx, null, { maxStaged: 1 })).toHaveLength(1)
  })

  it('runs nothing for a detector switched off', async () => {
    const mock = stagedOnce()
    const ctx = createDetectorContext({ supabase: mock.supabase as never, companyId: COMPANY, userId: USER, log: createLogger('test') })
    expect(await runDetector({ ...detector, enabled: () => false }, ctx, null)).toEqual([])
    expect(mock.calls).toHaveLength(0)
  })

  it('survives a failing condition and a failing subjects read', async () => {
    const mock = stagedOnce()
    const ctx = createDetectorContext({ supabase: mock.supabase as never, companyId: COMPANY, userId: USER, log: createLogger('test') })
    const flaky: Detector<{ n: number }> = { ...detector, condition: async (_c, s) => { if (s.n === 1) throw new Error('boom'); return true } }
    expect((await runDetector(flaky, ctx, null)).map((r) => r.key)).toEqual(['enable_package:p2', 'enable_package:p3'])
    const broken: Detector<{ n: number }> = { ...detector, subjects: () => { throw new Error('boom') } }
    await expect(runDetector(broken, ctx, null)).resolves.toEqual([])
  })

  it('reads the company capabilities once per firing, and treats an unreadable company as none', async () => {
    const mock = stagedOnce()
    mocks.loadCompanyCapabilities.mockRejectedValueOnce(new Error('db down'))
    const ctx = createDetectorContext({ supabase: mock.supabase as never, companyId: COMPANY, userId: USER, log: createLogger('test') })
    expect(await ctx.capabilities()).toBeNull()
    expect(await ctx.capabilities()).toBeNull()
    expect(mocks.loadCompanyCapabilities).toHaveBeenCalledTimes(1)
  })
})

describe('the event consumer', () => {
  it('subscribes to exactly the event types the event detectors name', () => {
    expect([...detectorsByEventType().keys()].sort()).toEqual(
      ['employee.created', 'pos.connected', 'shopify.connected', 'transaction.categorized', 'woocommerce.connected', 'zettle.connected'].sort(),
    )
  })

  it('stages "Slå på Lön?" when an employee is registered while Lön is off', async () => {
    const mock = stagedOnce()
    mocks.loadCompanyCapabilities.mockResolvedValue(capabilities('off'))
    registerSuggestionDetectorHandler()
    await eventBus.emit({ type: 'employee.created', payload: { employeeId: 'e1', userId: USER, companyId: COMPANY } })
    const call = mock.findCall('rpc:stage_company_suggestion', 'rpc')?.[0] as Record<string, unknown>
    expect(call).toMatchObject({
      p_company_id: COMPANY,
      p_user_id: USER,
      p_suggestion_key: 'enable_package:payroll',
      p_detector: 'first-employee',
      p_operation_type: 'enable_package',
    })
  })

  it('stages nothing for a company that has Lön on (every Standard company)', async () => {
    const mock = stagedOnce()
    mocks.loadCompanyCapabilities.mockResolvedValue(capabilities('on'))
    registerSuggestionDetectorHandler()
    await eventBus.emit({ type: 'employee.created', payload: { employeeId: 'e1', userId: USER, companyId: COMPANY } })
    expect(mock.findCall('rpc:stage_company_suggestion', 'rpc')).toBeUndefined()
  })

  it('stages "Slå på Kassa och webbshop?" when a till is connected while the package is off', async () => {
    const mock = stagedOnce()
    mocks.loadCompanyCapabilities.mockResolvedValue(capabilities('on', 'off'))
    registerSuggestionDetectorHandler()
    await eventBus.emit({ type: 'pos.connected', payload: { connectionId: 'c1', provider: 'heynow', userId: USER, companyId: COMPANY } })
    expect(mock.findCall('rpc:stage_company_suggestion', 'rpc')?.[0]).toMatchObject({
      p_suggestion_key: 'enable_package:pos-and-webshop',
      p_detector: 'sales-channel-connected',
    })
  })

  it('never throws at the emitter, whatever fails underneath', async () => {
    mocks.supabase = { rpc: () => { throw new Error('network down') }, from: () => { throw new Error('network down') } }
    mocks.loadCompanyCapabilities.mockResolvedValue(capabilities('off'))
    registerSuggestionDetectorHandler()
    await expect(
      eventBus.emit({ type: 'employee.created', payload: { employeeId: 'e1', userId: USER, companyId: COMPANY } }),
    ).resolves.toBeUndefined()
    await expect(
      runEventDetectors({ type: 'employee.created', payload: { employeeId: 'e1' } } as unknown as CoreEvent),
    ).resolves.toBeUndefined()
  })

  it('stages nothing while the database does not know the operation type (deploy order)', async () => {
    const mock = createTableMockSupabase({ 'rpc:stage_company_suggestion': { error: { code: '23514', message: 'violates check constraint' } } })
    mocks.supabase = mock.supabase
    mocks.loadCompanyCapabilities.mockResolvedValue(capabilities('off'))
    registerSuggestionDetectorHandler()
    await expect(
      eventBus.emit({ type: 'employee.created', payload: { employeeId: 'e1', userId: USER, companyId: COMPANY } }),
    ).resolves.toBeUndefined()
    expect(mock.findCalls('rpc:stage_company_suggestion', 'rpc')).toHaveLength(1)
  })
})
