import { describe, it, expect } from 'vitest'
import { updateDraftEntry } from '../engine'
import {
  CannotEditNonDraftError,
  JournalEntryNotFoundError,
  JournalEntryNotBalancedError,
} from '../errors'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { CreateJournalEntryInput } from '@/types'

const balancedInput: CreateJournalEntryInput = {
  fiscal_period_id: 'period-1',
  entry_date: '2026-06-01',
  description: 'Test draft',
  source_type: 'manual',
  voucher_series: 'A',
  lines: [
    { account_number: '1930', debit_amount: 100, credit_amount: 0 },
    { account_number: '3001', debit_amount: 0, credit_amount: 100 },
  ],
}

describe('updateDraftEntry', () => {
  it('throws JournalEntryNotFoundError when the entry does not exist', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: null, error: { message: 'not found' } })
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateDraftEntry(q.supabase as any, 'company-1', 'user-1', 'missing', balancedInput)
    ).rejects.toBeInstanceOf(JournalEntryNotFoundError)
  })

  it('refuses to edit a posted entry: only drafts are editable', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: { id: 'e1', status: 'posted', voucher_series: 'A' }, error: null })
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateDraftEntry(q.supabase as any, 'company-1', 'user-1', 'e1', balancedInput)
    ).rejects.toBeInstanceOf(CannotEditNonDraftError)
  })

  it('rejects an unbalanced draft before mutating anything', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: { id: 'e1', status: 'draft', voucher_series: 'A' }, error: null })
    const unbalanced: CreateJournalEntryInput = {
      ...balancedInput,
      lines: [
        { account_number: '1930', debit_amount: 100, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 50 },
      ],
    }
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateDraftEntry(q.supabase as any, 'company-1', 'user-1', 'e1', unbalanced)
    ).rejects.toBeInstanceOf(JournalEntryNotBalancedError)
  })
})
