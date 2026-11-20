import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { voucherLinkEvents } from '../voucher-matching-shared'

function foreignInvoice() {
  const db = createQueuedMockSupabase()
  db.enqueue({ data: { id: 'si-1', supplier_id: 'sup-1', currency: 'EUR', total: 100, paid_amount: 0, remaining_amount: 100 } })
  db.enqueue({ data: { entry_date: '2026-05-05' } })
  return db.supabase as never
}

const link = { side: 'supplier' as const, invoiceId: 'si-1', journalEntryId: 'je-1' }

describe('voucherLinkEvents: the basis on the event', () => {
  it('says what the payment row says: a rule door names its rule', async () => {
    const [event] = await voucherLinkEvents(foreignInvoice(), 'company-1', { ...link, linkBasis: 'rule_ocr_reference' })

    expect(event.evidence).toMatchObject({ link_basis: 'rule_ocr_reference' })
  })

  it('records a person when the door names nothing', async () => {
    const [event] = await voucherLinkEvents(foreignInvoice(), 'company-1', link)

    expect(event.evidence).toMatchObject({ link_basis: 'user_confirmed' })
  })
})
