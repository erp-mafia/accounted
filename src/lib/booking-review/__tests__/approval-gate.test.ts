/**
 * Hard blocks at the approval doors (accounted#130 step 2): a matched staged
 * booking stays pending unless a person approves it in the app within their
 * limit, and no grant claims it. The gate's own matching is enforcement.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/booking-review/operation-gate', () => ({
  operationBookingReview: vi.fn(async () => ({ matched: [{ id: 'r-1', rule_id: 'r-1', version: 1 }], amountSek: 119 })),
  bookingReviewLimitCovers: vi.fn(async (_s: unknown, _c: string, userId: string) => ({ covered: userId === 'u-ok', limitSek: 100 })),
}))
vi.mock('@/lib/grants/flag', () => ({ grantsEnabled: () => true }))

import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { applyCompanyGrant } from '@/lib/grants/enforce'

const PARAMS = { transaction_id: 'tx-1', category: 'expense_software', vat_treatment: 'standard_25' }
const PREVIEW = {
  lines: [
    { account_number: '6540', debit_amount: 95.2, credit_amount: 0 },
    { account_number: '2641', debit_amount: 23.8, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 119 },
  ],
}

describe('the approval gate', () => {
  it('keeps a matched categorize_transaction pending unless a person approves it in the app, within their limit', async () => {
    const { supabase, tables } = createTableMockSupabase()
    const op = { id: 'op-1', company_id: 'c-1', user_id: 'u-1', operation_type: 'categorize_transaction', status: 'pending', params: PARAMS, preview_data: PREVIEW, risk_level: 'medium' }

    for (const opts of [
      { commitMethod: 'api_key' as const, actor: { type: 'api_key' as const } },
      { commitMethod: 'bulk_accept' as const, actor: { type: 'user' as const } },
      {},
    ]) {
      const result = await commitPendingOperation(supabase as never, 'u-ok', 'c-1', op as never, opts)
      expect(result).toMatchObject({ status: 'failed', code: 'BOOKING_REVIEW_WEB_ONLY', http_status: 403, operation_status: 'pending' })
    }
    const overLimit = await commitPendingOperation(supabase as never, 'u-low', 'c-1', op as never, { commitMethod: 'user_accept', actor: { type: 'user' } })
    expect(overLimit).toMatchObject({ status: 'failed', code: 'BOOKING_REVIEW_LIMIT', operation_status: 'pending' })
    // Refused before the claim: the operation row was never touched.
    expect(tables()).not.toContain('pending_operations')
  })
})

describe('the grant path', () => {
  it('lets no grant claim a matched booking', async () => {
    const { supabase, findCall } = createTableMockSupabase({
      pending_operations: { data: { operation_type: 'categorize_transaction', params: PARAMS, preview_data: PREVIEW } },
    })
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
    const outcome = await applyCompanyGrant(supabase as never, {
      companyId: 'c-1',
      userId: 'u-1',
      operationId: 'op-1',
      credential: { actorType: 'api_key', apiKeyId: 'k-1', unattendedCommitLimit: null },
      log: log as never,
    })
    expect(outcome).toEqual({ applied: false, reason: 'booking_review_rule' })
    expect(findCall('rpc:claim_company_grant', 'rpc')).toBeUndefined()
  })
})
