import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccountMapping, SIEVoucher } from '../types'

const helpers = vi.hoisted(() => ({
  populateTemplatesFromSieVouchers: vi.fn(),
  suggestPartiesForCompany: vi.fn(),
  findUntransferredResults: vi.fn(),
}))

vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  populateTemplatesFromSieVouchers: helpers.populateTemplatesFromSieVouchers,
}))
vi.mock('@/lib/parties/suggest', () => ({ suggestPartiesForCompany: helpers.suggestPartiesForCompany }))
vi.mock('@/lib/reports/imbalance-diagnosis', () => ({ findUntransferredResults: helpers.findUntransferredResults }))

import { diagnoseUntransferredResults, learnFromCompletedSIEImport, vouchersForLearning } from '../sie-import-learning'

const supabase = {} as SupabaseClient

function voucher(description: string, accounts: [string, string], amount = 100): SIEVoucher {
  return {
    series: 'A',
    number: 1,
    date: new Date('2026-02-01'),
    description,
    lines: [
      { account: accounts[0], amount, description: 'line' },
      { account: accounts[1], amount: -amount },
    ],
  }
}

function mapping(sourceAccount: string, targetAccount: string): AccountMapping {
  return { sourceAccount, targetAccount, sourceName: sourceAccount, targetName: targetAccount, confidence: 1, matchType: 'exact', isOverride: false } as AccountMapping
}

const completedJob = {
  id: 'import-1',
  company_id: 'company-1',
  user_id: 'user-1',
  execution_actor_id: null,
  job_state: 'completed' as const,
  job_kind: 'import' as const,
}

const partySummary = { observed: 3, suggested: 2, skipped: 1, created: 2, attached: 0, identities: 0, facts: 0, merged: 0 }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('diagnoseUntransferredResults', () => {
  it('turns each untransferred year into a Swedish warning and a structured notice', async () => {
    helpers.findUntransferredResults.mockResolvedValue([
      { fiscal_period_id: 'p-2024', period_name: 'Räkenskapsår 2024', pl_net: 12345.5 },
    ])

    const diagnosis = await diagnoseUntransferredResults(supabase, 'company-1', '2025-01-01')

    expect(helpers.findUntransferredResults).toHaveBeenCalledWith(supabase, 'company-1', { beforePeriodStart: '2025-01-01' })
    expect(diagnosis.results).toEqual([{ fiscal_period_id: 'p-2024', period_name: 'Räkenskapsår 2024', pl_net: 12345.5 }])
    expect(diagnosis.warnings).toHaveLength(1)
    expect(diagnosis.warnings[0]).toMatch(/^Resultatet för Räkenskapsår 2024 \(.+\) har inte förts om till eget kapital/)
    expect(diagnosis.notices).toEqual([
      { code: 'sie_untransferred_result', severity: 'action', params: { period: 'Räkenskapsår 2024', amount: expect.any(String) } },
    ])
  })

  it('checks every earlier year when the import has no year start', async () => {
    helpers.findUntransferredResults.mockResolvedValue([])

    const diagnosis = await diagnoseUntransferredResults(supabase, 'company-1', null)

    expect(helpers.findUntransferredResults).toHaveBeenCalledWith(supabase, 'company-1', undefined)
    expect(diagnosis).toEqual({ results: [], warnings: [], notices: [] })
  })

  it('never fails the import: a failed check reports nothing', async () => {
    helpers.findUntransferredResults.mockRejectedValue(new Error('trial balance timed out'))

    await expect(diagnoseUntransferredResults(supabase, 'company-1', '2025-01-01'))
      .resolves.toEqual({ results: [], warnings: [], notices: [] })
  })
})

describe('vouchersForLearning', () => {
  it('moves each line onto the company account and keeps the rest of the voucher', () => {
    const learnable = vouchersForLearning([voucher('Telia', ['6212', '1930'])], [mapping('6212', '6211'), mapping('1930', '1930')])

    expect(learnable).toHaveLength(1)
    expect(learnable[0].description).toBe('Telia')
    expect(learnable[0].date).toEqual(new Date('2026-02-01'))
    expect(learnable[0].lines).toEqual([
      { account: '6211', amount: 100, description: 'line' },
      { account: '1930', amount: -100 },
    ])
  })

  it('leaves out a voucher with a line on an unmapped account, as the import did', () => {
    const learnable = vouchersForLearning(
      [voucher('Telia', ['6212', '1930']), voucher('Okänd', ['9999', '1930'])],
      [mapping('6212', '6212'), mapping('1930', '1930'), mapping('9999', '')],
    )

    expect(learnable.map((v) => v.description)).toEqual(['Telia'])
  })
})

describe('learnFromCompletedSIEImport', () => {
  const vouchers = [voucher('Telia', ['6212', '1930'])]

  it('learns templates from the vouchers and suggests parties for a completed import', async () => {
    helpers.populateTemplatesFromSieVouchers.mockResolvedValue(4)
    helpers.suggestPartiesForCompany.mockResolvedValue(partySummary)

    const summary = await learnFromCompletedSIEImport(supabase, { ...completedJob, execution_actor_id: 'actor-1' }, vouchers)

    expect(helpers.populateTemplatesFromSieVouchers).toHaveBeenCalledWith(supabase, 'company-1', vouchers)
    expect(helpers.suggestPartiesForCompany).toHaveBeenCalledWith(supabase, 'company-1', 'actor-1')
    expect(summary).toEqual({ templates: 4, parties: partySummary })
  })

  it('suggests parties on behalf of the importing user when no separate actor ran the job', async () => {
    helpers.populateTemplatesFromSieVouchers.mockResolvedValue(0)
    helpers.suggestPartiesForCompany.mockResolvedValue(partySummary)

    await learnFromCompletedSIEImport(supabase, completedJob, vouchers)

    expect(helpers.suggestPartiesForCompany).toHaveBeenCalledWith(supabase, 'company-1', 'user-1')
  })

  it('still suggests parties when template learning fails, and never throws', async () => {
    helpers.populateTemplatesFromSieVouchers.mockRejectedValue(new Error('template write refused'))
    helpers.suggestPartiesForCompany.mockResolvedValue(partySummary)

    await expect(learnFromCompletedSIEImport(supabase, completedJob, vouchers))
      .resolves.toEqual({ templates: null, parties: partySummary })
    expect(helpers.suggestPartiesForCompany).toHaveBeenCalledTimes(1)
  })

  it('keeps the learned templates when the party suggestions fail', async () => {
    helpers.populateTemplatesFromSieVouchers.mockResolvedValue(2)
    helpers.suggestPartiesForCompany.mockRejectedValue(new Error('apply_party_suggestions failed'))

    await expect(learnFromCompletedSIEImport(supabase, completedJob, vouchers))
      .resolves.toEqual({ templates: 2, parties: null })
  })

  it.each([
    ['an undone import', { job_state: 'undone' as const }],
    ['a failed import', { job_state: 'failed' as const }],
    ['a duplicate repair', { job_kind: 'duplicate_repair' as const }],
  ])('learns nothing from %s', async (_label, override) => {
    const summary = await learnFromCompletedSIEImport(supabase, { ...completedJob, ...override }, vouchers)

    expect(summary).toEqual({ templates: null, parties: null, skipped: 'not_a_completed_import' })
    expect(helpers.populateTemplatesFromSieVouchers).not.toHaveBeenCalled()
    expect(helpers.suggestPartiesForCompany).not.toHaveBeenCalled()
  })

  it('learns nothing from an import without vouchers', async () => {
    const summary = await learnFromCompletedSIEImport(supabase, completedJob, [])

    expect(summary).toEqual({ templates: null, parties: null, skipped: 'no_vouchers' })
    expect(helpers.populateTemplatesFromSieVouchers).not.toHaveBeenCalled()
    expect(helpers.suggestPartiesForCompany).not.toHaveBeenCalled()
  })
})
