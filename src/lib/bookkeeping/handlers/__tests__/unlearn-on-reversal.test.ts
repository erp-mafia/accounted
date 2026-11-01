import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { makeJournalEntry } from '@/tests/helpers'

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }))
vi.mock('@/lib/logger', () => ({ createLogger: () => logMock }))

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(),
}))

vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  unlearnCounterpartyTemplate: vi.fn(),
}))

import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { unlearnCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import { registerUnlearnOnReversalHandler, unlearnOnReversal, unlearnReversedBankBooking } from '../unlearn-on-reversal'

const mockServiceClient = vi.mocked(createServiceClientNoCookies)
const mockUnlearn = vi.mocked(unlearnCounterpartyTemplate)

const BANK_TEXT = { merchant_name: null, original_description: 'SKATTEVERKET BG 5050-1055', description: 'SKATTEVERKET' }
const LINES = [
  { account_number: '5890', debit_amount: 9780, credit_amount: 0 },
  { account_number: '2641', debit_amount: 2445, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 12225 },
]

/** A client that answers the transactions read and the journal_entry_lines read, recording their filters. */
function makeClient(opts: { transaction?: unknown; lines?: unknown[]; transactionError?: { message: string } } = {}) {
  const reads: Array<{ table: string; filters: Record<string, unknown> }> = []
  const from = vi.fn((table: string) => {
    const filters: Record<string, unknown> = {}
    reads.push({ table, filters })
    const result = table === 'transactions'
      ? { data: opts.transaction ?? null, error: opts.transactionError ?? null }
      : { data: opts.lines ?? [], error: null }
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filters[col] = val
        return chain
      },
      maybeSingle: async () => result,
      then: (resolve: (v: unknown) => void) => resolve(result),
    }
    return chain
  })
  return { client: { from } as never, from, reads }
}

describe('unlearnReversedBankBooking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('ignores a verifikat that did not book a bank line', async () => {
    const { client, from } = makeClient()
    const entry = { ...makeJournalEntry({ source_type: 'supplier_invoice_paid', source_id: 'si-1' }), lines: LINES }

    expect(await unlearnReversedBankBooking(client, 'company-1', entry as never)).toBeNull()
    expect(from).not.toHaveBeenCalled()
    expect(mockUnlearn).not.toHaveBeenCalled()
  })

  it('reads the bank line of the company and unlearns with the reversed lines', async () => {
    const { client, reads } = makeClient({ transaction: BANK_TEXT })
    mockUnlearn.mockResolvedValue('deactivated')
    const entry = { ...makeJournalEntry({ source_type: 'bank_transaction', source_id: 'tx-1' }), lines: LINES }

    expect(await unlearnReversedBankBooking(client, 'company-1', entry as never)).toBe('deactivated')
    expect(reads).toEqual([{ table: 'transactions', filters: { id: 'tx-1', company_id: 'company-1' } }])
    expect(mockUnlearn).toHaveBeenCalledWith(client, 'company-1', BANK_TEXT, LINES)
  })

  it('loads the lines when the event carried none', async () => {
    const { client, reads } = makeClient({ transaction: BANK_TEXT, lines: LINES })
    const entry = { ...makeJournalEntry({ id: 'je-1', source_type: 'bank_transaction', source_id: 'tx-1' }), lines: undefined }

    await unlearnReversedBankBooking(client, 'company-1', entry as never)

    expect(reads[1]).toEqual({ table: 'journal_entry_lines', filters: { journal_entry_id: 'je-1' } })
    expect(mockUnlearn).toHaveBeenCalledWith(client, 'company-1', BANK_TEXT, LINES)
  })

  it('does nothing when the bank line is not the company\'s', async () => {
    const { client } = makeClient({ transaction: null })
    const entry = { ...makeJournalEntry({ source_type: 'bank_transaction', source_id: 'tx-other' }), lines: LINES }

    expect(await unlearnReversedBankBooking(client, 'company-1', entry as never)).toBeNull()
    expect(mockUnlearn).not.toHaveBeenCalled()
  })

  it('a failed bank row read is a failure, not "no bank row": the template would stay taught', async () => {
    const { client } = makeClient({ transactionError: { message: 'timeout' } })
    const entry = { ...makeJournalEntry({ source_type: 'bank_transaction', source_id: 'tx-1' }), lines: LINES }

    await expect(unlearnReversedBankBooking(client, 'company-1', entry as never)).rejects.toThrow('transaction read failed')
    expect(mockUnlearn).not.toHaveBeenCalled()
  })

  it('a failure reaches the event bus as an error; the reversal (the emit) stands', async () => {
    const { client } = makeClient({ transaction: BANK_TEXT })
    mockServiceClient.mockReturnValue(client)
    mockUnlearn.mockRejectedValue(new Error('db down'))
    const unsubscribe = eventBus.on('journal_entry.reversed', unlearnOnReversal)
    const originalEntry = { ...makeJournalEntry({ source_type: 'bank_transaction', source_id: 'tx-1' }), lines: LINES }

    await expect(eventBus.emit({
      type: 'journal_entry.reversed',
      payload: {
        originalEntry: originalEntry as never,
        reversalEntry: makeJournalEntry({ source_type: 'storno' }) as never,
        userId: 'user-1',
        companyId: 'company-1',
      },
    })).resolves.toBeUndefined()

    expect(logMock.error).toHaveBeenCalledWith('handler failed', expect.any(Error), expect.objectContaining({
      eventType: 'journal_entry.reversed',
      handler: 'unlearnOnReversal',
    }))
    unsubscribe()
  })

  it('runs on every journal_entry.reversed once registered', async () => {
    const { client } = makeClient({ transaction: BANK_TEXT })
    mockServiceClient.mockReturnValue(client)
    registerUnlearnOnReversalHandler()
    const originalEntry = { ...makeJournalEntry({ source_type: 'bank_transaction', source_id: 'tx-1' }), lines: LINES }

    await eventBus.emit({
      type: 'journal_entry.reversed',
      payload: {
        originalEntry: originalEntry as never,
        reversalEntry: makeJournalEntry({ source_type: 'storno' }) as never,
        userId: 'user-1',
        companyId: 'company-1',
      },
    })

    expect(mockUnlearn).toHaveBeenCalledWith(client, 'company-1', BANK_TEXT, LINES)
  })
})
