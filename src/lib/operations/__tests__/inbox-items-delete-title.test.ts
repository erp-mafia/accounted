import { describe, expect, it } from 'vitest'
import { deleteInboxItemTitle, inboxItemsDelete } from '../inbox-items'
import { planStagedOperation } from '../stage'

const ITEM_ID = '22222222-2222-4222-8222-222222222222'

describe('staged delete_inbox_item names the item (crm#1411)', () => {
  it('titles the pending operation with the supplier and the file name from the dry run', () => {
    const stage = inboxItemsDelete.mcp?.stage
    if (!stage) throw new Error('inbox-items.delete has no staging binding')

    const plan = planStagedOperation(stage, { inbox_item_id: ITEM_ID }, {
      inbox_item_id: ITEM_ID,
      inbox_item_deleted: true,
      document_kept: true,
      supplier_name: 'Synthetic Hosting Inc.',
      file_name: 'synthetic-invoice-42.pdf',
      amount: 20,
      currency: 'USD',
    })

    expect(plan.pendingType).toBe('delete_inbox_item')
    expect(plan.title).toBe('Ta bort post ur inkorgen: Synthetic Hosting Inc., synthetic-invoice-42.pdf')
    // The approval card reads the preview as the dry run gave it: no would_delete next to a document id.
    expect(plan.preview).not.toHaveProperty('would_delete')
    expect(plan.preview).toMatchObject({ inbox_item_deleted: true, document_kept: true })
  })

  it.each([
    [{ email_subject: 'Ditt kvitto' }, 'Ta bort post ur inkorgen: Ditt kvitto'],
    [{ supplier_name: '  ', file_name: null, email_subject: null }, 'Ta bort post ur inkorgen'],
    [{}, 'Ta bort post ur inkorgen'],
  ])('falls back to the e-mail subject, then to the bare title (%j)', (preview, title) => {
    expect(deleteInboxItemTitle(preview)).toBe(title)
  })

  it('keeps the title within 200 characters', () => {
    expect(deleteInboxItemTitle({ file_name: 'x'.repeat(400) }).length).toBe(200)
  })
})
