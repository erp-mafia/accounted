import { describe, expect, it } from 'vitest'
import { focusDecision, offersRemoval } from '../decision'
import { MAX_INBOX_ITEMS_PER_REMOVAL, removalBatches, removalUndoSentence, summariseRemovals, type InboxItemRemovalResult } from '../remove-items'
import { makeItem, reading } from './fixtures'

const offered = (item: ReturnType<typeof makeItem>) => {
  const d = focusDecision(item)
  return d.actions.includes('not_underlag') || d.quietActions.includes('not_underlag')
}

describe('offersRemoval: the rows the list lets a person pick', () => {
  it('an item waiting for its first decision can go: an unread document, a receipt, an invoice, a credit note', () => {
    for (const item of [
      makeItem(),
      makeItem({ extracted_data: reading({ documentKind: 'receipt' }) }),
      makeItem({ extracted_data: reading({ documentKind: 'supplier_invoice' }) }),
      makeItem({ extracted_data: reading({ documentKind: 'credit_note' }) }),
      makeItem({ status: 'error' }),
    ]) {
      expect(offersRemoval(item)).toBe(true)
      expect(offersRemoval(item)).toBe(offered(item))
    }
  })

  it('a booked item, one that became a supplier invoice, one linked to a bank row and one still being read cannot be picked', () => {
    expect(offersRemoval(makeItem({ created_journal_entry_id: 'je-1' }))).toBe(false)
    expect(offersRemoval(makeItem({ created_supplier_invoice_id: 'si-1' }))).toBe(false)
    expect(offersRemoval(makeItem({ matched_transaction_id: 'tx-1' }))).toBe(false)
    expect(offersRemoval(makeItem({ matched_transaction_id: 'tx-1', matched_transaction_journal_entry_id: 'je-2' }))).toBe(false)
    expect(offersRemoval(makeItem({ document_journal_entry_id: 'je-3' }))).toBe(false)
    expect(offersRemoval(makeItem({ status: 'processing' }))).toBe(false)
  })

  it('the other half of a purchase that is booked already cannot be picked', () => {
    const pairing = { role: 'booked_companion' as const, booked_item_id: 'receipt', booked_kind: 'receipt' as const, basis: 'invoice_number' as const, journal_entry_id: 'je-41', voucher: 'A41', locked: false }
    expect(offersRemoval(makeItem({ pairing }))).toBe(false)
  })
})

describe('removalBatches', () => {
  it('keeps a selection within the bound as one request, in order', () => {
    const ids = Array.from({ length: MAX_INBOX_ITEMS_PER_REMOVAL }, (_, n) => `id-${n}`)
    expect(removalBatches(ids)).toEqual([ids])
    expect(removalBatches([])).toEqual([])
  })

  it('splits a larger selection, every id once', () => {
    const ids = Array.from({ length: MAX_INBOX_ITEMS_PER_REMOVAL * 2 + 3 }, (_, n) => `id-${n}`)
    const batches = removalBatches(ids)
    expect(batches.map((b) => b.length)).toEqual([MAX_INBOX_ITEMS_PER_REMOVAL, MAX_INBOX_ITEMS_PER_REMOVAL, 3])
    expect(batches.flat()).toEqual(ids)
  })
})

describe('summariseRemovals', () => {
  const booked = (id: string): InboxItemRemovalResult => ({ id, removed: false, code: 'INBOX_ITEM_DELETE_BOOKED', message: 'Bokförd.', message_en: 'Booked.' })
  const gone = (id: string): InboxItemRemovalResult => ({ id, removed: false, code: 'INBOX_ITEM_NOT_FOUND', message: 'Hittades inte.', message_en: 'Not found.' })

  it('counts what left and groups what did not by reason, most common first, in the person\'s language', () => {
    const results: InboxItemRemovalResult[] = [{ id: 'a', removed: true }, gone('b'), booked('c'), { id: 'd', removed: true }, booked('e')]
    expect(summariseRemovals(results, 'sv')).toEqual({
      removedIds: ['a', 'd'],
      refused: [
        { code: 'INBOX_ITEM_DELETE_BOOKED', message: 'Bokförd.', count: 2 },
        { code: 'INBOX_ITEM_NOT_FOUND', message: 'Hittades inte.', count: 1 },
      ],
      refusedCount: 3,
    })
    expect(summariseRemovals(results, 'en').refused.map((r) => r.message)).toEqual(['Booked.', 'Not found.'])
  })

  it('has nothing to say about refusals when everything left', () => {
    expect(summariseRemovals([{ id: 'a', removed: true }], 'sv')).toEqual({ removedIds: ['a'], refused: [], refusedCount: 0 })
  })
})

describe('removalUndoSentence: what the confirm of several says about putting them back', () => {
  it('promises Senast borttagna when every picked item can be put back', () => {
    expect(removalUndoSentence(3, 3)).toEqual({ key: 'bulk_drop_confirm_body_put_back', values: { count: 3 } })
    expect(removalUndoSentence(1, 1)).toEqual({ key: 'bulk_drop_confirm_body_put_back', values: { count: 1 } })
  })

  it('says it cannot be undone when none can', () => {
    expect(removalUndoSentence(2, 0)).toEqual({ key: 'bulk_drop_confirm_body', values: { count: 2 } })
  })

  it('says both numbers for a mix, never a promise for all', () => {
    expect(removalUndoSentence(5, 3)).toEqual({ key: 'bulk_drop_confirm_body_mixed', values: { putBack: 3, final: 2 } })
    expect(removalUndoSentence(2, 1)).toEqual({ key: 'bulk_drop_confirm_body_mixed', values: { putBack: 1, final: 1 } })
  })
})
