import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => ({ tag: 'service' })) }))
vi.mock('@/lib/operations/inbox-bank-match', () => ({ proposeBankMatchesForArrivedRows: vi.fn() }))

import { eventBus } from '@/lib/events/bus'
import { proposeBankMatchesForArrivedRows } from '@/lib/operations/inbox-bank-match'
import type { Transaction } from '@/types'
import { registerInboxBankMatchHandler } from '../inbox-bank-match-handler'

const propose = proposeBankMatchesForArrivedRows as ReturnType<typeof vi.fn>

const synced = (transactions: Partial<Transaction>[], companyId = 'co-1') =>
  eventBus.emit({ type: 'transaction.synced', payload: { transactions: transactions as Transaction[], userId: 'user-1', companyId } })

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  registerInboxBankMatchHandler()
})

describe('inbox bank match handler', () => {
  it('offers the arrived bank rows to the company\'s open inbox items, on the service client', async () => {
    propose.mockResolvedValue(undefined)
    const rows = [{ id: 'tx-1', amount: -1250, company_id: 'co-1' }]
    await synced(rows)
    expect(propose).toHaveBeenCalledWith({ tag: 'service' }, 'co-1', rows)
  })

  it('does nothing for an empty sync', async () => {
    await synced([])
    expect(propose).not.toHaveBeenCalled()
  })
})
