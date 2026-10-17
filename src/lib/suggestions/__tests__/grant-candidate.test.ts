import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import type { CoreEvent } from '@/lib/events/types'
import type { Transaction } from '@/types'

const clientMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: (...args: unknown[]) => clientMock(...args),
}))

import {
  describeGrantPattern,
  grantCandidateDetector,
  grantProposal,
  grantSuggestionKey,
  grantSuggestionsEnabled,
  suggestedGrantLimit,
  type GrantCandidate,
} from '../detectors/grant-candidate'
import { runEventDetectors } from '../handler'
import { createDetectorContext, runDetector } from '../run'
import { CreateGrantParamsSchema } from '@/lib/grants/types'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const USER = 'u0000000-0000-4000-8000-000000000001'
const TX = 't0000000-0000-4000-8000-000000000001'

const categorized: CoreEvent = {
  type: 'transaction.categorized',
  payload: { transaction: { id: TX } as Transaction, account: '5420', taxCode: '2641', userId: USER, companyId: COMPANY },
}

const CANDIDATE_ROW = {
  candidate: true,
  counterparty_key: 'spotify',
  counterparty_label: 'Spotify AB',
  pattern: {
    direction: 'out',
    category: 'expense_software',
    vat_treatment: 'standard_25',
    reverse_charge_kind: null,
    account_number: '5420',
    line_accounts: ['1930', '2641', '5420'],
  },
  booking_count: 5,
  max_amount_sek: 139,
  last_booked: '2026-05-03',
}

const candidate: GrantCandidate = {
  counterpartyKey: 'spotify',
  counterpartyLabel: 'Spotify AB',
  pattern: CANDIDATE_ROW.pattern as GrantCandidate['pattern'],
  bookingCount: 5,
  maxAmountSek: 139,
  lastBooked: '2026-05-03',
}

function context(row: { data?: unknown; error?: unknown }) {
  const mock = createTableMockSupabase({
    'rpc:company_grant_candidate': row,
    'rpc:stage_company_suggestion': { data: { staged: true, suggestion_id: 's1', pending_operation_id: 'p1' } },
  })
  return { mock, ctx: createDetectorContext({ supabase: mock.supabase as never, companyId: COMPANY, userId: USER, log: createLogger('test') }) }
}

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GRANT_SUGGESTIONS', () => {
  it('is off unless true or 1', () => {
    vi.stubEnv('GRANT_SUGGESTIONS', '')
    expect(grantSuggestionsEnabled()).toBe(false)
    for (const value of ['false', '0', 'yes']) {
      vi.stubEnv('GRANT_SUGGESTIONS', value)
      expect(grantSuggestionsEnabled()).toBe(false)
    }
    for (const value of ['true', '1', ' TRUE ']) {
      vi.stubEnv('GRANT_SUGGESTIONS', value)
      expect(grantSuggestionsEnabled()).toBe(true)
    }
  })

  it('switched off, an event reads and stages nothing, and no client is even made', async () => {
    vi.stubEnv('GRANT_SUGGESTIONS', 'false')
    await runEventDetectors(categorized, [grantCandidateDetector])
    expect(clientMock).not.toHaveBeenCalled()
  })
})

describe('the proposal', () => {
  it('rounds the limit up from a tenth above the largest booking', () => {
    expect(suggestedGrantLimit(139)).toBe(200)
    expect(suggestedGrantLimit(50)).toBe(100)
    expect(suggestedGrantLimit(909.09)).toBe(1000)
    expect(suggestedGrantLimit(950)).toBe(1500)
    expect(suggestedGrantLimit(4500)).toBe(5000)
    expect(suggestedGrantLimit(12000)).toBe(14000)
  })

  it('stages create_grant for exactly the booking seen, any key of the company, with a plain Swedish question', () => {
    const proposal = grantProposal(candidate)
    expect(proposal).toMatchObject({
      key: grantSuggestionKey('spotify'),
      operationType: 'create_grant',
      title: 'Godkänn Spotify AB automatiskt nästa gång, upp till 200 kr?',
      reason: expect.stringMatching(/^Samma motpart bokad på samma sätt 5 gånger \(konto 5420, moms 25 %\)\. /),
      rank: 15,
    })
    expect(proposal.key).toMatch(/^create_grant:cp-[0-9a-f]{16}$/)
    const params = CreateGrantParamsSchema.parse(proposal.params)
    expect(params).toMatchObject({
      counterparty_key: 'spotify',
      pattern: CANDIDATE_ROW.pattern,
      amount_limit_sek: 200,
      monthly_limit_sek: null,
      credential: { kind: 'any' },
      evidence: { booking_count: 5, max_amount_sek: 139, last_booked: '2026-05-03' },
      source: 'suggestion',
    })
  })

  it('says the booking plainly, whatever the VAT treatment', () => {
    expect(describeGrantPattern({ account_number: '5420', vat_treatment: 'reverse_charge' })).toBe('konto 5420, omvänd betalningsskyldighet')
    expect(describeGrantPattern({ account_number: '6570', vat_treatment: null })).toBe('konto 6570, momsen som kategorin anger')
  })
})

describe('grantCandidateDetector', () => {
  it('stages the suggestion when the candidate holds', async () => {
    vi.stubEnv('GRANT_SUGGESTIONS', 'true')
    const { mock, ctx } = context({ data: CANDIDATE_ROW })
    const results = await runDetector(grantCandidateDetector, ctx, categorized)
    expect(results).toEqual([{ detector: 'grant-candidate', key: grantSuggestionKey('spotify'), outcome: { staged: true, suggestionId: 's1', pendingOperationId: 'p1' } }])
    expect(mock.findCall('rpc:company_grant_candidate', 'rpc')?.[0]).toEqual({ p_company_id: COMPANY, p_transaction_id: TX, p_min_count: 5 })
    expect(mock.findCall('rpc:stage_company_suggestion', 'rpc')?.[0]).toMatchObject({
      p_operation_type: 'create_grant',
      p_detector: 'grant-candidate',
      p_risk_level: 'high',
    })
  })

  it('stages nothing without a candidate, on an unreadable one, or on a read error', async () => {
    vi.stubEnv('GRANT_SUGGESTIONS', 'true')
    for (const row of [
      { data: { candidate: false, reason: 'not_enough', booking_count: 3 } },
      { data: { ...CANDIDATE_ROW, pattern: { ...CANDIDATE_ROW.pattern, line_accounts: ['1930'] } } },
      { data: { ...CANDIDATE_ROW, max_amount_sek: 0 } },
      { error: { code: 'PGRST202', message: 'no function' } },
    ]) {
      const { mock, ctx } = context(row)
      expect(await runDetector(grantCandidateDetector, ctx, categorized)).toEqual([])
      expect(mock.findCall('rpc:stage_company_suggestion', 'rpc')).toBeUndefined()
    }
  })

  it('wakes on transaction.categorized only', async () => {
    const { ctx } = context({ data: CANDIDATE_ROW })
    expect(await grantCandidateDetector.subjects(ctx, { type: 'employee.created', payload: {} } as unknown as CoreEvent)).toEqual([])
    expect(grantCandidateDetector.trigger).toEqual({ kind: 'event', eventTypes: ['transaction.categorized'] })
  })
})
