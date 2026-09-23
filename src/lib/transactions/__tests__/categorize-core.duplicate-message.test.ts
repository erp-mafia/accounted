/**
 * The duplicate-guard refusal message in `categorizeMatchedTransaction`.
 *
 * This message is what the agent (MCP categorize flow) and the pending-operation
 * executors surface when the booking-time duplicate guard fires, and it appends
 * "kr" verbatim to a number. The contract under test: that number is ALWAYS the
 * candidate's SEK figure from the detector (`dup.amount`), never the raw foreign
 * `transactions.amount`, and when the detector could not establish a SEK figure
 * at all (`dup.amount === null`) the message states the amount in the sibling's
 * own currency and says the kronor value cannot be determined, rather than
 * fabricating one.
 *
 * Companion to lib/transactions/__tests__/booking-duplicate-detection.test.ts,
 * which pins the producer side of the same contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockDetectDup = vi.fn()
const mockCreateJE = vi.fn()
const mockMapping = vi.fn()
const mockHasLiveLink = vi.fn()

vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: (...args: unknown[]) => mockDetectDup(...args),
}))
vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: (...args: unknown[]) => mockCreateJE(...args),
}))
vi.mock('@/lib/bookkeeping/category-mapping', () => ({
  buildMappingResultFromCategory: (...args: unknown[]) => mockMapping(...args),
}))
vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  upsertCounterpartyTemplate: vi.fn(),
}))
vi.mock('@/lib/core/documents/document-service', () => ({
  linkToJournalEntry: vi.fn(),
}))
vi.mock('@/lib/transactions/link-journal-entry', () => ({
  hasLiveJournalEntryLink: (...args: unknown[]) => mockHasLiveLink(...args),
}))

import { buildDuplicateBookingClaim, categorizeMatchedTransaction } from '../categorize-core'
import { eventBus } from '@/lib/events/bus'

/**
 * The exact sv-SE prose formatting the claim builder uses: two decimals,
 * Swedish grouping, magnitude only. Computed with the same toLocaleString
 * call so the tests stay correct across ICU variants (the group separator is
 * a non-breaking space in most builds).
 */
const sv = (n: number) =>
  Math.abs(n).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Queue-based supabase mock: each `from()` consumes the next queued result. */
function queuedSupabase(results: Array<{ data?: unknown; error?: unknown }>) {
  const queue = [...results]
  const from = vi.fn(() => {
    const raw = queue.shift() ?? { data: null, error: null }
    const result = { data: raw.data ?? null, error: raw.error ?? null }
    const chain: object = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
          return () => chain
        },
      },
    )
    return chain
  })
  return { from } as never
}

/** A `transactions` row as select('*') returns it. Synthetic fixture. */
const txRow = (over: Record<string, unknown> = {}) => ({
  id: 'tx-1',
  date: '2026-06-01',
  amount: -1616,
  currency: 'SEK',
  amount_sek: null,
  exchange_rate: null,
  description: 'PROGRAMVARA AB',
  cash_account_id: null,
  journal_entry_id: null,
  ...over,
})

/** A detector candidate with the invariant defaults (SEK, verified). */
const candidate = (over: Record<string, unknown> = {}) => ({
  transaction_id: 'sib-1',
  journal_entry_id: 'je-1',
  voucher_label: 'A142',
  entry_date: '2026-06-01',
  description: 'PROGRAMVARA AB',
  amount: -1616,
  account_number: null,
  currency: null,
  amount_in_currency: null,
  amount_verified: true,
  unverified_reason: null,
  ...over,
})

const OPTS = { category: 'expense_software' as const }

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockHasLiveLink.mockResolvedValue(false)
})

describe('categorizeMatchedTransaction duplicate refusal message', () => {
  it('states a verified SEK twin as an absolute, sv-SE-formatted kr amount', async () => {
    mockDetectDup.mockResolvedValue(candidate())
    const supabase = queuedSupabase([{ data: txRow() }])

    const result = await categorizeMatchedTransaction(supabase, 'u1', 'c1', 'tx-1', OPTS)

    expect(result.status).toBe(409)
    expect(result.error).toContain('verifikat A142')
    expect(result.error).toContain(`bokför redan ${sv(1616)} kr`)
    expect(result.error).not.toContain('-1616')
    // Raw JS number inside Swedish prose is the finding: '1616 kr' must be
    // '1 616,00 kr'.
    expect(result.error).not.toContain('1616 kr')
  })

  it('prints the SIBLING SEK figure for a verified FX twin, never the raw EUR number as kr', async () => {
    // A 1 000 EUR sibling whose own booking states 11 500 kr. The message must
    // carry 11 500,00 kr; "1 000,00 kr" would be the original bug (foreign
    // figure with "kr" appended) in text form.
    mockDetectDup.mockResolvedValue(
      candidate({ amount: -11500, currency: 'EUR', amount_in_currency: -1000 }),
    )
    const supabase = queuedSupabase([
      { data: txRow({ amount: -1000, currency: 'EUR', amount_sek: -11450, exchange_rate: 11.45 }) },
    ])

    const result = await categorizeMatchedTransaction(supabase, 'u1', 'c1', 'tx-1', OPTS)

    expect(result.status).toBe(409)
    expect(result.error).toContain(`bokför redan ${sv(11500)} kr`)
    expect(result.error).not.toContain(`${sv(1000)} kr`)
    expect(result.error).not.toContain('1000 kr')
  })

  it('refuses to fabricate kronor for a rateless foreign sibling: states the foreign amount instead', async () => {
    mockDetectDup.mockResolvedValue(
      candidate({
        amount: null,
        currency: 'EUR',
        amount_in_currency: -1000,
        amount_verified: false,
        unverified_reason: 'transaction_missing_sek_value',
      }),
    )
    const supabase = queuedSupabase([
      { data: txRow({ amount: -1000, currency: 'EUR' }) },
    ])

    const result = await categorizeMatchedTransaction(supabase, 'u1', 'c1', 'tx-1', OPTS)

    expect(result.status).toBe(409)
    expect(result.error).toContain(`samma belopp (${sv(1000)} EUR)`)
    expect(result.error).toContain('kan inte fastställas')
    // No number in the message wears a kr label (the group separator in
    // sv-SE output is a non-breaking space, so an ASCII-space match suffices).
    expect(result.error).not.toMatch(/\d ?kr\b/)
  })

  it('says the amounts could not be compared for an unverified ledger candidate', async () => {
    // Ledger-voucher candidate found for a rateless foreign bank line: the kr
    // figure is the leg's own SEK amount (real), but no comparison was possible.
    mockDetectDup.mockResolvedValue(
      candidate({
        transaction_id: null,
        amount: 98565,
        account_number: '1930',
        amount_verified: false,
        unverified_reason: 'transaction_missing_sek_value',
      }),
    )
    const supabase = queuedSupabase([
      { data: txRow({ amount: -8570.87, currency: 'EUR' }) },
    ])

    const result = await categorizeMatchedTransaction(supabase, 'u1', 'c1', 'tx-1', OPTS)

    expect(result.status).toBe(409)
    expect(result.error).toContain(`bokför ${sv(98565)} kr`)
    expect(result.error).toContain('beloppen kunde inte jämföras')
    expect(result.error).toContain('EUR')
  })
})

describe('buildDuplicateBookingClaim (shared web + MCP claim builder)', () => {
  it('never renders "null kr" for the rateless foreign sibling shape', () => {
    const claim = buildDuplicateBookingClaim(
      { amount: null, currency: 'EUR', amount_in_currency: -1000, amount_verified: false },
      'EUR',
    )
    expect(claim).toContain(`samma belopp (${sv(1000)} EUR)`)
    expect(claim).toContain('växelkurs saknas')
    expect(claim).not.toContain('null')
  })

  it('uses magnitude and sv-SE formatting for the verified kr figure', () => {
    const claim = buildDuplicateBookingClaim(
      { amount: -11500, currency: 'EUR', amount_in_currency: -1000, amount_verified: true },
      'EUR',
    )
    expect(claim).toBe(`bokför redan ${sv(11500)} kr på bankkontot`)
  })

  it('attributes the missing rate to the TARGET transaction in the unverified branch', () => {
    const claim = buildDuplicateBookingClaim(
      { amount: 98565, currency: null, amount_in_currency: null, amount_verified: false },
      'EUR',
    )
    expect(claim).toContain(`bokför ${sv(98565)} kr`)
    expect(claim).toContain('transaktionen är i EUR utan växelkurs')
  })
})
