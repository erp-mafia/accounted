import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeJournalEntry } from '@/tests/helpers'

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }))
vi.mock('@/lib/logger', () => ({ createLogger: () => logMock }))

const serviceClient = { tag: 'service-client' }
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => serviceClient) }))

const cancelManualSchedulesForOrigin = vi.fn()
vi.mock('@/lib/bookkeeping/accruals/manual', () => ({
  cancelManualSchedulesForOrigin: (...args: unknown[]) => cancelManualSchedulesForOrigin(...args),
}))

import { cancelAccrualsOnOriginReversal } from '../cancel-accruals-on-origin-reversal'

function payload(sourceType: string) {
  return {
    originalEntry: makeJournalEntry({ id: 'origin-1', source_type: sourceType as never }),
    reversalEntry: makeJournalEntry({ id: 'storno-1', entry_date: '2026-11-07', source_type: 'storno' }),
    userId: 'user-1',
    companyId: 'company-1',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  cancelManualSchedulesForOrigin.mockResolvedValue({ cancelledSchedules: 1, reversedEntries: 3, failedReversals: 0 })
})

describe('cancelAccrualsOnOriginReversal', () => {
  it('cancels the manual plans of the reversed verifikat, stornoes dated as the storno', async () => {
    await cancelAccrualsOnOriginReversal(payload('bank_transaction'))

    expect(cancelManualSchedulesForOrigin).toHaveBeenCalledWith(serviceClient, 'company-1', 'user-1', 'origin-1', {
      reversalDate: '2026-11-07',
    })
    expect(logMock.warn).not.toHaveBeenCalled()
  })

  it('logs months whose storno failed', async () => {
    cancelManualSchedulesForOrigin.mockResolvedValue({ cancelledSchedules: 0, reversedEntries: 1, failedReversals: 2 })

    await cancelAccrualsOnOriginReversal(payload('manual'))

    expect(logMock.warn).toHaveBeenCalledWith(
      'manual accrual months could not be reversed with their origin',
      expect.objectContaining({ originEntryId: 'origin-1', failedReversals: 2 }),
    )
  })

  it('skips the reversal of a dissolution or a storno: neither is a plan\'s origin', async () => {
    await cancelAccrualsOnOriginReversal(payload('accrual'))
    await cancelAccrualsOnOriginReversal(payload('storno'))

    expect(cancelManualSchedulesForOrigin).not.toHaveBeenCalled()
  })
})
