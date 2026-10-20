import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VIEW,
  companionOf,
  doorOf,
  doorsInUse,
  itemHeadline,
  isCompanionReceipt,
  itemStage,
  needCount,
  needsYou,
  orderByArrival,
  parseViewKey,
  queueFor,
  stillInInbox,
  viewKey,
} from '../items'
import { makeItem, reading } from './fixtures'

describe('itemStage: where an item stands, by the workspace precedence', () => {
  it('booked: a supplier invoice, a verifikat of its own, or a booked match that carries this underlag', () => {
    expect(itemStage(makeItem({ created_supplier_invoice_id: 'si-1' }))).toBe('booked')
    expect(itemStage(makeItem({ created_journal_entry_id: 'je-1' }))).toBe('booked')
    expect(
      itemStage(makeItem({ matched_transaction_id: 'tx-1', matched_transaction_journal_entry_id: 'je-2', underlag_status: 'anchored' })),
    ).toBe('booked')
  })

  it('linked: a booked match whose verifikat does not carry this underlag is still a decision', () => {
    for (const status of ['unlinked', 'unlinked_locked', 'anchored_elsewhere', 'unknown'] as const) {
      expect(
        itemStage(makeItem({ matched_transaction_id: 'tx-1', matched_transaction_journal_entry_id: 'je-2', underlag_status: status })),
      ).toBe('linked')
    }
  })

  it('processing outranks a match: no booking from fields that are not read yet', () => {
    expect(itemStage(makeItem({ status: 'processing', matched_transaction_id: 'tx-1' }))).toBe('processing')
  })

  it('linked before error, error before needs_action', () => {
    expect(itemStage(makeItem({ status: 'error', matched_transaction_id: 'tx-1' }))).toBe('linked')
    expect(itemStage(makeItem({ status: 'error' }))).toBe('error')
    expect(itemStage(makeItem())).toBe('needs_action')
  })
})

describe('needsYou and stillInInbox', () => {
  it('Behöver dig: a first decision, a match to book, a failed reading; never a reading in flight or a booked item', () => {
    expect(needsYou(makeItem())).toBe(true)
    expect(needsYou(makeItem({ matched_transaction_id: 'tx-1' }))).toBe(true)
    expect(needsYou(makeItem({ status: 'error' }))).toBe(true)
    expect(needsYou(makeItem({ status: 'processing' }))).toBe(false)
    expect(needsYou(makeItem({ created_journal_entry_id: 'je-1' }))).toBe(false)
  })

  it('an item Arkiv took is neither waiting nor in the inbox', () => {
    const routed = makeItem({ routed_to_arkiv_at: '2026-10-02T00:00:00Z' })
    expect(needsYou(routed)).toBe(false)
    expect(stillInInbox(routed)).toBe(false)
  })

  it('still in the inbox: everything not booked, a reading in flight included', () => {
    expect(stillInInbox(makeItem({ status: 'processing' }))).toBe(true)
    expect(stillInInbox(makeItem({ created_supplier_invoice_id: 'si-1' }))).toBe(false)
  })

  it('a half whose other half is booked waits for nobody, and is still listed in its door until it is added', () => {
    const half = makeItem({ pairing: { role: 'booked_companion', booked_item_id: 'b', booked_kind: 'receipt', basis: 'invoice_number', voucher: 'A41' } })
    expect(needsYou(half)).toBe(false)
    expect(needCount([half, makeItem({ id: 'other' })])).toBe(1)
    expect(stillInInbox(half)).toBe(true)
  })
})

describe('doorOf', () => {
  it('reads the door through the one vocabulary', () => {
    expect(doorOf(makeItem({ source: 'email' }))).toBe('intake_email')
    expect(doorOf(makeItem({ source: 'peppol' }))).toBe('peppol')
    expect(doorOf(makeItem({ source: 'mail_hunt' }))).toBe('mailbox')
    expect(doorOf(makeItem({ source: 'upload', channel_context: { intake_source: 'mcp' } }))).toBe('mcp')
    expect(doorOf(makeItem({ source: 'upload', channel_context: { intake_source: 'partner_api' } }))).toBe('partner_api')
  })

  it('an unknown source reads as an upload, never as nothing', () => {
    expect(doorOf(makeItem({ source: 'something-new' }))).toBe('upload')
  })
})

describe('views', () => {
  it('round-trips through its key, and an unknown key is Behöver dig', () => {
    for (const view of [DEFAULT_VIEW, { kind: 'missing' } as const, { kind: 'door', door: 'peppol' } as const]) {
      expect(parseViewKey(viewKey(view))).toEqual(view)
    }
    expect(parseViewKey(null)).toEqual(DEFAULT_VIEW)
    expect(parseViewKey('door:nope')).toEqual(DEFAULT_VIEW)
    expect(parseViewKey('anything')).toEqual(DEFAULT_VIEW)
  })

  it('a portal row is Saknar underlag for that supplier, and round-trips too', () => {
    const view = { kind: 'missing', portal: 'Google Workspace' } as const
    expect(viewKey(view)).toBe('portal:Google Workspace')
    expect(parseViewKey(viewKey(view))).toEqual(view)
    expect(parseViewKey('portal:  OpenAI ')).toEqual({ kind: 'missing', portal: 'OpenAI' })
    // No supplier, or a value no directory name comes near, is Behöver dig.
    expect(parseViewKey('portal:')).toEqual(DEFAULT_VIEW)
    expect(parseViewKey('portal:   ')).toEqual(DEFAULT_VIEW)
    expect(parseViewKey(`portal:${'x'.repeat(81)}`)).toEqual(DEFAULT_VIEW)
    expect(queueFor([makeItem({ id: 'a' })], view)).toEqual([])
  })

  it('orders newest first, then by id, without touching the input', () => {
    const input = [
      makeItem({ id: 'b', created_at: '2026-10-01T00:00:00Z' }),
      makeItem({ id: 'c', created_at: '2026-10-03T00:00:00Z' }),
      makeItem({ id: 'a', created_at: '2026-10-01T00:00:00Z' }),
    ]
    expect(orderByArrival(input).map((i) => i.id)).toEqual(['c', 'a', 'b'])
    expect(input.map((i) => i.id)).toEqual(['b', 'c', 'a'])
  })

  it('Behöver dig lists what waits; a door lists what is still in the inbox from that door', () => {
    const items = [
      makeItem({ id: 'mail-open', source: 'email', created_at: '2026-10-05T00:00:00Z' }),
      makeItem({ id: 'mail-reading', source: 'email', status: 'processing', created_at: '2026-10-04T00:00:00Z' }),
      makeItem({ id: 'mail-booked', source: 'email', created_journal_entry_id: 'je-1', created_at: '2026-10-03T00:00:00Z' }),
      makeItem({ id: 'upload-open', source: 'upload', created_at: '2026-10-02T00:00:00Z' }),
    ]
    expect(queueFor(items, { kind: 'need' }).map((i) => i.id)).toEqual(['mail-open', 'upload-open'])
    expect(queueFor(items, { kind: 'door', door: 'intake_email' }).map((i) => i.id)).toEqual(['mail-open', 'mail-reading'])
    expect(queueFor(items, { kind: 'missing' })).toEqual([])
    expect(needCount(items)).toBe(2)
  })

  it('lists every door in use, in the vocabulary order, with what still waits from it', () => {
    const items = [
      makeItem({ id: '1', source: 'upload' }),
      makeItem({ id: '2', source: 'peppol', created_supplier_invoice_id: 'si-1' }),
      makeItem({ id: '3', source: 'email' }),
      makeItem({ id: '4', source: 'email' }),
      makeItem({ id: '5', source: 'whatsapp', routed_to_arkiv_at: '2026-10-02T00:00:00Z' }),
    ]
    expect(doorsInUse(items)).toEqual([
      { door: 'intake_email', waiting: 2 },
      { door: 'upload', waiting: 1 },
      { door: 'peppol', waiting: 0 },
    ])
    expect(doorsInUse([])).toEqual([])
  })
})

describe('itemHeadline', () => {
  it('names the supplier, else the mail subject, else nothing', () => {
    expect(itemHeadline(makeItem({ extracted_data: reading({ supplier: { name: ' Telia ' } }) })).name).toBe('Telia')
    expect(itemHeadline(makeItem({ email_subject: 'Faktura 12' })).name).toBe('Faktura 12')
    expect(itemHeadline(makeItem()).name).toBeNull()
  })

  it('shows the read total, else the single distinct amount, never a guess between two', () => {
    expect(itemHeadline(makeItem({ extracted_data: reading({ totals: { total: 412.5 } }) })).amount).toBe(412.5)
    expect(
      itemHeadline(makeItem({ extracted_data: reading({ prominentAmounts: [{ amount: 100 }, { amount: 100 }, { amount: 0 }] as never }) })).amount,
    ).toBe(100)
    expect(
      itemHeadline(makeItem({ extracted_data: reading({ prominentAmounts: [{ amount: 100 }, { amount: 200 }] as never }) })).amount,
    ).toBeNull()
  })

  it('takes the kind from the declared hint first, then the reading', () => {
    expect(itemHeadline(makeItem({ kind_hint: 'receipt', extracted_data: reading({ documentKind: 'supplier_invoice' }) })).kind).toBe('receipt')
    expect(itemHeadline(makeItem({ extracted_data: reading({ documentKind: 'supplier_invoice' }) })).kind).toBe('supplier_invoice')
    expect(itemHeadline(makeItem()).kind).toBeNull()
  })

  it('carries the currency, SEK when unread', () => {
    expect(itemHeadline(makeItem({ extracted_data: reading({ invoice: { currency: 'EUR' } }) })).currency).toBe('EUR')
    expect(itemHeadline(makeItem()).currency).toBe('SEK')
  })
})

describe('an invoice and its receipt as one row', () => {
  const invoice = makeItem({ id: 'invoice', pairing: { role: 'invoice', receipt_item_id: 'receipt', basis: 'invoice_number' } })
  const receipt = makeItem({ id: 'receipt', pairing: { role: 'receipt', invoice_item_id: 'invoice', basis: 'invoice_number' } })
  const other = makeItem({ id: 'other' })

  it('lists the invoice and hides the receipt as its companion, in every view', () => {
    const items = [invoice, receipt, other]
    expect(queueFor(items, { kind: 'need' }).map((i) => i.id).sort()).toEqual(['invoice', 'other'])
    expect(queueFor(items, { kind: 'door', door: 'upload' }).map((i) => i.id).sort()).toEqual(['invoice', 'other'])
    expect(needCount(items)).toBe(2)
    expect(doorsInUse(items)).toEqual([{ door: 'upload', waiting: 2 }])
    expect(isCompanionReceipt(receipt)).toBe(true)
    expect(isCompanionReceipt(invoice)).toBe(false)
  })

  it('finds the receipt an invoice carries', () => {
    expect(companionOf(invoice, [invoice, receipt])?.id).toBe('receipt')
    expect(companionOf(invoice, [invoice])).toBeNull()
    expect(companionOf(receipt, [invoice, receipt])).toBeNull()
  })
})
