import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => ({ tag: 'service' })) }))
vi.mock('@/lib/forecast/realise', () => ({ realiseForecastRows: vi.fn() }))

import { realiseForecastRows } from '@/lib/forecast/realise'
import type { Transaction } from '@/types'
import { EVENT_CONSUMERS } from '@/lib/composition/event-consumers'
import { realiseForecastRowsOnArrival } from '../forecast-realise-handler'

const realise = vi.mocked(realiseForecastRows)

const payload = (transactions: Partial<Transaction>[], companyId = 'co-1') => ({ transactions: transactions as Transaction[], userId: 'user-1', companyId })

beforeEach(() => {
  vi.clearAllMocks()
  realise.mockResolvedValue({ checked: 0, realised: 0 })
})

describe('forecast realise handler', () => {
  it('hands the arrived bank rows to the matcher, on the service client, for the company', async () => {
    const rows = [{ id: 'tx-1', amount: 48000, date: '2026-11-18', company_id: 'co-1' }]
    await realiseForecastRowsOnArrival(payload(rows))
    expect(realise).toHaveBeenCalledWith({ tag: 'service' }, 'co-1', rows)
  })

  it('does nothing for an empty sync or one without a company', async () => {
    await realiseForecastRowsOnArrival(payload([]))
    await realiseForecastRowsOnArrival(payload([{ id: 'tx-1' }], ''))
    expect(realise).not.toHaveBeenCalled()
  })

  it('lets a failure through, so the bus logs it and an outbox delivery retries', async () => {
    realise.mockRejectedValue(new Error('forecast row update failed: boom'))
    await expect(realiseForecastRowsOnArrival(payload([{ id: 'tx-1' }]))).rejects.toThrow('boom')
  })

  it('is subscribed to transaction.synced, after the inbox match, owned by the ledger', () => {
    const consumer = EVENT_CONSUMERS.find((c) => c.id === 'forecast-realise')
    expect(consumer).toMatchObject({ owner: 'ledger', eventTypes: ['transaction.synced'] })
    const ids = EVENT_CONSUMERS.filter((c) => c.eventTypes.includes('transaction.synced')).map((c) => c.id)
    expect(ids).toEqual(['event-log', 'inbox-bank-match', 'forecast-realise'])
  })
})
