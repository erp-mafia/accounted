/**
 * gnubok_propose_accruals passes the detector snapshot through untouched,
 * including `notices`: the reason a proposal was withheld must reach the
 * agent, not just the wizard.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildAccrualsProposal } from '@/lib/bokslut/accruals/accrual-detector'
import { tools } from '../server'

vi.mock('@/lib/bokslut/accruals/accrual-detector', () => ({
  buildAccrualsProposal: vi.fn().mockResolvedValue({
    fiscalPeriod: { id: 'p1', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' },
    proposals: [],
    notices: ['Semesterlöneskuld 1 361 046 kr på 2920 men inga anställda finns i Accounted; lön körs troligen i ett annat system. Ingen justering föreslås; stäm av skulden mot lönesystemet.'],
  }),
}))

const tool = tools.find((t) => t.name === 'gnubok_propose_accruals')!

describe('gnubok_propose_accruals', () => {
  it('surfaces notices when the detector declined to propose', async () => {
    const result = (await tool.execute(
      { fiscal_period_id: 'p1' },
      'c1',
      'u1',
      {} as never,
      {} as never,
    )) as { proposals: unknown[]; notices: string[] }

    expect(result.proposals).toEqual([])
    expect(result.notices).toHaveLength(1)
    expect(result.notices[0]).toContain('inga anställda')
  })

  it('requires fiscal_period_id', async () => {
    await expect(
      tool.execute({}, 'c1', 'u1', {} as never, {} as never),
    ).rejects.toThrow(/fiscal_period_id/)
  })
})

// Per-employee figures are payroll data: the tool itself needs only
// reports:read, so it asks the detector for them only when the key also
// holds payroll:read.
describe('gnubok_propose_accruals: employee detail follows payroll:read', () => {
  beforeEach(() => {
    vi.mocked(buildAccrualsProposal).mockClear()
  })

  async function detailFor(args: Record<string, unknown>) {
    await tool.execute({ fiscal_period_id: 'p1', ...args }, 'c1', 'u1', {} as never, { type: 'api_key' })
    return vi.mocked(buildAccrualsProposal).mock.calls[0][3]
  }

  it('leaves employee detail out for a key with reports:read only', async () => {
    expect(await detailFor({ __keyScopes: ['reports:read'] })).toEqual({ employeeDetail: false })
  })

  it('includes employee detail for a key that also reads payroll', async () => {
    expect(await detailFor({ __keyScopes: ['reports:read', 'payroll:read'] })).toEqual({ employeeDetail: true })
  })

  it('leaves employee detail out when the scopes are unknown', async () => {
    expect(await detailFor({})).toEqual({ employeeDetail: false })
  })
})
