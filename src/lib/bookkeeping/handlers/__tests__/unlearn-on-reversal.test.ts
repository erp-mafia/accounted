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
import { registerUnlearnOnReversalHandler, unlearnOnCorrection, unlearnOnReversal, unlearnReversedBankBooking } from '../unlearn-on-reversal'

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

// crm#1858: a supplier with Swedish moms on its receipt was booked from its
// learned template as an EU reverse charge, the person corrected it with
// storno and rättelse, and the template kept proposing the reverse charge:
// correctEntry emits journal_entry.corrected, never journal_entry.reversed.
describe('unlearnOnCorrection', () => {
  const BANK_ROW = { merchant_name: null, original_description: 'LOOPIA AB', description: 'Loopia' }
  const REVERSE_CHARGE = [
    { account_number: '5420', debit_amount: 156.1, credit_amount: 0 },
    { account_number: '4535', debit_amount: 156.1, credit_amount: 0 },
    { account_number: '4598', debit_amount: 0, credit_amount: 156.1 },
    { account_number: '2645', debit_amount: 39.03, credit_amount: 0 },
    { account_number: '2614', debit_amount: 0, credit_amount: 39.03 },
    { account_number: '1930', debit_amount: 0, credit_amount: 156.1 },
  ]
  const DOMESTIC_MOMS = [
    { account_number: '5420', debit_amount: 124.88, credit_amount: 0 },
    { account_number: '2641', debit_amount: 31.22, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 156.1 },
  ]

  function corrected(originalLines: unknown[], correctedLines: unknown[]) {
    return {
      original: { ...makeJournalEntry({ id: 'je-orig', source_type: 'bank_transaction', source_id: 'tx-1' }), lines: originalLines } as never,
      storno: makeJournalEntry({ source_type: 'storno' }) as never,
      corrected: { ...makeJournalEntry({ id: 'je-new', source_type: 'bank_transaction', source_id: 'tx-1' }), lines: correctedLines } as never,
      userId: 'user-1',
      companyId: 'company-1',
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('a correction that changed the moms takes back what the original booking taught', async () => {
    const { client } = makeClient({ transaction: BANK_ROW })
    mockServiceClient.mockReturnValue(client)
    mockUnlearn.mockResolvedValue('deactivated')

    await unlearnOnCorrection(corrected(REVERSE_CHARGE, DOMESTIC_MOMS))

    expect(mockUnlearn).toHaveBeenCalledWith(client, 'company-1', BANK_ROW, REVERSE_CHARGE)
  })

  it('a correction on the same accounts (a new date or amount) leaves the template alone', async () => {
    const { client, from } = makeClient({ transaction: BANK_ROW })
    mockServiceClient.mockReturnValue(client)
    const moved = DOMESTIC_MOMS.map((l) => ({ ...l }))

    await unlearnOnCorrection(corrected(DOMESTIC_MOMS, moved))

    expect(from).not.toHaveBeenCalled()
    expect(mockUnlearn).not.toHaveBeenCalled()
  })

  it('loads the lines of either verifikat when the event carried none', async () => {
    const reads: string[] = []
    const linesById: Record<string, unknown[]> = { 'je-orig': REVERSE_CHARGE, 'je-new': DOMESTIC_MOMS }
    const from = vi.fn((table: string) => {
      const filters: Record<string, unknown> = {}
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters[col] = val
          return chain
        },
        maybeSingle: async () => ({ data: BANK_ROW, error: null }),
        then: (resolve: (v: unknown) => void) => {
          reads.push(`${table}:${String(filters.journal_entry_id)}`)
          resolve({ data: linesById[String(filters.journal_entry_id)] ?? [], error: null })
        },
      }
      return chain
    })
    const client = { from } as never
    mockServiceClient.mockReturnValue(client)
    const payload = corrected([], [])

    await unlearnOnCorrection(payload)

    expect(reads.slice(0, 2)).toEqual(['journal_entry_lines:je-orig', 'journal_entry_lines:je-new'])
    expect(mockUnlearn).toHaveBeenCalledWith(client, 'company-1', BANK_ROW, REVERSE_CHARGE)
  })

  /** A client that holds verifikat rows by id, so the correction_of_id chain is read as production reads it. */
  function makeChainClient(entries: Record<string, { source_type: string; source_id: string | null; correction_of_id: string | null; lines: unknown[] }>) {
    const reads: string[] = []
    const from = vi.fn((table: string) => {
      const filters: Record<string, unknown> = {}
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters[col] = val
          return chain
        },
        maybeSingle: async () => {
          if (table === 'transactions') return { data: filters.id === 'tx-1' ? BANK_ROW : null, error: null }
          reads.push(`${table}:${String(filters.id)}`)
          const row = entries[String(filters.id)]
          return { data: row ? { id: filters.id, source_type: row.source_type, source_id: row.source_id, correction_of_id: row.correction_of_id } : null, error: null }
        },
        then: (resolve: (v: unknown) => void) => {
          reads.push(`${table}:${String(filters.journal_entry_id)}`)
          resolve({ data: entries[String(filters.journal_entry_id)]?.lines ?? [], error: null })
        },
      }
      return chain
    })
    return { client: { from } as never, reads }
  }

  it('a second correction reaches the bank booking through correction_of_id and takes its occurrence back', async () => {
    const amountOnly = REVERSE_CHARGE.map((l) => ({ ...l, debit_amount: l.debit_amount ? l.debit_amount + 1 : 0, credit_amount: l.credit_amount ? l.credit_amount + 1 : 0 }))
    const { client } = makeChainClient({
      'je-orig': { source_type: 'bank_transaction', source_id: 'tx-1', correction_of_id: null, lines: REVERSE_CHARGE },
      'je-fix1': { source_type: 'correction', source_id: null, correction_of_id: 'je-orig', lines: amountOnly },
    })
    mockServiceClient.mockReturnValue(client)
    mockUnlearn.mockResolvedValue('decremented')

    await unlearnOnCorrection({
      original: { ...makeJournalEntry({ id: 'je-fix1', source_type: 'correction', source_id: null }), correction_of_id: 'je-orig', lines: amountOnly } as never,
      storno: makeJournalEntry({ source_type: 'storno' }) as never,
      corrected: { ...makeJournalEntry({ id: 'je-fix2', source_type: 'correction', source_id: null }), lines: DOMESTIC_MOMS } as never,
      userId: 'user-1',
      companyId: 'company-1',
    })

    expect(mockUnlearn).toHaveBeenCalledTimes(1)
    expect(mockUnlearn).toHaveBeenCalledWith(client, 'company-1', BANK_ROW, REVERSE_CHARGE)
  })

  it('a second correction after one that already changed the kontering takes nothing back again', async () => {
    const { client, reads } = makeChainClient({
      'je-orig': { source_type: 'bank_transaction', source_id: 'tx-1', correction_of_id: null, lines: REVERSE_CHARGE },
      'je-fix1': { source_type: 'correction', source_id: null, correction_of_id: 'je-orig', lines: DOMESTIC_MOMS },
    })
    mockServiceClient.mockReturnValue(client)
    const otherCost = DOMESTIC_MOMS.map((l) => (l.account_number === '5420' ? { ...l, account_number: '6540' } : l))

    await unlearnOnCorrection({
      original: { ...makeJournalEntry({ id: 'je-fix1', source_type: 'correction', source_id: null }), correction_of_id: 'je-orig', lines: DOMESTIC_MOMS } as never,
      storno: makeJournalEntry({ source_type: 'storno' }) as never,
      corrected: { ...makeJournalEntry({ id: 'je-fix2', source_type: 'correction', source_id: null }), lines: otherCost } as never,
      userId: 'user-1',
      companyId: 'company-1',
    })

    // The walk reached the bank booking and compared against what it taught;
    // without it the bank-identity check alone would also unlearn nothing.
    expect(reads).toContain('journal_entries:je-orig')
    expect(reads).toContain('journal_entry_lines:je-orig')
    expect(mockUnlearn).not.toHaveBeenCalled()
  })

  it('a correction that only adds lines (the missing reverse-charge basis pair) keeps the template', async () => {
    const { client, from } = makeClient({ transaction: BANK_ROW })
    mockServiceClient.mockReturnValue(client)
    const withoutBasis = REVERSE_CHARGE.filter((l) => l.account_number !== '4535' && l.account_number !== '4598')

    await unlearnOnCorrection(corrected(withoutBasis, REVERSE_CHARGE))

    expect(from).not.toHaveBeenCalled()
    expect(mockUnlearn).not.toHaveBeenCalled()
  })

  it('a correction that adds moms to a booking that had none takes the occurrence back', async () => {
    const { client } = makeClient({ transaction: BANK_ROW })
    mockServiceClient.mockReturnValue(client)
    mockUnlearn.mockResolvedValue('deactivated')
    const withoutMoms = [
      { account_number: '5420', debit_amount: 40.72, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 40.72 },
    ]
    const nonEuReverseCharge = [
      ...withoutMoms,
      { account_number: '4531', debit_amount: 40.72, credit_amount: 0 },
      { account_number: '4598', debit_amount: 0, credit_amount: 40.72 },
      { account_number: '2645', debit_amount: 10.18, credit_amount: 0 },
      { account_number: '2614', debit_amount: 0, credit_amount: 10.18 },
    ]

    await unlearnOnCorrection(corrected(withoutMoms, nonEuReverseCharge))

    expect(mockUnlearn).toHaveBeenCalledWith(client, 'company-1', BANK_ROW, withoutMoms)
  })

  it('a correction that adds lines but drops a taught account takes the occurrence back', async () => {
    const { client } = makeClient({ transaction: BANK_ROW })
    mockServiceClient.mockReturnValue(client)
    mockUnlearn.mockResolvedValue('decremented')
    const otherCostPlusRounding = [
      ...DOMESTIC_MOMS.map((l) => (l.account_number === '5420' ? { ...l, account_number: '6540' } : l)),
      { account_number: '3740', debit_amount: 0, credit_amount: 0.01 },
    ]

    await unlearnOnCorrection(corrected(DOMESTIC_MOMS, otherCostPlusRounding))

    expect(mockUnlearn).toHaveBeenCalledWith(client, 'company-1', BANK_ROW, DOMESTIC_MOMS)
  })

  it('a correction the system made (kontantmetod cut-off) keeps the template', async () => {
    const { client, from } = makeClient({ transaction: BANK_ROW })
    mockServiceClient.mockReturnValue(client)
    const clearing = [
      { account_number: '2440', debit_amount: 156.1, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 156.1 },
    ]

    await unlearnOnCorrection({ ...corrected(DOMESTIC_MOMS, clearing), keepLearnedTemplates: true })

    expect(from).not.toHaveBeenCalled()
    expect(mockUnlearn).not.toHaveBeenCalled()
  })

  it('runs on every journal_entry.corrected once registered', async () => {
    const { client } = makeClient({ transaction: BANK_ROW })
    mockServiceClient.mockReturnValue(client)
    registerUnlearnOnReversalHandler()

    await eventBus.emit({ type: 'journal_entry.corrected', payload: corrected(REVERSE_CHARGE, DOMESTIC_MOMS) })

    expect(mockUnlearn).toHaveBeenCalledWith(client, 'company-1', BANK_ROW, REVERSE_CHARGE)
  })
})
