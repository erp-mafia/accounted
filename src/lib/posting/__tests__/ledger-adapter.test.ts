/**
 * The ledger adapter passes the producer's arguments to the engine as they
 * are: no event and no options, the same arity as the producer's own call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateJournalEntryInput } from '@/types'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'je-1' })),
  createDraftEntry: vi.fn(async () => ({ id: 'je-3' })),
  commitEntry: vi.fn(async () => ({ id: 'je-3' })),
  reverseEntry: vi.fn(async () => ({ id: 'je-2' })),
  commitBulkBooking: vi.fn(async () => ({ data: 'bulk_book_transactions', error: null })),
  commitMatchBatchAllocation: vi.fn(async () => ({ data: 'match_batch_allocate', error: null })),
  commitInvoiceVoucherLink: vi.fn(async () => ({ data: 'link_invoice_to_voucher', error: null })),
  commitSupplierInvoiceVoucherLink: vi.fn(async () => ({ data: 'link_supplier_invoice_to_voucher', error: null })),
  commitExpensePayoutBatch: vi.fn(async () => ({ data: 'create_expense_payout_batch', error: null })),
  replaceOpeningBalanceEntry: vi.fn(async () => ({ newEntryId: 'commit_opening_balance_replacement' })),
  commitAssetDepreciation: vi.fn(async () => ({ entry: { id: 'commit_asset_depreciation' }, scheduleId: 's-1' })),
  commitAssetDisposal: vi.fn(async () => ({ id: 'commit_asset_disposal' })),
}))
vi.mock('@/lib/bookkeeping/journal-entry-batch', () => ({
  createJournalEntries: vi.fn(async () => [{ id: 'je-4' }, { id: 'je-5' }]),
}))
vi.mock('@/lib/core/bookkeeping/storno-service', () => ({
  correctEntry: vi.fn(async () => ({ reversal: { id: 'je-6' }, corrected: { id: 'je-7' } })),
  recordateEntry: vi.fn(async () => ({ reversal: { id: 'je-8' }, corrected: { id: 'je-9' } })),
}))

const engine = await import('@/lib/bookkeeping/engine')
const { commitEntry, createDraftEntry, createJournalEntry, reverseEntry } = engine
const { createJournalEntries } = await import('@/lib/bookkeeping/journal-entry-batch')
const { correctEntry, recordateEntry } = await import('@/lib/core/bookkeeping/storno-service')
const { ledgerAdapter } = await import('../ledger-adapter')

const INPUT = { description: 'x', lines: [] } as unknown as CreateJournalEntryInput
const LINK = { id: 'ev-1', role: 'produced' as const, onFailure: 'log' as const }

describe('ledger adapter', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls createJournalEntry with exactly the producer\'s six arguments when there is nothing to add', async () => {
    await ledgerAdapter.createJournalEntry({ supabase: 'sb' as never, companyId: 'c', userId: 'u', input: INPUT, rubricVersion: 'r1' })
    const call = vi.mocked(createJournalEntry).mock.calls[0]!
    expect(call).toHaveLength(6)
    expect(call).toEqual(['sb', 'c', 'u', INPUT, undefined, 'r1'])
    expect(call[3]).toBe(INPUT)
  })

  it('adds the link as the engine option, beside the producer\'s own options', async () => {
    await ledgerAdapter.createJournalEntry({
      supabase: 'sb' as never, companyId: 'c', userId: 'u', input: INPUT, commitMethod: 'user_accept',
      options: { replayDimensions: true }, businessEvent: LINK,
    })
    expect(vi.mocked(createJournalEntry).mock.calls[0]).toEqual([
      'sb', 'c', 'u', INPUT, 'user_accept', undefined, { replayDimensions: true, businessEvent: LINK },
    ])
    await ledgerAdapter.createJournalEntry({ supabase: 'sb' as never, companyId: 'c', userId: 'u', input: INPUT, options: { replayDimensions: true } })
    expect(vi.mocked(createJournalEntry).mock.calls[1]).toEqual(['sb', 'c', 'u', INPUT, undefined, undefined, { replayDimensions: true }])
  })

  it('drafts with exactly the producer\'s four arguments when there is nothing to add, the link as the fifth', async () => {
    await ledgerAdapter.createDraftEntry({ supabase: 'sb' as never, companyId: 'c', userId: 'u', input: INPUT })
    const call = vi.mocked(createDraftEntry).mock.calls[0]!
    expect(call).toHaveLength(4)
    expect(call).toEqual(['sb', 'c', 'u', INPUT])
    expect(call[3]).toBe(INPUT)
    await ledgerAdapter.createDraftEntry({ supabase: 'sb' as never, companyId: 'c', userId: 'u', input: INPUT, businessEvent: LINK })
    expect(vi.mocked(createDraftEntry).mock.calls[1]).toEqual(['sb', 'c', 'u', INPUT, { businessEvent: LINK }])
  })

  it('posts a set with exactly the producer\'s four arguments when there is nothing to add, the link as the fifth', async () => {
    const inputs = [INPUT, INPUT]
    await ledgerAdapter.createJournalEntries({ supabase: 'sb' as never, companyId: 'c', userId: 'u', inputs })
    const call = vi.mocked(createJournalEntries).mock.calls[0]!
    expect(call).toHaveLength(4)
    expect(call).toEqual(['sb', 'c', 'u', inputs])
    expect(call[3]).toBe(inputs)
    await ledgerAdapter.createJournalEntries({ supabase: 'sb' as never, companyId: 'c', userId: 'u', inputs, businessEvent: LINK })
    expect(vi.mocked(createJournalEntries).mock.calls[1]).toEqual(['sb', 'c', 'u', inputs, { businessEvent: LINK }])
  })

  it('commits with only the arguments the producer passed', async () => {
    await ledgerAdapter.commitEntry({ supabase: 'sb' as never, companyId: 'c', userId: 'u', entryId: 'je-3' })
    expect(vi.mocked(commitEntry).mock.calls[0]).toEqual(['sb', 'c', 'u', 'je-3'])
    expect(vi.mocked(commitEntry).mock.calls[0]).toHaveLength(4)
    await ledgerAdapter.commitEntry({ supabase: 'sb' as never, companyId: 'c', userId: 'u', entryId: 'je-3', commitMethod: 'user_accept' })
    expect(vi.mocked(commitEntry).mock.calls[1]).toEqual(['sb', 'c', 'u', 'je-3', 'user_accept'])
    await ledgerAdapter.commitEntry({ supabase: 'sb' as never, companyId: 'c', userId: 'u', entryId: 'je-3', rubricVersion: 'r1' })
    expect(vi.mocked(commitEntry).mock.calls[2]).toEqual(['sb', 'c', 'u', 'je-3', undefined, 'r1'])
  })

  it('reverses with the same rule', async () => {
    await ledgerAdapter.reverseEntry({ supabase: 'sb' as never, companyId: 'c', userId: 'u', entryId: 'je-1' })
    expect(vi.mocked(reverseEntry).mock.calls.at(-1)).toEqual(['sb', 'c', 'u', 'je-1'])
    expect(vi.mocked(reverseEntry).mock.calls.at(-1)).toHaveLength(4)
    vi.mocked(reverseEntry).mockClear()
    await ledgerAdapter.reverseEntry({ supabase: 'sb' as never, companyId: 'c', userId: 'u', entryId: 'je-1', reversalDate: '2026-03-31' })
    expect(vi.mocked(reverseEntry).mock.calls[0]).toEqual(['sb', 'c', 'u', 'je-1', '2026-03-31'])
    await ledgerAdapter.reverseEntry({
      supabase: 'sb' as never, companyId: 'c', userId: 'u', entryId: 'je-1', options: { allowDeepChain: true }, businessEvent: LINK,
    })
    expect(vi.mocked(reverseEntry).mock.calls[1]).toEqual(['sb', 'c', 'u', 'je-1', undefined, { allowDeepChain: true, businessEvent: LINK }])
  })

  it('corrects with exactly the producer\'s arguments when there is nothing to add, the links beside its options', async () => {
    const lines = [{ account_number: '1930', debit_amount: 1, credit_amount: 0 }]
    await ledgerAdapter.correctEntry({ supabase: 'sb' as never, companyId: 'c', userId: 'u', entryId: 'je-1', correction: { lines } })
    expect(vi.mocked(correctEntry).mock.calls[0]).toEqual(['sb', 'c', 'u', 'je-1', lines])
    expect(vi.mocked(correctEntry).mock.calls[0]).toHaveLength(5)
    expect(vi.mocked(correctEntry).mock.calls[0]![4]).toBe(lines)
    const options = { description: 'Rättelse', allowDeepChain: true }
    await ledgerAdapter.correctEntry({ supabase: 'sb' as never, companyId: 'c', userId: 'u', entryId: 'je-1', correction: { lines, options } })
    expect(vi.mocked(correctEntry).mock.calls[1]![5]).toBe(options)
    const links = { reversal: { ...LINK, role: 'reversal' as const }, correction: { ...LINK, role: 'correction' as const } }
    await ledgerAdapter.correctEntry({
      supabase: 'sb' as never, companyId: 'c', userId: 'u', entryId: 'je-1', correction: { lines, options }, businessEvents: links,
    })
    expect(vi.mocked(correctEntry).mock.calls[2]).toEqual(['sb', 'c', 'u', 'je-1', lines, { ...options, businessEvents: links }])
  })

  it('moves a verifikat to another date through recordateEntry, by the same rule', async () => {
    await ledgerAdapter.correctEntry({ supabase: 'sb' as never, companyId: 'c', userId: 'u', entryId: 'je-1', correction: { newDate: '2025-01-02' } })
    expect(vi.mocked(recordateEntry).mock.calls[0]).toEqual(['sb', 'c', 'u', 'je-1', '2025-01-02'])
    expect(vi.mocked(recordateEntry).mock.calls[0]).toHaveLength(5)
    const options = { allowDeepChain: true }
    await ledgerAdapter.correctEntry({
      supabase: 'sb' as never, companyId: 'c', userId: 'u', entryId: 'je-1', correction: { newDate: '2025-01-02', options },
    })
    expect(vi.mocked(recordateEntry).mock.calls[1]![5]).toBe(options)
    const links = { reversal: { ...LINK, role: 'reversal' as const } }
    await ledgerAdapter.correctEntry({
      supabase: 'sb' as never, companyId: 'c', userId: 'u', entryId: 'je-1', correction: { newDate: '2025-01-02' }, businessEvents: links,
    })
    expect(vi.mocked(recordateEntry).mock.calls[2]).toEqual(['sb', 'c', 'u', 'je-1', '2025-01-02', { businessEvents: links }])
    expect(correctEntry).not.toHaveBeenCalled()
  })
})

describe('ledger adapter: the SQL posting functions (commitSqlPosting)', () => {
  beforeEach(() => vi.clearAllMocks())

  const LINK_IDS = { ids: ['ev-1'], mode: 'shadow' as const }
  const CASES = [
    { fn: 'bulk_book_transactions', wrapper: 'commitBulkBooking', args: [{ txIds: ['tx-1'], existingJournalEntryId: null, newEntry: null }] },
    { fn: 'match_batch_allocate', wrapper: 'commitMatchBatchAllocation', args: [{ transactionId: 'tx-1', allocations: [], businessEvents: LINK_IDS }] },
    { fn: 'link_invoice_to_voucher', wrapper: 'commitInvoiceVoucherLink', args: [{ invoiceId: 'i-1', journalEntryId: 'je-1', notes: null }] },
    { fn: 'link_supplier_invoice_to_voucher', wrapper: 'commitSupplierInvoiceVoucherLink', args: [{ supplierInvoiceId: 's-1', journalEntryId: 'je-1', notes: null, amount: 40 }] },
    { fn: 'create_expense_payout_batch', wrapper: 'commitExpensePayoutBatch', args: [{ claimIds: ['c-1'], payoutDate: '2026-06-10', cashAccount: '1930', notes: null, transactionId: null }] },
    { fn: 'commit_opening_balance_replacement', wrapper: 'replaceOpeningBalanceEntry', args: ['je-old', INPUT] },
    { fn: 'commit_opening_balance_replacement', wrapper: 'replaceOpeningBalanceEntry', args: ['je-old', INPUT, { businessEvents: LINK_IDS }] },
    { fn: 'commit_asset_depreciation', wrapper: 'commitAssetDepreciation', args: [{ id: 'je-draft', fiscal_period_id: 'p' }, { asset_id: 'a-1' }] },
    { fn: 'commit_asset_disposal', wrapper: 'commitAssetDisposal', args: [null, { asset_id: 'a-1' }] },
  ] as const

  it.each(CASES)('$fn: calls $wrapper with the producer\'s arguments, the same objects in the same number', async ({ fn, wrapper, args }) => {
    const answer = await ledgerAdapter.commitSqlPosting({ supabase: 'sb' as never, companyId: 'c', userId: 'u', fn, args: args as never })
    const mock = vi.mocked(engine[wrapper] as (...a: unknown[]) => unknown)
    expect(mock).toHaveBeenCalledTimes(1)
    const call = mock.mock.calls[0]!
    expect(call).toHaveLength(3 + args.length)
    expect(call).toEqual(['sb', 'c', 'u', ...args])
    args.forEach((arg, i) => expect(call[3 + i]).toBe(arg))
    expect(answer).toEqual(await (mock.mock.results[0]!.value as Promise<unknown>))
    // No other wrapper is called.
    for (const other of new Set(CASES.map((c) => c.wrapper))) {
      if (other !== wrapper) expect(engine[other], other).not.toHaveBeenCalled()
    }
  })
})
