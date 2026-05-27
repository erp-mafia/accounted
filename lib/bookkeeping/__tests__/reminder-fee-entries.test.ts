import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CreateJournalEntryInput } from '@/types'

vi.mock('../engine', () => ({
  findFiscalPeriod: vi.fn().mockResolvedValue('period-1'),
  createJournalEntry: vi.fn().mockImplementation(
    async (_supabase: unknown, _companyId: string, _userId: string, input: CreateJournalEntryInput) => ({
      id: 'entry-reminder-fee-1',
      ...input,
      lines: input.lines,
    }),
  ),
}))

const { createJournalEntry, findFiscalPeriod } = await import('../engine')
const { createReminderFeeEntry } = await import('../reminder-fee-entries')

const mockedCreateEntry = vi.mocked(createJournalEntry)
const mockedFindFiscalPeriod = vi.mocked(findFiscalPeriod)

beforeEach(() => {
  vi.clearAllMocks()
  mockedFindFiscalPeriod.mockResolvedValue('period-1')
  mockedCreateEntry.mockImplementation(
    async (_supabase: unknown, _companyId: string, _userId: string, input: CreateJournalEntryInput) => ({
      id: 'entry-reminder-fee-1',
      ...input,
      lines: input.lines,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  )
})

describe('createReminderFeeEntry', () => {
  it('books a balanced entry: debit 1510, credit 3990', async () => {
    const result = await createReminderFeeEntry({} as never, {
      invoiceId: 'inv-1',
      invoiceNumber: 'F2026001',
      companyId: 'company-1',
      userId: 'user-1',
      feeAmount: 60,
      asOfDate: '2026-05-26',
    })

    expect(result?.journal_entry_id).toBe('entry-reminder-fee-1')
    expect(mockedCreateEntry).toHaveBeenCalledTimes(1)

    const callArgs = mockedCreateEntry.mock.calls[0]
    const input = callArgs[3] as CreateJournalEntryInput

    expect(input.source_type).toBe('reminder_fee')
    expect(input.source_id).toBe('inv-1')
    expect(input.fiscal_period_id).toBe('period-1')
    expect(input.entry_date).toBe('2026-05-26')
    expect(input.description).toBe('Påminnelseavgift faktura F2026001')

    expect(input.lines).toHaveLength(2)
    const debitLine = input.lines.find((l) => l.account_number === '1510')
    const creditLine = input.lines.find((l) => l.account_number === '3990')
    expect(debitLine?.debit_amount).toBe(60)
    expect(debitLine?.credit_amount).toBe(0)
    expect(creditLine?.debit_amount).toBe(0)
    expect(creditLine?.credit_amount).toBe(60)
  })

  it('rounds the fee to 2 decimals (defense in depth — caller should already round)', async () => {
    await createReminderFeeEntry({} as never, {
      invoiceId: 'inv-1',
      invoiceNumber: 'F2026001',
      companyId: 'company-1',
      userId: 'user-1',
      feeAmount: 59.999,
      asOfDate: '2026-05-26',
    })

    const input = mockedCreateEntry.mock.calls[0][3] as CreateJournalEntryInput
    const debit = input.lines.find((l) => l.account_number === '1510')!
    const credit = input.lines.find((l) => l.account_number === '3990')!
    expect(debit.debit_amount).toBe(60)
    expect(credit.credit_amount).toBe(60)
  })

  it('returns null and does not call the engine when feeAmount is 0', async () => {
    const result = await createReminderFeeEntry({} as never, {
      invoiceId: 'inv-1',
      invoiceNumber: 'F2026001',
      companyId: 'company-1',
      userId: 'user-1',
      feeAmount: 0,
      asOfDate: '2026-05-26',
    })
    expect(result).toBeNull()
    expect(mockedCreateEntry).not.toHaveBeenCalled()
  })

  it('returns null and does not call the engine when feeAmount is negative', async () => {
    const result = await createReminderFeeEntry({} as never, {
      invoiceId: 'inv-1',
      invoiceNumber: 'F2026001',
      companyId: 'company-1',
      userId: 'user-1',
      feeAmount: -1,
      asOfDate: '2026-05-26',
    })
    expect(result).toBeNull()
    expect(mockedCreateEntry).not.toHaveBeenCalled()
  })

  it('returns null when no open fiscal period is found', async () => {
    mockedFindFiscalPeriod.mockResolvedValueOnce(null)
    const result = await createReminderFeeEntry({} as never, {
      invoiceId: 'inv-1',
      invoiceNumber: 'F2026001',
      companyId: 'company-1',
      userId: 'user-1',
      feeAmount: 60,
      asOfDate: '2026-05-26',
    })
    expect(result).toBeNull()
    expect(mockedCreateEntry).not.toHaveBeenCalled()
  })
})
