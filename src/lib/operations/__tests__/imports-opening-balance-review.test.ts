/**
 * imports.opening-balance-review.acknowledge (crm#1967): an agent stages
 * confirming the opening balance review an SIE import raised on the next
 * year; the approval runs the review dialog's own service, pinned to the
 * review and IB verifikat the preview compared.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '@/lib/logger'
import type { OperationContext } from '../types'

const service = vi.hoisted(() => ({ acknowledgeOpeningBalanceReview: vi.fn() }))
vi.mock('@/lib/import/opening-balance/review', () => service)

import { importsOpeningBalanceReviewAcknowledge as op } from '../imports'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { SESSION_ROUTE_PARITY } from '../session-route-parity'

const YEAR = '11111111-1111-4111-8111-111111111111'
const TOKEN = '22222222-2222-4222-8222-222222222222'
const IB = '33333333-3333-4333-8333-333333333333'

const ctx: OperationContext = { supabase: {} as never, companyId: 'company-1', userId: 'owner-1', log: createLogger('test') }

const PREVIEW = {
  fiscal_period_id: YEAR,
  period_name: 'Räkenskapsår 2026',
  review_token: TOKEN,
  opening_balance_entry_id: IB,
  review_reason: 'import',
  sie_import_id: '44444444-4444-4444-8444-444444444444',
  previous_period_name: 'Räkenskapsår 2025',
  ib_matches_previous_ub: true,
  checked_accounts: 19,
  discrepancies: [],
}

beforeEach(() => vi.clearAllMocks())

describe('imports.opening-balance-review.acknowledge: contract', () => {
  it('is a staged, low-risk bookkeeping:write tool covering the review dialog\'s route', () => {
    expect(op.kind).toBe('write')
    expect(op.scope).toBe('bookkeeping:write')
    expect(op.risk).toBe('low')
    expect(op.http).toBeUndefined()
    expect(op.mcp?.name).toBe('gnubok_acknowledge_opening_balance_review')
    expect(op.mcp?.stage?.pendingType).toBe('acknowledge_opening_balance_review')
    expect(OPERATION_RISK_TIERS.acknowledge_opening_balance_review).toBe('low')
    expect(TOOL_SCOPE_MAP.gnubok_acknowledge_opening_balance_review).toBe('bookkeeping:write')
    expect((op.mcp?.description ?? '').length).toBeLessThanOrEqual(280)
    expect(op.mcp?.description).toMatch(/^Stage /)
    expect(SESSION_ROUTE_PARITY['POST /api/bookkeeping/fiscal-periods/:id/opening-balance-review']).toMatchObject({
      status: 'covered',
      by: ['gnubok_acknowledge_opening_balance_review'],
    })
  })

  it('takes the year, and optionally the review and IB verifikat it pins (validation)', () => {
    expect(op.input.safeParse({ fiscal_period_id: YEAR }).success).toBe(true)
    expect(op.input.safeParse({ fiscal_period_id: YEAR, review_token: TOKEN, opening_balance_entry_id: null }).success).toBe(true)
    expect(op.input.safeParse({ fiscal_period_id: 'Räkenskapsår 2026' }).success).toBe(false)
    expect(op.input.safeParse({ fiscal_period_id: YEAR, review_token: 'abc' }).success).toBe(false)
    expect(op.input.safeParse({}).success).toBe(false)
  })

  it('declares the refusals its door can answer', () => {
    expect(op.errorCodes).toEqual(
      expect.arrayContaining(['OB_PERIOD_NOT_FOUND', 'OB_REVIEW_NOT_PENDING', 'OB_REVIEW_CHANGED', 'OB_REVIEW_IMPORT_RUNNING', 'FORBIDDEN']),
    )
  })

  it('titles the staged confirmation with the year, never an id', () => {
    expect(op.mcp?.stage?.title({ fiscal_period_id: YEAR }, PREVIEW)).toBe(
      'Bekräfta granskningen av ingående balanser för Räkenskapsår 2026',
    )
    expect(op.mcp?.stage?.title({ fiscal_period_id: YEAR }, undefined)).not.toContain(YEAR.slice(0, 8))
  })

  it('pins the approval to the review token and IB verifikat the preview compared', () => {
    expect(op.mcp?.stage?.pinParams?.({ fiscal_period_id: YEAR }, PREVIEW)).toEqual({
      fiscal_period_id: YEAR,
      review_token: TOKEN,
      opening_balance_entry_id: IB,
    })
    // A year without an IB verifikat pins null, so one booked before the approval is refused.
    const pinned = op.mcp?.stage?.pinParams?.({ fiscal_period_id: YEAR }, { ...PREVIEW, opening_balance_entry_id: null })
    expect(pinned).toEqual({ fiscal_period_id: YEAR, review_token: TOKEN, opening_balance_entry_id: null })
    expect(op.input.safeParse(pinned).success).toBe(true)
  })

  it('shows the approver the year and that the IB equals the previous UB', () => {
    expect(op.mcp?.stage?.preview?.({ fiscal_period_id: YEAR }, PREVIEW)).toMatchObject({
      fiscal_year: 'Räkenskapsår 2026',
      previous_fiscal_year: 'Räkenskapsår 2025',
      ib_matches_previous_ub: true,
      compared_accounts: 19,
      opening_balance_differences: [],
      discrepancies: [],
    })
  })

  it('shows every differing account with its difference, and keeps the full rows for the agent', () => {
    const discrepancies = [
      { account_number: '1930', account_name: 'Företagskonto', previous_ub_net: 10500, current_ib_net: 10000, difference: 500 },
      { account_number: '2099', account_name: 'Årets resultat', previous_ub_net: -10500, current_ib_net: -10000, difference: -500 },
    ]
    const shown = op.mcp?.stage?.preview?.({ fiscal_period_id: YEAR }, { ...PREVIEW, ib_matches_previous_ub: false, discrepancies })
    expect(shown).toMatchObject({ ib_matches_previous_ub: false, discrepancies })
    const lines = (shown?.opening_balance_differences ?? []) as string[]
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^1930: 500,00\s?kr$/)
    expect(lines[1]).toMatch(/^2099: (−|-)500,00\s?kr$/)
    expect(String(shown?.will)).toMatch(/differs/)
  })
})

describe('imports.opening-balance-review.acknowledge: run', () => {
  it('previews and commits through the review dialog\'s service', async () => {
    service.acknowledgeOpeningBalanceReview.mockResolvedValue({ ok: true, dryRun: true, preview: PREVIEW })
    const input = { fiscal_period_id: YEAR }
    expect(await op.run(ctx, input, { dryRun: true })).toEqual({ ok: true, dryRun: true, preview: PREVIEW })
    expect(service.acknowledgeOpeningBalanceReview).toHaveBeenCalledWith(ctx, input, { dryRun: true })

    const data = { fiscal_period_id: YEAR, period_name: 'Räkenskapsår 2026', reviewed: true }
    service.acknowledgeOpeningBalanceReview.mockResolvedValue({ ok: true, data })
    const pinned = { fiscal_period_id: YEAR, review_token: TOKEN, opening_balance_entry_id: IB }
    expect(await op.run(ctx, pinned, { dryRun: false })).toEqual({ ok: true, data })
    expect(service.acknowledgeOpeningBalanceReview).toHaveBeenLastCalledWith(ctx, pinned, { dryRun: false })
  })

  it('passes a refusal through as its code', async () => {
    service.acknowledgeOpeningBalanceReview.mockResolvedValue({ ok: false, code: 'OB_REVIEW_NOT_PENDING' })
    expect(await op.run(ctx, { fiscal_period_id: YEAR }, { dryRun: true })).toEqual({ ok: false, code: 'OB_REVIEW_NOT_PENDING' })
  })
})
