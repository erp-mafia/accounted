import { describe, expect, it } from 'vitest'
import { isInboxItemTaken, isInboxItemUnbooked, isOpenInboxItem, itemStage, whereInboxItemFree, whereInboxItemOpen, withDocumentHold } from '@/lib/documents/inbox-item-state'
import { DEFAULT_VIEW, companionOf, doorOf, doorsInUse, inboxScope, itemHeadline, isCompanionReceipt, mailProviderOf, mailSenderOf, needCount, needsYou, orderByArrival, parseViewKey, queueFor, recentlyRoutedAway, ROUTED_AWAY_NOTICE_MS, stillInInbox, viewKey } from '../items'
import { INTAKE_SOURCE_IDS } from '@/lib/intake/sources'
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

describe('mailSenderOf: the sender of the mail the item came in', () => {
  it('gives the address, also when the mail carried a display name', () => {
    expect(mailSenderOf(makeItem({ source: 'email', email_from: 'Leverantör AB <faktura@lev.example>' }))).toBe('faktura@lev.example')
    expect(mailSenderOf(makeItem({ source: 'email', email_from: '"Anna Ek" <anna@firma.example>' }))).toBe('anna@firma.example')
    expect(mailSenderOf(makeItem({ source: 'email', email_from: 'anna@firma.example' }))).toBe('anna@firma.example')
  })

  it('reads a connected mailbox from the mail it was found in, else from the item', () => {
    expect(
      mailSenderOf(makeItem({ source: 'mail_hunt', channel_context: { channel: 'mail_hunt', mail_from: 'Telia <faktura@telia.example>' }, email_from: null })),
    ).toBe('faktura@telia.example')
    expect(
      mailSenderOf(makeItem({ source: 'mail_hunt', channel_context: { channel: 'mail_hunt', mail_from: ' ' }, email_from: 'faktura@telia.example' })),
    ).toBe('faktura@telia.example')
  })

  it('follows the stamped door when the source column cannot say', () => {
    expect(
      mailSenderOf(makeItem({ source: 'upload', channel_context: { intake_source: 'intake_email' }, email_from: 'anna@firma.example' })),
    ).toBe('anna@firma.example')
  })

  it('falls back to the name when the header carried no address, and to nothing when there is no sender', () => {
    expect(mailSenderOf(makeItem({ source: 'email', email_from: 'Anna Ek' }))).toBe('Anna Ek')
    expect(mailSenderOf(makeItem({ source: 'email', email_from: null }))).toBeNull()
    expect(mailSenderOf(makeItem({ source: 'email', email_from: '  ' }))).toBeNull()
  })

  it('says nothing for a door that is not a mail: there email_from is a supplier or partner name', () => {
    expect(mailSenderOf(makeItem({ source: 'peppol', email_from: 'Leverantör AB' }))).toBeNull()
    expect(
      mailSenderOf(makeItem({ source: 'upload', channel_context: { intake_source: 'partner_api' }, email_from: 'partner@byra.example' })),
    ).toBeNull()
    expect(mailSenderOf(makeItem({ source: 'upload', email_from: 'anna@firma.example' }))).toBeNull()
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

describe('recentlyRoutedAway: what left the inbox for Dokument lately (PH 225)', () => {
  const now = Date.parse('2026-10-27T16:00:00Z')
  const routed = (id: string, source: string, at: string) =>
    makeItem({ id, source, routed_to_arkiv_at: at, created_at: '2026-10-27T15:09:00Z' })

  it('Behöver dig names every recent one; a door only those it received', () => {
    const items = [
      routed('mail-1', 'email', '2026-10-27T15:12:00Z'),
      routed('mail-2', 'email', '2026-10-27T15:12:30Z'),
      routed('upload-1', 'upload', '2026-10-26T09:00:00Z'),
      makeItem({ id: 'open-1', source: 'email' }),
    ]
    expect(recentlyRoutedAway(items, { kind: 'need' }, now).map((i) => i.id)).toEqual(['mail-1', 'mail-2', 'upload-1'])
    expect(recentlyRoutedAway(items, { kind: 'door', door: doorOf(items[0]) }, now).map((i) => i.id)).toEqual(['mail-1', 'mail-2'])
    expect(recentlyRoutedAway(items, { kind: 'door', door: doorOf(items[2]) }, now).map((i) => i.id)).toEqual(['upload-1'])
  })

  it('forgets one that left more than the notice window ago, and Saknar underlag names none', () => {
    const old = routed('old', 'email', new Date(now - ROUTED_AWAY_NOTICE_MS - 1000).toISOString())
    const fresh = routed('fresh', 'email', new Date(now - 60_000).toISOString())
    expect(recentlyRoutedAway([old, fresh], { kind: 'need' }, now).map((i) => i.id)).toEqual(['fresh'])
    expect(recentlyRoutedAway([fresh], { kind: 'missing' }, now)).toEqual([])
  })

  it('stays out of every queue it is named under', () => {
    const item = routed('mail-1', 'email', '2026-10-27T15:12:00Z')
    expect(queueFor([item], { kind: 'need' })).toEqual([])
    expect(queueFor([item], { kind: 'door', door: doorOf(item) })).toEqual([])
  })
})

describe('the one reading of an open item', () => {
  const shapes = {
    nothing: {},
    'a supplier invoice': { created_supplier_invoice_id: 'si-1' },
    'a stamp': { created_journal_entry_id: 'je-1' },
    'a matched bank row': { matched_transaction_id: 'tx-1' },
    'a booked match': { matched_transaction_id: 'tx-1', matched_transaction_journal_entry_id: 'je-1', underlag_status: 'anchored' },
    'a verifikat on its document, no stamp': { document_journal_entry_id: 'je-1' },
    Arkiv: { routed_to_arkiv_at: '2026-10-01T10:00:00Z' },
    'Arkiv and a stamp': { routed_to_arkiv_at: '2026-10-01T10:00:00Z', created_journal_entry_id: 'je-1' },
  } as const

  it.each([
    ['nothing', true, false, true],
    ['a supplier invoice', false, true, false],
    ['a stamp', false, true, false],
    ['a matched bank row', false, true, true],
    ['a booked match', false, true, false],
    ['a verifikat on its document, no stamp', false, true, false],
    ['Arkiv', false, false, false],
    ['Arkiv and a stamp', false, true, false],
  ] as const)('%s: open %s, taken %s, unbooked %s', (shape, open, taken, unbooked) => {
    expect(isOpenInboxItem(shapes[shape])).toBe(open)
    expect(isInboxItemTaken(shapes[shape])).toBe(taken)
    expect(isInboxItemUnbooked(shapes[shape])).toBe(unbooked)
  })

  it('the stage says booked for a document on a verifikat with no stamp, the bug: the Inkorg offered it for booking', () => {
    expect(itemStage({ document_journal_entry_id: 'je-1' })).toBe('booked')
  })

  it('matched to a row, a document on another verifikat stays a decision, never a silent booked', () => {
    const elsewhere = { matched_transaction_id: 'tx-1', matched_transaction_journal_entry_id: 'je-2', underlag_status: 'anchored_elsewhere', document_journal_entry_id: 'je-1' }
    expect(itemStage(elsewhere)).toBe('linked')
  })

  it('a row read without its document answers from its own columns', () => {
    expect(isOpenInboxItem({ status: 'received' })).toBe(true)
    expect(isOpenInboxItem({ status: 'processing' })).toBe(true)
    expect(isOpenInboxItem({ status: 'error' })).toBe(true)
    expect(isOpenInboxItem({ status: 'processing', matched_transaction_id: 'tx-1' })).toBe(false)
  })

  it('the two filters are the same reading over the columns', () => {
    const calls: string[] = []
    const query = { is(column: string) { calls.push(column); return query } }
    whereInboxItemFree(query)
    expect(calls).toEqual(['created_supplier_invoice_id', 'created_journal_entry_id', 'matched_transaction_id'])
    calls.length = 0
    whereInboxItemOpen(query)
    expect(calls).toEqual(['created_supplier_invoice_id', 'created_journal_entry_id', 'matched_transaction_id', 'routed_to_arkiv_at'])
  })
})

describe('withDocumentHold', () => {
  it.each([
    ['a posted verifikat holds it', { journal_entry_id: 'je-1', entry: { status: 'posted' } }, 'je-1'],
    ['a draft does', { journal_entry_id: 'je-1', entry: { status: 'draft' } }, 'je-1'],
    ['a verifikat whose status could not be read does: never open on a guess', { journal_entry_id: 'je-1', entry: null }, 'je-1'],
    ['a reversed one no longer books it', { journal_entry_id: 'je-1', entry: { status: 'reversed' } }, null],
    ['nor a cancelled one', { journal_entry_id: 'je-1', entry: { status: 'cancelled' } }, null],
    ['a document on nothing', { journal_entry_id: null, entry: null }, null],
    ['no document', null, null],
    ['the array shape of a to-one embed', [{ journal_entry_id: 'je-1', entry: [{ status: 'posted' }] }], 'je-1'],
  ])('%s', (_label, hold, expected) => {
    expect(withDocumentHold({ id: 'item-1', document_hold: hold as never })).toEqual({ id: 'item-1', document_journal_entry_id: expected })
  })
})

describe('inboxScope: the cut GET /items?scope=inbox answers reads the same as the whole list', () => {
  const NOW = Date.parse('2026-11-20T12:00:00.000Z')
  const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString()
  const open = (over: Partial<Parameters<typeof makeItem>[0]>) =>
    makeItem({ status: 'received', extracted_data: reading({ supplier: { name: 'Telia' } }), ...over })
  const whole = [
    open({ id: 'open-upload' }),
    // An invoice still in the inbox and its receipt (one purchase).
    open({ id: 'inv-open', pairing: { role: 'invoice', receipt_item_id: 'rcpt-open', basis: 'invoice_number' } }),
    open({ id: 'rcpt-open', pairing: { role: 'receipt', invoice_item_id: 'inv-open', basis: 'invoice_number' } }),
    // A registered (booked) invoice whose receipt is still open: kept as the receipt's other half.
    makeItem({ id: 'inv-registered', created_supplier_invoice_id: 'si-1', pairing: { role: 'invoice', receipt_item_id: 'rcpt-of-registered', basis: 'invoice_number' } }),
    open({ id: 'rcpt-of-registered', pairing: { role: 'receipt', invoice_item_id: 'inv-registered', basis: 'invoice_number' } }),
    // An open half of a purchase already booked.
    open({ id: 'half-open', pairing: { role: 'booked_companion', booked_item_id: 'half-booked', booked_kind: 'invoice', basis: 'supplier_amount_date' } }),
    makeItem({ id: 'half-booked', created_journal_entry_id: 'je-1' }),
    // Years of booked underlag, through doors that have nothing waiting now.
    ...Array.from({ length: 40 }, (_, i) => makeItem({ id: `booked-${i}`, source: 'peppol', created_journal_entry_id: `je-b${i}` })),
    makeItem({ id: 'mail-booked', source: 'email', channel_context: { intake_source: 'mailbox', mail_provider: 'microsoft' } as never, created_supplier_invoice_id: 'si-2' }),
    // Taken by Arkiv: three days ago (still named) and a month ago (not).
    makeItem({ id: 'routed-recent', routed_to_arkiv_at: daysAgo(3) }),
    makeItem({ id: 'routed-old', routed_to_arkiv_at: daysAgo(30) }),
  ]

  it('keeps what is in the inbox, the recently routed, and the other half of every kept pair', () => {
    const { items } = inboxScope(whole, NOW)
    expect(items.map((i) => i.id).sort()).toEqual(
      ['half-booked', 'half-open', 'inv-open', 'inv-registered', 'open-upload', 'rcpt-of-registered', 'rcpt-open', 'routed-recent'].sort(),
    )
  })

  it('gives every view the page derives the same answer as the whole list', () => {
    const scoped = inboxScope(whole, NOW)
    // Not a vacuous comparison: the whole list has decisions waiting.
    expect(queueFor(whole, { kind: 'need' }).length).toBeGreaterThan(0)
    const views = [{ kind: 'need' as const }, ...INTAKE_SOURCE_IDS.map((door) => ({ kind: 'door' as const, door }))]
    for (const view of views) {
      expect(queueFor(scoped.items, view).map((i) => i.id), JSON.stringify(view)).toEqual(queueFor(whole, view).map((i) => i.id))
      expect(recentlyRoutedAway(scoped.items, view, NOW).map((i) => i.id)).toEqual(recentlyRoutedAway(whole, view, NOW).map((i) => i.id))
    }
    expect(needCount(scoped.items)).toBe(needCount(whole))
    expect(doorsInUse(scoped.items, scoped.doors)).toEqual(doorsInUse(whole))
    for (const item of queueFor(whole, { kind: 'need' })) {
      expect(companionOf(item, scoped.items)?.id ?? null).toBe(companionOf(item, whole)?.id ?? null)
    }
    expect(scoped.mailProvider).toBe(mailProviderOf(whole))
    expect(scoped.mailProvider).toBe('microsoft')
  })
})
