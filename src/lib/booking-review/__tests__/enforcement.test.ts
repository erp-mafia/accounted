/**
 * Hard blocks at the doors (accounted#130 step 2): the approval gate's
 * matching and limit check, and the engine's reviewed commit. The gate's
 * place in commitPendingOperation and the grant path: approval-gate.test.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { bookingReviewLimitCovers, operationBookingReview } from '../operation-gate'
import {
  bookingReviewLimitError,
  commitAsReviewed,
  isBookingReviewRefusal,
  isReviewedCommit,
} from '@/lib/bookkeeping/booking-review-commit'
import { BookingReviewLimitError, BookingReviewRequiredError } from '@/lib/bookkeeping/errors'
import { extractBookkeepingDetails, getStructuredError } from '@/lib/errors/get-structured-error'

const RULE = {
  id: 'r-1',
  rule_id: 'r-1',
  version: 1,
  accounts: null,
  counterparty_key: 'spotify',
  counterparty_label: 'Spotify',
  amount_from_sek: null,
  vat_treatment: null,
  note: null,
  valid_from: '2026-10-29T00:00:00Z',
  created_by: 'u-1',
  created_at: '2026-10-29T00:00:00Z',
  revoked_at: null,
  revoked_by: null,
  revoked_reason: null,
}

const OP = {
  operation_type: 'categorize_transaction',
  params: { transaction_id: 'tx-1', category: 'expense_software', vat_treatment: 'standard_25' },
  preview_data: {
    debit_account: '6540',
    credit_account: '1930',
    lines: [
      { account_number: '6540', debit_amount: 95.2, credit_amount: 0 },
      { account_number: '2641', debit_amount: 23.8, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 119 },
    ],
  },
}

describe('operationBookingReview', () => {
  let mock: ReturnType<typeof createTableMockSupabase>
  beforeEach(() => {
    mock = createTableMockSupabase({
      booking_review_rules: { data: [RULE] },
      transactions: { data: { merchant_name: 'Spotify AB', original_description: null, description: 'KORTKÖP', amount: -119, amount_sek: null } },
    })
  })

  it('names the rules a staged booking of a bank row matches, and the amount a limit is judged on', async () => {
    const review = await operationBookingReview(mock.supabase as never, 'c-1', OP as never)
    expect(review).toEqual({ matched: [{ id: 'r-1', rule_id: 'r-1', version: 1 }], amountSek: 119 })
  })

  it('is null for another counterparty, another operation type, or no rules', async () => {
    mock.setTable('transactions', { data: { merchant_name: 'Telia', amount: -119, amount_sek: null } })
    expect(await operationBookingReview(mock.supabase as never, 'c-1', OP as never)).toBeNull()
    expect(await operationBookingReview(mock.supabase as never, 'c-1', { ...OP, operation_type: 'create_customer' } as never)).toBeNull()
    mock.setTable('booking_review_rules', { data: [] })
    mock.setTable('transactions', { data: { merchant_name: 'Spotify AB', amount: -119, amount_sek: null } })
    expect(await operationBookingReview(mock.supabase as never, 'c-1', OP as never)).toBeNull()
  })

  it('judges a preview without lines on its two accounts and the staged VAT treatment', async () => {
    mock.setTable('booking_review_rules', { data: [{ ...RULE, counterparty_key: null, counterparty_label: null, accounts: ['6540'], vat_treatment: 'standard_25' }] })
    const review = await operationBookingReview(mock.supabase as never, 'c-1', { ...OP, preview_data: { debit_account: '6540', credit_account: '1930' } } as never)
    expect(review?.matched).toHaveLength(1)
  })

  it('judges a staged utlägg on its seller, lines and gross', async () => {
    mock.setTable('invoice_inbox_items', { data: { extracted_data: { supplier: { name: 'Spotify AB' } } } })
    const review = await operationBookingReview(mock.supabase as never, 'c-1', {
      operation_type: 'create_expense_claim',
      params: {},
      preview_data: {
        amount_sek: 119,
        inbox_item_id: 'item-1',
        verifikat: { lines: OP.preview_data.lines },
      },
    } as never)
    expect(review).toEqual({ matched: [{ id: 'r-1', rule_id: 'r-1', version: 1 }], amountSek: 119 })
  })

  it('reads no rules table that is not there yet as no rules', async () => {
    mock.setTable('booking_review_rules', { data: null, error: { code: '42P01', message: 'relation does not exist' } })
    expect(await operationBookingReview(mock.supabase as never, 'c-1', OP as never)).toBeNull()
  })
})

describe('bookingReviewLimitCovers', () => {
  it('covers when the company set no booking_review limits', async () => {
    const { supabase } = createTableMockSupabase({ company_attest_limits: { data: [] } })
    expect(await bookingReviewLimitCovers(supabase as never, 'c-1', 'u-1', 5000)).toEqual({ covered: true, limitSek: null })
  })

  it('refuses a person without a limit when the company set some, and one whose limit is below the amount', async () => {
    const { supabase, setTable } = createTableMockSupabase({ company_attest_limits: { data: [{ user_id: 'u-2', max_amount_sek: null }] } })
    expect(await bookingReviewLimitCovers(supabase as never, 'c-1', 'u-1', 5000)).toEqual({ covered: false, limitSek: null })
    setTable('company_attest_limits', { data: [{ user_id: 'u-1', max_amount_sek: '1000.00' }] })
    expect(await bookingReviewLimitCovers(supabase as never, 'c-1', 'u-1', 5000)).toEqual({ covered: false, limitSek: 1000 })
    expect(await bookingReviewLimitCovers(supabase as never, 'c-1', 'u-1', 1000)).toEqual({ covered: true, limitSek: 1000 })
    setTable('company_attest_limits', { data: [{ user_id: 'u-1', max_amount_sek: null }] })
    expect(await bookingReviewLimitCovers(supabase as never, 'c-1', 'u-1', 5000)).toEqual({ covered: true, limitSek: null })
  })
})

describe('the engine’s reviewed commit', () => {
  const base = { companyId: 'c-1', entryId: 'je-1', userId: 'u-1', rubricVersion: null }

  it('recognises the database refusal and the limit refusal', () => {
    expect(isBookingReviewRefusal({ message: 'BOOKING_REVIEW_REQUIRED: a booking review rule matches' })).toBe(true)
    expect(isBookingReviewRefusal({ message: 'Draft journal entry not found' })).toBe(false)
    expect(isBookingReviewRefusal(null)).toBe(false)
    const limit = bookingReviewLimitError({ message: 'BOOKING_REVIEW_LIMIT: 1250 SEK, limit 1000', details: '{"amount_sek": 1250, "limit_sek": 1000}' })
    expect(limit).toBeInstanceOf(BookingReviewLimitError)
    expect([limit?.amountSek, limit?.limitSek]).toEqual([1250, 1000])
    expect(bookingReviewLimitError({ message: 'other' })).toBeNull()
  })

  it('is a person’s review only for a person, one at a time, who saw the review', () => {
    expect(isReviewedCommit({ type: 'user' }, 'user_accept')).toBe(true)
    expect(isReviewedCommit({ type: 'user', withoutReview: true }, 'user_accept')).toBe(false)
    expect(isReviewedCommit({ type: 'user' }, 'bulk_accept')).toBe(false)
    expect(isReviewedCommit({ type: 'api_key' }, 'api_key')).toBe(false)
    expect(isReviewedCommit({ type: 'cron' }, null)).toBe(false)
    expect(isReviewedCommit(undefined, null)).toBe(false)
  })

  it('refuses a key, an agent and a one click with BOOKING_REVIEW_REQUIRED and calls nothing', async () => {
    const { supabase } = createTableMockSupabase()
    for (const actor of [{ type: 'api_key' as const }, { type: 'agent_chat' as const }, { type: 'user' as const, withoutReview: true as const }]) {
      await expect(commitAsReviewed(supabase as never, { ...base, actor, commitMethod: 'user_accept' })).rejects.toBeInstanceOf(BookingReviewRequiredError)
    }
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('commits a person’s review through commit_reviewed_journal_entry, naming the reviewer', async () => {
    const { supabase, findCall } = createTableMockSupabase({ 'rpc:commit_reviewed_journal_entry': { data: [{ voucher_number: 7 }] } })
    const result = await commitAsReviewed(supabase as never, { ...base, actor: { type: 'user', label: 'a@b.se' }, commitMethod: 'user_accept' })
    expect(result).toEqual({ data: [{ voucher_number: 7 }], error: null })
    expect(findCall('rpc:commit_reviewed_journal_entry', 'rpc')?.[0]).toEqual({
      p_company_id: 'c-1',
      p_entry_id: 'je-1',
      p_reviewer_id: 'u-1',
      p_rubric_version: null,
      p_actor_label: 'a@b.se',
    })
  })

  it('throws the limit refusal as BOOKING_REVIEW_LIMIT with its numbers', async () => {
    const { supabase } = createTableMockSupabase({
      'rpc:commit_reviewed_journal_entry': { data: null, error: { message: 'BOOKING_REVIEW_LIMIT: 1250 SEK, limit 1000', details: '{"amount_sek": 1250, "limit_sek": 1000}' } as never },
    })
    const err = await commitAsReviewed(supabase as never, { ...base, actor: { type: 'user' }, commitMethod: 'user_accept' }).catch((e) => e)
    expect(err).toBeInstanceOf(BookingReviewLimitError)
    expect(getStructuredError(err).code).toBe('BOOKING_REVIEW_LIMIT')
    expect(extractBookkeepingDetails(err)).toEqual({ code: 'BOOKING_REVIEW_LIMIT', details: { amount_sek: 1250, limit_sek: 1000 } })
  })
})
