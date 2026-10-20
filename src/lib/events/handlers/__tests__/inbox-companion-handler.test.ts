import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => ({ tag: 'service' })) }))
const followReceipts = vi.fn()
vi.mock('@/lib/operations/inbox-companion', () => ({
  followReceiptsOfSupplierInvoice: (...args: unknown[]) => followReceipts(...args),
}))

import type { SupplierInvoice, Transaction } from '@/types'
import { followReceiptOnSupplierPayment } from '../inbox-companion-handler'

beforeEach(() => {
  vi.clearAllMocks()
  followReceipts.mockResolvedValue([])
})

describe('inbox companion handler', () => {
  it('a settled supplier invoice brings its inbox receipt along, on the service client, in the company', async () => {
    await followReceiptOnSupplierPayment({
      supplierInvoice: { id: 'si-1' } as SupplierInvoice,
      transaction: { id: 'tx-1' } as Transaction,
      userId: 'user-1',
      companyId: 'co-1',
    })
    expect(followReceipts).toHaveBeenCalledWith(
      expect.objectContaining({ supabase: { tag: 'service' }, companyId: 'co-1', userId: 'user-1' }),
      'si-1',
    )
  })

  it('does nothing without a company or an invoice', async () => {
    await followReceiptOnSupplierPayment({ supplierInvoice: { id: 'si-1' } as SupplierInvoice, transaction: {} as Transaction, userId: 'u', companyId: '' })
    await followReceiptOnSupplierPayment({ supplierInvoice: {} as SupplierInvoice, transaction: {} as Transaction, userId: 'u', companyId: 'co-1' })
    expect(followReceipts).not.toHaveBeenCalled()
  })
})
