import { describe, expect, it } from 'vitest'
import { addDaysIso, addMonthsIso } from '@/lib/dates/iso'
import {
  detectCadence,
  documentEvidence,
  evidenceDocumentIds,
  expectationsFrom,
  findPatterns,
  nextOccurrence,
  purchasesOnTheWay,
  upcomingExpectations,
  type DocumentEvidence,
  type ExpectationHistory,
  type HistorySupplierInvoice,
  type HistoryTransaction,
  type OpenPurchase,
  type PatternExpectation,
} from '../expectations'

const TODAY = '2026-10-16'

/** `count` dates one month apart on `day`, the last one in `lastMonth` (YYYY-MM). */
function monthly(lastMonth: string, count: number, day = 4): string[] {
  const last = `${lastMonth}-${String(day).padStart(2, '0')}`
  return Array.from({ length: count }, (_, i) => addMonthsIso(last, i - count + 1))
}

let seq = 0
function tx(overrides: Partial<HistoryTransaction> = {}): HistoryTransaction {
  seq += 1
  return {
    id: `tx-${seq}`,
    date: '2026-10-04',
    amount: -699,
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
    merchant_name: null,
    description: 'MOLNTJANSTEN',
    document_id: null,
    ...overrides,
  }
}

function invoice(overrides: Partial<HistorySupplierInvoice> = {}): HistorySupplierInvoice {
  seq += 1
  return {
    id: `si-${seq}`,
    supplier_id: 'sup-el',
    invoice_date: '2026-10-01',
    total: 1250,
    total_sek: null,
    currency: 'SEK',
    exchange_rate: null,
    document_id: null,
    ...overrides,
  }
}

function history(overrides: Partial<ExpectationHistory> = {}): ExpectationHistory {
  return { transactions: [], supplierInvoices: [], suppliers: [{ id: 'sup-el', name: 'Elbolaget Norr AB' }], payments: [], ...overrides }
}

/** A monthly bank subscription whose every row has its receipt (doc-<date>). */
function subscriptionRows(dates: string[], overrides: Partial<HistoryTransaction> = {}): HistoryTransaction[] {
  return dates.map((date) => tx({ date, document_id: `doc-${date}`, ...overrides }))
}

/** The same door for every document, arriving `lag` days after its date. */
function evidenceFor(ids: string[], door: DocumentEvidence['door'], lag = 0): Map<string, DocumentEvidence> {
  return new Map(ids.map((id) => [id, { door, arrivedOn: addDaysIso(id.replace(/^doc-/, ''), lag) }]))
}

function expectationsOf(h: ExpectationHistory, evidence: Map<string, DocumentEvidence> = new Map()): PatternExpectation[] {
  return expectationsFrom(findPatterns(h, TODAY), evidence)
}

// ---------------------------------------------------------------------------

describe('detectCadence', () => {
  it('reads a year of bills on the 4th as monthly', () => {
    const fit = detectCadence(monthly('2026-10', 12))
    expect(fit).toMatchObject({ cadence: 'monthly', months: 1, weak: false })
    expect(fit!.windowDays).toBeGreaterThanOrEqual(3)
  })

  it('keeps a monthly supplier monthly through a skipped month', () => {
    const dates = monthly('2026-10', 10).filter((d) => d !== '2026-08-04')
    expect(detectCadence(dates)?.cadence).toBe('monthly')
  })

  it('does not take a supplier that skips every other month for monthly', () => {
    const dates = ['2026-02-04', '2026-04-04', '2026-06-04', '2026-08-04', '2026-10-04']
    expect(detectCadence(dates)).toBeNull()
  })

  it('reads bills that move with weekends as monthly, with a window that covers the drift', () => {
    const dates = ['2026-04-06', '2026-05-04', '2026-06-04', '2026-07-03', '2026-08-04', '2026-09-07', '2026-10-05']
    const fit = detectCadence(dates)
    expect(fit?.cadence).toBe('monthly')
    expect(fit!.windowDays).toBeGreaterThanOrEqual(3)
    expect(fit!.windowDays).toBeLessThanOrEqual(7)
  })

  it('tolerates one extra purchase in a year of monthly bills', () => {
    const dates = [...monthly('2026-10', 12), '2026-06-20']
    expect(detectCadence(dates)?.cadence).toBe('monthly')
  })

  it('reads four bills a quarter apart as quarterly', () => {
    expect(detectCadence(['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15'])?.cadence).toBe('quarterly')
  })

  it('reads two bills a year apart as a weak yearly cadence', () => {
    expect(detectCadence(['2024-11-02', '2025-11-03'])).toMatchObject({ cadence: 'yearly', months: 12, weak: true })
  })

  it('needs enough history: one bill, or two a month apart, is no cadence', () => {
    expect(detectCadence(['2026-10-04'])).toBeNull()
    expect(detectCadence(['2026-09-04', '2026-10-04'])).toBeNull()
    expect(detectCadence([])).toBeNull()
  })

  it('finds no cadence in purchases at random intervals', () => {
    expect(detectCadence(['2026-03-01', '2026-03-04', '2026-03-21', '2026-04-30', '2026-05-09', '2026-07-01'])).toBeNull()
  })

  it('counts two bills on one day once', () => {
    expect(detectCadence(['2026-08-04', '2026-08-04', '2026-09-04', '2026-10-04'])?.cadence).toBe('monthly')
  })
})

describe('nextOccurrence', () => {
  const MONTHLY = { months: 1, days: 30.44 }

  it('is one month after the latest, on the usual day', () => {
    expect(nextOccurrence(monthly('2026-10', 6), MONTHLY)).toBe('2026-11-04')
  })

  it('does not let one late bill move the next one', () => {
    expect(nextOccurrence(['2026-06-04', '2026-07-04', '2026-08-04', '2026-09-04', '2026-10-06'], MONTHLY)).toBe('2026-11-04')
  })

  it('skips the period a bill already came early for', () => {
    // The October bill came on 30 September: the next one is November's.
    expect(nextOccurrence(['2026-06-04', '2026-07-04', '2026-08-04', '2026-09-03', '2026-09-30'], MONTHLY)).toBe('2026-11-03')
  })

  it('keeps a turn-of-the-month biller at the turn of the month', () => {
    expect(nextOccurrence(['2026-06-30', '2026-07-31', '2026-09-01', '2026-09-30', '2026-10-31'], MONTHLY)).toBe('2026-11-30')
  })

  it('steps a quarter and a year', () => {
    expect(nextOccurrence(['2026-04-15', '2026-07-15', '2026-10-15'], { months: 3, days: 91.31 })).toBe('2027-01-15')
    expect(nextOccurrence(['2024-11-02', '2025-11-03'], { months: 12, days: 365.25 })).toBe('2026-11-03')
  })
})

describe('findPatterns', () => {
  it('finds a monthly bank subscription with its usual amount and next window', () => {
    const [pattern] = findPatterns(history({ transactions: subscriptionRows(monthly('2026-10', 8)) }), TODAY)
    expect(pattern).toMatchObject({
      key: 'bank:molntjansten',
      kind: 'bank',
      name: 'MOLNTJANSTEN',
      bankKeys: ['molntjansten'],
      events: 8,
      lastSeen: '2026-10-04',
      amount: { usual: 699, min: 699, max: 699 },
    })
    expect(pattern.fit.cadence).toBe('monthly')
    expect(pattern.next.expected).toBe('2026-11-04')
    expect(pattern.next.from < pattern.next.expected && pattern.next.to > pattern.next.expected).toBe(true)
  })

  it('follows a price that drifts up: the usual amount is the latest few, the range the latest six', () => {
    const dates = monthly('2026-10', 12)
    const rows = dates.map((date, i) => tx({ date, document_id: `doc-${date}`, amount: -(100 + i * 5) }))
    const [pattern] = findPatterns(history({ transactions: rows }), TODAY)
    // Amounts run 100..155: the latest three are 145, 150, 155; the latest six 130..155.
    expect(pattern.amount).toEqual({ usual: 150, min: 130, max: 155 })
  })

  it('reads foreign charges in kronor, and leaves out the ones without a kronor amount', () => {
    const dates = monthly('2026-10', 4)
    const rows = dates.map((date, i) =>
      tx({ date, document_id: `doc-${date}`, currency: 'EUR', amount: -20, amount_sek: i === 3 ? null : -(221.5 + i) }),
    )
    const [pattern] = findPatterns(history({ transactions: rows }), TODAY)
    expect(pattern.amount).toEqual({ usual: 222.5, min: 221.5, max: 223.5 })
  })

  it('drops a supplier that stopped: two bills in a row did not come', () => {
    const rows = subscriptionRows(monthly('2026-07', 8))
    expect(findPatterns(history({ transactions: rows }), TODAY)).toEqual([])
  })

  it('keeps a supplier whose latest bill is only one period behind', () => {
    const rows = subscriptionRows(monthly('2026-09', 8))
    const [pattern] = findPatterns(history({ transactions: rows }), TODAY)
    expect(pattern.next.expected).toBe('2026-10-04')
  })

  it('needs enough history', () => {
    const rows = subscriptionRows(monthly('2026-10', 2))
    expect(findPatterns(history({ transactions: rows }), TODAY)).toEqual([])
  })

  it('leaves out salary and tax, which have no document to expect', () => {
    const rows = [
      ...subscriptionRows(monthly('2026-09', 8, 25), { description: 'Löneutbetalning' }),
      ...subscriptionRows(monthly('2026-10', 8, 12), { description: 'Skattekonto inbetalning' }),
    ]
    expect(findPatterns(history({ transactions: rows }), TODAY)).toEqual([])
  })

  it('leaves out a bank series that never had an underlag, unless the portal directory knows where it is', () => {
    const bare = monthly('2026-10', 6).map((date) => tx({ date, description: 'MANADSAVGIFT KONTO' }))
    expect(findPatterns(history({ transactions: bare }), TODAY)).toEqual([])
    const portal = monthly('2026-10', 6).map((date) => tx({ date, description: 'HETZNER ONLINE GMBH' }))
    expect(findPatterns(history({ transactions: portal }), TODAY).map((p) => p.key)).toEqual(['bank:hetzner online'])
  })

  it('reads a yearly bill from two years, and only when the two amounts agree', () => {
    const agree = [tx({ date: '2024-11-02', amount: -1490, document_id: 'doc-a' }), tx({ date: '2025-11-03', amount: -1590, document_id: 'doc-b' })]
    const [pattern] = findPatterns(history({ transactions: agree }), TODAY)
    expect(pattern).toMatchObject({ fit: { cadence: 'yearly', weak: true }, next: { expected: '2026-11-03' } })
    const disagree = [tx({ date: '2024-11-02', amount: -300, document_id: 'doc-a' }), tx({ date: '2025-11-03', amount: -4200, document_id: 'doc-b' })]
    expect(findPatterns(history({ transactions: disagree }), TODAY)).toEqual([])
  })

  it('reads a supplier from its registered invoices, and the bank rows that paid them name it at the bank', () => {
    const dates = monthly('2026-10', 6, 1)
    const invoices = dates.map((date) => invoice({ invoice_date: date, document_id: `doc-${date}` }))
    const payments = invoices.map((inv) => {
      const paid = tx({ date: addDaysIso(inv.invoice_date, 14), description: 'ELBOLAGET NORR', amount: -1250 })
      return { paid, payment: { supplier_invoice_id: inv.id, transaction_id: paid.id } }
    })
    const [pattern, ...rest] = findPatterns(
      history({
        supplierInvoices: invoices,
        transactions: payments.map((p) => p.paid),
        payments: payments.map((p) => p.payment),
      }),
      TODAY,
    )
    // The paying rows belong to the supplier: no second, bank-keyed series for them.
    expect(rest).toEqual([])
    expect(pattern).toMatchObject({
      key: 'supplier:sup-el',
      kind: 'supplier',
      name: 'Elbolaget Norr AB',
      supplierId: 'sup-el',
      bankKeys: ['elbolaget norr'],
      amount: { usual: 1250, min: 1250, max: 1250 },
      next: { expected: '2026-11-01' },
    })
    expect(pattern.occurrences[0].paidOn).toBe('2026-05-15')
  })

  it('names a bank series by its latest row, whatever order the rows come in', () => {
    const dates = monthly('2026-10', 4)
    const rows = dates.reverse().map((date, i) => tx({ date, document_id: `doc-${date}`, merchant_name: i === 0 ? 'Molntjansten' : 'MOLNTJANSTEN' }))
    expect(findPatterns(history({ transactions: rows }), TODAY)[0].name).toBe('Molntjansten')
  })
})

describe('documentEvidence', () => {
  it('takes the door from the inbox item the document arrived as, else from the document itself', () => {
    const evidence = documentEvidence(
      [
        { id: 'd-peppol', upload_source: 'e_invoice', file_name: 'invoice.xml', created_at: '2026-10-02T08:00:00Z' },
        { id: 'd-mail', upload_source: 'email', file_name: 'kvitto.pdf', created_at: '2026-10-03T23:30:00Z' },
        { id: 'd-hand', upload_source: 'file_upload', file_name: 'scan.pdf', created_at: '2026-10-05T10:00:00Z' },
        { id: 'd-ai', upload_source: 'api', file_name: 'faktura.pdf', created_at: '2026-10-06T10:00:00Z' },
      ],
      [
        { document_id: 'd-peppol', source: 'peppol', channel_context: { channel: 'peppol' }, created_at: '2026-10-02T08:00:01Z' },
        { document_id: 'd-mail', source: 'email', channel_context: null, created_at: '2026-10-03T23:30:01Z' },
        { document_id: 'd-ai', source: 'upload', channel_context: null, created_at: '2026-10-06T10:00:01Z' },
      ],
    )
    expect(evidence.get('d-peppol')).toEqual({ door: 'peppol', arrivedOn: '2026-10-02' })
    // 23:30 UTC is past midnight in Stockholm: it arrived on the 4th there.
    expect(evidence.get('d-mail')).toEqual({ door: 'intake_email', arrivedOn: '2026-10-04' })
    expect(evidence.get('d-hand')?.door).toBe('upload')
    expect(evidence.get('d-ai')?.door).toBe('mcp')
  })
})

describe('expectationsFrom', () => {
  const dates = monthly('2026-10', 6)
  const docIds = dates.map((d) => `doc-${d}`)

  it('names the door most of the latest documents came through, and how long they take after the bank row', () => {
    const evidence = evidenceFor(docIds, 'intake_email', 1)
    evidence.set(docIds[0], { door: 'upload', arrivedOn: dates[0] })
    const [e] = expectationsOf(history({ transactions: subscriptionRows(dates) }), evidence)
    expect(e.door).toBe('intake_email')
    // A day after the bank row, plus two days' grace.
    expect(e.waitDays).toBe(3)
    expect(e.portal).toBeNull()
  })

  it('names no door when no door carries most of them', () => {
    const evidence = evidenceFor(docIds.slice(0, 2), 'intake_email')
    for (const [id, e] of evidenceFor(docIds.slice(2, 4), 'whatsapp')) evidence.set(id, e)
    for (const [id, e] of evidenceFor(docIds.slice(4), 'upload')) evidence.set(id, e)
    const [e] = expectationsOf(history({ transactions: subscriptionRows(dates) }), evidence)
    expect(e.door).toBeNull()
    expect(e.waitDays).toBeNull()
  })

  it('needs two documents through a door before it is the usual one', () => {
    const rows = subscriptionRows(dates).map((r, i) => (i < 5 ? { ...r, document_id: null } : r))
    const [e] = expectationsOf(history({ transactions: rows }), evidenceFor([docIds[5]], 'intake_email'))
    expect(e.door).toBeNull()
  })

  it('says portal for a supplier the portal directory knows when its documents are uploaded by hand', () => {
    const rows = subscriptionRows(dates, { description: 'HETZNER ONLINE GMBH' })
    const [e] = expectationsOf(history({ transactions: rows }), evidenceFor(docIds, 'upload'))
    expect(e.door).toBe('portal')
    expect(e.portal).toEqual({ vendor: 'Hetzner', url: 'https://accounts.hetzner.com/invoice' })
    expect(e.waitDays).toBeNull()
  })

  it('waits the default five days for a door that delivers by itself when no delay was ever measured', () => {
    const invDates = monthly('2026-10', 6, 1)
    const invoices = invDates.map((date) => invoice({ invoice_date: date, document_id: `doc-${date}` }))
    const [e] = expectationsOf(history({ supplierInvoices: invoices }), evidenceFor(invoices.map((i) => i.document_id!), 'peppol'))
    expect(e).toMatchObject({ door: 'peppol', waitDays: 5, bankKeys: [] })
  })

  it('does not wait for documents that usually come weeks after the bank row: a person sends those on', () => {
    const [e] = expectationsOf(history({ transactions: subscriptionRows(dates) }), evidenceFor(docIds, 'intake_email', 30))
    expect(e.door).toBe('intake_email')
    expect(e.waitDays).toBeNull()
  })

  it('reads only the latest occurrences documents', () => {
    const many = subscriptionRows(monthly('2026-10', 12))
    const ids = evidenceDocumentIds(findPatterns(history({ transactions: many }), TODAY))
    expect(ids).toHaveLength(8)
    expect(ids).toContain('doc-2026-10-04')
    expect(ids).not.toContain('doc-2025-11-04')
  })
})

describe('upcomingExpectations', () => {
  it('lists the next documents due within 45 days, soonest first', () => {
    const rows = [
      ...subscriptionRows(monthly('2026-10', 6, 4)),
      ...subscriptionRows(monthly('2026-10', 6, 12), { description: 'KONTORSHOTELLET' }),
      // Yearly, next due in a year: past the horizon.
      tx({ date: '2025-10-01', description: 'DOMANREGISTRET', amount: -300, document_id: 'doc-y1' }),
      tx({ date: '2026-09-30', description: 'DOMANREGISTRET', amount: -300, document_id: 'doc-y2' }),
    ]
    const upcoming = upcomingExpectations(expectationsOf(history({ transactions: rows })), TODAY)
    expect(upcoming.map((e) => [e.counterparty, e.expected_on])).toEqual([
      ['MOLNTJANSTEN', '2026-11-04'],
      ['KONTORSHOTELLET', '2026-11-12'],
    ])
    expect(upcoming[0]).toMatchObject({ cadence: 'monthly', occurrences: 6, last_seen: '2026-10-04', amount: { usual: 699 } })
  })

  it('leaves out one whose window has passed: it is late, not later', () => {
    const rows = subscriptionRows(monthly('2026-09', 6))
    const expectations = expectationsOf(history({ transactions: rows }))
    expect(expectations).toHaveLength(1)
    expect(upcomingExpectations(expectations, TODAY)).toEqual([])
  })

  it('keeps one whose window is still open', () => {
    const rows = subscriptionRows(monthly('2026-09', 6, 14))
    expect(upcomingExpectations(expectationsOf(history({ transactions: rows })), TODAY).map((e) => e.expected_on)).toEqual(['2026-10-14'])
  })

  it('lists a supplier once, under its own name, when its bank text also bills on its own', () => {
    const invDates = monthly('2026-10', 6, 1)
    const invoices = invDates.map((date) => invoice({ invoice_date: date }))
    const paid = tx({ date: '2026-06-30', description: 'ELBOLAGET NORR', amount: -1250 })
    const unlinked = subscriptionRows(monthly('2026-10', 4, 2), { description: 'ELBOLAGET NORR', amount: -1250 })
    const expectations = expectationsOf(
      history({
        supplierInvoices: invoices,
        transactions: [paid, ...unlinked],
        payments: [{ supplier_invoice_id: invoices[0].id, transaction_id: paid.id }],
      }),
    )
    expect(expectations.map((e) => e.key).sort()).toEqual(['bank:elbolaget norr', 'supplier:sup-el'])
    expect(upcomingExpectations(expectations, TODAY).map((e) => e.key)).toEqual(['supplier:sup-el'])
  })
})

describe('purchasesOnTheWay', () => {
  const dates = monthly('2026-10', 6, 15)
  const docIds = dates.map((d) => `doc-${d}`)
  // The October row is the open one: no receipt yet.
  const rows = subscriptionRows(dates).map((r) => (r.date === '2026-10-15' ? { ...r, id: 'open-1', document_id: null } : r))
  const open: OpenPurchase[] = [{ id: 'open-1', date: '2026-10-15', merchant_name: null, description: 'MOLNTJANSTEN' }]

  it('puts a purchase on its way while its receipt is due through the intake address', () => {
    const expectations = expectationsOf(history({ transactions: rows }), evidenceFor(docIds, 'intake_email', 1))
    expect(purchasesOnTheWay(open, expectations, TODAY)).toEqual([
      {
        transaction_id: 'open-1',
        expectation_key: 'bank:molntjansten',
        counterparty: 'MOLNTJANSTEN',
        door: 'intake_email',
        expected_by: '2026-10-18',
      },
    ])
  })

  it('gives it back to the person once its receipt is overdue', () => {
    const expectations = expectationsOf(history({ transactions: rows }), evidenceFor(docIds, 'intake_email', 1))
    expect(purchasesOnTheWay(open, expectations, '2026-10-19')).toEqual([])
  })

  it('never puts a purchase on its way when its documents are uploaded by hand', () => {
    const expectations = expectationsOf(history({ transactions: rows }), evidenceFor(docIds, 'upload'))
    expect(purchasesOnTheWay(open, expectations, TODAY)).toEqual([])
  })

  it('leaves a purchase from a counterparty with no cadence to the person', () => {
    const lone: OpenPurchase[] = [{ id: 'open-2', date: '2026-10-15', merchant_name: null, description: 'BYGGHANDELN' }]
    const expectations = expectationsOf(history({ transactions: rows }), evidenceFor(docIds, 'intake_email'))
    expect(purchasesOnTheWay(lone, expectations, TODAY)).toEqual([])
  })

  it('finds a Peppol supplier by the bank text its earlier payments carried', () => {
    // Invoices on the 28th, paid by autogiro 17 days later; September's has not come yet.
    const invDates = monthly('2026-08', 6, 28)
    const invoices = invDates.map((date) => invoice({ invoice_date: date, document_id: `doc-${date}` }))
    const paid = invoices.map((inv) => tx({ date: addDaysIso(inv.invoice_date, 17), description: 'Autogiro ELBOLAGET NORR', amount: -1250 }))
    const expectations = expectationsOf(
      history({
        supplierInvoices: invoices,
        transactions: paid,
        payments: invoices.map((inv, i) => ({ supplier_invoice_id: inv.id, transaction_id: paid[i].id })),
      }),
      evidenceFor(invoices.map((i) => i.document_id!), 'peppol'),
    )
    const autogiro: OpenPurchase[] = [{ id: 'open-3', date: '2026-10-15', merchant_name: null, description: 'Autogiro ELBOLAGET NORR' }]
    // The invoices came before their payments: on its way for the grace days only.
    expect(purchasesOnTheWay(autogiro, expectations, TODAY)).toEqual([
      expect.objectContaining({ transaction_id: 'open-3', expectation_key: 'supplier:sup-el', door: 'peppol', expected_by: '2026-10-17' }),
    ])
  })

  it('finds a supplier no payment was ever linked to by every word of its name in the bank text', () => {
    const invDates = monthly('2026-10', 6, 1)
    const invoices = invDates.map((date) => invoice({ invoice_date: date, document_id: `doc-${date}` }))
    const expectations = expectationsOf(history({ supplierInvoices: invoices }), evidenceFor(invoices.map((i) => i.document_id!), 'peppol'))
    const named: OpenPurchase[] = [{ id: 'open-4', date: '2026-10-14', merchant_name: 'ELBOLAGET NORR KUNDSERVICE', description: null }]
    const other: OpenPurchase[] = [{ id: 'open-5', date: '2026-10-14', merchant_name: 'ELBOLAGET SYD', description: null }]
    expect(purchasesOnTheWay(named, expectations, TODAY).map((p) => p.transaction_id)).toEqual(['open-4'])
    expect(purchasesOnTheWay(other, expectations, TODAY)).toEqual([])
  })

  it('ignores a purchase dated after today', () => {
    const expectations = expectationsOf(history({ transactions: rows }), evidenceFor(docIds, 'intake_email', 1))
    const ahead: OpenPurchase[] = [{ ...open[0], date: '2026-10-17' }]
    expect(purchasesOnTheWay(ahead, expectations, TODAY)).toEqual([])
  })
})
