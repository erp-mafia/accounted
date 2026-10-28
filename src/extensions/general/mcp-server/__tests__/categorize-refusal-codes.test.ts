/**
 * gnubok_categorize_transaction: every staging refusal reaches the agent with
 * its registry code, never as UNKNOWN_ERROR ("Något gick fel. Försök igen.").
 *
 * The 2026-10 session autopsy counted 124 categorize refusals answered
 * UNKNOWN_ERROR in 30 days (58 sessions), among them the duplicate guard,
 * while 26 other sessions got the same guard as
 * TRANSACTION_BOOK_POSSIBLE_DUPLICATE. The split was a deploy, not two live
 * paths: until edb2a7771 (2026-10-12) the tool threw these four refusals as
 * plain Errors; since then categorizeStagingRefusal throws OperationError,
 * whose code the dispatch reads first. This suite pins that, refusal by
 * refusal, through the same toToolError the dispatcher uses; the ratchet on
 * bare `throw new Error(` in the MCP server (scripts/checks) keeps new ones
 * from appearing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const mockDetectDup = vi.fn()
vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: (...args: unknown[]) => mockDetectDup(...args),
}))
vi.mock('@/lib/bookkeeping/account-validation', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/account-validation')>()),
  findUnresolvableAccounts: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn().mockResolvedValue({ locked: false }),
}))

import { tools } from '../server'
import { toToolError } from '../tool-result'

const categorize = tools.find((t) => t.name === 'gnubok_categorize_transaction')!

const TX_ID = '00000000-0000-4000-8000-0000000000dd'
const JE_ID = '00000000-0000-4000-8000-0000000000ee'

const txRow = (over: Record<string, unknown> = {}) => ({
  id: TX_ID,
  date: '2026-10-06',
  amount: -40,
  currency: 'SEK',
  amount_sek: -40,
  exchange_rate: 1,
  description: 'KORTAVGIFT',
  merchant_name: null,
  cash_account_id: null,
  document_id: null,
  journal_entry_id: null,
  is_business: true,
  ...over,
})

const settingsRow = { entity_type: 'aktiebolag', fiscal_year_start_month: 1 }

/** The envelope the agent reads for a refused categorize call. */
async function refusal(args: Record<string, unknown>, enqueueReads: (enqueue: (r: { data: unknown }) => void) => void) {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueueReads(enqueue)
  const err = await categorize
    .execute({ transaction_id: TX_ID, ...args }, 'company-1', 'user-1', supabase as never, { type: 'api_key' } as never)
    .then(
      () => {
        throw new Error('expected a refusal')
      },
      (e: unknown) => e,
    )
  return toToolError(err, { toolName: 'gnubok_categorize_transaction' }).error
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockDetectDup.mockResolvedValue(null)
})

describe('gnubok_categorize_transaction: refusals carry their code', () => {
  it('a likely double booking is TRANSACTION_BOOK_POSSIBLE_DUPLICATE', async () => {
    mockDetectDup.mockResolvedValue({
      transaction_id: 'sib-1',
      journal_entry_id: JE_ID,
      voucher_label: 'A149',
      entry_date: '2026-10-06',
      description: 'KORTAVGIFT',
      amount: -40,
      account_number: null,
      currency: null,
      amount_in_currency: null,
      amount_verified: true,
      unverified_reason: null,
    })
    const error = await refusal({ category: 'expense_bank_fees' }, (enqueue) => {
      enqueue({ data: txRow() })
      enqueue({ data: settingsRow })
      enqueue({ data: [] }) // no enabled cash accounts: 1930
    })
    expect(error.code).toBe('TRANSACTION_BOOK_POSSIBLE_DUPLICATE')
    expect(error.message_sv).toContain('Möjlig dubblettbokföring: verifikat A149')
    expect(error.retryable).toBe(false)
  })

  it('an already booked row is TRANSACTION_ALREADY_CATEGORIZED', async () => {
    const error = await refusal({ category: 'expense_bank_fees' }, (enqueue) => {
      enqueue({ data: txRow({ journal_entry_id: JE_ID }) })
      enqueue({ data: [{ id: JE_ID, status: 'posted' }] })
    })
    expect(error.code).toBe('TRANSACTION_ALREADY_CATEGORIZED')
    expect(error.message_en).toContain(`already booked (journal_entry_id ${JE_ID})`)
    expect(error.retryable).toBe(false)
  })

  it('a missing category is VALIDATION_ERROR, before any read', async () => {
    const error = await refusal({ account_override: '6570' }, () => {})
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message_en).toMatch(/^category is required/)
    expect(error.retryable).toBe(false)
  })

  it('account_override on a private marking is VALIDATION_ERROR', async () => {
    const error = await refusal({ category: 'private', account_override: '6570' }, (enqueue) => {
      enqueue({ data: txRow() })
      enqueue({ data: settingsRow })
      enqueue({ data: [] })
    })
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message_sv).toContain('account_override kan inte kombineras med category "private"')
    expect(error.retryable).toBe(false)
  })
})
