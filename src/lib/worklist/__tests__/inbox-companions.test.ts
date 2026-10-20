import { describe, expect, it, vi } from 'vitest'

const readInboxPairings = vi.hoisted(() => vi.fn())
vi.mock('@/lib/operations/inbox-pairings', () => ({
  readInboxPairings: (...args: unknown[]) => readInboxPairings(...args),
}))

import { inboxCompanionIds } from '../inbox-companions'

describe('inboxCompanionIds', () => {
  it('names the receipts riding on their invoice and the open halves of a booked purchase, reading the deliveries', async () => {
    readInboxPairings.mockResolvedValue(
      new Map([
        ['invoice', { role: 'invoice', receipt_item_id: 'receipt', basis: 'invoice_number' }],
        ['receipt', { role: 'receipt', invoice_item_id: 'invoice', basis: 'invoice_number' }],
        ['half', { role: 'booked_companion', booked_item_id: 'b', booked_kind: 'receipt', basis: 'invoice_number' }],
      ]),
    )
    const rows = [{ id: 'invoice' }, { id: 'receipt' }, { id: 'half' }]
    const ids = await inboxCompanionIds({ tag: 'db' } as never, 'company-1')(rows)
    expect([...ids].sort()).toEqual(['half', 'receipt'])
    expect(readInboxPairings).toHaveBeenCalledWith({ tag: 'db' }, 'company-1', rows, { readDeliveries: true })
  })
})
