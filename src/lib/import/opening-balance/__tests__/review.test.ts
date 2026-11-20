/**
 * Confirming the opening balance review an SIE import raised on the next year
 * (crm#1967): one service for the review dialog's route and the staged MCP
 * operation. The confirmation mirrors the dialog: it is allowed whatever the
 * IB/UB comparison shows, and the dry run reports that comparison.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import type { OperationContext } from '@/lib/operations/types'

const continuity = vi.hoisted(() => ({ validateBalanceContinuity: vi.fn() }))
vi.mock('@/lib/reports/continuity-check', () => continuity)
const access = vi.hoisted(() => ({ requireCompanyAdmin: vi.fn() }))
vi.mock('@/lib/operations/access', () => access)

import { acknowledgeOpeningBalanceReview } from '../review'

const YEAR = '11111111-1111-4111-8111-111111111111'
const TOKEN = '22222222-2222-4222-8222-222222222222'
const IB = '33333333-3333-4333-8333-333333333333'
const IMPORT = '44444444-4444-4444-8444-444444444444'

const db = createQueuedMockSupabase()
const ctx: OperationContext = {
  supabase: db.supabase as never,
  companyId: 'company-1',
  userId: 'owner-1',
  log: createLogger('test'),
}

const openYear = {
  id: YEAR,
  name: 'Räkenskapsår 2026',
  opening_balance_entry_id: IB,
  opening_balance_review_token: TOKEN,
  opening_balance_review_reason: 'import',
  opening_balance_review_import_id: IMPORT,
}

const MATCHING = {
  valid: true,
  period_name: 'Räkenskapsår 2026',
  previous_period_name: 'Räkenskapsår 2025',
  discrepancies: [],
  checked_accounts: 19,
}

const DIFFERING = {
  ...MATCHING,
  valid: false,
  discrepancies: [
    { account_number: '1930', account_name: 'Företagskonto', previous_ub_net: 10500, current_ib_net: 10000, difference: 500 },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  db.reset()
  access.requireCompanyAdmin.mockResolvedValue(null)
  continuity.validateBalanceContinuity.mockResolvedValue(MATCHING)
})

describe('acknowledgeOpeningBalanceReview: refusals', () => {
  it('answers OB_PERIOD_NOT_FOUND for a year outside the company, reading only within it', async () => {
    db.enqueue({ data: null })
    const outcome = await acknowledgeOpeningBalanceReview(ctx, { fiscal_period_id: YEAR }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'OB_PERIOD_NOT_FOUND', details: { fiscal_period_id: YEAR } })
    expect(db.findCalls('fiscal_periods', 'eq')).toEqual([['id', YEAR], ['company_id', 'company-1']])
    expect(db.supabase.rpc).not.toHaveBeenCalled()
  })

  it('answers OB_REVIEW_NOT_PENDING for a year whose review is confirmed or was never raised', async () => {
    db.enqueue({ data: { ...openYear, opening_balance_review_token: null, opening_balance_review_reason: null, opening_balance_review_import_id: null } })
    const outcome = await acknowledgeOpeningBalanceReview(ctx, { fiscal_period_id: YEAR, review_token: TOKEN }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: false, code: 'OB_REVIEW_NOT_PENDING', details: { period_name: 'Räkenskapsår 2026' } })
    expect(db.supabase.rpc).not.toHaveBeenCalled()
  })

  it('answers OB_REVIEW_CHANGED for a token a later import replaced', async () => {
    db.enqueue({ data: { ...openYear, opening_balance_review_token: '55555555-5555-4555-8555-555555555555' } })
    const outcome = await acknowledgeOpeningBalanceReview(ctx, { fiscal_period_id: YEAR, review_token: TOKEN }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: false, code: 'OB_REVIEW_CHANGED' })
    expect(db.supabase.rpc).not.toHaveBeenCalled()
  })

  it('answers OB_REVIEW_CHANGED for an IB verifikat corrected since the review was read', async () => {
    db.enqueue({ data: { ...openYear, opening_balance_entry_id: '66666666-6666-4666-8666-666666666666' } })
    const outcome = await acknowledgeOpeningBalanceReview(
      ctx,
      { fiscal_period_id: YEAR, review_token: TOKEN, opening_balance_entry_id: IB },
      { dryRun: false },
    )
    expect(outcome).toMatchObject({ ok: false, code: 'OB_REVIEW_CHANGED' })
    expect(db.supabase.rpc).not.toHaveBeenCalled()
  })

  it('refuses a member on the dry run, before comparing anything', async () => {
    db.enqueue({ data: openYear })
    access.requireCompanyAdmin.mockResolvedValue({ ok: false, code: 'FORBIDDEN', messageSv: 'x', details: { required_roles: ['owner', 'admin'] } })
    const outcome = await acknowledgeOpeningBalanceReview(ctx, { fiscal_period_id: YEAR }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'FORBIDDEN', messageEn: 'Only owners and administrators can confirm the review.' })
    expect(continuity.validateBalanceContinuity).not.toHaveBeenCalled()
  })

  it.each([
    ['42501', 'Opening balance review requires owner or administrator', 'FORBIDDEN'],
    ['P0002', 'Fiscal period not found', 'OB_PERIOD_NOT_FOUND'],
    ['55000', 'SIE import is unfinished: review after it completes', 'OB_REVIEW_IMPORT_RUNNING'],
    ['55000', 'Opening balance review changed; reload before confirming', 'OB_REVIEW_CHANGED'],
  ])('maps the RPC refusal %s (%s) to %s', async (code, message, expected) => {
    db.enqueue({ data: openYear })
    db.enqueue({ error: { code, message } })
    const outcome = await acknowledgeOpeningBalanceReview(ctx, { fiscal_period_id: YEAR }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: false, code: expected })
  })

  it('throws a database failure that is not a refusal, for the door to classify', async () => {
    db.enqueue({ data: openYear })
    db.enqueue({ error: { code: '57014', message: 'statement timeout' } })
    await expect(acknowledgeOpeningBalanceReview(ctx, { fiscal_period_id: YEAR }, { dryRun: false })).rejects.toMatchObject({
      code: '57014',
    })
  })
})

describe('acknowledgeOpeningBalanceReview: dry run', () => {
  it('previews the open review with IB equal to the previous year\'s UB, and writes nothing', async () => {
    db.enqueue({ data: openYear })
    const outcome = await acknowledgeOpeningBalanceReview(ctx, { fiscal_period_id: YEAR }, { dryRun: true })
    expect(outcome).toEqual({
      ok: true,
      dryRun: true,
      preview: {
        fiscal_period_id: YEAR,
        period_name: 'Räkenskapsår 2026',
        review_token: TOKEN,
        opening_balance_entry_id: IB,
        review_reason: 'import',
        sie_import_id: IMPORT,
        previous_period_name: 'Räkenskapsår 2025',
        ib_matches_previous_ub: true,
        checked_accounts: 19,
        discrepancies: [],
      },
    })
    expect(continuity.validateBalanceContinuity).toHaveBeenCalledWith(db.supabase, 'company-1', YEAR)
    expect(db.supabase.rpc).not.toHaveBeenCalled()
  })

  it('lists every account where the IB differs, and does not refuse: the dialog confirms with differences too', async () => {
    db.enqueue({ data: openYear })
    continuity.validateBalanceContinuity.mockResolvedValue(DIFFERING)
    const outcome = await acknowledgeOpeningBalanceReview(ctx, { fiscal_period_id: YEAR, review_token: TOKEN }, { dryRun: true })
    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: { ib_matches_previous_ub: false, discrepancies: DIFFERING.discrepancies },
    })
  })
})

describe('acknowledgeOpeningBalanceReview: commit', () => {
  it('confirms the review it read, in the acting person\'s name', async () => {
    db.enqueue({ data: openYear })
    db.enqueue({ data: null })
    const outcome = await acknowledgeOpeningBalanceReview(
      ctx,
      { fiscal_period_id: YEAR, review_token: TOKEN, opening_balance_entry_id: IB },
      { dryRun: false },
    )
    expect(outcome).toEqual({ ok: true, data: { fiscal_period_id: YEAR, period_name: 'Räkenskapsår 2026', reviewed: true } })
    expect(db.supabase.rpc).toHaveBeenCalledWith('acknowledge_sie_opening_balance_review', {
      p_company_id: 'company-1',
      p_period_id: YEAR,
      p_actor: 'owner-1',
      p_review_token: TOKEN,
      p_expected_entry_id: IB,
    })
    // The commit does not compare: the RPC is the record, the preview showed the comparison.
    expect(continuity.validateBalanceContinuity).not.toHaveBeenCalled()
  })

  it('confirms a year without an IB verifikat against null, as the dialog does', async () => {
    db.enqueue({ data: { ...openYear, opening_balance_entry_id: null, opening_balance_review_reason: 'undo' } })
    db.enqueue({ data: null })
    const outcome = await acknowledgeOpeningBalanceReview(
      ctx,
      { fiscal_period_id: YEAR, review_token: TOKEN, opening_balance_entry_id: null },
      { dryRun: false },
    )
    expect(outcome).toMatchObject({ ok: true })
    expect(db.supabase.rpc).toHaveBeenCalledWith(
      'acknowledge_sie_opening_balance_review',
      expect.objectContaining({ p_expected_entry_id: null }),
    )
  })
})
