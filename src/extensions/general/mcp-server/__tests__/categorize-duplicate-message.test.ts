/**
 * gnubok_categorize_transaction: the duplicate-guard refusal message.
 *
 * The MCP surface used to build its own two-branch claim with a raw
 * `${dup.amount} kr` interpolation: a rateless foreign sibling (the
 * `dup.amount === null` shape detectBookingDuplicate produces) rendered as
 * "bokför null kr ...", and the unverified branch blamed the missing rate on
 * the wrong row. The tool now shares the three-branch claim builder with the
 * web surface (`buildDuplicateBookingClaim` in
 * lib/transactions/categorize-core.ts); these tests pin the MCP side of that
 * contract. Companion suites:
 *   - lib/transactions/__tests__/categorize-core.duplicate-message.test.ts
 *     (web/agent consumer + the builder itself)
 *   - lib/transactions/__tests__/booking-duplicate-detection.test.ts
 *     (producer of the candidate shapes)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const mockDetectDup = vi.fn()
vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: (...args: unknown[]) => mockDetectDup(...args),
}))

// The booking service's chart pre-validation and period-lock pre-check have
// their own tests; complete and open here.
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

/** Same sv-SE prose formatting the shared claim builder uses. */
const sv = (n: number) =>
  Math.abs(n).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const TX_ID = '00000000-0000-4000-8000-0000000000aa'

/** `transactions` row for the booking service's read. Synthetic. */
const coreTxRow = (over: Record<string, unknown> = {}) => ({
  id: TX_ID,
  date: '2026-06-01',
  amount: -1000,
  currency: 'EUR',
  amount_sek: null,
  exchange_rate: null,
  description: 'FIGMA',
  merchant_name: null,
  cash_account_id: null,
  document_id: null,
  journal_entry_id: null,
  is_business: true,
  ...over,
})

/** Detector candidate with the invariant defaults (SEK, verified). */
const candidate = (over: Record<string, unknown> = {}) => ({
  transaction_id: 'sib-1',
  journal_entry_id: 'je-1',
  voucher_label: 'A142',
  entry_date: '2026-06-01',
  description: 'FIGMA',
  amount: -11500,
  account_number: null,
  currency: null,
  amount_in_currency: null,
  amount_verified: true,
  unverified_reason: null,
  ...over,
})

async function runCategorize(supabase: unknown): Promise<Error> {
  try {
    await categorize.execute(
      { transaction_id: TX_ID, category: 'expense_software' },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' },
    )
  } catch (err) {
    return err as Error
  }
  throw new Error('expected the duplicate guard to throw')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_categorize_transaction duplicate-guard message', () => {
  it('states the foreign amount, never "null kr", for a rateless foreign sibling', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: coreTxRow(), error: null }) // core: transactions
    enqueue({ data: [] }) // the gate: no posted verifikat booked from the row (#203)
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null }) // core: settings
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930

    mockDetectDup.mockResolvedValue(
      candidate({
        amount: null,
        currency: 'EUR',
        amount_in_currency: -1000,
        amount_verified: false,
        unverified_reason: 'transaction_missing_sek_value',
      }),
    )

    const err = await runCategorize(supabase)

    expect(err.message).toContain('Möjlig dubblettbokföring: verifikat A142')
    expect(err.message).toContain(`samma belopp (${sv(1000)} EUR)`)
    expect(err.message).toContain('växelkurs saknas')
    expect(err.message).not.toContain('null kr')
    expect(err.message).not.toContain('null')
  })

  it('prints the verified candidate SEK figure as a magnitude with sv-SE formatting', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: coreTxRow({ amount: -1616, currency: 'SEK' }), error: null })
    enqueue({ data: [] }) // the gate: no posted verifikat booked from the row (#203)
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930

    mockDetectDup.mockResolvedValue(candidate({ amount: -1616 }))

    const err = await runCategorize(supabase)

    expect(err.message).toContain(`bokför redan ${sv(1616)} kr på bankkontot`)
    // Magnitude only: no minus sign, no raw JS number wearing a kr label.
    expect(err.message).not.toContain('-1616')
    expect(err.message).not.toContain('1616 kr')
  })

  it('attributes the missing rate to the TARGET transaction in the unverified ledger branch', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: coreTxRow({ amount: -8570.87 }), error: null })
    enqueue({ data: [] }) // the gate: no posted verifikat booked from the row (#203)
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930

    mockDetectDup.mockResolvedValue(
      candidate({
        transaction_id: null,
        amount: 98565,
        account_number: '1930',
        amount_verified: false,
        unverified_reason: 'transaction_missing_sek_value',
      }),
    )

    const err = await runCategorize(supabase)

    expect(err.message).toContain(`bokför ${sv(98565)} kr på bankkontot`)
    expect(err.message).toContain('beloppen kunde inte jämföras')
    expect(err.message).toContain('transaktionen är i EUR utan växelkurs')
  })
})

// Agent feedback seq 887729: with no duplicate in the way, a foreign row with
// no SEK value is refused at staging (it used to stage and post the foreign
// figure as kronor). Nothing is staged.
describe('gnubok_categorize_transaction on a foreign row without a SEK value', () => {
  it('refuses with TX_MISSING_SEK_VALUE after the duplicate guard found nothing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: coreTxRow({ amount: -200, currency: 'CAD' }), error: null })
    enqueue({ data: [] }) // the gate: no posted verifikat booked from the row (#203)
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    mockDetectDup.mockResolvedValue(null)

    const err = await runCategorize(supabase)

    expect((err as Error & { code?: string }).code).toBe('TX_MISSING_SEK_VALUE')
    expect(mockDetectDup).toHaveBeenCalledTimes(1)
    expect(findCalls('pending_operations', 'insert')).toEqual([])
  })

  it('names a way out an MCP agent can take: the v1 rate refresh has no MCP tool', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: coreTxRow({ amount: -200, currency: 'CAD' }), error: null })
    enqueue({ data: [] }) // the gate: no posted verifikat booked from the row (#203)
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null })
    mockDetectDup.mockResolvedValue(null)

    const { error } = toToolError(await runCategorize(supabase))

    expect(error.code).toBe('TX_MISSING_SEK_VALUE')
    const remediation = (error.remediation as { description: string }).description
    // The v1 door's step stays, and the steps without the v1 API follow it.
    expect(remediation).toContain('refresh-exchange-rate')
    expect(remediation).toContain('open the transaction in Accounted')
    expect(remediation).toContain('gnubok_create_voucher')
    expect(remediation).toContain('gnubok_link_transaction_to_journal_entry')
  })
})
